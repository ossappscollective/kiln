import { createHash } from 'node:crypto';
import {
  APPLE_ROLLOUT_ACTIONS,
  AppleRolloutConnector,
  type AppleRolloutState,
  type AppleRolloutTarget,
  appleScope,
  connectorFactory,
  isMarketingVersion,
  isPlayTrackName,
  isVersionCode,
  normalizeFraction,
  PLAY_ROLLOUT_ACTIONS,
  PlayRolloutConnector,
  type PlayRolloutState,
  type PlayRolloutTarget,
  planAppleRollout,
  planPlayRollout,
  type RolloutChange,
  RolloutDriftError,
  RolloutOutcomeUnknownError,
  type RolloutPlan,
  type RolloutState,
  type RolloutTarget,
  redactSecrets,
  rolloutKey,
  type StoreConnectorInput,
  StoreError,
  StoreRateLimitError,
  type StoreRolloutConnector,
  sameRolloutState,
  secretStrings,
} from '@kiln/connectors';
import { type ActorType, needsStoreAppId, type Platform, supports } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded, messageCoding } from '../../i18n/problem.ts';
import { credentialKindFor, getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import { storeBody } from './store-failure.ts';

/**
 * Changing a LIVE ROLLOUT in a store: a STORE WRITE (what users receive). The design copies the one
 * of review replies (docs/adr/0007-review-replies.md) and is written down in
 * docs/adr/0008-store-rollout-writes.md and docs/api/rollout.md:
 *
 * - Off unless `rolloutEnabled` (KILN_STORE_ROLLOUT_ENABLED): every function here answers
 *   `409 rollout_disabled` and no connector is ever built.
 * - Preview, then apply. The preview reads the live state and returns it with the proposed change
 *   and `confirmHash`, a SHA-256 over the app, the target, the change and the state that was read.
 *   Apply needs that hash and RE-READS the store right before writing: if the state is not the one
 *   the person saw, nothing is written (`409 state_changed`, with the new state and a new hash).
 * - One write in flight per app and platform, decided by the database (`store_rollout_claims`), so
 *   it holds across processes. A claim that expired is not trusted, but the re-read and the hash
 *   make a repeated change refuse itself.
 * - Never retried. A timeout, a cut connection or a 5xx on the write may mean the store applied it:
 *   the state is read back. Shows the change: `applied` (confirmedByReread). Shows the old state:
 *   Apple, `failed` (not applied); Play, unknown (a commit can be slow to show). Unreadable:
 *   `outcome_unknown`, which blocks writing until a preview (a successful read) clears it.
 * - Only increases: the Play share never goes down (except halt, which keeps it); Apple has no
 *   un-release. These rules are pure and live in the connectors package (`planPlayRollout`,
 *   `planAppleRollout`) so the preview, the apply and the connector agree.
 * - Audit (`release.rollout_changed`, `release.rollout_failed`) and the event
 *   `release.rollout_changed` hold ids and values (action, track or version, share or state before
 *   and after, the hash). Never a credential, a token or a store response body.
 * - Nothing calls this but the routes, one app per request: there is no bulk, scheduled or
 *   automatic rollout change.
 */

type Actor = { type: ActorType; id: string };

export const ROLLOUT_ENV = 'KILN_STORE_ROLLOUT_ENABLED';
export const ROLLOUT_PURPOSE = 'release.rollout';
export const DEFAULT_ROLLOUT_TIMEOUT_MS = 90_000;
export const DEFAULT_ROLLOUT_CLAIM_TTL_MS = 180_000;

// ---------------------------------------------------------------------------------------------
// Context

export type RolloutConnectorInput = StoreConnectorInput;

export type RolloutConnectorFactory = (input: RolloutConnectorInput) => StoreRolloutConnector;

export const defaultRolloutConnectorFactory: RolloutConnectorFactory =
  connectorFactory<StoreRolloutConnector>({
    app_store_connect: (input) =>
      AppleRolloutConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        platform: appleScope(input),
        fetch: input.fetch,
      }),
    google_play: (input) =>
      new PlayRolloutConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export type RolloutContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** KILN_STORE_ROLLOUT_ENABLED. */
  rolloutEnabled: boolean;
  rolloutConnectorFactory: RolloutConnectorFactory;
  /** Longest one store operation (a read, or a whole write) may take. Default 90 seconds. */
  rolloutTimeoutMs?: number;
  /** How long a write in flight is trusted. Default 3 minutes. */
  claimTtlMs?: number;
};

// ---------------------------------------------------------------------------------------------
// The request

/** What a client sends: the action and which release or version it is about. */
export type RolloutRequest = {
  action: string;
  /** Google Play. */
  track?: string | undefined;
  versionCodes?: string[] | undefined;
  /** App Store. */
  version?: string | undefined;
  /** Google Play `set_fraction` (required) and `resume` (optional): 0 < share < 1. */
  userFraction?: number | undefined;
};

const invalid = (message: string, field: string): Failure =>
  failure(422, 'invalid_rollout', message, { field });

/** The target of a request for an app of this platform, or why not. Also used for the state read. */
export function parseRolloutTarget(
  platform: Platform,
  input: {
    track?: string | undefined;
    versionCodes?: string[] | undefined;
    version?: string | undefined;
  },
): { ok: true; target: RolloutTarget } | Failure {
  if (supports(platform, 'releaseTracks')) {
    if (input.version !== undefined)
      return invalid(
        'A Google Play release is named by track and versionCodes, not by version.',
        'version',
      );
    if (input.track === undefined || !isPlayTrackName(input.track))
      return invalid('A track is required, for example production.', 'track');
    const codes = input.versionCodes;
    if (
      codes === undefined ||
      codes.length === 0 ||
      codes.length > 50 ||
      !codes.every(isVersionCode)
    ) {
      return invalid(
        'versionCodes is required: one to fifty version codes (digits), exactly those of the release.',
        'versionCodes',
      );
    }
    const target: PlayRolloutTarget = {
      track: input.track,
      versionCodes: [...new Set(codes)].sort(),
    };
    return { ok: true, target };
  }
  if (input.track !== undefined || input.versionCodes !== undefined) {
    return invalid(
      'An App Store version is named by version, not by track or versionCodes.',
      input.track !== undefined ? 'track' : 'versionCodes',
    );
  }
  if (input.version === undefined || !isMarketingVersion(input.version))
    return invalid('version is required, for example 2.4.0.', 'version');
  const target: AppleRolloutTarget = { version: input.version };
  return { ok: true, target };
}

/** The target and the change of a request for an app of this platform, or why not. */
export function parseRolloutRequest(
  platform: Platform,
  request: RolloutRequest,
): { ok: true; target: RolloutTarget; change: RolloutChange } | Failure {
  const target = parseRolloutTarget(platform, request);
  if (!target.ok) return target;
  if (supports(platform, 'releaseTracks')) {
    const action = PLAY_ROLLOUT_ACTIONS.find((a) => a === request.action);
    if (!action)
      return invalid(
        `action must be one of ${PLAY_ROLLOUT_ACTIONS.join(', ')} for Google Play.`,
        'action',
      );
    if (action === 'set_fraction' || action === 'resume') {
      if (request.userFraction === undefined) {
        return action === 'set_fraction'
          ? invalid(
              'userFraction is required: more than 0 and less than 1, for example 0.2.',
              'userFraction',
            )
          : { ok: true, target: target.target, change: { action } };
      }
      const fraction = normalizeFraction(request.userFraction);
      if (fraction === undefined)
        return invalid(
          'userFraction must be more than 0 and less than 1, for example 0.2. To reach everyone, use complete.',
          'userFraction',
        );
      return { ok: true, target: target.target, change: { action, userFraction: fraction } };
    }
    if (request.userFraction !== undefined)
      return invalid(`userFraction does not apply to ${action}.`, 'userFraction');
    return { ok: true, target: target.target, change: { action } };
  }
  const action = APPLE_ROLLOUT_ACTIONS.find((a) => a === request.action);
  if (!action)
    return invalid(
      `action must be one of ${APPLE_ROLLOUT_ACTIONS.join(', ')} for the App Store.`,
      'action',
    );
  if (request.userFraction !== undefined)
    return invalid(
      'Apple decides the share of a phased release: it cannot be set.',
      'userFraction',
    );
  return { ok: true, target: target.target, change: { action } };
}

// ---------------------------------------------------------------------------------------------
// The confirmation hash

/**
 * What the person confirms: this app, this target, this change, from this state. Informational
 * fields of the state that move by themselves (Apple's day number) are not part of it.
 */
export function rolloutConfirmHash(input: {
  workspaceId: string;
  app: { id: string; platform: Platform };
  target: RolloutTarget;
  change: RolloutChange;
  current: RolloutState;
}): string {
  const body = JSON.stringify({
    v: 1,
    workspaceId: input.workspaceId,
    appId: input.app.id,
    platform: input.app.platform,
    target: input.target,
    change: input.change,
    current: rolloutKey(input.current),
  });
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The few values of a state that an audit entry and an event carry. */
function summary(state: RolloutState): Record<string, unknown> {
  return state.store === 'googleplay'
    ? { status: state.status, userFraction: state.userFraction }
    : { phasedReleaseState: state.phasedReleaseState };
}

function targetDetail(state: RolloutState): Record<string, unknown> {
  return state.store === 'googleplay'
    ? { track: state.track, versionCodes: state.versionCodes }
    : { version: state.version, storeVersionId: state.storeVersionId };
}

// ---------------------------------------------------------------------------------------------
// Failures

const disabled = (): Failure =>
  failure(
    409,
    'rollout_disabled',
    `Changing a store rollout is switched off on this server. Set ${ROLLOUT_ENV}=true to turn it on (see docs/deployment.md).`,
    { envName: ROLLOUT_ENV },
  );

/** The `409 rollout_disabled` answer, for routes that check the kill switch before anything else. */
export const rolloutDisabledFailure = disabled;

const clean = (text: string, secret: string) =>
  redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, 500);

type Mapped = { failure: Failure; code: string };

/** A store refusal as an answer to the person. Everything here means NOTHING was changed. `secret` is only used to redact. */
function mapStoreError(error: unknown, secret: string): Mapped {
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Mapped => ({
    code,
    failure: {
      ...failure(status, code, clean(message, secret), {
        ...extra,
        ...messageCoding(error, message),
        ...storeBody(error, secret),
      }),
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
      case 'invalid_input':
        return make(422, 'invalid_rollout', error.message);
      case 'changes_in_review':
        return make(409, 'changes_in_review', error.message);
      case 'server':
      case 'network':
      case 'edit_invalid':
        return make(502, 'store_unavailable', `${error.message} Nothing was changed.`);
      default:
        // The store looked at the request and said no (a 4xx), so nothing was changed.
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
    'The change could not be made. Nothing was changed that this server knows of.',
  );
}

class RolloutTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: RolloutContext,
  input: Omit<RolloutConnectorInput, 'fetch'>,
  job: (connector: StoreRolloutConnector) => Promise<T>,
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
      reject(new RolloutTimeout('timeout'));
    }, ctx.rolloutTimeoutMs ?? DEFAULT_ROLLOUT_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.rolloutConnectorFactory({ ...input, fetch: guardedFetch }));
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
  ctx: RolloutContext,
  input: { workspaceId: string; app: ManagedApp; action: string; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_ROLLOUT_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const insert = () =>
    db.execute(
      `INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, ?, 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.action, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM store_rollout_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) {
    // Settled between the insert and the read.
    return (await insert()) === 1
      ? { ok: true, claim }
      : failure(
          409,
          'write_in_progress',
          'A rollout change for this app is in progress. Wait for it to finish.',
          coded('publish.inProgress.rollout'),
        );
  }
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last rollout change of this app reached the store. Preview the rollout again: that reads the store and shows where it stands. Nothing is changed until you confirm a new preview.',
      coded('publish.unknown.rollout'),
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) {
    return failure(
      409,
      'write_in_progress',
      'A rollout change for this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.rollout'),
    );
  }
  // A write that started long ago and never finished (a process died): its outcome is unknown, so it
  // is not trusted, but the re-read and the hash refuse a change that no longer fits the store's state.
  const taken = await db.execute(
    `UPDATE store_rollout_claims SET claim_at = ?, claimed_by = ?, action = ?, workspace_id = ?
      WHERE app_id = ? AND platform = ? AND status = 'writing' AND claim_at = ?`,
    [
      claim.at,
      input.actor.id,
      input.action,
      input.workspaceId,
      claim.appId,
      claim.platform,
      startedAt,
    ],
  );
  return taken === 1
    ? { ok: true, claim }
    : failure(
        409,
        'write_in_progress',
        'A rollout change for this app is in progress. Wait for it to finish.',
        coded('publish.inProgress.rollout'),
      );
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_rollout_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );

const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE store_rollout_claims SET status = 'unknown' WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );

/** A successful read of the store settles an unknown outcome: the person sees where things stand. */
const clearUnknown = (sql: Sql, app: ManagedApp) =>
  sql.execute(
    "DELETE FROM store_rollout_claims WHERE app_id = ? AND platform = ? AND status = 'unknown'",
    [app.id, app.platform],
  );

// ---------------------------------------------------------------------------------------------
// Connection

type Connection = { input: Omit<RolloutConnectorInput, 'fetch'>; secret: string };

/** The credential of the app, decrypted for one use; or the failure to answer with (nothing was asked of the store). */
async function connect(
  ctx: RolloutContext,
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
  if (String(credential.kind) !== credentialKindFor[app.platform]) {
    return failure(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
      coded('credential.wrongKind'),
    );
  }
  if (needsStoreAppId(app.platform) && !app.storeAppId) {
    return failure(
      422,
      'app_not_synced',
      'The App Store id of this app is not known yet. Sync the app first.',
      coded('app.storeIdUnknown'),
    );
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: ROLLOUT_PURPOSE },
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

/** Reads the state of the target from the store. A failure is the answer to give. Changes nothing. */
async function readLive(
  ctx: RolloutContext,
  connection: Connection,
  target: RolloutTarget,
): Promise<{ ok: true; state: RolloutState } | Failure> {
  try {
    const state = await withConnector(ctx, connection.input, (connector) =>
      connector.readState(target),
    );
    return { ok: true, state };
  } catch (error) {
    if (error instanceof RolloutTimeout)
      return failure(
        504,
        'timeout',
        'The store did not answer in time. Nothing was changed.',
        coded('store.noAnswerNothingChanged'),
      );
    return mapStoreError(error, connection.secret).failure;
  }
}

// ---------------------------------------------------------------------------------------------
// Config

export type RolloutConfig = {
  enabled: boolean;
  envName: string;
  actions: { android: readonly string[]; ios: readonly string[] };
  irreversible: readonly string[];
  /** Google Play: a share is more than `exclusiveMin` and less than `exclusiveMax`, and only goes up. */
  fraction: { exclusiveMin: number; exclusiveMax: number };
};

export const rolloutConfig = (ctx: Pick<RolloutContext, 'rolloutEnabled'>): RolloutConfig => ({
  enabled: ctx.rolloutEnabled,
  envName: ROLLOUT_ENV,
  actions: { android: PLAY_ROLLOUT_ACTIONS, ios: APPLE_ROLLOUT_ACTIONS },
  irreversible: ['complete', 'release_to_all'],
  fraction: { exclusiveMin: 0, exclusiveMax: 1 },
});

// ---------------------------------------------------------------------------------------------
// State and preview

export type AllowedAction = {
  action: string;
  allowed: boolean;
  reason?: string;
  irreversible: boolean;
};

export type RolloutStateView = {
  app: { id: string; name: string; platform: Platform; store: string };
  current: RolloutState;
  /** What could be changed from here. `set_fraction` needs a share above `minUserFraction`. */
  allowedActions: AllowedAction[];
  minUserFraction: number | null;
  readAt: number;
};

const planFor = (state: RolloutState, change: RolloutChange): RolloutPlan =>
  state.store === 'googleplay'
    ? planPlayRollout(state as PlayRolloutState, change as Parameters<typeof planPlayRollout>[1])
    : planAppleRollout(
        state as AppleRolloutState,
        change as Parameters<typeof planAppleRollout>[1],
      );

function allowedActionsOf(state: RolloutState): AllowedAction[] {
  const probes: RolloutChange[] =
    state.store === 'googleplay'
      ? [
          {
            action: 'set_fraction',
            userFraction: normalizeFraction(((state.userFraction ?? 0) + 1) / 2) ?? 0.5,
          },
          { action: 'halt' },
          { action: 'resume' },
          { action: 'complete' },
        ]
      : APPLE_ROLLOUT_ACTIONS.map((action) => ({ action }));
  return probes.map((change) => {
    const plan = planFor(state, change);
    return plan.ok
      ? { action: change.action, allowed: true, irreversible: plan.irreversible }
      : { action: change.action, allowed: false, reason: plan.message, irreversible: false };
  });
}

type Loaded = { app: ManagedApp; connection: Connection };

async function load(
  ctx: RolloutContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<({ ok: true } & Loaded) | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return connected;
  return { ok: true, app, connection: connected.connection };
}

/** `GET .../rollout/state`: where the release stands in the store, and what may be done from there. Changes nothing. */
export async function readRolloutState(
  ctx: RolloutContext,
  input: {
    workspaceId: string;
    appId: string;
    target: {
      track?: string | undefined;
      versionCodes?: string[] | undefined;
      version?: string | undefined;
    };
    actor: Actor;
  },
): Promise<{ ok: true; state: RolloutStateView } | Failure> {
  if (!ctx.rolloutEnabled) return disabled();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const target = parseRolloutTarget(app.platform, input.target);
  if (!target.ok) return target;
  const loaded = await load(ctx, input);
  if (!loaded.ok) return loaded;
  const read = await readLive(ctx, loaded.connection, target.target);
  if (!read.ok) return read;
  await clearUnknown(ctx.db, app);
  return {
    ok: true,
    state: {
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      current: read.state,
      allowedActions: allowedActionsOf(read.state),
      minUserFraction: read.state.store === 'googleplay' ? read.state.userFraction : null,
      readAt: ctx.now(),
    },
  };
}

export type RolloutPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  action: string;
  target: RolloutTarget;
  /** The store as it is now. */
  current: RolloutState;
  /** The store as it should be after the change. */
  proposed: RolloutState;
  /** One sentence for the confirmation dialog. */
  summary: string;
  /** True for complete and release to all: nothing here undoes it. */
  irreversible: boolean;
  /** Send this back to apply the change. Valid only while the store still shows `current`. */
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

function warningsFor(state: RolloutState): string[] {
  return state.store === 'googleplay'
    ? [
        'Google Play can take several hours to apply a change to a release.',
        'This server does not cancel a review that is in progress: if changes are in review the change is refused.',
      ]
    : [
        'Apple decides the share per day (1, 2, 5, 10, 20, 50 and 100 percent over seven days): it cannot be set.',
      ];
}

/** `POST .../rollout/preview`: reads the live state and proposes the change. Nothing is written. */
export async function previewRollout(
  ctx: RolloutContext,
  input: { workspaceId: string; appId: string; request: RolloutRequest; actor: Actor },
): Promise<{ ok: true; preview: RolloutPreview } | Failure> {
  if (!ctx.rolloutEnabled) return disabled();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const parsed = parseRolloutRequest(app.platform, input.request);
  if (!parsed.ok) return parsed;
  const loaded = await load(ctx, input);
  if (!loaded.ok) return loaded;
  const read = await readLive(ctx, loaded.connection, parsed.target);
  if (!read.ok) return read;
  await clearUnknown(ctx.db, app);
  const plan = planFor(read.state, parsed.change);
  if (!plan.ok) {
    return failure(
      422,
      plan.code === 'invalid_fraction' ? 'invalid_rollout' : 'rollout_not_allowed',
      plan.message,
      {
        reason: plan.code,
        current: read.state,
        allowedActions: allowedActionsOf(read.state),
      },
    );
  }
  return {
    ok: true,
    preview: {
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      action: parsed.change.action,
      target: parsed.target,
      current: read.state,
      proposed: plan.proposed,
      summary: plan.summary,
      irreversible: plan.irreversible,
      confirmHash: rolloutConfirmHash({
        workspaceId: input.workspaceId,
        app,
        target: parsed.target,
        change: parsed.change,
        current: read.state,
      }),
      warnings: warningsFor(read.state),
      readAt: ctx.now(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Apply

export type RolloutResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  action: string;
  before: RolloutState;
  after: RolloutState;
  irreversible: boolean;
  /** True when the write's outcome was unknown and reading the store back showed the change. */
  confirmedByReread: boolean;
  appliedAt: number;
  /** Google Play can take hours; the stored copy of the app's releases is refreshed by the next sync. */
  note: string;
};

const NOTE =
  'The stored copy of this app is refreshed by the next sync. Google Play can take several hours to apply a change.';

/**
 * `POST .../rollout/apply`: re-reads the store, checks it is still what `confirmHash` was made
 * from, writes once. See the file comment.
 */
export async function applyRollout(
  ctx: RolloutContext,
  input: {
    workspaceId: string;
    appId: string;
    request: RolloutRequest;
    confirmHash: string;
    actor: Actor;
  },
): Promise<{ ok: true; result: RolloutResult } | Failure> {
  if (!ctx.rolloutEnabled) return disabled();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const parsed = parseRolloutRequest(app.platform, input.request);
  if (!parsed.ok) return parsed;
  const { target, change } = parsed;
  const appView = {
    id: app.id,
    name: app.name,
    platform: app.platform,
    store: storeFor(app.platform),
  };

  const taken = await takeClaim(ctx, {
    workspaceId: input.workspaceId,
    app,
    action: change.action,
    actor: input.actor,
  });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  // Anything that returns before the write is attempted gives the claim back.
  const stop = async (f: Failure): Promise<Failure> => {
    await releaseClaim(db, claim);
    return f;
  };

  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return stop(connected);
  const { connection } = connected;

  const hashOf = (current: RolloutState) =>
    rolloutConfirmHash({ workspaceId: input.workspaceId, app, target, change, current });
  /** The state the guard accepted: what the person confirmed. */
  let before: RolloutState | undefined;
  let outcome: { before: RolloutState; after: RolloutState } | undefined;
  let unknown: string | undefined;
  try {
    outcome = await withConnector(ctx, connection.input, (connector) =>
      connector.applyChange({
        target,
        change,
        guard: (current) => {
          const same = hashOf(current) === input.confirmHash;
          if (same) before = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof RolloutDriftError) {
      await audit(
        ctx,
        input,
        app,
        change,
        before ?? error.current,
        { code: 'state_changed', outcome: 'refused' },
        'failed',
      );
      await releaseClaim(db, claim);
      const plan = planFor(error.current, change);
      return failure(
        409,
        'state_changed',
        'The store changed since this was previewed, so nothing was changed. Review the current state and preview again.',
        {
          current: error.current,
          ...(plan.ok
            ? {
                proposed: plan.proposed,
                summary: plan.summary,
                irreversible: plan.irreversible,
                confirmHash: hashOf(error.current),
              }
            : {
                reason: plan.code,
                problem: plan.message,
                allowedActions: allowedActionsOf(error.current),
              }),
          ...coded('publish.changedSinceRollout'),
        },
      );
    }
    if (error instanceof RolloutOutcomeUnknownError || error instanceof RolloutTimeout) {
      unknown = error instanceof RolloutTimeout ? 'timeout' : 'network';
    } else {
      const mapped = mapStoreError(error, connection.secret);
      // The guard may not have run (the store refused earlier): there is then no state to report.
      await audit(
        ctx,
        input,
        app,
        change,
        before,
        { code: mapped.code, outcome: 'failed' },
        'failed',
      );
      await releaseClaim(db, claim);
      return mapped.failure;
    }
  }

  if (outcome) {
    return succeed(ctx, input, {
      app: appView,
      change,
      claim,
      before: outcome.before,
      after: outcome.after,
      via: 'store',
    });
  }

  // ----- an unknown outcome is checked, not sent again
  const accepted = before;
  const readBack = await readLive(ctx, connection, target);
  if (!readBack.ok || accepted === undefined) {
    await markUnknown(db, claim);
    await audit(
      ctx,
      input,
      app,
      change,
      accepted,
      {
        code: unknown ?? 'unknown',
        outcome: 'unknown',
        ...(readBack.ok ? {} : { readBack: 'failed' }),
      },
      'failed',
    );
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the change reached the store: the store did not answer and its state could not be read back. Preview the rollout again to see where it stands; nothing is changed until you confirm a new preview.',
      coded('publish.unknown.rolloutReached'),
    );
  }
  const plan = planFor(accepted, change);
  const proposed = plan.ok ? plan.proposed : undefined;
  const current = readBack.state;
  if (proposed && sameRolloutState(current, proposed)) {
    return succeed(ctx, input, {
      app: appView,
      change,
      claim,
      before: accepted,
      after: current,
      via: 'reread',
      cause: unknown ?? 'unknown',
    });
  }
  if (sameRolloutState(current, accepted)) {
    if (!supports(app.platform, 'transactionalEdits')) {
      // Apple changes the state synchronously: the old state means the change was not applied.
      await audit(
        ctx,
        input,
        app,
        change,
        accepted,
        { code: 'not_applied', outcome: 'failed', cause: unknown ?? 'unknown' },
        'failed',
      );
      await releaseClaim(db, claim);
      return failure(
        502,
        'write_failed',
        'The store did not answer, and reading its state back shows the old state, so the change was not applied. Nothing was changed. Preview again to try again.',
        { outcome: 'not_applied', current, ...coded('publish.rolloutNotApplied') },
      );
    }
    // Google Play can be slow to show a committed change: the old state is not proof.
    await markUnknown(db, claim);
    await audit(
      ctx,
      input,
      app,
      change,
      accepted,
      { code: 'not_visible', outcome: 'unknown', cause: unknown ?? 'unknown' },
      'failed',
    );
    return failure(
      409,
      'outcome_unknown',
      'Google Play did not answer, and it still shows the old state. A commit can take a while to show: check Play Console, then preview the rollout again. Nothing is changed until you confirm a new preview.',
      { current, ...coded('publish.playRolloutUnchanged') },
    );
  }
  // Neither the old state nor the asked one: somebody else changed it too. Nothing more is done.
  await audit(
    ctx,
    input,
    app,
    change,
    accepted,
    { code: 'state_changed', outcome: 'diverged', cause: unknown ?? 'unknown' },
    'failed',
  );
  await releaseClaim(db, claim);
  return failure(
    409,
    'state_changed',
    'The store shows a state that is neither the old one nor the requested one. Nothing more was done. Review it and preview again.',
    { current, ...coded('publish.rolloutOther') },
  );
}

async function audit(
  ctx: RolloutContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  change: RolloutChange,
  state: RolloutState | undefined,
  extra: Record<string, unknown>,
  kind: 'failed',
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: kind === 'failed' ? 'release.rollout_failed' : 'release.rollout_changed',
    target: { type: 'app', id: app.id },
    // Ids and values: never a credential, a token or a store response.
    detail: {
      appId: app.id,
      store: storeFor(app.platform),
      platform: app.platform,
      action: change.action,
      ...(change.action === 'set_fraction' ||
      (change.action === 'resume' && 'userFraction' in change)
        ? { requestedUserFraction: (change as { userFraction?: number }).userFraction }
        : {}),
      ...(state ? { ...targetDetail(state), from: summary(state) } : {}),
      hash: input.confirmHash,
      ...extra,
    },
    at: ctx.now(),
  });
}

async function succeed(
  ctx: RolloutContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  s: {
    app: RolloutResult['app'];
    change: RolloutChange;
    claim: Claim;
    before: RolloutState;
    after: RolloutState;
    via: 'store' | 'reread';
    cause?: string;
  },
): Promise<{ ok: true; result: RolloutResult }> {
  const at = ctx.now();
  const irreversible = s.change.action === 'complete' || s.change.action === 'release_to_all';
  await ctx.db.transaction(async (tx) => {
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'release.rollout_changed',
      target: { type: 'app', id: s.app.id },
      detail: {
        appId: s.app.id,
        store: s.app.store,
        platform: s.app.platform,
        action: s.change.action,
        ...targetDetail(s.before),
        from: summary(s.before),
        to: summary(s.after),
        irreversible,
        hash: input.confirmHash,
        via: s.via,
        ...(s.cause ? { cause: s.cause } : {}),
      },
      at,
    });
    // Ids and values only: never a credential, a token or a store response.
    await emitEvent(tx, {
      workspaceId: input.workspaceId,
      type: 'release.rollout_changed',
      subject: { appId: s.app.id },
      payload: {
        appId: s.app.id,
        store: s.app.store,
        platform: s.app.platform,
        action: s.change.action,
        ...targetDetail(s.before),
        from: summary(s.before),
        to: summary(s.after),
        irreversible,
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
      action: s.change.action,
      before: s.before,
      after: s.after,
      irreversible,
      confirmedByReread: s.via === 'reread',
      appliedAt: at,
      note: NOTE,
    },
  };
}
