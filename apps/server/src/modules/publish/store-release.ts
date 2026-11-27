import { createHash } from 'node:crypto';
import {
  APPLE_RELEASABLE_STATE,
  AppleReleaseConnector,
  appleScope,
  connectorFactory,
  type PlayReleaseBuild,
  PlayReleaseConnector,
  ReleaseDriftError,
  ReleaseOutcomeUnknownError,
  type ReleaseRequest,
  type ReleaseState,
  releaseKey,
  type StoreConnectorInput,
  type StoreReleaseConnector,
} from '@kiln/connectors';
import {
  byFamily,
  STORE_CALL_CLAIM_TTL_MS as DEFAULT_RELEASE_CLAIM_TTL_MS,
  needsStoreAppId,
  normalizeReleaseValue,
  STORE_CALL_CLAIM_TTL_MS as OTHER_CLAIM_TTL_MS,
  type Platform,
  supports,
  versionCodesOf,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { credentialKindFor, getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitCacheEvent } from '../../services/cache-registry.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import { mapStoreError } from './store-draft.ts';
import { markReleasedHere } from './store-draft-record.ts';

export { DEFAULT_RELEASE_CLAIM_TTL_MS };

/**
 * RELEASING: making an approved App Store version available to users, or starting a Google Play draft release at a chosen
 * share of users. The most consequential STORE WRITE after a submit, and one this server cannot take back. It is written down in
 * docs/adr/0014-release-management.md and docs/api/releases-write.md and gated exactly like a submit (ADR 0010):
 *
 * - Off unless `releaseEnabled` (KILN_STORE_RELEASE_ENABLED, default false), separately from the draft and submit switches: every
 *   function answers `409 store_release_disabled` and no connector is built.
 * - A role action of its own, `store.release` (owner and admin; a token only when its actions name it), checked by the route.
 * - Preview (what is released, to whom, what cannot be undone, the checks), then apply with the `confirmHash` of that preview AND
 *   the typed confirmation phrase. The store is read again right before the write (the guard of the connector): a different
 *   state is `409 state_changed` with a new preview; a blocking check is `409 blocked`; a wrong phrase is
 *   `422 confirmation_mismatch`, all before anything is written.
 * - Refused when nothing is releasable: App Store only a version in Pending Developer Release (and only one, or the version is
 *   named), Google Play only a draft release whose version codes are uploaded and beside which nothing is rolling out.
 * - The share of a Google Play release is EXPLICIT (`userFraction`, more than 0, at most 1): it is part of the confirmation, never
 *   taken from a staged value or a default.
 * - One release in flight per app and platform (`store_release_claims`; a push or a submit in flight blocks it). Never retried.
 *   A lost answer: the store is READ BACK and the answer is `confirmedByReread`, `502 write_failed` (`outcome: not_applied`) or
 *   `409 outcome_unknown` (blocks until the person has previewed again: a successful read settles it).
 * - Audit (`store.released`, `store.release_failed`) and the event `release.started` hold ids, a share, counts and hashes. Never a
 *   text, a credential, a token or a store response body.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const RELEASE_ENV = 'KILN_STORE_RELEASE_ENABLED';
export const RELEASE_PURPOSE = 'store.release';
/** One to four requests to a store. */
export const DEFAULT_RELEASE_TIMEOUT_MS = 120_000;
/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
/** The claims of a push and of a submit are not trusted as "in flight" after this long (their own time to live). */

// ---------------------------------------------------------------------------------------------
// Context

export type ReleaseConnectorInput = StoreConnectorInput;
export type ReleaseConnectorFactory = (input: ReleaseConnectorInput) => StoreReleaseConnector;

export const defaultReleaseConnectorFactory: ReleaseConnectorFactory =
  connectorFactory<StoreReleaseConnector>({
    app_store_connect: (input) =>
      AppleReleaseConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        platform: appleScope(input),
        fetch: input.fetch,
      }),
    google_play: (input) =>
      new PlayReleaseConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export type ReleaseContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** KILN_STORE_RELEASE_ENABLED. */
  releaseEnabled: boolean;
  releaseConnectorFactory: ReleaseConnectorFactory;
  releaseTimeoutMs?: number;
  claimTtlMs?: number;
};

// ---------------------------------------------------------------------------------------------
// Failures

export const releaseDisabledFailure = (): Failure =>
  failure(
    409,
    'store_release_disabled',
    `Releasing from this server is switched off. Set ${RELEASE_ENV}=true to turn it on (see docs/deployment.md).`,
    {
      envName: RELEASE_ENV,
    },
  );

class ReleaseTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: ReleaseContext,
  input: Omit<ReleaseConnectorInput, 'fetch'>,
  job: (connector: StoreReleaseConnector) => Promise<T>,
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
      reject(new ReleaseTimeout('timeout'));
    }, ctx.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.releaseConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The claim: one release in flight per app and platform

type Claim = { appId: string; platform: Platform; at: number };

async function takeClaim(
  ctx: ReleaseContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_RELEASE_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A release of this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.release'),
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_release_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, 'release', 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM store_release_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last release of this app reached the store. Look at the app in App Store Connect or Play Console, then preview the release again: that reads the store and shows where it stands. Nothing is released until you confirm a new preview.',
      coded('publish.unknown.release'),
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A release that started long ago and never finished (a process died): its outcome is unknown. The re-read and the hash refuse
  // a release that no longer fits the store (a version already released is no longer in Pending Developer Release).
  const taken = await db.execute(
    `UPDATE store_release_claims SET claim_at = ?, claimed_by = ?, workspace_id = ?
      WHERE app_id = ? AND platform = ? AND status = 'writing' AND claim_at = ?`,
    [claim.at, input.actor.id, input.workspaceId, claim.appId, claim.platform, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_release_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );
const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE store_release_claims SET status = 'unknown' WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );
/** A successful read of the store settles an unknown outcome: the person sees where things stand. */
const clearUnknown = (sql: Sql, app: ManagedApp) =>
  sql.execute(
    "DELETE FROM store_release_claims WHERE app_id = ? AND platform = ? AND status = 'unknown'",
    [app.id, app.platform],
  );

type Flight = 'writing' | 'unknown' | null;
type InFlight = { release: Flight; push: Flight; submit: Flight };

/** The claims that bear on a release: its own, and a push's and a submit's (either changes what a release would release). */
async function inFlightOf(ctx: ReleaseContext, app: ManagedApp): Promise<InFlight> {
  const now = ctx.now();
  const read = async (
    table: 'store_release_claims' | 'store_draft_claims' | 'store_submit_claims',
    limit: number,
  ): Promise<Flight> => {
    const [row] = await ctx.db.query(
      `SELECT status, claim_at FROM ${table} WHERE app_id = ? AND platform = ?`,
      [app.id, app.platform],
    );
    if (!row) return null;
    if (String(row.status) === 'unknown') return 'unknown';
    return now - Number(row.claim_at) < limit ? 'writing' : null;
  };
  return {
    release: await read('store_release_claims', ctx.claimTtlMs ?? DEFAULT_RELEASE_CLAIM_TTL_MS),
    push: await read('store_draft_claims', OTHER_CLAIM_TTL_MS),
    submit: await read('store_submit_claims', OTHER_CLAIM_TTL_MS),
  };
}

// ---------------------------------------------------------------------------------------------
// Connection

type Connection = { input: Omit<ReleaseConnectorInput, 'fetch'>; secret: string };

async function connect(
  ctx: ReleaseContext,
  workspaceId: string,
  app: ManagedApp,
  actor: Actor,
): Promise<{ ok: true; connection: Connection } | Failure> {
  const [credential] = await ctx.db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential)
    return failure(
      422,
      'credential_not_found',
      'The credential of this app no longer exists.',
      coded('credential.gone'),
    );
  if (String(credential.kind) !== credentialKindFor[app.platform])
    return failure(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
      coded('credential.wrongKind'),
    );
  if (needsStoreAppId(app.platform) && !app.storeAppId)
    return failure(
      422,
      'app_not_synced',
      'The App Store id of this app is not known yet. Sync the app first.',
      coded('app.storeIdUnknown'),
    );
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: RELEASE_PURPOSE },
      actor,
      ctx.now(),
    );
  } catch {
    return failure(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
      coded('credential.undecryptable'),
    );
  }
  if (secret === undefined)
    return failure(
      422,
      'credential_not_found',
      'The credential of this app no longer exists.',
      coded('credential.gone'),
    );
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
// What is asked

export type ReleaseInput = {
  /** App Store: the marketing version, to be sure which one (required when more than one waits). */
  version?: string | undefined;
  /** Google Play: the track of the draft release. Required there. */
  track?: string | undefined;
  /** Google Play: the version codes that identify the draft release (needed when the track holds more than one draft). */
  versionCodes?: string[] | undefined;
  /** Google Play: the share of users, more than 0 and at most 1. Required there and always explicit. */
  userFraction?: number | undefined;
  /**
   * Google Play, DIRECT release (docs/adr/0029-direct-play-release.md): release the staged fields (version codes, release name,
   * notes) in ONE edit, building the release when the track holds no draft with the codes. Not for the App Store.
   */
  direct?: boolean | undefined;
  /** What the direct release is built from: read from the staged release fields by `resolveDirect`, never taken from a caller. */
  build?: PlayReleaseBuild | undefined;
};

const TRACK = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;
const invalid = (code: string, message: string, extra: Record<string, unknown> = {}): Failure =>
  failure(422, code, message, extra);

/** The request the connector reads and writes by, or why it is not one. */
export function requestOfInput(
  app: Pick<ManagedApp, 'platform'>,
  input: ReleaseInput,
): { ok: true; request: ReleaseRequest } | Failure {
  if (!supports(app.platform, 'releaseTracks')) {
    if (
      input.track !== undefined ||
      input.versionCodes !== undefined ||
      input.userFraction !== undefined ||
      input.direct !== undefined
    ) {
      return invalid(
        'not_applicable',
        'track, versionCodes, userFraction and direct are for Google Play. An App Store release has only an optional version.',
        { field: 'track' },
      );
    }
    const version = input.version?.trim();
    if (version !== undefined && (version === '' || version.length > 40))
      return invalid('invalid_request', 'version is the marketing version, for example 2.4.0.', {
        field: 'version',
      });
    return { ok: true, request: version !== undefined ? { version } : {} };
  }
  if (input.version !== undefined)
    return invalid(
      'not_applicable',
      'version is for the App Store. A Google Play release is chosen by track and version codes.',
      { field: 'version' },
    );
  if (input.track === undefined || !TRACK.test(input.track))
    return invalid(
      'track_required',
      'Name the track of the draft release (for example production).',
      { field: 'track', ...coded('publish.trackRequired') },
    );
  const fraction = input.userFraction;
  if (fraction === undefined)
    return invalid(
      'user_fraction_required',
      'Name the share of users to release to, more than 0 and at most 1 (1 is everybody). It is never implied.',
      { field: 'userFraction', ...coded('publish.shareRequired') },
    );
  if (
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction > 1 ||
    Math.round(fraction * 10000) / 10000 !== fraction
  ) {
    return invalid(
      'invalid_user_fraction',
      'userFraction must be more than 0 and at most 1, with at most 4 decimals (for example 0.1 for 10%).',
      { field: 'userFraction' },
    );
  }
  let codes: string[] | undefined;
  if (input.versionCodes !== undefined) {
    codes = versionCodesOf(normalizeReleaseValue('version_codes', input.versionCodes));
    if (codes.length === 0 || codes.length > 20 || codes.some((c) => !/^[0-9]{1,10}$/.test(c)))
      return invalid('invalid_version_codes', 'versionCodes are whole numbers (at most 20).', {
        field: 'versionCodes',
      });
  }
  if (input.build !== undefined && codes === undefined)
    return invalid(
      'version_codes_required',
      'A direct release needs the version codes: stage them, or name them.',
      { field: 'versionCodes' },
    );
  return {
    ok: true,
    request: {
      track: input.track,
      userFraction: fraction,
      ...(codes ? { versionCodes: codes } : {}),
      ...(input.build !== undefined ? { build: input.build } : {}),
    },
  };
}

/**
 * Google Play, direct release: what the release is built from, read from the STAGED release fields of the app (the version codes
 * and the track when the caller named none, the release name, the notes per language). Staged values are the person's own and are
 * never taken from the request. Not a direct release: the input as it was.
 */
export async function resolveDirect(
  sql: Sql,
  app: Pick<ManagedApp, 'id' | 'platform'>,
  input: ReleaseInput,
): Promise<{ ok: true; input: ReleaseInput } | Failure> {
  if (input.direct !== true) return { ok: true, input: { ...input, build: undefined } };
  if (!supports(app.platform, 'directRelease'))
    return invalid('not_applicable', 'direct is for Google Play.', { field: 'direct' });
  const rows = await sql.query(
    "SELECT target, locale, value_text FROM staged_changes WHERE app_id = ? AND kind = 'release_field' AND target IN ('track', 'version_codes', 'release_name', 'release_notes')",
    [app.id],
  );
  const staged = (field: string) => rows.find((r) => String(r.target) === field);
  const stagedCodes = staged('version_codes');
  const codes =
    input.versionCodes ?? (stagedCodes ? versionCodesOf(String(stagedCodes.value_text)) : []);
  const track = input.track ?? (staged('track') ? String(staged('track')?.value_text) : undefined);
  const name = staged('release_name') ? String(staged('release_name')?.value_text).trim() : '';
  const notes = rows
    .filter((r) => String(r.target) === 'release_notes' && String(r.value_text ?? '').trim() !== '')
    .map((r) => ({ locale: String(r.locale), text: String(r.value_text) }))
    .sort((a, b) => (a.locale < b.locale ? -1 : 1));
  return {
    ok: true,
    input: {
      ...input,
      track,
      ...(codes.length > 0 ? { versionCodes: codes } : {}),
      build: { name: name === '' ? null : name, notes },
    },
  };
}

const percentOf = (fraction: number): string => String(Math.round(fraction * 10000) / 100);

// ---------------------------------------------------------------------------------------------
// Checks

export type ReleaseCheck = {
  code: string;
  /** `blocking`: the release is refused until it is fixed. `warning`: shown, does not stop it. */
  severity: 'blocking' | 'warning';
  message: string;
  item?: string;
};
export type ReleaseChecks = {
  blocking: ReleaseCheck[];
  warnings: ReleaseCheck[];
  canRelease: boolean;
};

const split = (items: ReleaseCheck[]): ReleaseChecks => {
  const blocking = items.filter((i) => i.severity === 'blocking');
  return {
    blocking,
    warnings: items.filter((i) => i.severity === 'warning'),
    canRelease: blocking.length === 0,
  };
};

/** Checks against the state read from the store and the claims. Pure. */
export function evaluateReleaseChecks(input: {
  request: ReleaseRequest;
  state: ReleaseState;
  inFlight: InFlight;
  /** Staged release fields that were not pushed to the draft (the release releases what the store holds, not what is staged). */
  unpushedFields: number;
  /** The share staged as an intention (Play), to compare with the one asked. */
  stagedFraction: number | null;
}): ReleaseCheck[] {
  const { request, state } = input;
  const out: ReleaseCheck[] = [];
  const add = (check: ReleaseCheck) => out.push(check);
  if (input.inFlight.push === 'writing')
    add({
      code: 'push_in_progress',
      severity: 'blocking',
      message: 'A draft push for this app is in progress. Wait for it to finish.',
    });
  if (input.inFlight.push === 'unknown')
    add({
      code: 'push_outcome_unknown',
      severity: 'blocking',
      message:
        'It is not known whether the last draft push reached the store. Preview that push again first (staged changes), then release.',
    });
  if (input.inFlight.submit === 'writing')
    add({
      code: 'submit_in_progress',
      severity: 'blocking',
      message: 'A submit for review of this app is in progress. Wait for it to finish.',
    });
  if (input.inFlight.submit === 'unknown')
    add({
      code: 'submit_outcome_unknown',
      severity: 'blocking',
      message:
        'It is not known whether the last submit for review reached the store. Preview that submit again first, then release.',
    });
  if (input.unpushedFields > 0) {
    add({
      code: 'unpushed_release_fields',
      severity: 'warning',
      message: `${input.unpushedFields} staged release field${input.unpushedFields === 1 ? ' is' : 's are'} not written to the store's draft. A release releases what the store holds, not what is staged.`,
    });
  }

  if (state.store === 'appstoreconnect') {
    if (state.ambiguous) {
      add({
        code: 'ambiguous_version',
        severity: 'blocking',
        message:
          'More than one version waits for release. Name the version (its marketing version, for example 2.4.0).',
      });
    } else if (state.version === null || !state.releasable) {
      const known = state.versions.slice(0, 6).map((v) => `${v.versionString ?? '?'} (${v.state})`);
      add({
        code: 'not_releasable',
        severity: 'blocking',
        message: `No version is waiting for release (${APPLE_RELEASABLE_STATE}), so there is nothing to release.${known.length > 0 ? ` The versions of this platform: ${known.join(', ')}.` : ''}`,
      });
    } else {
      if (state.build === null)
        add({
          code: 'no_build_read',
          severity: 'warning',
          message: 'The build of the version could not be read.',
        });
      else if (state.build.expired === true)
        add({
          code: 'build_expired',
          severity: 'warning',
          message: `Build ${state.build.buildNumber ?? state.build.id} is marked expired.`,
        });
      if (state.version.releaseType !== null && state.version.releaseType !== 'MANUAL') {
        add({
          code: 'release_type_not_manual',
          severity: 'warning',
          message: `The version was set to release ${state.version.releaseType}. It waits for release, so this request releases it now.`,
        });
      }
    }
    return out;
  }

  // Google Play
  add({
    code: 'play_review_state_unknown',
    severity: 'warning',
    message:
      'Google Play shows no review state through its API: this server cannot tell whether the release goes live at once or waits for review, and cannot confirm it afterwards beyond reading the track back.',
  });
  if (state.ambiguous)
    add({
      code: 'ambiguous_release',
      severity: 'blocking',
      message: `The ${state.track} track holds more than one draft release. Name its version codes.`,
    });
  else if (state.release === null)
    add({
      code: 'no_draft_release',
      severity: 'blocking',
      message: `The ${state.track} track has no draft release${request.versionCodes ? ' with these version codes' : ''}, so there is nothing to start.`,
    });
  else {
    if (state.release.status !== 'draft')
      add({
        code: 'not_a_draft',
        severity: 'blocking',
        message: `The release is ${state.release.status}, not a draft.`,
      });
    if (state.release.versionCodes.length === 0)
      add({
        code: 'no_version_codes',
        severity: 'blocking',
        message: 'The draft release has no version codes.',
      });
    if (state.missingCodes.length > 0) {
      add({
        code: 'version_codes_not_uploaded',
        severity: 'blocking',
        message: `Google Play does not list ${state.missingCodes.length === 1 ? 'this version code' : 'these version codes'} as uploaded: ${state.missingCodes.slice(0, 10).join(', ')}.`,
      });
    }
    if (state.release.notes === 0)
      add({
        code: 'no_release_notes',
        severity: 'warning',
        message: 'The draft release has no release notes.',
      });
  }
  if (state.creates) {
    add({
      code: 'direct_release',
      severity: 'warning',
      message: `The ${state.track} track holds no draft release with these version codes. The release is made from the staged fields and sent to Google in this one step, with no draft first. Google reviews it before users get it.`,
    });
    const wanted = [...(request.versionCodes ?? [])].sort().join(',');
    const holding = state.others.filter((r) => [...r.versionCodes].sort().join(',') === wanted);
    if (holding.length > 0)
      add({
        code: 'codes_already_in_track',
        severity: 'blocking',
        message: `A release of the ${state.track} track (${holding.map((r) => r.status).join(', ')}) already holds these version codes, so a new release is not made from them.`,
      });
  } else if (request.build !== undefined) {
    add({
      code: 'draft_used_as_is',
      severity: 'warning',
      message:
        'A draft release with these version codes already exists in the track. It is released as it is: its name and notes are not changed by this step.',
    });
  }
  const rolling = state.others.filter((r) => r.status === 'inProgress');
  if (rolling.length > 0) {
    add({
      code: 'rollout_in_progress',
      severity: 'blocking',
      message: `A release is already rolling out in the ${state.track} track (${rolling.map((r) => `${r.name ?? r.versionCodes.join(',')} at ${r.userFraction === null ? '?' : `${percentOf(r.userFraction)}%`}`).join(', ')}). Complete or halt it in Play Console first: this server does not start a second rollout beside a running one.`,
    });
  }
  if (state.others.some((r) => r.status === 'halted'))
    add({
      code: 'halted_release',
      severity: 'warning',
      message: `A halted release is in the ${state.track} track.`,
    });
  if (request.userFraction === 1)
    add({
      code: 'full_rollout',
      severity: 'warning',
      message: 'The release goes to 100% of users at once (the release is completed).',
    });
  if (
    input.stagedFraction !== null &&
    request.userFraction !== undefined &&
    input.stagedFraction !== request.userFraction
  ) {
    add({
      code: 'fraction_differs_from_staged',
      severity: 'warning',
      message: `The staged intended share is ${percentOf(input.stagedFraction)}%, this release is asked for ${percentOf(request.userFraction)}%. The share asked here is the one used.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The confirmation

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** The staged fields a direct release is built from, as hashes (so the confirmation binds them and no text is kept). */
const buildDigest = (b: PlayReleaseBuild): unknown => [
  b.name === null ? null : sha(b.name),
  [...b.notes].sort((x, y) => (x.locale < y.locale ? -1 : 1)).map((n) => [n.locale, sha(n.text)]),
];

/** What the person confirms: this app, what is asked (including the share), and the store exactly as it was read. */
export function releaseConfirmHash(input: {
  workspaceId: string;
  app: { id: string; platform: Platform };
  request: ReleaseRequest;
  state: ReleaseState;
}): string {
  const r = input.request;
  return sha(
    JSON.stringify({
      v: 1,
      workspaceId: input.workspaceId,
      appId: input.app.id,
      platform: input.app.platform,
      request: {
        version: r.version ?? null,
        track: r.track ?? null,
        codes: r.versionCodes ? [...r.versionCodes].sort() : null,
        userFraction: r.userFraction ?? null,
        build: r.build ? buildDigest(r.build) : null,
      },
      store: releaseKey(input.state),
    }),
  );
}

/**
 * The text the person types to confirm. It names the app, what is released and, for Google Play, the share, so a typed phrase
 * cannot be for another release. App Store: the version that waits (known only after a read); null while none does.
 */
export function confirmationPhraseOf(
  app: Pick<ManagedApp, 'identifier'>,
  request: ReleaseRequest,
  state: ReleaseState | undefined,
): string | null {
  if (request.track !== undefined && request.userFraction !== undefined)
    return `release ${app.identifier} ${request.track} ${percentOf(request.userFraction)}%`;
  if (state?.store === 'appstoreconnect' && state.version !== null)
    return `release ${app.identifier} ${state.version.versionString ?? state.version.id}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Config and state

export type ReleaseConfig = {
  enabled: boolean;
  envName: string;
  action: 'store.release';
  /** The lowest role that can release. A token needs `store.release` named in its actions. */
  minimumRole: 'admin';
  /** Always true: nothing here can recall a release. */
  irreversible: true;
  note: string;
};

export const releaseConfig = (ctx: Pick<ReleaseContext, 'releaseEnabled'>): ReleaseConfig => ({
  enabled: ctx.releaseEnabled,
  envName: RELEASE_ENV,
  action: 'store.release',
  minimumRole: 'admin',
  irreversible: true,
  note: 'Releasing makes an approved App Store version available, or starts a Google Play draft release at a share you name. It cannot be recalled from here (docs/api/releases-write.md).',
});

export type ReleaseStateView = {
  enabled: boolean;
  inFlight: { release: boolean; push: boolean; submit: boolean };
  /** An earlier release, push or submit whose outcome is unknown: preview again (a release) or look at the store (the others). */
  unknownOutcome: { release: boolean; push: boolean; submit: boolean };
};

/** `GET .../store-release`: the database only, no store is contacted. */
export async function getReleaseState(
  ctx: ReleaseContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; state: ReleaseStateView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const f = await inFlightOf(ctx, app);
  return {
    ok: true,
    state: {
      enabled: ctx.releaseEnabled,
      inFlight: {
        release: f.release === 'writing',
        push: f.push === 'writing',
        submit: f.submit === 'writing',
      },
      unknownOutcome: {
        release: f.release === 'unknown',
        push: f.push === 'unknown',
        submit: f.submit === 'unknown',
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Preview

export type ReleasePreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  /** What was asked (the share is always the one the person named). */
  request: ReleaseRequest;
  /** App Store: the version that would be released. Google Play: null. */
  version: {
    id: string;
    versionString: string | null;
    state: string;
    releaseType: string | null;
  } | null;
  build: {
    id: string;
    buildNumber: string | null;
    processingState: string | null;
    expired: boolean | null;
  } | null;
  /** App Store: whether Apple would release in phases (a phased release exists) or to everybody at once. Google Play: null. */
  phasedRelease: { id: string; state: string | null } | null;
  /** Google Play: the track, the release that would start and the others, as the store shows them. */
  track: string | null;
  release: { name: string | null; status: string; versionCodes: string[]; notes: number } | null;
  others: {
    name: string | null;
    status: string;
    userFraction: number | null;
    versionCodes: string[];
  }[];
  /** Who gets it: `all` (everybody, now), `phased` (Apple's seven day phased release) or `percent` (a Google Play share). */
  audience: {
    kind: 'all' | 'phased' | 'percent';
    userFraction: number | null;
    description: string;
  };
  /** Google Play, DIRECT release: what is made and sent in one step (never a note, only the languages). Null: not a direct release. */
  direct: {
    /** False: a draft with these codes exists in the track and is released as it is. */
    creates: boolean;
    versionCodes: string[];
    name: string | null;
    notesLanguages: string[];
    /** Plain words: what happens, to whom, and that Google reviews it. */
    summary: string;
  } | null;
  /** What cannot be undone from this server. */
  irreversible: string[];
  /** Always true. */
  releases: true;
  checks: ReleaseChecks;
  /** Null while a blocking check stands: nothing can be confirmed. */
  confirmHash: string | null;
  /** What the person types to confirm (null while blocked). The apply request carries it as `confirmation`. */
  confirmation: { phrase: string; instruction: string } | null;
  /** False when the person's own confirmation (password or passkey, `stepUpCovers`) stands in for the typed phrase. */
  confirmationRequired: boolean;
  readAt: number;
};

/** The request as an answer shows it: what the direct release is built from is not repeated (notes are texts). */
const publicRequest = (request: ReleaseRequest): ReleaseRequest & { direct?: true } => {
  const { build, ...rest } = request;
  return build === undefined ? rest : { ...rest, direct: true };
};

/** Plain words for a direct release. */
export function directSummaryOf(
  request: ReleaseRequest,
  state: Extract<ReleaseState, { store: 'googleplay' }>,
): string {
  const codes = request.versionCodes ?? state.release?.versionCodes ?? [];
  const share =
    request.userFraction === 1
      ? 'everybody (100%)'
      : `${percentOf(request.userFraction ?? 0)}% of users`;
  const langs = [
    ...new Set(
      (request.build?.notes ?? []).filter((n) => n.text.trim() !== '').map((n) => n.locale),
    ),
  ];
  const notes = langs.length > 0 ? `release notes in ${langs.join(', ')}` : 'no release notes';
  return `${state.creates ? 'Makes and sends' : 'Sends the existing draft of'} the release with version code${codes.length === 1 ? '' : 's'} ${codes.join(', ')} to the ${state.track} track for ${share}, with ${notes}. Google reviews this release before users get it; it cannot be undone from here.`;
}

const irreversibleOf = (state: ReleaseState, request: ReleaseRequest): string[] =>
  state.store === 'appstoreconnect'
    ? [
        `${state.version?.versionString ? `Version ${state.version.versionString}` : 'The version'} is released: App Store Connect makes it available to users. Apple does not allow cancelling the request.`,
        state.phasedRelease !== null
          ? 'The version has a phased release: automatic updates reach users over seven days (Apple’s help page, UNVERIFIED for the API).'
          : 'The version has no phased release: it is available to everybody at once.',
        'This server cannot take the version back. Only a new version (or removing the app from sale in App Store Connect) changes what users get.',
      ]
    : [
        request.userFraction === 1
          ? 'The release is completed: every user of the track can get it. This server cannot undo that.'
          : `The release starts at ${percentOf(request.userFraction ?? 0)}% of users. This server can neither halt it nor raise it afterwards: do that in Play Console or with the rollout controls (docs/api/rollout.md).`,
        request.build !== undefined
          ? 'The release is sent to Google for review with the commit: Google reviews it before users get it, and this server cannot take it back. Whether and when Google publishes it is not shown by its API.'
          : 'The release is sent to Google with the commit; whether it waits for review first is not shown by Google’s API.',
      ];

const audienceOf = (state: ReleaseState, request: ReleaseRequest): ReleasePreview['audience'] => {
  if (state.store === 'appstoreconnect') {
    return state.phasedRelease !== null
      ? {
          kind: 'phased',
          userFraction: null,
          description: 'Phased release: automatic updates reach users over seven days.',
        }
      : { kind: 'all', userFraction: null, description: 'Everybody at once.' };
  }
  const f = request.userFraction ?? 0;
  return f === 1
    ? { kind: 'all', userFraction: 1, description: '100% of users (the release is completed).' }
    : { kind: 'percent', userFraction: f, description: `${percentOf(f)}% of users.` };
};

async function unpushedFieldsOf(
  sql: Sql,
  app: ManagedApp,
  /** A direct release uses the staged fields itself: none of them is "not written to the draft". */
  direct = false,
): Promise<{ count: number; fraction: number | null }> {
  const rows = await sql.query(
    "SELECT target, value_text, value_hash, pushed_hash FROM staged_changes WHERE app_id = ? AND kind = 'release_field'",
    [app.id],
  );
  let count = 0;
  let fraction: number | null = null;
  for (const r of rows) {
    if (String(r.target) === 'user_fraction') {
      const n = Number(r.value_text);
      fraction = Number.isFinite(n) ? n : null;
      continue;
    }
    if (direct) continue;
    if (
      r.pushed_hash === null ||
      r.pushed_hash === undefined ||
      String(r.pushed_hash) !== String(r.value_hash)
    )
      count++;
  }
  return { count, fraction };
}

function previewOf(
  ctx: ReleaseContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    request: ReleaseRequest;
    state: ReleaseState;
    inFlight: InFlight;
    unpushed: { count: number; fraction: number | null };
    stepUpCovers?: boolean | undefined;
  },
): ReleasePreview {
  const { app, request, state } = input;
  const checks = split(
    evaluateReleaseChecks({
      request,
      state,
      inFlight: input.inFlight,
      unpushedFields: input.unpushed.count,
      stagedFraction: input.unpushed.fraction,
    }),
  );
  const phrase = checks.canRelease ? confirmationPhraseOf(app, request, state) : null;
  const apple = state.store === 'appstoreconnect';
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    request: publicRequest(request),
    version: apple ? state.version : null,
    build: apple ? state.build : null,
    phasedRelease: apple ? state.phasedRelease : null,
    track: apple ? null : state.track,
    release:
      apple || state.release === null
        ? null
        : {
            name: state.release.name,
            status: state.release.status,
            versionCodes: state.release.versionCodes,
            notes: state.release.notes,
          },
    others: apple
      ? []
      : state.others.map((o) => ({
          name: o.name,
          status: o.status,
          userFraction: o.userFraction,
          versionCodes: o.versionCodes,
        })),
    audience: audienceOf(state, request),
    direct:
      apple || request.build === undefined
        ? null
        : {
            creates: state.creates,
            versionCodes: request.versionCodes ?? state.release?.versionCodes ?? [],
            name: request.build.name,
            notesLanguages: [
              ...new Set(
                request.build.notes.filter((n) => n.text.trim() !== '').map((n) => n.locale),
              ),
            ],
            summary: directSummaryOf(request, state),
          },
    irreversible: irreversibleOf(state, request),
    releases: true,
    checks,
    confirmHash:
      checks.canRelease && phrase !== null
        ? releaseConfirmHash({ workspaceId: input.workspaceId, app, request, state })
        : null,
    confirmation:
      phrase !== null
        ? { phrase, instruction: `Type "${phrase}" to confirm. This cannot be undone from here.` }
        : null,
    confirmationRequired: input.stepUpCovers !== true,
    readAt: ctx.now(),
  };
}

/** `POST .../store-release/preview`: reads the store and shows what would be released, to whom, and what stands in the way. Writes nothing. */
export async function previewRelease(
  ctx: ReleaseContext,
  input: ReleaseInput & {
    workspaceId: string;
    appId: string;
    actor: Actor;
    stepUpCovers?: boolean | undefined;
  },
): Promise<{ ok: true; preview: ReleasePreview } | Failure> {
  if (!ctx.releaseEnabled) return releaseDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const resolved = await resolveDirect(ctx.db, app, input);
  if (!resolved.ok) return resolved;
  const asked = requestOfInput(app, resolved.input);
  if (!asked.ok) return asked;
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return connected;
  const { connection } = connected;
  let state: ReleaseState;
  try {
    state = await withConnector(ctx, connection.input, (connector) =>
      connector.readReleaseState(asked.request),
    );
  } catch (error) {
    if (error instanceof ReleaseTimeout)
      return failure(
        504,
        'timeout',
        'The store did not answer in time. Nothing was changed.',
        coded('store.noAnswerNothingChanged'),
      );
    return mapStoreError(error, connection.secret).failure;
  }
  await clearUnknown(ctx.db, app);
  const inFlight = await inFlightOf(ctx, app);
  const unpushed = await unpushedFieldsOf(ctx.db, app, asked.request.build !== undefined);
  return {
    ok: true,
    preview: previewOf(ctx, {
      workspaceId: input.workspaceId,
      app,
      request: asked.request,
      state,
      inFlight,
      unpushed,
      stepUpCovers: input.stepUpCovers,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Apply

export type ReleaseResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  request: ReleaseRequest;
  version: { id: string; versionString: string | null } | null;
  track: string | null;
  /** App Store: the release request Apple created, when it said. Google Play: null. */
  releaseRequestId: string | null;
  via: 'release_request' | 'edit_commit';
  audience: ReleasePreview['audience'];
  /** Always true. */
  released: true;
  /** True when the store did not answer and reading it back showed the release. */
  confirmedByReread: boolean;
  releasedAt: number;
  note: string;
};

const NOTE_IOS =
  'The version was released. Follow its availability in App Store Connect: it can take a while to show.';
const NOTE_PLAY =
  'The release was sent to Google Play. Follow it in Play Console: whether it waits for review first is not shown by the API.';

async function auditFailed(
  ctx: ReleaseContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  request: ReleaseRequest,
  extra: Record<string, unknown>,
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'store.release_failed',
    target: { type: 'app', id: app.id },
    // Ids, a share and outcomes: never a text, a credential, a token or a store response.
    detail: {
      appId: app.id,
      store: storeFor(app.platform),
      platform: app.platform,
      ...(request.track ? { track: request.track } : {}),
      ...(request.userFraction !== undefined ? { userFraction: request.userFraction } : {}),
      hash: input.confirmHash,
      ...extra,
    },
    at: ctx.now(),
  });
}

async function succeed(
  ctx: ReleaseContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  s: {
    app: ManagedApp;
    claim: Claim;
    request: ReleaseRequest;
    before: ReleaseState;
    releaseRequestId: string | null;
    via: ReleaseResult['via'];
    reread: boolean;
    cause?: string;
  },
): Promise<{ ok: true; result: ReleaseResult }> {
  const at = ctx.now();
  emitCacheEvent('release_changed', { workspaceId: input.workspaceId, appId: s.app.id });
  const store = storeFor(s.app.platform);
  const apple = s.before.store === 'appstoreconnect';
  const version =
    s.before.store === 'appstoreconnect' && s.before.version !== null
      ? { id: s.before.version.id, versionString: s.before.version.versionString }
      : null;
  const track = s.before.store === 'googleplay' ? s.before.track : null;
  const codes =
    s.before.store === 'googleplay' && s.before.release ? s.before.release.versionCodes : [];
  await ctx.db.transaction(async (tx) => {
    if (track && codes.length > 0)
      await markReleasedHere(tx, s.app, track, codes, s.request.userFraction === 1, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'store.released',
      target: { type: 'app', id: s.app.id },
      detail: {
        appId: s.app.id,
        store,
        platform: s.app.platform,
        ...(version ? { versionId: version.id } : {}),
        ...(track ? { track, versionCodes: codes } : {}),
        ...(s.request.userFraction !== undefined ? { userFraction: s.request.userFraction } : {}),
        ...(s.releaseRequestId ? { releaseRequestId: s.releaseRequestId } : {}),
        ...(s.request.build !== undefined
          ? { direct: true, created: s.before.store === 'googleplay' && s.before.creates }
          : {}),
        via: s.via,
        confirmedByReread: s.reread,
        hash: input.confirmHash,
        ...(s.cause ? { cause: s.cause } : {}),
      },
      at,
    });
    await emitEvent(tx, {
      workspaceId: input.workspaceId,
      type: 'release.started',
      subject: { appId: s.app.id },
      payload: {
        appId: s.app.id,
        store,
        platform: s.app.platform,
        ...(version?.versionString ? { versionString: version.versionString } : {}),
        ...(track ? { track, versionCodes: codes } : {}),
        ...(s.request.userFraction !== undefined ? { userFraction: s.request.userFraction } : {}),
        via: s.via,
        confirmedByReread: s.reread,
        actor: { type: input.actor.type, id: input.actor.id },
      },
      at,
    });
  });
  await releaseClaim(ctx.db, s.claim);
  return {
    ok: true,
    result: {
      app: { id: s.app.id, name: s.app.name, platform: s.app.platform, store },
      request: publicRequest(s.request),
      version,
      track,
      releaseRequestId: s.releaseRequestId,
      via: s.via,
      audience: audienceOf(s.before, s.request),
      released: true,
      confirmedByReread: s.reread,
      releasedAt: at,
      note: apple ? NOTE_IOS : NOTE_PLAY,
    },
  };
}

/** After a lost answer: does the store show the release? */
function showsRelease(
  before: ReleaseState,
  current: ReleaseState,
): 'released' | 'still_waiting' | 'unclear' {
  if (
    before.store === 'appstoreconnect' &&
    current.store === 'appstoreconnect' &&
    before.version !== null
  ) {
    const name = before.version.versionString;
    const same = current.versions.filter((v) => v.versionString === name);
    if (same.length === 0) return 'unclear';
    if (same.some((v) => v.state === APPLE_RELEASABLE_STATE)) return 'still_waiting';
    return 'released';
  }
  if (before.store === 'googleplay' && current.store === 'googleplay' && before.release !== null) {
    const wanted = [...before.release.versionCodes].sort().join(',');
    const same = (r: { versionCodes: string[] }) => [...r.versionCodes].sort().join(',') === wanted;
    if (
      current.others.some((r) => same(r) && (r.status === 'inProgress' || r.status === 'completed'))
    )
      return 'released';
    if (current.release !== null && same(current.release)) return 'still_waiting';
  }
  return 'unclear';
}

/**
 * `POST .../store-release`: re-reads the store, checks it is still what `confirmHash` was made from, that nothing blocks and that the
 * typed phrase is right, writes once. See the file comment. Never retried.
 */
export async function applyRelease(
  ctx: ReleaseContext,
  input: ReleaseInput & {
    workspaceId: string;
    appId: string;
    confirmHash: string;
    confirmation: string;
    actor: Actor;
    /** A person's own confirmation stands in for the typed phrase (the route checked the grant). */
    stepUpCovers?: boolean | undefined;
  },
): Promise<{ ok: true; result: ReleaseResult } | Failure> {
  if (!ctx.releaseEnabled) return releaseDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const resolved = await resolveDirect(db, app, input);
  if (!resolved.ok) return resolved;
  const asked = requestOfInput(app, resolved.input);
  if (!asked.ok) return asked;
  const request = asked.request;
  // Google Play: the phrase needs no store read, so a wrong one is refused before anything else.
  const early = confirmationPhraseOf(app, request, undefined);
  if (input.stepUpCovers !== true && early !== null && input.confirmation.trim() !== early) {
    return failure(
      422,
      'confirmation_mismatch',
      `The confirmation does not match. Type "${early}" exactly. Nothing was released.`,
      { phrase: early, ...coded('confirm.mismatchReleased', { phrase: early }) },
    );
  }
  const flights = await inFlightOf(ctx, app);
  if (flights.push === 'writing' || flights.submit === 'writing')
    return failure(
      409,
      'write_in_progress',
      'A draft push or a submit for this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.draftOrSubmit'),
    );
  if (flights.push === 'unknown')
    return failure(
      409,
      'push_outcome_unknown',
      'It is not known whether the last draft push reached the store. Preview that push again first (staged changes), then release.',
      coded('publish.unknown.draftBeforeRelease'),
    );
  if (flights.submit === 'unknown')
    return failure(
      409,
      'submit_outcome_unknown',
      'It is not known whether the last submit for review reached the store. Preview that submit again first, then release.',
      coded('publish.unknown.submitBeforeRelease'),
    );

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
  const unpushed = await unpushedFieldsOf(db, app, request.build !== undefined);

  let accepted: ReleaseState | undefined;
  let blocked: ReleaseChecks | undefined;
  let wrongPhrase: string | undefined;
  let unknown: { cause: string } | undefined;
  let done: Awaited<ReturnType<StoreReleaseConnector['release']>> | undefined;
  try {
    done = await withConnector(ctx, connection.input, (connector) =>
      connector.release({
        request,
        guard: (current) => {
          const checks = split(
            evaluateReleaseChecks({
              request,
              state: current,
              inFlight: { release: null, push: null, submit: null },
              unpushedFields: unpushed.count,
              stagedFraction: unpushed.fraction,
            }),
          );
          if (!checks.canRelease) {
            blocked = checks;
            return false;
          }
          const phrase = confirmationPhraseOf(app, request, current);
          if (
            input.stepUpCovers !== true &&
            (phrase === null || input.confirmation.trim() !== phrase)
          ) {
            wrongPhrase = phrase ?? '';
            return false;
          }
          const same =
            releaseConfirmHash({ workspaceId: input.workspaceId, app, request, state: current }) ===
            input.confirmHash;
          if (same) accepted = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof ReleaseDriftError) {
      if (blocked) {
        await auditFailed(ctx, input, app, request, {
          code: 'blocked',
          outcome: 'refused',
          blocking: blocked.blocking.map((b) => b.code).slice(0, 20),
        });
        await releaseClaim(db, claim);
        return failure(
          409,
          'blocked',
          'Something stands in the way of releasing, so nothing was released. See `checks`.',
          { checks: blocked, ...coded('publish.blocked.release') },
        );
      }
      if (wrongPhrase !== undefined) {
        await auditFailed(ctx, input, app, request, {
          code: 'confirmation_mismatch',
          outcome: 'refused',
        });
        await releaseClaim(db, claim);
        return failure(
          422,
          'confirmation_mismatch',
          `The confirmation does not match. Type "${wrongPhrase}" exactly. Nothing was released.`,
          { phrase: wrongPhrase, ...coded('confirm.mismatchReleased', { phrase: wrongPhrase }) },
        );
      }
      await auditFailed(ctx, input, app, request, { code: 'state_changed', outcome: 'refused' });
      await releaseClaim(db, claim);
      return failure(
        409,
        'state_changed',
        'The store changed since this was previewed, so nothing was released. Review the new preview and confirm it.',
        {
          preview: previewOf(ctx, {
            workspaceId: input.workspaceId,
            app,
            request,
            state: error.current,
            inFlight: { release: null, push: null, submit: null },
            unpushed,
            stepUpCovers: input.stepUpCovers,
          }),
          ...coded('publish.changedSinceRelease'),
        },
      );
    }
    if (error instanceof ReleaseOutcomeUnknownError || error instanceof ReleaseTimeout) {
      unknown = { cause: error instanceof ReleaseTimeout ? 'timeout' : 'network' };
    } else {
      const mapped = mapStoreError(error, connection.secret);
      await auditFailed(ctx, input, app, request, { code: mapped.code, outcome: 'failed' });
      await releaseClaim(db, claim);
      return mapped.failure;
    }
  }

  if (done)
    return succeed(ctx, input, {
      app,
      claim,
      request,
      before: done.before,
      releaseRequestId: done.releaseRequestId,
      via: done.via,
      reread: false,
    });

  // ----- an unknown outcome is checked, not sent again
  const cause = unknown?.cause ?? 'unknown';
  let current: ReleaseState | undefined;
  try {
    current = await withConnector(ctx, connection.input, (connector) =>
      connector.readReleaseState(request),
    );
  } catch {
    current = undefined;
  }
  if (current === undefined || accepted === undefined) {
    await markUnknown(db, claim);
    await auditFailed(ctx, input, app, request, {
      code: cause,
      outcome: 'unknown',
      readBack: 'failed',
    });
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the release reached the store: the store did not answer and could not be read back. Look at the app in App Store Connect or Play Console, then preview again. Nothing is released until you confirm a new preview.',
      coded('publish.unknown.releaseReached'),
    );
  }
  const shown = showsRelease(accepted, current);
  if (shown === 'released')
    return succeed(ctx, input, {
      app,
      claim,
      request,
      before: accepted,
      releaseRequestId: null,
      via: byFamily(app.platform, { apple: 'release_request', google: 'edit_commit' }),
      reread: true,
      cause,
    });
  if (shown === 'still_waiting' && !supports(app.platform, 'transactionalEdits')) {
    await auditFailed(ctx, input, app, request, { code: 'not_applied', outcome: 'failed', cause });
    await releaseClaim(db, claim);
    return failure(
      502,
      'write_failed',
      'The store did not answer, and reading it back shows the version is still waiting for release. Nothing was released as far as the store shows. Preview again to try again.',
      { outcome: 'not_applied', ...coded('publish.releaseNotApplied') },
    );
  }
  // Google Play: a committed edit can take a while to show, so the old draft is not proof. Anything else unclear stays unknown.
  await markUnknown(db, claim);
  await auditFailed(ctx, input, app, request, {
    code: shown === 'still_waiting' ? 'not_visible' : 'unclear',
    outcome: 'unknown',
    cause,
  });
  return failure(
    409,
    'outcome_unknown',
    supports(app.platform, 'transactionalEdits')
      ? 'Google Play did not answer, and the track does not show the release yet. A commit can take a while to show: check Play Console, then preview again. Nothing is released until you confirm a new preview.'
      : 'It is not known whether the version was released: the store did not answer and its state is unclear. Look at the app in App Store Connect, then preview again. Nothing is released until you confirm a new preview.',
  );
}
