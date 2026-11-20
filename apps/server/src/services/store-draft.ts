import { createHash } from 'node:crypto';
import {
  AppleDraftConnector,
  appleScope,
  connectorFactory,
  type DraftApplyResult,
  type DraftAssetWrite,
  DraftDriftError,
  type DraftFieldState,
  type DraftFieldWrite,
  type DraftFile,
  DraftOutcomeUnknownError,
  DraftPartialError,
  type DraftReadRequest,
  type DraftState,
  type DraftStep,
  type DraftTextWrite,
  draftKey,
  type EditableRelease,
  isStoreImageReader,
  isStoreNotesHistoryReader,
  isStoreReleaseReader,
  type NotesHistoryRead,
  PlayDraftConnector,
  type ReleaseCandidates,
  redactSecrets,
  type StoreConnectorInput,
  type StoreDraftConnector,
  StoreError,
  type StoreImagesRead,
  StoreRateLimitError,
  sameDraftState,
  secretStrings,
  setMatches,
} from '@mrm/connectors';
import {
  type AssetSlot,
  byFamily,
  isReleaseFieldId,
  LOCAL_ONLY_RELEASE_FIELDS,
  needsStoreAppId,
  type Platform,
  RELEASE_FIELD_SPECS,
  STAGED_LIMITS,
  slotKey,
  sniffImageFormat,
  storeFamilyOf,
  supports,
  versionCodesOf,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { type AssetsContext, openAssets } from '../modules/listing/asset-repo.ts';
import { normalizeListingValue } from '../modules/listing/drift.ts';
import { storeFor } from '../modules/reviews/sync.ts';
import { credentialKindFor, getApp, type ManagedApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { useCredentialSecret } from './credentials.ts';
import { emitEvent } from './events.ts';
import { type Failure, failure } from './repositories.ts';
import { getBlob } from './staged-asset-blobs.ts';
import {
  assetSetsOf,
  buildStagedView,
  loadStagedRows,
  type StagedRow,
  stagedKey,
  storeTargetOf,
} from './staged-changes.ts';
import { type ReleaseCheck, releaseFieldChecks } from './staged-release.ts';
import { fileEntry, type PushedManifest, recordPush, textEntry } from './store-draft-record.ts';

/**
 * Writing staged listing text and graphics into a store as a DRAFT: a STORE WRITE. The design copies
 * review replies and rollout changes (docs/adr/0007-review-replies.md, docs/adr/0008-store-rollout-writes.md)
 * and is written down in docs/adr/0009-staged-store-drafts.md and docs/api/staged-changes.md:
 *
 * - Off unless `draftEnabled` (MRM_STORE_DRAFT_WRITE_ENABLED): every function here answers
 *   `409 store_draft_disabled` and no connector is ever built.
 * - A DRAFT, never a submission. App Store: the editable version's localizations and screenshots.
 *   Google Play: an edit committed with `changesNotSentForReview=true`. Nothing here submits for review,
 *   sends changes for review, creates a version or publishes; no function of this file or of the
 *   connectors can (the connector interface has no such method). Submitting is a separate gated step
 *   (services/store-submit.ts, docs/adr/0010-store-submit.md); a successful push only RECORDS what it wrote
 *   (`store_draft_pushes`, hashes and ids) so that step can check the store against it.
 * - Preview, then apply. The preview reads the store's draft and the bytes of the staged files, and
 *   returns per item before and after with `confirmHash`: a SHA-256 over the app, the staged items
 *   (text hashes, blob ids) and the draft that was read. Apply needs the hash and RE-READS the draft
 *   right before the first write (the guard of the connector): a different draft, or different staged
 *   items, write nothing (`409 state_changed`, with a new preview).
 * - One write in flight per app and platform (`store_draft_claims`, in the database, so it holds across
 *   processes; a claim older than the time to live is not trusted, the re-read and the hash refuse a
 *   repeat).
 * - Never retried. A lost answer or a 5xx may mean the store applied (part of) it: the draft is read
 *   back. It shows what was asked: success (`confirmedByReread`). It shows the old draft: Apple
 *   `not_applied` (502), Google Play unknown (a commit can be slow to show). Neither: `draft_partial`.
 *   Unreadable: `outcome_unknown`, which blocks writing until a preview (a successful read).
 * - Bytes come from the repository's clone, through the asset index (a staged path must be a file the index
 *   lists at the staged commit, so nothing outside the listing target's folders is read), are checked
 *   against the staged git blob id, sniffed (png or jpeg) and capped (8 MiB a file, 100 files and
 *   64 MiB a push). They are never logged, audited or kept.
 * - Audit (`listing.draft_pushed`, `listing.draft_push_failed`) and the event `listing.draft_pushed`
 *   hold ids, counts, hashes and outcomes. Never a text, a credential, a token, an upload address or a
 *   store response body.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const DRAFT_ENV = 'MRM_STORE_DRAFT_WRITE_ENABLED';
export const DRAFT_PURPOSE = 'store.draft_push';
/** A whole push, uploads included. Longer than a rollout change: screenshots are uploaded and processed. */
export const DEFAULT_DRAFT_TIMEOUT_MS = 240_000;
/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
export const DEFAULT_DRAFT_CLAIM_TTL_MS = 300_000;

const FIELDS_NOTE = {
  apple:
    'Release fields change the editable App Store version right away (the version string, release type, release date, copyright and build in one request; the phased release in its own). Releasing the approved version is a separate, gated step (docs/api/releases-write.md).',
  google:
    'The draft release of the track is written in the same edit and held back with the rest. The intended rollout share is kept here only: Google Play cannot hold a share in a draft. Starting the release is a separate, gated step (docs/api/releases-write.md).',
} as const;

const DRAFT_NOTE =
  'This is a draft only. Nothing was submitted for review or published: do that in App Store Connect or Play Console.';

// ---------------------------------------------------------------------------------------------
// Context

export type DraftConnectorInput = StoreConnectorInput;
export type DraftConnectorFactory = (input: DraftConnectorInput) => StoreDraftConnector;

export const defaultDraftConnectorFactory: DraftConnectorFactory =
  connectorFactory<StoreDraftConnector>({
    app_store_connect: (input) =>
      AppleDraftConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        platform: appleScope(input),
        fetch: input.fetch,
      }),
    google_play: (input) =>
      new PlayDraftConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export type DraftContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_STORE_DRAFT_WRITE_ENABLED. */
  draftEnabled: boolean;
  draftConnectorFactory: DraftConnectorFactory;
  /** Reads the bytes of the staged files (the asset index of the repository). */
  assets: AssetsContext;
  draftTimeoutMs?: number;
  claimTtlMs?: number;
};

/** What reaching a store needs: the same for a push and for the reads that only look. */
export type StoreConnectContext = Pick<
  DraftContext,
  'db' | 'masterKey' | 'now' | 'draftConnectorFactory' | 'draftTimeoutMs'
>;

// ---------------------------------------------------------------------------------------------
// Failures

const disabled = (): Failure =>
  failure(
    409,
    'store_draft_disabled',
    `Writing drafts to the stores is switched off on this server. Set ${DRAFT_ENV}=true to turn it on (see docs/deployment.md).`,
    {
      envName: DRAFT_ENV,
    },
  );
/** The `409 store_draft_disabled` answer, for routes that check the kill switch before anything else. */
export const draftDisabledFailure = disabled;

const clean = (text: string, secret: string) =>
  redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, 500);

export type Mapped = { failure: Failure; code: string };

/** A store refusal as an answer to the person. Everything here means nothing was changed (see `DraftPartialError` for the rest). */
export function mapStoreError(error: unknown, secret: string): Mapped {
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Mapped => ({
    code,
    failure: {
      ...failure(status, code, clean(message, secret), extra),
      ...(headers ? { headers } : {}),
    },
  });
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return make(
      429,
      'rate_limited',
      error.message,
      { retryAfterSeconds: wait },
      { 'Retry-After': String(wait) },
    );
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
        return make(422, 'store_auth', error.message);
      case 'forbidden':
      case 'api_disabled':
      case 'unsupported':
        return make(422, 'store_forbidden', error.message);
      case 'not_found':
        return make(422, 'store_not_found', error.message);
      case 'no_editable_version':
        return make(422, 'no_editable_version', error.message);
      case 'draft_not_allowed':
        return make(409, 'draft_not_allowed', error.message);
      case 'invalid_input':
        return make(422, 'store_rejected', error.message);
      case 'changes_in_review':
        return make(409, 'changes_in_review', error.message);
      case 'server':
      case 'network':
      case 'edit_invalid':
        return make(502, 'store_unavailable', `${error.message} Nothing was changed.`);
      default:
        return make(
          error.status !== undefined && error.status >= 400 && error.status < 500 ? 422 : 502,
          'store_rejected',
          error.message,
        );
    }
  }
  return make(
    502,
    'write_failed',
    'The draft could not be written. Nothing was changed that this server knows of.',
  );
}

class DraftTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: StoreConnectContext,
  input: Omit<DraftConnectorInput, 'fetch'>,
  job: (connector: StoreDraftConnector) => Promise<T>,
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
      reject(new DraftTimeout('timeout'));
    }, ctx.draftTimeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.draftConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The claim: one write in flight per app and platform

type Claim = { appId: string; platform: Platform; at: number };

async function takeClaim(
  ctx: DraftContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_DRAFT_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A draft push for this app is in progress. Wait for it to finish.',
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, 'push_draft', 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM store_draft_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last draft push of this app reached the store. Preview the push again: that reads the store and shows where it stands. Nothing is written until you confirm a new preview.',
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A write that started long ago and never finished (a process died): its outcome is unknown, so it is
  // not trusted, but the re-read and the hash refuse a push that no longer fits the store's draft.
  const taken = await db.execute(
    `UPDATE store_draft_claims SET claim_at = ?, claimed_by = ?, workspace_id = ?
      WHERE app_id = ? AND platform = ? AND status = 'writing' AND claim_at = ?`,
    [claim.at, input.actor.id, input.workspaceId, claim.appId, claim.platform, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_draft_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );

const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE store_draft_claims SET status = 'unknown' WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );

/** A successful read of the store settles an unknown outcome: the person sees where things stand. */
const clearUnknown = (sql: Sql, app: ManagedApp) =>
  sql.execute(
    "DELETE FROM store_draft_claims WHERE app_id = ? AND platform = ? AND status = 'unknown'",
    [app.id, app.platform],
  );

// ---------------------------------------------------------------------------------------------
// Connection

export type Connection = { input: Omit<DraftConnectorInput, 'fetch'>; secret: string };

/** Looks the credential up and decrypts it for one use (audited as `credential.use` with `purpose`). Also used by services/store-version.ts. */
export async function connect(
  ctx: Pick<StoreConnectContext, 'db' | 'masterKey' | 'now'>,
  workspaceId: string,
  app: ManagedApp,
  actor: Actor,
  purpose: string = DRAFT_PURPOSE,
): Promise<{ ok: true; connection: Connection } | Failure> {
  const [credential] = await ctx.db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential)
    return failure(422, 'credential_not_found', 'The credential of this app no longer exists.');
  if (String(credential.kind) !== credentialKindFor[app.platform])
    return failure(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
    );
  if (needsStoreAppId(app.platform) && !app.storeAppId)
    return failure(
      422,
      'app_not_synced',
      'The App Store id of this app is not known yet. Sync the app first.',
    );
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined)
    return failure(422, 'credential_not_found', 'The credential of this app no longer exists.');
  return {
    ok: true,
    connection: {
      secret,
      input: {
        kind: credentialKindFor[app.platform],
        secret,
        identifier: app.identifier,
        storeAppId: app.storeAppId,
        platform: app.platform,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the store's images (never a write, so not behind the draft switch)

export const IMAGES_PURPOSE = 'store.images_read';

/**
 * The images the store holds for the app: for the App Store the version the draft push would edit (or the live one), for
 * Google Play the live listing. Reads with the credential of the app (audited as `credential.use`, purpose
 * `store.images_read`) and changes nothing. The connector is the same one a push uses, so a fake stands in for it in tests.
 */
export async function readStoreImagesOf(
  ctx: DraftContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; read: StoreImagesRead } | Failure> {
  const connected = await connect(ctx, input.workspaceId, input.app, input.actor, IMAGES_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  const { app } = input;
  try {
    const read = await withConnector(ctx, connection.input, async (connector) => {
      if (!isStoreImageReader(connector))
        throw new StoreError(
          storeFor(app.platform),
          'unsupported',
          'This store connection cannot read images.',
        );
      return connector.readStoreImages();
    });
    return { ok: true, read };
  } catch (error) {
    if (error instanceof DraftTimeout)
      return failure(504, 'timeout', 'The store did not answer in time.');
    return mapStoreError(error, connection.secret).failure;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading what a release draft is made of (never a write, so not behind the draft switch)

export const RELEASE_READ_PURPOSE = 'store.release_read';

/**
 * The processed builds of the app (App Store, the macOS ones for a macOS app) or the uploaded version codes with where a track
 * uses them (Google Play, the track is required). Reads with the credential of the app (audited as `credential.use`, purpose
 * `store.release_read`), changes nothing. The connector is the one a push uses, so a fake stands in for it in tests.
 */
export async function readReleaseCandidatesOf(
  ctx: StoreConnectContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    actor: Actor;
    version?: string | undefined;
    track?: string | undefined;
  },
): Promise<{ ok: true; read: ReleaseCandidates } | Failure> {
  const { app } = input;
  if (
    supports(app.platform, 'releaseTracks') &&
    (input.track === undefined || input.track === '')
  ) {
    return failure(422, 'track_required', 'Name the track (for example production).');
  }
  const connected = await connect(ctx, input.workspaceId, app, input.actor, RELEASE_READ_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  try {
    const read = await withConnector(ctx, connection.input, async (connector) => {
      if (!isStoreReleaseReader(connector))
        throw new StoreError(
          storeFor(app.platform),
          'unsupported',
          'This store connection cannot read builds or version codes.',
        );
      return connector.listReleaseCandidates({
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.track !== undefined ? { track: input.track } : {}),
      });
    });
    return { ok: true, read };
  } catch (error) {
    if (error instanceof DraftTimeout)
      return failure(504, 'timeout', 'The store did not answer in time.');
    return mapStoreError(error, connection.secret).failure;
  }
}

/**
 * The "what is new" texts of earlier versions in the store (App Store: the newest versions; Google Play: the releases the tracks
 * hold now). Reads with the credential of the app (audited as `credential.use`, purpose `store.release_read`), changes nothing. The
 * texts go to the caller only: they are never logged and never audited.
 */
export async function readNotesHistoryOf(
  ctx: StoreConnectContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor; locale?: string | undefined },
): Promise<{ ok: true; read: NotesHistoryRead } | Failure> {
  const { app } = input;
  const connected = await connect(ctx, input.workspaceId, app, input.actor, RELEASE_READ_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  try {
    const read = await withConnector(ctx, connection.input, async (connector) => {
      if (!isStoreNotesHistoryReader(connector))
        throw new StoreError(
          storeFor(app.platform),
          'unsupported',
          'This store connection cannot read earlier release notes.',
        );
      return connector.readNotesHistory(input.locale !== undefined ? { locale: input.locale } : {});
    });
    return { ok: true, read };
  } catch (error) {
    if (error instanceof DraftTimeout)
      return failure(504, 'timeout', 'The store did not answer in time.');
    return mapStoreError(error, connection.secret).failure;
  }
}

/** The release fields the store holds for the editable App Store version, or for the draft release of a Google Play track. */
export async function readEditableReleaseOf(
  ctx: StoreConnectContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor; track?: string | undefined },
): Promise<{ ok: true; read: EditableRelease } | Failure> {
  const { app } = input;
  if (
    supports(app.platform, 'releaseTracks') &&
    (input.track === undefined || input.track === '')
  ) {
    return failure(422, 'track_required', 'Name the track (for example production).');
  }
  const connected = await connect(ctx, input.workspaceId, app, input.actor, RELEASE_READ_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  try {
    const read = await withConnector(ctx, connection.input, async (connector) => {
      if (!isStoreReleaseReader(connector))
        throw new StoreError(
          storeFor(app.platform),
          'unsupported',
          'This store connection cannot read the release fields.',
        );
      return connector.readEditableRelease(input.track !== undefined ? { track: input.track } : {});
    });
    return { ok: true, read };
  } catch (error) {
    if (error instanceof DraftTimeout)
      return failure(504, 'timeout', 'The store did not answer in time.');
    return mapStoreError(error, connection.secret).failure;
  }
}

// ---------------------------------------------------------------------------------------------
// What is to be written: the staged rows, with the bytes of the files

type PreparedSet = {
  locale: string;
  slot: AssetSlot;
  key: string;
  /** The store's own name of the set. */
  target: string;
  rows: StagedRow[];
  files: DraftFile[];
};
type Prepared = {
  rows: StagedRow[];
  texts: DraftTextWrite[];
  sets: PreparedSet[];
  /** The release fields to write (docs/api/releases-write.md). The intended Play share (`user_fraction`) stays here: a draft cannot hold it. */
  fields: DraftFieldWrite[];
};

const md5Hex = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const sha256Bytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** A file name the store shows: no path, no odd characters. */
const fileNameOf = (path: string, ordinal: number): string => {
  const base = (path.split('/').pop() ?? '').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100);
  return base === '' || base === '.' || base === '..' ? `image-${ordinal + 1}.png` : base;
};

const assetFailure = (status: number, message: string): Failure =>
  failure(
    status === 429 || status === 504
      ? status
      : status === 404 || status === 413 || status === 422
        ? 422
        : 502,
    'asset_unreadable',
    message,
  );

/**
 * The staged items of the app with the bytes of their files. Reads only the paths the asset index lists
 * at the staged commit; every file is held to the staged blob id and the caps. Nothing is sent to a store.
 */
async function prepare(
  ctx: DraftContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; prepared: Prepared } | Failure> {
  const { app } = input;
  const rows = await loadStagedRows(ctx.db, input.workspaceId, app.id);
  if (rows.length === 0) return failure(422, 'nothing_staged', 'Nothing is staged for this app.');
  const view = await buildStagedView(ctx, input.workspaceId, app, rows);
  if (!view.valid) {
    const errors = [
      ...view.text.flatMap((t) =>
        t.problems
          .filter((p) => p.severity === 'error')
          .map((p) => ({ item: `${t.locale}/${t.field}`, code: p.code, message: p.message })),
      ),
      ...view.assets.flatMap((a) =>
        a.problems
          .filter((p) => p.severity === 'error')
          .map((p) => ({ item: a.id, code: p.code, message: p.message })),
      ),
      ...(view.release ?? []).flatMap((r) =>
        r.problems
          .filter((p) => p.severity === 'error')
          .map((p) => ({
            item: `${r.field}${r.locale ? `/${r.locale}` : ''}`,
            code: p.code,
            message: p.message,
          })),
      ),
    ];
    return failure(
      422,
      'staged_invalid',
      'Some staged items have errors. Fix or remove them first.',
      { problems: errors.slice(0, 30), total: errors.length },
    );
  }
  const texts: DraftTextWrite[] = rows
    .filter((r) => r.kind === 'listing_text')
    .map((r) => ({ locale: r.locale, field: r.target, value: r.valueText ?? '' }));
  const fields: DraftFieldWrite[] = rows
    .filter(
      (r) =>
        r.kind === 'release_field' &&
        isReleaseFieldId(r.target) &&
        !LOCAL_ONLY_RELEASE_FIELDS.includes(r.target),
    )
    .map((r) => ({ field: r.target, locale: r.locale, value: r.valueText ?? '' }));
  const sets: PreparedSet[] = [];
  const planned = assetSetsOf(rows);
  let total = 0;
  let count = 0;
  for (const set of planned) {
    const first = set.rows[0] as StagedRow;
    const target = storeTargetOf(app.platform, set.slot, {
      width: first.assetWidth,
      height: first.assetHeight,
    });
    if (target === undefined)
      return failure(422, 'staged_invalid', 'A staged set has no store name.', { item: set.key });
    sets.push({
      locale: set.locale,
      slot: set.slot,
      key: slotKey(set.slot),
      target,
      rows: set.rows,
      files: [],
    });
    for (const r of set.rows) {
      count++;
      total += r.assetBytes ?? 0;
    }
  }
  if (count > STAGED_LIMITS.maxAssetFilesPerPush || total > STAGED_LIMITS.maxAssetBytesPerPush) {
    return failure(422, 'staged_invalid', 'The staged files are more than one push can upload.', {
      limit: STAGED_LIMITS.maxAssetFilesPerPush,
      actual: count,
    });
  }
  // One read of the index per commit the files were staged at.
  const byCommit = new Map<string, PreparedSet[]>();
  for (const set of sets) {
    for (const r of set.rows) {
      if (r.source === 'local') continue;
      const list = byCommit.get(r.assetCommit ?? '') ?? [];
      if (!list.includes(set)) list.push(set);
      byCommit.set(r.assetCommit ?? '', list);
    }
  }
  let read = 0;
  // Images uploaded or fixed in the app: their bytes are kept here, held to the staged blob id like a repository file.
  for (const set of sets) {
    for (const r of set.rows) {
      if (r.source !== 'local') continue;
      const name = (r.assetPath ?? '').split('/').pop() ?? '';
      const blob = await getBlob(ctx.db, input.workspaceId, app.id, r.valueHash);
      if (!blob)
        return failure(
          422,
          'asset_changed',
          `${name} is no longer kept by this server. Upload it again.`,
          { item: set.key },
        );
      read += blob.bytes.length;
      if (
        blob.bytes.length > STAGED_LIMITS.maxAssetFileBytes ||
        read > STAGED_LIMITS.maxAssetBytesPerPush
      ) {
        return failure(422, 'staged_invalid', `${name} is larger than a push uploads.`, {
          item: set.key,
        });
      }
      const format = sniffImageFormat(blob.bytes);
      if (format !== 'png' && format !== 'jpeg')
        return failure(422, 'asset_changed', `${name} is not a PNG or JPEG.`, { item: set.key });
      set.files[r.ordinal] = {
        name: fileNameOf(r.assetPath ?? '', r.ordinal),
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        bytes: blob.bytes,
        md5: md5Hex(blob.bytes),
        sha256: sha256Bytes(blob.bytes),
      };
    }
  }
  for (const [commit, group] of byCommit) {
    const opened = await openAssets(
      ctx.assets,
      { workspaceId: input.workspaceId, app, commit },
      input.actor,
    );
    if (!opened.ok)
      return assetFailure(
        opened.status,
        String(opened.body.message ?? 'The repository could not be read.'),
      );
    const { handle } = opened;
    for (const set of group) {
      for (const r of set.rows) {
        if (r.assetCommit !== commit) continue;
        const listed = handle.view.assets.find(
          (a) =>
            a.path === r.assetPath &&
            a.origin === 'store' &&
            a.oid === r.valueHash &&
            a.locale === set.locale &&
            a.kind === set.slot.kind &&
            a.device === set.slot.device,
        );
        const name = (r.assetPath ?? '').split('/').pop() ?? '';
        if (!listed || r.assetPath === null) {
          return failure(
            422,
            'asset_changed',
            `${name} is no longer a file of this set in the repository's asset index at the staged commit. Stage the set again.`,
            { item: set.key },
          );
        }
        const file = await handle.readFile(r.assetPath);
        if (!file.ok) return assetFailure(file.status, file.message);
        read += file.bytes.length;
        if (
          file.bytes.length > STAGED_LIMITS.maxAssetFileBytes ||
          read > STAGED_LIMITS.maxAssetBytesPerPush
        ) {
          return failure(422, 'staged_invalid', `${name} is larger than a push uploads.`, {
            item: set.key,
          });
        }
        if (file.oid !== r.valueHash)
          return failure(
            422,
            'asset_changed',
            `${name} does not match the staged blob id. Stage the set again.`,
            { item: set.key },
          );
        const format = sniffImageFormat(file.bytes);
        if (format !== 'png' && format !== 'jpeg')
          return failure(422, 'asset_changed', `${name} is not a PNG or JPEG.`, { item: set.key });
        set.files[r.ordinal] = {
          name: fileNameOf(r.assetPath, r.ordinal),
          mime: format === 'png' ? 'image/png' : 'image/jpeg',
          bytes: file.bytes,
          md5: md5Hex(file.bytes),
          sha256: sha256Bytes(file.bytes),
        };
      }
    }
  }
  for (const set of sets) set.files = set.files.filter((f) => f !== undefined);
  return { ok: true, prepared: { rows, texts, sets, fields } };
}

const requestOf = (p: Prepared): DraftReadRequest => ({
  text: p.texts.map((t) => ({ locale: t.locale, field: t.field })),
  assets: p.sets.map((s) => ({
    locale: s.locale,
    kind: s.slot.kind,
    device: s.slot.device,
    target: s.target,
    ...sizeOf(s),
  })),
  ...(p.fields.length > 0 ? { fields: p.fields } : {}),
});

const writesOf = (
  p: Prepared,
): { text: DraftTextWrite[]; assets: DraftAssetWrite[]; fields?: DraftFieldWrite[] } => ({
  text: p.texts,
  assets: p.sets.map((s) => ({
    locale: s.locale,
    kind: s.slot.kind,
    device: s.slot.device,
    target: s.target,
    ...sizeOf(s),
    files: s.files,
  })),
  ...(p.fields.length > 0 ? { fields: p.fields } : {}),
});

/** The pixel size of the first file of a set: the App Store connector finds the asset library placement group from it. */
const sizeOf = (s: PreparedSet): { width: number | null; height: number | null } => ({
  width: s.rows[0]?.assetWidth ?? null,
  height: s.rows[0]?.assetHeight ?? null,
});

/** The record of what a push wrote (hashes and ids only), for the submit step (docs/adr/0010-store-submit.md). */
/** Google Play: the draft release this push wrote, when it named the track and the version codes. */
const pushedReleaseOf = (p: Prepared): Pick<PushedManifest, 'release'> => {
  const track = p.fields.find((f) => f.field === 'track')?.value;
  const codes = p.fields.find((f) => f.field === 'version_codes')?.value;
  if (!track || !codes) return {};
  const list = versionCodesOf(codes);
  return list.length > 0 ? { release: { track, codes: list } } : {};
};

export const manifestOfPrepared = (p: Prepared): PushedManifest => ({
  v: 1,
  ...pushedReleaseOf(p),
  text: p.texts.map((t) => textEntry(t.locale, t.field, t.value)),
  assets: p.sets.map((s) => ({
    locale: s.locale,
    key: s.key,
    kind: s.slot.kind,
    device: s.slot.device,
    target: s.target,
    ...sizeOf(s),
    files: s.files.map(fileEntry),
  })),
});

// ---------------------------------------------------------------------------------------------
// The confirmation hash

/**
 * What the person confirms: this app, these staged items (text hashes, blob ids), from this draft.
 * `draftKey` leaves out what moves by itself.
 */
export function draftConfirmHash(input: {
  workspaceId: string;
  app: { id: string; platform: Platform };
  rows: readonly StagedRow[];
  current: DraftState;
}): string {
  const body = JSON.stringify({
    v: 1,
    workspaceId: input.workspaceId,
    appId: input.app.id,
    platform: input.app.platform,
    staged: stagedKey(input.rows),
    current: draftKey(input.current),
  });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Config

export type DraftConfig = {
  enabled: boolean;
  envName: string;
  /** Pushing never submits, sends for review or publishes. Submitting is a separate step (`GET /store-submit/config`). */
  submit: { implemented: true; configRoute: string; note: string };
  limits: typeof STAGED_LIMITS;
};

export const draftConfig = (ctx: Pick<DraftContext, 'draftEnabled'>): DraftConfig => ({
  enabled: ctx.draftEnabled,
  envName: DRAFT_ENV,
  submit: {
    implemented: true,
    configRoute: '/store-submit/config',
    note: 'A push never submits. Submitting the draft for review is a separate, gated step with its own switch, right and confirmation (docs/api/submit.md).',
  },
  limits: STAGED_LIMITS,
});

// ---------------------------------------------------------------------------------------------
// Preview

export type PreviewText = {
  id: string;
  locale: string;
  field: string;
  /** The draft's value now (null: not set, or the locale is not in the draft). */
  before: string | null;
  after: string;
  localeExists: boolean;
  status: 'changed' | 'unchanged' | 'new_locale';
};

export type PreviewFileBefore = {
  id: string;
  name: string | null;
  checksum: string | null;
  state: string | null;
};
export type PreviewFileAfter = {
  path: string;
  name: string;
  oid: string;
  bytes: number;
  width: number | null;
  height: number | null;
  format: string | null;
};

export type PreviewAssetSet = {
  id: string;
  locale: string;
  slot: AssetSlot;
  slotKey: string;
  /** This server's name of the set (App Store display type, Google Play image type). */
  target: string;
  /** App Store: the asset library placement group the set is written to (from Apple's reference data). Google Play: absent. */
  placementGroup?: string;
  before: { setExists: boolean; files: PreviewFileBefore[] };
  after: { files: PreviewFileAfter[] };
  status: 'changed' | 'unchanged';
  willUpload: number;
  willRemove: number;
};

export type PreviewReleaseField = {
  id: string;
  field: string;
  label: string;
  /** The language of a per language field (Play release notes); empty otherwise. */
  locale: string;
  /** The store's value now, in the same canonical text (null: not set). */
  before: string | null;
  after: string;
  /** `local`: kept here, never written to the store (the intended Play share). */
  status: 'changed' | 'unchanged' | 'local';
  localOnly: boolean;
};

export type DraftPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  /** App Store: the editable version that is written. Google Play: null (a draft is an edit). */
  version: { id: string; versionString: string | null; state: string } | null;
  text: PreviewText[];
  assets: PreviewAssetSet[];
  /** The release fields (docs/api/releases-write.md), before and after. Empty when none is staged. */
  release: PreviewReleaseField[];
  /** What the store says about the staged release fields. A blocking check refuses the push (`409 blocked`). */
  checks: { blocking: ReleaseCheck[]; warnings: ReleaseCheck[]; canPush: boolean };
  summary: {
    textChanged: number;
    textUnchanged: number;
    assetSetsChanged: number;
    assetSetsUnchanged: number;
    filesToUpload: number;
    filesToRemove: number;
    fieldsChanged: number;
    fieldsUnchanged: number;
    nothingToDo: boolean;
  };
  /** Always false: a push writes a draft and never submits or publishes. */
  submits: false;
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

const checksOf = (p: Prepared, platform: Platform, state: DraftState): DraftPreview['checks'] => {
  const all = releaseFieldChecks({ platform, fields: p.fields, state: state.fields });
  const blocking = all.filter((c) => c.severity === 'blocking');
  return {
    blocking,
    warnings: all.filter((c) => c.severity === 'warning'),
    canPush: blocking.length === 0,
  };
};

const itemMatches = (state: DraftState, p: Prepared) => ({
  fields: p.fields.map(
    (f) =>
      state.fields?.find((s) => s.field === f.field && s.locale === f.locale)?.value === f.value,
  ),
  text: p.texts.map((t) => {
    const found = state.text.find((s) => s.locale === t.locale && s.field === t.field);
    return (
      found !== undefined &&
      found.value !== null &&
      normalizeListingValue(found.value) === normalizeListingValue(t.value)
    );
  }),
  assets: p.sets.map((s) => {
    const found = state.assets.find((a) => a.locale === s.locale && a.target === s.target);
    return (
      found !== undefined &&
      setMatches(found.images, s.files) &&
      (found.images.length > 0 || s.files.length === 0)
    );
  }),
});

function previewOf(
  ctx: DraftContext,
  app: ManagedApp,
  workspaceId: string,
  p: Prepared,
  state: DraftState,
): DraftPreview {
  const match = itemMatches(state, p);
  const text: PreviewText[] = p.texts.map((t, i) => {
    const found = state.text.find((s) => s.locale === t.locale && s.field === t.field);
    const row = p.rows.find(
      (r) => r.kind === 'listing_text' && r.locale === t.locale && r.target === t.field,
    );
    return {
      id: row?.id ?? '',
      locale: t.locale,
      field: t.field,
      before: found?.value ?? null,
      after: t.value,
      localeExists: found?.localeExists ?? false,
      status: found && !found.localeExists ? 'new_locale' : match.text[i] ? 'unchanged' : 'changed',
    };
  });
  const assets: PreviewAssetSet[] = p.sets.map((s, i) => {
    const found = state.assets.find((a) => a.locale === s.locale && a.target === s.target);
    const unchanged = match.assets[i] === true;
    return {
      id: `${s.locale}/${s.key}`,
      locale: s.locale,
      slot: s.slot,
      slotKey: s.key,
      target: s.target,
      ...(found?.placementGroup ? { placementGroup: found.placementGroup } : {}),
      before: {
        setExists: found?.setExists ?? false,
        files: (found?.images ?? []).map((im) => ({
          id: im.id,
          name: im.name,
          checksum: im.checksum,
          state: im.state,
        })),
      },
      after: {
        files: s.rows.map((r, n) => ({
          path: r.assetPath ?? '',
          name: s.files[n]?.name ?? '',
          oid: r.valueHash,
          bytes: s.files[n]?.bytes.length ?? r.assetBytes ?? 0,
          width: r.assetWidth,
          height: r.assetHeight,
          format: r.assetFormat,
        })),
      },
      status: unchanged ? 'unchanged' : 'changed',
      willUpload: unchanged ? 0 : s.files.length,
      willRemove: unchanged ? 0 : (found?.images.length ?? 0),
    };
  });
  const release: PreviewReleaseField[] = p.rows
    .filter((r) => r.kind === 'release_field' && isReleaseFieldId(r.target))
    .map((r) => {
      const local = LOCAL_ONLY_RELEASE_FIELDS.includes(r.target as never);
      const index = p.fields.findIndex((f) => f.field === r.target && f.locale === r.locale);
      const found: DraftFieldState | undefined = state.fields?.find(
        (f) => f.field === r.target && f.locale === r.locale,
      );
      return {
        id: r.id,
        field: r.target,
        label: isReleaseFieldId(r.target) ? RELEASE_FIELD_SPECS[r.target].label : r.target,
        locale: r.locale,
        before: local ? null : (found?.value ?? null),
        after: r.valueText ?? '',
        status: local
          ? ('local' as const)
          : index !== -1 && match.fields[index]
            ? ('unchanged' as const)
            : ('changed' as const),
        localOnly: local,
      };
    });
  const summary = {
    fieldsChanged: release.filter((f) => f.status === 'changed').length,
    fieldsUnchanged: release.filter((f) => f.status === 'unchanged').length,
    textChanged: text.filter((t) => t.status !== 'unchanged').length,
    textUnchanged: text.filter((t) => t.status === 'unchanged').length,
    assetSetsChanged: assets.filter((a) => a.status === 'changed').length,
    assetSetsUnchanged: assets.filter((a) => a.status === 'unchanged').length,
    filesToUpload: assets.reduce((n, a) => n + a.willUpload, 0),
    filesToRemove: assets.reduce((n, a) => n + a.willRemove, 0),
    nothingToDo: false,
  };
  summary.nothingToDo =
    summary.textChanged === 0 && summary.assetSetsChanged === 0 && summary.fieldsChanged === 0;
  const warnings = !supports(app.platform, 'transactionalEdits')
    ? [
        DRAFT_NOTE,
        'Texts and screenshots are written to the editable App Store version right away, one request at a time: if a request fails, the earlier ones stay written.',
        'Replacing a screenshot set uploads the new files, then removes the old ones.',
      ]
    : [
        DRAFT_NOTE,
        'Google Play applies nothing until the final commit, which is made with changesNotSentForReview. If Google refuses that, nothing is committed, except for a push that holds only the draft release of a track: that is committed once more without it (a draft release is not served to users).',
        'This server does not cancel a review that is in progress: if changes are in review the push is refused.',
      ];
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    version: state.version,
    text,
    assets,
    release,
    checks: checksOf(p, app.platform, state),
    summary,
    submits: false,
    confirmHash: draftConfirmHash({ workspaceId, app, rows: p.rows, current: state }),
    warnings:
      p.fields.length > 0 ? [...warnings, FIELDS_NOTE[storeFamilyOf(app.platform)]] : warnings,
    readAt: ctx.now(),
  };
}

/** `POST .../staged/push/preview`: reads the store's draft and the staged files, and shows each item before and after. Nothing is written. */
export async function previewDraftPush(
  ctx: DraftContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; preview: DraftPreview } | Failure> {
  if (!ctx.draftEnabled) return disabled();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const prepared = await prepare(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!prepared.ok) return prepared;
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return connected;
  const { connection } = connected;
  let state: DraftState;
  try {
    state = await withConnector(ctx, connection.input, (connector) =>
      connector.readDraft(requestOf(prepared.prepared)),
    );
  } catch (error) {
    if (error instanceof DraftTimeout)
      return failure(504, 'timeout', 'The store did not answer in time. Nothing was changed.');
    return mapStoreError(error, connection.secret).failure;
  }
  await clearUnknown(ctx.db, app);
  return { ok: true, preview: previewOf(ctx, app, input.workspaceId, prepared.prepared, state) };
}

// ---------------------------------------------------------------------------------------------
// Apply

export type DraftResultStep = DraftStep;

export type DraftPushResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null; state: string } | null;
  steps: DraftResultStep[];
  counts: { applied: number; alreadySame: number; filesUploaded: number; filesRemoved: number };
  /** Google Play: `not_sent_for_review` (the commit held the changes back). App Store: `none`. */
  commit: 'not_sent_for_review' | 'draft_release' | 'none';
  /** The release fields that were part of the push (docs/api/releases-write.md). */
  fields: number;
  /** Always true: what was written is a draft. */
  draft: true;
  /** Always false: nothing was submitted, sent for review or published. */
  submitted: false;
  /** True when the write's outcome was unknown and reading the draft back showed the changes. */
  confirmedByReread: boolean;
  pushedAt: number;
  note: string;
};

const countsOf = (steps: readonly DraftStep[]) => ({
  applied: steps.filter((s) => s.outcome === 'applied').length,
  alreadySame: steps.filter((s) => s.outcome === 'already_same').length,
  filesUploaded: steps.reduce((n, s) => n + (s.uploaded ?? 0), 0),
  filesRemoved: steps.reduce((n, s) => n + (s.removed ?? 0), 0),
});

/** The steps a successful read-back stands for: what differed in the draft that was accepted is what was applied. */
function stepsFromReread(p: Prepared, before: DraftState): DraftStep[] {
  const was = itemMatches(before, p);
  const steps: DraftStep[] = [];
  p.texts.forEach((t, i) =>
    steps.push({
      type: 'text',
      locale: t.locale,
      target: t.field,
      outcome: was.text[i] ? 'already_same' : 'applied',
    }),
  );
  p.fields.forEach((f, i) =>
    steps.push({
      type: 'field',
      locale: f.locale,
      target: f.field,
      outcome: was.fields[i] ? 'already_same' : 'applied',
    }),
  );
  p.sets.forEach((s, i) => {
    const found = before.assets.find((a) => a.locale === s.locale && a.target === s.target);
    steps.push({
      type: 'asset',
      locale: s.locale,
      target: s.target,
      outcome: was.assets[i] ? 'already_same' : 'applied',
      ...(was.assets[i] ? {} : { uploaded: s.files.length, removed: found?.images.length ?? 0 }),
    });
  });
  return steps;
}

async function markPushed(
  sql: Sql,
  workspaceId: string,
  appId: string,
  p: Prepared,
  steps: readonly DraftStep[] | 'all',
  at: number,
): Promise<void> {
  const done = (type: 'text' | 'asset' | 'field', locale: string, target: string) =>
    steps === 'all' ||
    steps.some(
      (s) =>
        s.type === type &&
        s.locale === locale &&
        s.target === target &&
        (s.outcome === 'applied' || s.outcome === 'already_same'),
    );
  for (const t of p.texts) {
    if (!done('text', t.locale, t.field)) continue;
    await sql.execute(
      "UPDATE staged_changes SET pushed_at = ?, pushed_hash = value_hash WHERE workspace_id = ? AND app_id = ? AND kind = 'listing_text' AND locale = ? AND target = ?",
      [at, workspaceId, appId, t.locale, t.field],
    );
  }
  for (const f of p.fields) {
    if (!done('field', f.locale, f.field)) continue;
    await sql.execute(
      "UPDATE staged_changes SET pushed_at = ?, pushed_hash = value_hash WHERE workspace_id = ? AND app_id = ? AND kind = 'release_field' AND locale = ? AND target = ?",
      [at, workspaceId, appId, f.locale, f.field],
    );
  }
  for (const s of p.sets) {
    if (!done('asset', s.locale, s.target)) continue;
    await sql.execute(
      "UPDATE staged_changes SET pushed_at = ?, pushed_hash = value_hash WHERE workspace_id = ? AND app_id = ? AND kind = 'asset' AND locale = ? AND target = ?",
      [at, workspaceId, appId, s.locale, s.key],
    );
  }
}

async function audit(
  ctx: DraftContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  state: DraftState | undefined,
  extra: Record<string, unknown>,
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'listing.draft_push_failed',
    target: { type: 'app', id: app.id },
    // Ids, counts and outcomes: never a text, a credential, an upload address or a store response.
    detail: {
      appId: app.id,
      store: storeFor(app.platform),
      platform: app.platform,
      ...(state?.version ? { versionId: state.version.id } : {}),
      hash: input.confirmHash,
      ...extra,
    },
    at: ctx.now(),
  });
}

async function succeed(
  ctx: DraftContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  s: {
    app: DraftPushResult['app'];
    prepared: Prepared;
    claim: Claim;
    before: DraftState;
    steps: DraftStep[];
    commit: DraftPushResult['commit'];
    via: 'store' | 'reread';
    cause?: string;
  },
): Promise<{ ok: true; result: DraftPushResult }> {
  const at = ctx.now();
  const counts = countsOf(s.steps);
  await ctx.db.transaction(async (tx) => {
    await markPushed(tx, input.workspaceId, s.app.id, s.prepared, s.steps, at);
    // The record the submit step checks the store against (hashes and ids only).
    await recordPush(tx, {
      workspaceId: input.workspaceId,
      appId: s.app.id,
      platform: s.app.platform,
      version:
        s.before.version === null
          ? null
          : { id: s.before.version.id, versionString: s.before.version.versionString },
      confirmHash: input.confirmHash,
      manifest: manifestOfPrepared(s.prepared),
      actorId: input.actor.id,
      at,
    });
    const detail = {
      appId: s.app.id,
      store: s.app.store,
      platform: s.app.platform,
      ...(s.before.version ? { versionId: s.before.version.id } : {}),
      texts: s.prepared.texts.length,
      assetSets: s.prepared.sets.length,
      fields: s.prepared.fields.length,
      ...counts,
      commit: s.commit,
      hash: input.confirmHash,
      via: s.via,
      ...(s.cause ? { cause: s.cause } : {}),
    };
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'listing.draft_pushed',
      target: { type: 'app', id: s.app.id },
      detail,
      at,
    });
    await emitEvent(tx, {
      workspaceId: input.workspaceId,
      type: 'listing.draft_pushed',
      subject: { appId: s.app.id },
      payload: {
        appId: s.app.id,
        store: s.app.store,
        platform: s.app.platform,
        texts: s.prepared.texts.length,
        assetSets: s.prepared.sets.length,
        fields: s.prepared.fields.length,
        ...counts,
        commit: s.commit,
        submitted: false,
        confirmedByReread: s.via === 'reread',
        actor: { type: input.actor.type, id: input.actor.id },
      },
      at,
    });
  });
  await releaseClaim(ctx.db, s.claim);
  return {
    ok: true,
    result: {
      app: s.app,
      version: s.before.version,
      steps: s.steps,
      counts,
      commit: s.commit,
      fields: s.prepared.fields.length,
      draft: true,
      submitted: false,
      confirmedByReread: s.via === 'reread',
      pushedAt: at,
      note: DRAFT_NOTE,
    },
  };
}

/**
 * `POST .../staged/push`: re-reads the store's draft, checks it is still what `confirmHash` was made
 * from, writes once. See the file comment. Never submits.
 */
export async function applyDraftPush(
  ctx: DraftContext,
  input: { workspaceId: string; appId: string; confirmHash: string; actor: Actor },
): Promise<{ ok: true; result: DraftPushResult } | Failure> {
  if (!ctx.draftEnabled) return disabled();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const appView = {
    id: app.id,
    name: app.name,
    platform: app.platform,
    store: storeFor(app.platform),
  };

  const taken = await takeClaim(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  const stop = async (f: Failure): Promise<Failure> => {
    await releaseClaim(db, claim);
    return f;
  };
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return stop(connected);
  const { connection } = connected;
  const prepared = await prepare(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!prepared.ok) return stop(prepared);
  const p = prepared.prepared;
  const hashOf = (current: DraftState) =>
    draftConfirmHash({ workspaceId: input.workspaceId, app, rows: p.rows, current });

  let accepted: DraftState | undefined;
  let blocked: DraftPreview['checks'] | undefined;
  let done: DraftApplyResult | undefined;
  let unknown: { cause: string; completed: DraftStep[] } | undefined;
  try {
    done = await withConnector(ctx, connection.input, (connector) =>
      connector.applyDraft({
        ...writesOf(p),
        guard: (current) => {
          const checks = checksOf(p, app.platform, current);
          if (!checks.canPush) {
            blocked = checks;
            return false;
          }
          const same = hashOf(current) === input.confirmHash;
          if (same) accepted = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof DraftDriftError) {
      if (blocked) {
        await audit(ctx, input, app, error.current, {
          code: 'blocked',
          outcome: 'refused',
          blocking: blocked.blocking.map((b) => b.code).slice(0, 20),
        });
        await releaseClaim(db, claim);
        return failure(
          409,
          'blocked',
          'Something stands in the way of writing the release fields, so nothing was written. See `checks`.',
          { checks: blocked },
        );
      }
      await audit(ctx, input, app, error.current, { code: 'state_changed', outcome: 'refused' });
      await releaseClaim(db, claim);
      return failure(
        409,
        'state_changed',
        'The staged changes or the store’s draft changed since this was previewed, so nothing was written. Review the new preview and confirm it.',
        {
          preview: previewOf(ctx, app, input.workspaceId, p, error.current),
        },
      );
    }
    if (error instanceof DraftPartialError) {
      const at = ctx.now();
      await markPushed(db, input.workspaceId, app.id, p, error.completed, at);
      const mapped = mapStoreError(error.cause, connection.secret);
      await audit(ctx, input, app, accepted, {
        code: 'partial',
        outcome: 'partial',
        storeCode: mapped.code,
        ...countsOf(error.completed),
        failed: error.failed,
      });
      await releaseClaim(db, claim);
      return failure(
        502,
        'draft_partial',
        `Some changes reached the draft before the store refused one (${mapped.failure.body.message ?? mapped.code}). What was written stays written; preview and push again to finish: items that already match are skipped.`,
        {
          completed: error.completed,
          failed: error.failed,
          storeError: { code: mapped.code },
        },
      );
    }
    if (error instanceof DraftOutcomeUnknownError || error instanceof DraftTimeout) {
      unknown = {
        cause: error instanceof DraftTimeout ? 'timeout' : 'network',
        completed: error instanceof DraftOutcomeUnknownError ? error.completed : [],
      };
    } else {
      const mapped = mapStoreError(error, connection.secret);
      await audit(ctx, input, app, accepted, { code: mapped.code, outcome: 'failed' });
      await releaseClaim(db, claim);
      return mapped.failure;
    }
  }

  if (done) {
    return succeed(ctx, input, {
      app: appView,
      prepared: p,
      claim,
      before: done.before,
      steps: done.steps,
      commit: done.commit,
      via: 'store',
    });
  }

  // ----- an unknown outcome is checked, not sent again
  const before = accepted;
  let current: DraftState | undefined;
  try {
    current = await withConnector(ctx, connection.input, (connector) =>
      connector.readDraft(requestOf(p)),
    );
  } catch {
    current = undefined;
  }
  const cause = unknown?.cause ?? 'unknown';
  if (current === undefined || before === undefined) {
    await markUnknown(db, claim);
    await audit(ctx, input, app, before, {
      code: cause,
      outcome: 'unknown',
      ...(current === undefined ? { readBack: 'failed' } : {}),
    });
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the draft reached the store: the store did not answer and its draft could not be read back. Preview the push again to see where it stands; nothing is written until you confirm a new preview.',
    );
  }
  const now = itemMatches(current, p);
  if (now.text.every(Boolean) && now.assets.every(Boolean) && now.fields.every(Boolean)) {
    // Google Play: whether the committed draft shows in a later edit is UNVERIFIED; it counts here only when it does show.
    return succeed(ctx, input, {
      app: appView,
      prepared: p,
      claim,
      before,
      steps: stepsFromReread(p, before),
      commit: byFamily(app.platform, { apple: 'none', google: 'not_sent_for_review' }),
      via: 'reread',
      cause,
    });
  }
  if (sameDraftState(current, before)) {
    if (!supports(app.platform, 'transactionalEdits')) {
      await audit(ctx, input, app, before, { code: 'not_applied', outcome: 'failed', cause });
      await releaseClaim(db, claim);
      return failure(
        502,
        'write_failed',
        'The store did not answer, and reading its draft back shows nothing was written. Nothing was changed. Preview again to try again.',
        { outcome: 'not_applied' },
      );
    }
    // Google Play can be slow to show a committed edit: the old draft is not proof.
    await markUnknown(db, claim);
    await audit(ctx, input, app, before, { code: 'not_visible', outcome: 'unknown', cause });
    return failure(
      409,
      'outcome_unknown',
      'Google Play did not answer, and the draft it shows is unchanged. A commit can take a while to show: check Play Console, then preview the push again. Nothing is written until you confirm a new preview.',
    );
  }
  // Neither the old draft nor the asked one: part of it was written (App Store), or somebody else changed it too.
  const itemsDone = {
    text: p.texts.map((t, i) => ({
      locale: t.locale,
      field: t.field,
      matches: now.text[i] === true,
    })),
    assets: p.sets.map((s, i) => ({
      locale: s.locale,
      slotKey: s.key,
      matches: now.assets[i] === true,
    })),
    fields: p.fields.map((f, i) => ({
      locale: f.locale,
      field: f.field,
      matches: now.fields[i] === true,
    })),
  };
  await audit(ctx, input, app, before, {
    code: 'partial',
    outcome: 'partial',
    cause,
    matching: [...itemsDone.text, ...itemsDone.assets, ...itemsDone.fields].filter((i) => i.matches)
      .length,
    total: itemsDone.text.length + itemsDone.assets.length + itemsDone.fields.length,
  });
  await releaseClaim(db, claim);
  return failure(
    409,
    'draft_partial',
    'The store did not answer, and its draft now holds some of the changes but not all. Preview and push again to finish: items that already match are skipped.',
    { items: itemsDone },
  );
}
