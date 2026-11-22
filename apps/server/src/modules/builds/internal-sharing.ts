import { createHash, randomUUID } from 'node:crypto';
import {
  AnalyticsError,
  type CiArtifact,
  type InternalSharingConnector,
  type InternalSharingKind,
  InternalSharingOutcomeUnknownError,
  readZipEntries,
  StoreError,
  StoreRateLimitError,
} from '@kiln/connectors';
import type { Platform } from '@kiln/core';
import { supports } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { decryptSecret, encryptSecret } from '@kiln/vault';
import { codingOf } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import type { Failure } from '../../services/repositories.ts';
import {
  type BuildsContext,
  type BuildsFailure,
  fail,
  findArtifact,
  guessArtifact,
  openArtifactDownload,
} from './service.ts';

/**
 * Google Play INTERNAL APP SHARING from the Test builds panel (docs/api/internal-sharing.md, docs/adr/0020-play-internal-sharing.md): take
 * the .aab or .apk inside a CI artifact (a zip), upload it to Google Play's internal app sharing with the credential of the app, and
 * keep the install link for a day. A STORE WRITE (a binary leaves this server for Google under the developer's account) that publishes
 * nothing to users, and one this server cannot take back (Google has no delete call for it). Gated like the other store writes:
 *
 * - Off unless `internalSharingEnabled` (KILN_PLAY_INTERNAL_SHARING_ENABLED, default false): `409 internal_sharing_disabled`, no connector.
 * - The role action `builds.share` (owner and admin; a token only when its actions name it), checked by the route; the step-up class
 *   `internal_sharing` (the route calls `requireStepUp`, a token is `step_up_required_human` when the policy covers it).
 * - A preview (what is uploaded, to which package, the checks, a `confirmHash`) and an apply that carries that hash AND the typed phrase
 *   `SHARE <package>`. The artifact is looked at again before anything is read: a different artifact is `409 state_changed`.
 * - One upload in flight per app (`play_internal_share_claims`). Never retried. Google has no call to read an uploaded artifact back, so a
 *   lost answer is `409 outcome_unknown` (reported, cleared by the next preview), never a blind second upload.
 * - The install link is SENSITIVE: it is encrypted with the master key (bound to its row), cleared after 24 hours, returned only by
 *   the apply answer and by the link route (both for `builds.share`), and is never logged, audited or sent in an event. Audit rows hold ids,
 *   a size and hashes; the file name is kept on the row, not in the audit.
 */

type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

export const SHARING_ENV = 'KILN_PLAY_INTERNAL_SHARING_ENABLED';
export const SHARING_PURPOSE = 'builds.share';
/** How long this server keeps a link. Google's own links last longer (60 days, its help page); ours is the short, encrypted copy. */
export const LINK_RETENTION_MS = 24 * 60 * 60_000;
export const DEFAULT_SHARE_TIMEOUT_MS = 10 * 60_000;
/** Longer than the download plus the upload, so a claim is never trusted less than the work it guards can still run. */
export const DEFAULT_SHARE_CLAIM_TTL_MS = 25 * 60_000;
/** Rows are kept (without their link) this long, for the history. */
export const SHARE_HISTORY_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES_LISTED = 20;

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type Failed = BuildsFailure | Failure;

export const sharingDisabledFailure = (): BuildsFailure =>
  fail(
    409,
    'internal_sharing_disabled',
    `Sharing builds through Google Play internal app sharing is switched off on this server. Set ${SHARING_ENV}=true to turn it on (see docs/deployment.md).`,
    { envName: SHARING_ENV },
  );

export const confirmationPhraseOf = (app: Pick<ManagedApp, 'identifier'>) =>
  `SHARE ${app.identifier}`;

// ---------------------------------------------------------------------------------------------
// The claim: one upload in flight per app

type Claim = { appId: string; at: number };
const claimTtl = (ctx: BuildsContext) =>
  ctx.builds.internalSharingClaimTtlMs ?? DEFAULT_SHARE_CLAIM_TTL_MS;

async function takeClaim(
  ctx: BuildsContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | BuildsFailure> {
  const { db } = ctx;
  const claim: Claim = { appId: input.app.id, at: ctx.now() };
  const busy = () =>
    fail(
      409,
      'write_in_progress',
      'A build of this app is being uploaded to Google Play. Wait for it to finish.',
    );
  const insert = () =>
    db.execute(
      "INSERT INTO play_internal_share_claims (app_id, workspace_id, status, claimed_by, claim_at) VALUES (?, ?, 'writing', ?, ?) ON CONFLICT (app_id) DO NOTHING",
      [claim.appId, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM play_internal_share_claims WHERE app_id = ?',
    [claim.appId],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return fail(
      409,
      'outcome_unknown',
      'It is not known whether the last upload of this app reached Google Play (Google has no call to read it back). Preview the share again: that clears this. An extra upload only makes a second link.',
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < claimTtl(ctx)) return busy();
  // An upload that started long ago and never finished (a process died): its outcome is unknown, and an extra upload is harmless.
  const taken = await db.execute(
    "UPDATE play_internal_share_claims SET claim_at = ?, claimed_by = ?, workspace_id = ? WHERE app_id = ? AND status = 'writing' AND claim_at = ?",
    [claim.at, input.actor.id, input.workspaceId, claim.appId, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM play_internal_share_claims WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.at],
  );
const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE play_internal_share_claims SET status = 'unknown' WHERE app_id = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.at],
  );
/** A preview tells the person about the unknown outcome; that settles it (an extra upload is harmless). */
const clearUnknown = (sql: Sql, appId: string) =>
  sql.execute("DELETE FROM play_internal_share_claims WHERE app_id = ? AND status = 'unknown'", [
    appId,
  ]);

type Flight = 'writing' | 'unknown' | null;
async function flightOf(ctx: BuildsContext, appId: string): Promise<Flight> {
  const [row] = await ctx.db.query(
    'SELECT status, claim_at FROM play_internal_share_claims WHERE app_id = ?',
    [appId],
  );
  if (!row) return null;
  if (String(row.status) === 'unknown') return 'unknown';
  return ctx.now() - Number(row.claim_at) < claimTtl(ctx) ? 'writing' : null;
}

// ---------------------------------------------------------------------------------------------
// What is asked, the checks and the confirmation

const ENTRY = /^[^\u0000-\u001f\\]{1,300}\.(aab|apk)$/i;
const isCandidate = (name: string) =>
  /\.(aab|apk)$/i.test(name) &&
  !name.startsWith('__MACOSX/') &&
  !name.split('/').some((p) => p.startsWith('._'));
const kindOfName = (name: string): InternalSharingKind => (/\.aab$/i.test(name) ? 'bundle' : 'apk');
const baseName = (name: string) => name.split('/').pop() ?? name;
const hexDigest = (digest: string | null) =>
  digest && /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : null;

export type ShareCheck = { code: string; severity: 'blocking' | 'warning'; message: string };
export type ShareChecks = { blocking: ShareCheck[]; warnings: ShareCheck[]; canShare: boolean };

/** Pure. */
export function evaluateShareChecks(input: { kind: string; flight: Flight }): ShareChecks {
  const items: ShareCheck[] = [];
  if (input.flight === 'writing')
    items.push({
      code: 'share_in_progress',
      severity: 'blocking',
      message: 'A build of this app is being uploaded to Google Play. Wait for it to finish.',
    });
  if (input.flight === 'unknown')
    items.push({
      code: 'previous_upload_unknown',
      severity: 'warning',
      message:
        'It is not known whether the last upload of this app reached Google Play (Google cannot be asked). Sharing again only makes another link.',
    });
  if (['ipa', 'app', 'dmg', 'pkg'].includes(input.kind))
    items.push({
      code: 'not_an_android_build',
      severity: 'blocking',
      message: 'This artifact looks like an Apple build, not an Android one.',
    });
  if (input.kind === 'other')
    items.push({
      code: 'not_obviously_a_build',
      severity: 'warning',
      message:
        'The name of this artifact does not look like a build (it may be a report). The server looks for an .aab or .apk inside it when you confirm, and refuses if there is none.',
    });
  const blocking = items.filter((i) => i.severity === 'blocking');
  return {
    blocking,
    warnings: items.filter((i) => i.severity === 'warning'),
    canShare: blocking.length === 0,
  };
}

type Subject = {
  workspaceId: string;
  app: ManagedApp;
  artifact: {
    id: string;
    name: string;
    sizeInBytes: number;
    digest: string | null;
    runId: string | null;
    headSha: string | null;
  };
  entry: string | null;
};

/** What the person confirms: this app and package, this artifact exactly as it was listed, and the file inside it if they named one. */
export function shareConfirmHash(s: Subject): string {
  return sha(
    JSON.stringify({
      v: 1,
      workspaceId: s.workspaceId,
      appId: s.app.id,
      package: s.app.identifier,
      artifact: {
        id: s.artifact.id,
        name: s.artifact.name,
        size: s.artifact.sizeInBytes,
        digest: s.artifact.digest,
        runId: s.artifact.runId,
        headSha: s.artifact.headSha,
      },
      entry: s.entry,
    }),
  );
}

export type SharePreview = {
  app: { id: string; name: string; platform: Platform; identifier: string };
  artifact: {
    id: string;
    name: string;
    kind: string;
    sizeBytes: number;
    zipSha256: string | null;
    runId: string | null;
    headSha: string | null;
    createdAt: number | null;
    expiresAt: number | null;
  };
  /** What will be uploaded. `fileName` and `kind` are known from the artifact name or the entry you named; otherwise they are read from the zip when you confirm. */
  upload: {
    packageName: string;
    kind: InternalSharingKind | null;
    fileName: string | null;
    entry: string | null;
    versionCode: null;
    sha256: null;
    maxSizeBytes: number;
  };
  /** What happens and what does not, in words for the person. */
  effects: string[];
  linkRetentionHours: number;
  checks: ShareChecks;
  /** Null while a blocking check stands. */
  confirmHash: string | null;
  /** What the person types to confirm (null while blocked). */
  confirmation: { phrase: string; instruction: string } | null;
  readAt: number;
};

const EFFECTS = [
  'The build file is read out of the artifact and uploaded to Google Play internal app sharing with the Google credential of this app.',
  'Google returns an install link. Anyone Google lets use internal app sharing for this account can install the build with it; the link is a secret, so treat it like one.',
  'Nothing is published to users and no track or release changes. This server cannot delete the uploaded file or the link from Google.',
];

export type ShareInput = {
  workspaceId: string;
  appId: string;
  artifactId: string;
  entry?: string | undefined;
  actor: Actor;
};

function entryOf(entry: string | undefined): { ok: true; entry: string | null } | BuildsFailure {
  if (entry === undefined) return { ok: true, entry: null };
  if (!ENTRY.test(entry) || entry.split('/').includes('..') || entry.startsWith('/'))
    return fail(
      422,
      'invalid_entry',
      'entry is the path of an .aab or .apk file inside the artifact.',
    );
  return { ok: true, entry };
}

async function look(
  ctx: BuildsContext,
  input: ShareInput,
): Promise<
  | {
      ok: true;
      app: ManagedApp;
      found: Extract<Awaited<ReturnType<typeof findArtifact>>, { ok: true }>;
      entry: string | null;
    }
  | Failed
> {
  if (!ctx.builds.internalSharingEnabled) return sharingDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return fail(404, 'not_found');
  if (!supports(app.platform, 'internalAppSharing'))
    return fail(422, 'not_android', 'Google Play internal app sharing is for Android apps.');
  const asked = entryOf(input.entry);
  if (!asked.ok) return asked;
  if (!/^[0-9]{1,20}$/.test(input.artifactId))
    return fail(400, 'invalid_request', 'An artifact id is a number.');
  const found = await findArtifact(
    ctx,
    { workspaceId: input.workspaceId, appId: input.appId, artifactId: input.artifactId },
    input.actor,
  );
  if (!found.ok) return found;
  return { ok: true, app, found, entry: asked.entry };
}

function previewOf(
  ctx: BuildsContext,
  s: {
    workspaceId: string;
    app: ManagedApp;
    artifact: CiArtifact;
    entry: string | null;
    flight: Flight;
  },
): SharePreview {
  const kind = guessArtifact(s.artifact.name, s.app.platform).kind;
  const checks = evaluateShareChecks({ kind, flight: s.flight });
  const named = s.entry ?? /([^/\\]+\.(aab|apk))(\.zip)?$/i.exec(s.artifact.name)?.[1] ?? null;
  const phrase = checks.canShare ? confirmationPhraseOf(s.app) : null;
  return {
    app: { id: s.app.id, name: s.app.name, platform: s.app.platform, identifier: s.app.identifier },
    artifact: {
      id: s.artifact.id,
      name: s.artifact.name,
      kind,
      sizeBytes: s.artifact.sizeInBytes,
      zipSha256: hexDigest(s.artifact.digest),
      runId: s.artifact.runId,
      headSha: s.artifact.headSha,
      createdAt: s.artifact.createdAt,
      expiresAt: s.artifact.expiresAt,
    },
    upload: {
      packageName: s.app.identifier,
      kind: named ? kindOfName(named) : null,
      fileName: named ? baseName(named) : null,
      entry: s.entry,
      versionCode: null,
      sha256: null,
      maxSizeBytes: ctx.builds.maxDownloadBytes,
    },
    effects: EFFECTS,
    linkRetentionHours: LINK_RETENTION_MS / 3_600_000,
    checks,
    confirmHash:
      phrase !== null
        ? shareConfirmHash({
            workspaceId: s.workspaceId,
            app: s.app,
            artifact: s.artifact,
            entry: s.entry,
          })
        : null,
    confirmation:
      phrase !== null
        ? {
            phrase,
            instruction: `Type "${phrase}" to confirm. This uploads the build to Google and cannot be taken back from here.`,
          }
        : null,
    readAt: ctx.now(),
  };
}

/** `POST .../internal-share/preview`: looks at the artifact (GitHub's list, no download) and shows what would be uploaded. Writes nothing. */
export async function previewShare(
  ctx: BuildsContext,
  input: ShareInput,
): Promise<{ ok: true; preview: SharePreview } | Failed> {
  const seen = await look(ctx, input);
  if (!seen.ok) return seen;
  const flight = await flightOf(ctx, seen.app.id);
  // The person has now been told about an unknown outcome: that is all there is to settle (Google cannot be read).
  if (flight === 'unknown') await clearUnknown(ctx.db, seen.app.id);
  const a = seen.found.artifact;
  return {
    ok: true,
    preview: previewOf(ctx, {
      workspaceId: input.workspaceId,
      app: seen.app,
      artifact: a,
      entry: seen.entry,
      flight,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Apply

export type ShareView = {
  id: string;
  appId: string;
  artifactId: string;
  runId: string | null;
  packageName: string;
  kind: InternalSharingKind;
  fileName: string | null;
  sizeBytes: number;
  sha256: string;
  certificateFingerprint: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  /** True while this server still holds the link (24 hours). The link itself is never in a list. */
  hasLink: boolean;
};

export type ShareResult = {
  share: ShareView;
  /** The install link. SENSITIVE: shown to the person who shared, never logged or stored in the clear. */
  downloadUrl: string;
  /** Whether Google's SHA-256 of the file is the one this server computed (null: Google did not say). */
  checksumMatches: boolean | null;
  note: string;
};

const NOTE = `The build was uploaded to Google Play internal app sharing. Open the link on a device whose Google account is allowed to use internal app sharing (Play Console, Setup, Internal app sharing, and "Internal app sharing" turned on in the Play Store app). This server keeps the link for ${LINK_RETENTION_MS / 3_600_000} hours; Google's own links last longer (Google's help page says 60 days; UNVERIFIED in practice).`;

const toView = (row: Record<string, unknown>, now: number): ShareView => ({
  id: String(row.id),
  appId: String(row.app_id),
  artifactId: String(row.artifact_id),
  runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
  packageName: String(row.package_name),
  kind: String(row.file_kind) === 'apk' ? 'apk' : 'bundle',
  fileName: row.file_name === null || row.file_name === undefined ? null : String(row.file_name),
  sizeBytes: Number(row.size_bytes),
  sha256: String(row.sha256),
  certificateFingerprint:
    row.certificate_fingerprint === null || row.certificate_fingerprint === undefined
      ? null
      : String(row.certificate_fingerprint),
  createdBy: String(row.created_by),
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
  hasLink: row.url_secret !== null && row.url_secret !== undefined && Number(row.expires_at) > now,
});

async function auditFailed(
  ctx: BuildsContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  artifactId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'build.share_failed',
    target: { type: 'app', id: app.id },
    // Ids, a code and an outcome: never a link, a file name, a credential or a Google response.
    detail: { appId: app.id, artifactId, hash: input.confirmHash, ...extra },
    at: ctx.now(),
  });
}

class ShareTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: BuildsContext,
  input: { secret: string; packageName: string },
  job: (connector: InternalSharingConnector) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (target, init) =>
    baseFetch(target, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ShareTimeout('timeout'));
    }, ctx.builds.internalSharingTimeoutMs ?? DEFAULT_SHARE_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.builds.internalSharingConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The vocabulary of a refused upload. Everything here means Google stored nothing. */
export function mapShareError(error: unknown, secret: string): BuildsFailure {
  const clean = (m: string) => (secret ? m.split(secret).join('[redacted]') : m).slice(0, 500);
  if (error instanceof StoreRateLimitError) {
    return {
      ...fail(429, 'rate_limited', clean(error.message), {
        retryAfterSeconds: error.retryAfterSeconds,
        ...codingOf(error),
      }),
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    };
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
        return fail(422, 'store_auth', clean(error.message), codingOf(error));
      case 'forbidden':
      case 'api_disabled':
      case 'unsupported':
        return fail(422, 'store_forbidden', clean(error.message), codingOf(error));
      case 'not_found':
        return fail(422, 'store_not_found', clean(error.message), codingOf(error));
      case 'too_large':
        return fail(413, 'artifact_too_large', clean(error.message), codingOf(error));
      case 'invalid_input':
        return fail(422, 'artifact_rejected', clean(error.message), codingOf(error));
      default:
        return fail(
          error.status !== undefined && error.status >= 400 && error.status < 500 ? 422 : 502,
          'store_rejected',
          clean(error.message),
          codingOf(error),
        );
    }
  }
  return fail(
    502,
    'upload_failed',
    'The upload to Google Play failed. Nothing was stored that this server knows of.',
  );
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The file to upload out of the zip, or why there is none. Entry names are shown only for this caller's own artifact. */
async function fileOf(
  zip: Uint8Array,
  wanted: string | null,
  max: number,
): Promise<{ ok: true; name: string; bytes: Uint8Array } | BuildsFailure> {
  const limits = { maxEntries: 5000, maxEntryBytes: max, maxTotalBytes: max };
  try {
    const names: string[] = [];
    await readZipEntries(
      zip,
      (name) => {
        if (isCandidate(name)) names.push(name);
        return false;
      },
      limits,
    );
    if (wanted !== null) {
      if (!names.includes(wanted))
        return fail(422, 'entry_not_found', 'That file is not in the artifact.', {
          entries: names.slice(0, MAX_ENTRIES_LISTED),
        });
    } else if (names.length === 0) {
      return fail(422, 'no_android_build', 'There is no .aab or .apk file in this artifact.');
    } else if (names.length > 1) {
      return fail(
        422,
        'entry_required',
        'This artifact holds more than one build file. Name the one to share (preview again with `entry`).',
        { entries: names.slice(0, MAX_ENTRIES_LISTED), entryCount: names.length },
      );
    }
    const chosen = wanted ?? (names[0] as string);
    const [entry] = await readZipEntries(zip, (name) => name === chosen, limits);
    if (!entry)
      return fail(422, 'no_android_build', 'There is no .aab or .apk file in this artifact.');
    return { ok: true, name: chosen, bytes: entry.bytes };
  } catch (error) {
    if (error instanceof AnalyticsError && error.code === 'file_too_large')
      return fail(
        413,
        'artifact_too_large',
        'The file inside the artifact is larger than the limit.',
        { maxBytes: max },
      );
    return fail(422, 'bad_zip', 'The artifact could not be read as a zip file.');
  }
}

/**
 * `POST .../internal-share`: checks the switch, the typed phrase, that the artifact is still the one previewed and that nothing blocks,
 * takes the claim, reads the zip, uploads the file ONCE and keeps the encrypted link. See the file comment. Never retried.
 */
export async function applyShare(
  ctx: BuildsContext,
  input: ShareInput & { confirmHash: string; confirmation: string },
): Promise<{ ok: true; result: ShareResult } | Failed> {
  if (!ctx.builds.internalSharingEnabled) return sharingDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return fail(404, 'not_found');
  if (!supports(app.platform, 'internalAppSharing'))
    return fail(422, 'not_android', 'Google Play internal app sharing is for Android apps.');
  const phrase = confirmationPhraseOf(app);
  if (input.confirmation.trim() !== phrase) {
    await auditFailed(ctx, input, app, input.artifactId, {
      code: 'confirmation_mismatch',
      outcome: 'refused',
    });
    return fail(
      422,
      'confirmation_mismatch',
      `The confirmation does not match. Type "${phrase}" exactly. Nothing was uploaded.`,
      { phrase },
    );
  }
  const seen = await look(ctx, input);
  if (!seen.ok) return seen;
  const artifact = seen.found.artifact;
  const flight = await flightOf(ctx, app.id);
  const checks = evaluateShareChecks({
    kind: guessArtifact(artifact.name, app.platform).kind,
    flight: flight === 'unknown' ? null : flight,
  });
  if (!checks.canShare) {
    await auditFailed(ctx, input, app, artifact.id, {
      code: 'blocked',
      outcome: 'refused',
      blocking: checks.blocking.map((b) => b.code),
    });
    return fail(
      409,
      'blocked',
      'Something stands in the way of sharing, so nothing was uploaded. See `checks`.',
      { checks },
    );
  }
  if (
    shareConfirmHash({ workspaceId: input.workspaceId, app, artifact, entry: seen.entry }) !==
    input.confirmHash
  ) {
    await auditFailed(ctx, input, app, artifact.id, { code: 'state_changed', outcome: 'refused' });
    return fail(
      409,
      'state_changed',
      'The artifact changed since this was previewed, so nothing was uploaded. Review the new preview and confirm it.',
      {
        preview: previewOf(ctx, {
          workspaceId: input.workspaceId,
          app,
          artifact,
          entry: seen.entry,
          flight,
        }),
      },
    );
  }

  const taken = await takeClaim(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  let unknown = false;
  try {
    // ----- the credential of the app
    const [credential] = await db.query(
      'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
      [app.credentialId, input.workspaceId],
    );
    if (!credential)
      return fail(422, 'credential_not_found', 'The credential of this app no longer exists.');
    if (String(credential.kind) !== 'google_play')
      return fail(
        422,
        'credential_kind',
        "This app's credential is not a Google Play service account.",
      );
    let secret: string | undefined;
    try {
      secret = await useCredentialSecret(
        db,
        ctx.masterKey,
        { workspaceId: input.workspaceId, id: app.credentialId, purpose: SHARING_PURPOSE },
        input.actor,
        ctx.now(),
      );
    } catch {
      return fail(
        422,
        'credential_unreadable',
        'The credential could not be decrypted. Enter its secret again.',
      );
    }
    if (secret === undefined)
      return fail(422, 'credential_not_found', 'The credential of this app no longer exists.');

    // ----- the zip, through the same guards as a download (size cap, time cap, rate limit, audited as a download)
    const opened = await openArtifactDownload(
      ctx,
      { workspaceId: input.workspaceId, appId: app.id, artifactId: artifact.id, via: 'share' },
      input.actor,
    );
    if (!opened.ok) {
      await auditFailed(ctx, input, app, artifact.id, {
        code: opened.body.error,
        outcome: 'failed',
        step: 'download',
      });
      return opened;
    }
    let zip: Uint8Array;
    try {
      zip = await readAll(opened.body);
    } catch (error) {
      const tooLarge =
        error instanceof Error && /larger than the download limit/.test(error.message);
      await auditFailed(ctx, input, app, artifact.id, {
        code: tooLarge ? 'artifact_too_large' : 'download_failed',
        outcome: 'failed',
        step: 'download',
      });
      return tooLarge
        ? fail(413, 'artifact_too_large', 'This artifact is larger than the download limit.', {
            maxBytes: ctx.builds.maxDownloadBytes,
          })
        : fail(
            502,
            'download_failed',
            'The artifact could not be downloaded from GitHub. Nothing was uploaded.',
          );
    }
    const file = await fileOf(zip, seen.entry, ctx.builds.maxDownloadBytes);
    if (!file.ok) {
      await auditFailed(ctx, input, app, artifact.id, {
        code: file.body.error,
        outcome: 'refused',
        step: 'extract',
      });
      return file;
    }
    const kind = kindOfName(file.name);
    const fileSha = createHash('sha256').update(file.bytes).digest('hex');

    // ----- the upload: once
    let uploaded: Awaited<ReturnType<InternalSharingConnector['upload']>> | undefined;
    try {
      uploaded = await withConnector(ctx, { secret, packageName: app.identifier }, (connector) =>
        connector.upload(kind, file.bytes),
      );
    } catch (error) {
      if (error instanceof InternalSharingOutcomeUnknownError || error instanceof ShareTimeout) {
        unknown = true;
        await markUnknown(db, claim);
        await auditFailed(ctx, input, app, artifact.id, {
          code: error instanceof ShareTimeout ? 'timeout' : 'network',
          outcome: 'unknown',
          kind,
          sizeBytes: file.bytes.byteLength,
          fileSha256: fileSha,
        });
        return fail(
          409,
          'outcome_unknown',
          'It is not known whether Google Play stored the build: it did not answer, and Google has no call to read an uploaded build back. Nothing was retried. Preview the share again to clear this; sharing again only makes another link.',
        );
      }
      const mapped = mapShareError(error, secret);
      await auditFailed(ctx, input, app, artifact.id, {
        code: mapped.body.error,
        outcome: 'failed',
        kind,
        sizeBytes: file.bytes.byteLength,
      });
      return mapped;
    }

    // ----- keep the link, encrypted
    const at = ctx.now();
    const id = randomUUID();
    const fileName = baseName(file.name).slice(0, 200);
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO play_internal_shares (id, workspace_id, app_id, artifact_id, run_id, package_name, file_kind, file_name, size_bytes, sha256, certificate_fingerprint, url_secret, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.workspaceId,
          app.id,
          artifact.id,
          artifact.runId,
          app.identifier,
          kind,
          fileName,
          file.bytes.byteLength,
          fileSha,
          uploaded.certificateFingerprint,
          encryptSecret(uploaded.downloadUrl, ctx.masterKey, shareAad(input.workspaceId, id)),
          input.actor.id,
          at,
          at + LINK_RETENTION_MS,
        ],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'build.shared',
        target: { type: 'app', id: app.id },
        // Ids, a kind, a size and hashes: never the link, the file name, a credential or a Google response.
        detail: {
          appId: app.id,
          artifactId: artifact.id,
          shareId: id,
          kind,
          sizeBytes: file.bytes.byteLength,
          fileSha256: fileSha,
          hash: input.confirmHash,
        },
        at,
      });
    });
    const share: ShareView = {
      id,
      appId: app.id,
      artifactId: artifact.id,
      runId: artifact.runId,
      packageName: app.identifier,
      kind,
      fileName,
      sizeBytes: file.bytes.byteLength,
      sha256: fileSha,
      certificateFingerprint: uploaded.certificateFingerprint,
      createdBy: input.actor.id,
      createdAt: at,
      expiresAt: at + LINK_RETENTION_MS,
      hasLink: true,
    };
    return {
      ok: true,
      result: {
        share,
        downloadUrl: uploaded.downloadUrl,
        checksumMatches: uploaded.sha256 === null ? null : uploaded.sha256 === fileSha,
        note: NOTE,
      },
    };
  } finally {
    if (!unknown) await releaseClaim(db, claim);
  }
}

// ---------------------------------------------------------------------------------------------
// The record: lists without links, and the link for a caller who may read it

const shareAad = (workspaceId: string, id: string) => `internal-share:${workspaceId}:${id}`;

/** Links past their time are cleared (the row stays, without the secret); rows older than 30 days go. */
async function tidy(ctx: BuildsContext): Promise<void> {
  const now = ctx.now();
  await ctx.db.execute(
    'UPDATE play_internal_shares SET url_secret = NULL WHERE url_secret IS NOT NULL AND expires_at <= ?',
    [now],
  );
  await ctx.db.execute('DELETE FROM play_internal_shares WHERE created_at < ?', [
    now - SHARE_HISTORY_MS,
  ]);
}

export type ShareState = {
  enabled: boolean;
  inFlight: boolean;
  unknownOutcome: boolean;
  shares: ShareView[];
};

/** `GET .../internal-shares`: the shares of an app, newest first, WITHOUT their links. */
export async function listShares(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; state: ShareState } | Failed> {
  if (!ctx.builds.internalSharingEnabled) return sharingDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return fail(404, 'not_found');
  await tidy(ctx);
  const rows = await ctx.db.query(
    'SELECT * FROM play_internal_shares WHERE workspace_id = ? AND app_id = ? ORDER BY created_at DESC, id LIMIT 20',
    [input.workspaceId, input.appId],
  );
  const flight = await flightOf(ctx, app.id);
  const now = ctx.now();
  return {
    ok: true,
    state: {
      enabled: true,
      inFlight: flight === 'writing',
      unknownOutcome: flight === 'unknown',
      shares: rows.map((r) => toView(r, now)),
    },
  };
}

/** `GET .../internal-shares/{id}/link`: the install link, for a caller who may share. Audited with ids only. */
export async function readShareLink(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string; shareId: string; actor: Actor },
): Promise<{ ok: true; downloadUrl: string; expiresAt: number } | Failed> {
  if (!ctx.builds.internalSharingEnabled) return sharingDisabledFailure();
  await tidy(ctx);
  const [row] = await ctx.db.query(
    'SELECT id, app_id, url_secret, expires_at FROM play_internal_shares WHERE id = ? AND workspace_id = ? AND app_id = ?',
    [input.shareId, input.workspaceId, input.appId],
  );
  if (!row) return fail(404, 'not_found');
  if (!row.url_secret || Number(row.expires_at) <= ctx.now())
    return fail(
      410,
      'link_expired',
      `This server keeps a link for ${LINK_RETENTION_MS / 3_600_000} hours. Share the build again to get a new one.`,
    );
  let downloadUrl: string;
  try {
    downloadUrl = decryptSecret(
      String(row.url_secret),
      ctx.masterKey,
      shareAad(input.workspaceId, input.shareId),
    );
  } catch {
    return fail(
      410,
      'link_unreadable',
      'The stored link could not be read. Share the build again.',
    );
  }
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'build.share_link_read',
    target: { type: 'app', id: input.appId },
    detail: { appId: input.appId, shareId: input.shareId },
    at: ctx.now(),
  });
  return { ok: true, downloadUrl, expiresAt: Number(row.expires_at) };
}

export type SharingConfig = {
  enabled: boolean;
  envName: string;
  action: 'builds.share';
  minimumRole: 'admin';
  stepUpClass: 'internal_sharing';
  linkRetentionHours: number;
  maxBytes: number;
  /** Whether the caller's role may share. */
  canShare: boolean;
  note: string;
};

export const sharingConfig = (ctx: BuildsContext, canShare: boolean): SharingConfig => ({
  enabled: ctx.builds.internalSharingEnabled,
  envName: SHARING_ENV,
  action: 'builds.share',
  minimumRole: 'admin',
  stepUpClass: 'internal_sharing',
  linkRetentionHours: LINK_RETENTION_MS / 3_600_000,
  maxBytes: ctx.builds.maxDownloadBytes,
  canShare,
  note: 'Uploads an Android build from a CI artifact to Google Play internal app sharing and returns an install link. It publishes nothing to users and cannot be taken back from here (docs/api/internal-sharing.md).',
});
