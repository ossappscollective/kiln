import { createHash } from 'node:crypto';
import {
  AppleVersionConnector,
  CREATABLE_RELEASE_TYPES,
  type CreatableReleaseType,
  StoreError,
  type StoreVersionRow,
  type VersionCreateRequest,
  VersionDriftError,
  type VersionListState,
  VersionOutcomeUnknownError,
} from '@mrm/connectors';
import {
  compareDottedVersions,
  isApplePlatform,
  isDottedVersion,
  newestDottedVersion,
  nextVersion,
  type Platform,
} from '@mrm/core';
import type { Database, Sql } from '@mrm/db';
import { getApp, type ManagedApp } from './apps.ts';
import { recordAudit } from './audit.ts';
import { type Failure, failure } from './repositories.ts';
import { storeFor } from '../modules/reviews/sync.ts';
import { connect, DRAFT_ENV, mapStoreError } from './store-draft.ts';

/**
 * CREATING the next App Store version (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md): the dead end of the
 * release stepper ("no version a build can be attached to"). A STORE WRITE, but a reversible one: the version starts in
 * `PREPARE_FOR_SUBMISSION` and App Store Connect lets a person delete it there. It is gated like the draft push it prepares for:
 *
 * - Off unless `versionEnabled`, which is the draft-write switch (MRM_STORE_DRAFT_WRITE_ENABLED): `409 store_draft_disabled`, no
 *   connector built. The right is `store.push_draft` (checked by the route, with the step-up of that action).
 * - Preview (a store read: the versions of the platform, the checks), then create with the preview's `confirmHash`. The versions are
 *   READ AGAIN right before the write (the guard of the connector): a different list is `409 state_changed` with a new preview, a
 *   blocking check is `409 blocked`. No typed phrase: a draft version can be deleted in App Store Connect.
 * - Refused (checks, data): a version string that is not one to three dotted numbers, one that is not higher than every version the
 *   store lists, one that already exists, and an editable version that already exists for the platform (it is the one to use).
 * - One write in flight per app and platform: the claim table of the draft push (`store_draft_claims`), so a push and a create
 *   exclude each other. Never retried. A lost answer: the versions are read back (`confirmedByReread`) or the answer is
 *   `409 outcome_unknown` (look in App Store Connect; a new preview settles it).
 * - Writes the version only: no text, no build, no review submission, no release. Google Play has no such thing: a version is a
 *   release (`422 not_supported`).
 * - Audit (`store.version_created`, `store.version_create_failed`) holds ids, the version string and hashes. Never a credential,
 *   a token or a store response body.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const VERSION_ENV = DRAFT_ENV;
export const VERSION_PURPOSE = 'store.version_create';
export const DEFAULT_VERSION_TIMEOUT_MS = 120_000;
/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
export const DEFAULT_VERSION_CLAIM_TTL_MS = 300_000;

// ---------------------------------------------------------------------------------------------
// Context

export type VersionConnector = Pick<AppleVersionConnector, 'readVersions' | 'createVersion'>;
export type VersionConnectorInput = {
  secret: string;
  storeAppId: string | null;
  platform?: Platform | undefined;
  /** Aborted when the call times out. Pass it to the connector as its `fetch`. */
  fetch: typeof fetch;
};
export type VersionConnectorFactory = (input: VersionConnectorInput) => VersionConnector;

export const defaultVersionConnectorFactory: VersionConnectorFactory = (input) =>
  AppleVersionConnector.fromSecret(input.secret, {
    appStoreId: input.storeAppId ?? '',
    platform: input.platform === 'macos' ? 'macos' : 'ios',
    fetch: input.fetch,
  });

export type VersionContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_STORE_DRAFT_WRITE_ENABLED. */
  versionEnabled: boolean;
  versionConnectorFactory: VersionConnectorFactory;
  versionTimeoutMs?: number;
  claimTtlMs?: number;
};

export const versionDisabledFailure = (): Failure =>
  failure(
    409,
    'store_draft_disabled',
    `Writing drafts to the stores is switched off on this server. Set ${VERSION_ENV}=true to turn it on (see docs/deployment.md).`,
    { envName: VERSION_ENV },
  );

class VersionTimeout extends Error {}

async function withConnector<T>(
  ctx: VersionContext,
  input: Omit<VersionConnectorInput, 'fetch'>,
  job: (connector: VersionConnector) => Promise<T>,
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
      reject(new VersionTimeout('timeout'));
    }, ctx.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.versionConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The claim: one write in flight per app and platform (the table of the draft push)

type Claim = { appId: string; platform: Platform; at: number };
const ACTION = 'create_version';

async function takeClaim(
  ctx: VersionContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_VERSION_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A draft push or a version for this app is being written. Wait for it to finish.',
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, '${ACTION}', 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, action, claim_at FROM store_draft_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      String(existing.action) === ACTION
        ? 'It is not known whether the last version this app tried to create reached App Store Connect. Look at the app there, then preview again. Nothing is created until you confirm a new preview.'
        : 'It is not known whether the last draft push of this app reached the store. Preview that push again first (staged changes), then create the version.',
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A write that started long ago and never finished (a process died): the re-read and the hash refuse a version that now exists.
  const taken = await db.execute(
    `UPDATE store_draft_claims SET claim_at = ?, claimed_by = ?, workspace_id = ?, action = '${ACTION}'
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
/** A successful read settles an unknown outcome of an earlier create (an unknown draft push is settled by its own preview, not here). */
const clearUnknown = (sql: Sql, app: ManagedApp) =>
  sql.execute(
    `DELETE FROM store_draft_claims WHERE app_id = ? AND platform = ? AND status = 'unknown' AND action = '${ACTION}'`,
    [app.id, app.platform],
  );

// ---------------------------------------------------------------------------------------------
// What is asked, and the checks

export type VersionInput = {
  versionString: string;
  releaseType?: CreatableReleaseType | undefined;
};

export type VersionCheck = { code: string; message: string };
export type VersionChecks = {
  blocking: VersionCheck[];
  warnings: VersionCheck[];
  canCreate: boolean;
};

/** States in which another version is on its way (in review, waiting for release, ...): Apple may refuse a second one. */
const IN_PROGRESS_STATES = new Set([
  'WAITING_FOR_REVIEW',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_DISTRIBUTION',
  'PROCESSING_FOR_APP_STORE',
  'WAITING_FOR_EXPORT_COMPLIANCE',
]);

const label = (v: StoreVersionRow) => `${v.versionString ?? v.id} (${v.state || 'state unknown'})`;

/** The newest version the store lists that cannot be edited: the one the next version has to be higher than. */
export const liveVersionOf = (versions: readonly StoreVersionRow[]): string | null =>
  newestDottedVersion(versions.filter((v) => !v.editable).map((v) => v.versionString));

export function evaluateChecks(request: VersionInput, state: VersionListState): VersionChecks {
  const blocking: VersionCheck[] = [];
  const warnings: VersionCheck[] = [];
  const wanted = request.versionString;
  if (!isDottedVersion(wanted)) {
    blocking.push({
      code: 'invalid_version',
      message:
        'A version is one to three numbers separated by periods, for example 3.1.2. Letters, a leading "v" and suffixes are not allowed.',
    });
  }
  const editable = state.versions.filter((v) => v.editable);
  if (editable.length > 0) {
    blocking.push({
      code: 'editable_version_exists',
      message: `Version ${label(editable[0] as StoreVersionRow)} can still be edited, so there is no need for another. Attach the build to it.`,
    });
  }
  if (isDottedVersion(wanted)) {
    const same = state.versions.filter(
      (v) => v.versionString !== null && compareDottedVersions(v.versionString, wanted) === 0,
    );
    if (same.length > 0) {
      blocking.push({
        code: 'version_exists',
        message: `Version ${label(same[0] as StoreVersionRow)} already exists in App Store Connect.`,
      });
    } else {
      const live = liveVersionOf(state.versions);
      if (live !== null && compareDottedVersions(wanted, live) <= 0) {
        blocking.push({
          code: 'not_higher',
          message: `The new version must be higher than ${live}, the newest version in App Store Connect that cannot be edited.`,
        });
      }
    }
  }
  const going = state.versions.filter((v) => IN_PROGRESS_STATES.has(v.state));
  if (going.length > 0 && editable.length === 0) {
    warnings.push({
      code: 'version_in_progress',
      message: `Version ${label(going[0] as StoreVersionRow)} is in review or waiting to be released. Apple may refuse a new version until it is done.`,
    });
  }
  return { blocking, warnings, canCreate: blocking.length === 0 };
}

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** What the person confirms: this app, the version asked for, and the versions the store lists as they were read. */
export function versionConfirmHash(input: {
  workspaceId: string;
  app: { id: string; platform: Platform };
  request: VersionInput;
  state: VersionListState;
}): string {
  return sha(
    JSON.stringify({
      v: 1,
      workspaceId: input.workspaceId,
      appId: input.app.id,
      platform: input.app.platform,
      versionString: input.request.versionString,
      releaseType: input.request.releaseType ?? null,
      versions: input.state.versions
        .map((v) => `${v.id}|${v.versionString ?? ''}|${v.state}`)
        .sort(),
    }),
  );
}

const requestOf = (input: VersionInput): VersionCreateRequest => ({
  versionString: input.versionString.trim(),
  ...(input.releaseType !== undefined ? { releaseType: input.releaseType } : {}),
});

function ready(app: ManagedApp): Failure | null {
  if (!isApplePlatform(app.platform))
    return failure(
      422,
      'not_supported',
      'Google Play has no versions to create: a version there is a release, made in the release steps.',
    );
  return null;
}

// ---------------------------------------------------------------------------------------------
// Preview

export type VersionPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  request: { versionString: string; releaseType: CreatableReleaseType | null };
  /** The newest version that cannot be edited, as the store lists it (null: none). */
  live: string | null;
  /** The next patch of `live`, or '' when it cannot be told. */
  suggested: string;
  versions: { versionString: string | null; state: string; editable: boolean }[];
  checks: VersionChecks;
  /** Null while a check blocks. */
  confirmHash: string | null;
  /** Always true: a version in Prepare for Submission can be deleted in App Store Connect. */
  reversible: true;
  note: string;
};

const NOTE =
  'Creates an editable draft version in App Store Connect. Nothing is submitted. A version in Prepare for Submission can be deleted in App Store Connect.';

function previewOf(
  workspaceId: string,
  app: ManagedApp,
  request: VersionInput,
  state: VersionListState,
): VersionPreview {
  const checks = evaluateChecks(request, state);
  const live = liveVersionOf(state.versions);
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    request: { versionString: request.versionString, releaseType: request.releaseType ?? null },
    live,
    suggested: nextVersion(live),
    versions: state.versions.map((v) => ({
      versionString: v.versionString,
      state: v.state,
      editable: v.editable,
    })),
    checks,
    confirmHash: checks.canCreate ? versionConfirmHash({ workspaceId, app, request, state }) : null,
    reversible: true,
    note: NOTE,
  };
}

/** A store failure as an answer, with the reasons Apple gave (they say what to fix). */
function mapped(error: unknown, secret: string): { failure: Failure; code: string } {
  const m = mapStoreError(error, secret);
  if (error instanceof StoreError && error.details !== undefined && error.details.length > 0)
    return { ...m, failure: { ...m.failure, body: { ...m.failure.body, details: error.details } } };
  return m;
}

/** `POST .../store-version/preview`: reads the versions of the platform and shows what would be created and what stands in the way. Writes nothing. */
export async function previewVersion(
  ctx: VersionContext,
  input: VersionInput & { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; preview: VersionPreview } | Failure> {
  if (!ctx.versionEnabled) return versionDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const unsupported = ready(app);
  if (unsupported) return unsupported;
  const request = requestOf(input);
  const connected = await connect(ctx, input.workspaceId, app, input.actor, VERSION_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  let state: VersionListState;
  try {
    state = await withConnector(ctx, connection.input, (c) => c.readVersions());
  } catch (error) {
    if (error instanceof VersionTimeout)
      return failure(504, 'timeout', 'The store did not answer in time. Nothing was changed.');
    return mapped(error, connection.secret).failure;
  }
  await clearUnknown(ctx.db, app);
  return { ok: true, preview: previewOf(input.workspaceId, app, request, state) };
}

// ---------------------------------------------------------------------------------------------
// Create

export type VersionResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string | null; versionString: string; state: string };
  /** Always true: the version can be deleted in App Store Connect while it is in Prepare for Submission. */
  reversible: true;
  /** True when the store did not answer and reading it back showed the version. */
  confirmedByReread: boolean;
  warnings: VersionCheck[];
  createdAt: number;
  note: string;
};

async function audit(
  ctx: VersionContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  action: 'store.version_created' | 'store.version_create_failed',
  detail: Record<string, unknown>,
  sql: Sql = ctx.db,
): Promise<void> {
  await recordAudit(sql, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action,
    target: { type: 'app', id: app.id },
    // Ids, the version string the person typed (validated: numbers and periods) and outcomes: never a credential, a token or a
    // store response.
    detail: {
      appId: app.id,
      store: storeFor(app.platform),
      platform: app.platform,
      hash: input.confirmHash,
      ...detail,
    },
    at: ctx.now(),
  });
}

/**
 * `POST .../store-version`: re-reads the versions, checks they are still what `confirmHash` was made from and that nothing blocks,
 * writes once. Never retried.
 */
export async function applyVersion(
  ctx: VersionContext,
  input: VersionInput & {
    workspaceId: string;
    appId: string;
    confirmHash: string;
    actor: Actor;
  },
): Promise<{ ok: true; result: VersionResult } | Failure> {
  if (!ctx.versionEnabled) return versionDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const unsupported = ready(app);
  if (unsupported) return unsupported;
  const request = requestOf(input);
  const taken = await takeClaim(ctx, { workspaceId: input.workspaceId, app, actor: input.actor });
  if (!taken.ok) return taken;
  const claim = taken.claim;
  const stop = async (f: Failure): Promise<Failure> => {
    await releaseClaim(db, claim);
    return f;
  };
  const connected = await connect(ctx, input.workspaceId, app, input.actor, VERSION_PURPOSE);
  if (!connected.ok) return stop(connected);
  const { connection } = connected;
  const view = {
    id: app.id,
    name: app.name,
    platform: app.platform,
    store: storeFor(app.platform),
  };

  let accepted: VersionListState | undefined;
  let blocked: VersionChecks | undefined;
  let created: Awaited<ReturnType<VersionConnector['createVersion']>> | undefined;
  let unknown: { cause: string } | undefined;
  const succeed = async (
    before: VersionListState,
    version: VersionResult['version'],
    reread: boolean,
    cause?: string,
  ): Promise<{ ok: true; result: VersionResult }> => {
    const at = ctx.now();
    await db.transaction(async (tx) => {
      await audit(
        ctx,
        input,
        app,
        'store.version_created',
        {
          ...(version.id ? { versionId: version.id } : {}),
          versionString: request.versionString,
          ...(request.releaseType ? { releaseType: request.releaseType } : {}),
          confirmedByReread: reread,
          ...(cause ? { cause } : {}),
        },
        tx,
      );
    });
    await releaseClaim(db, claim);
    return {
      ok: true,
      result: {
        app: view,
        version,
        reversible: true,
        confirmedByReread: reread,
        warnings: evaluateChecks(request, before).warnings,
        createdAt: at,
        note: 'The version was created as an editable draft. Sync this app, then attach a build to it. Nothing was submitted.',
      },
    };
  };

  try {
    created = await withConnector(ctx, connection.input, (connector) =>
      connector.createVersion({
        request,
        guard: (current) => {
          const checks = evaluateChecks(request, current);
          if (!checks.canCreate) {
            blocked = checks;
            return false;
          }
          const same =
            versionConfirmHash({ workspaceId: input.workspaceId, app, request, state: current }) ===
            input.confirmHash;
          if (same) accepted = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof VersionDriftError) {
      if (blocked) {
        await audit(ctx, input, app, 'store.version_create_failed', {
          code: 'blocked',
          outcome: 'refused',
          blocking: blocked.blocking.map((b) => b.code).slice(0, 10),
        });
        await releaseClaim(db, claim);
        return failure(
          409,
          'blocked',
          'Something stands in the way of creating this version, so nothing was created. See `checks`.',
          { checks: blocked },
        );
      }
      await audit(ctx, input, app, 'store.version_create_failed', {
        code: 'state_changed',
        outcome: 'refused',
      });
      await releaseClaim(db, claim);
      return failure(
        409,
        'state_changed',
        'The versions in App Store Connect changed since this was previewed, so nothing was created. Review the new preview and confirm it.',
        { preview: previewOf(input.workspaceId, app, request, error.current) },
      );
    }
    if (error instanceof VersionOutcomeUnknownError || error instanceof VersionTimeout) {
      unknown = { cause: error instanceof VersionTimeout ? 'timeout' : 'network' };
    } else {
      const m = mapped(error, connection.secret);
      await audit(ctx, input, app, 'store.version_create_failed', {
        code: m.code,
        outcome: 'failed',
      });
      await releaseClaim(db, claim);
      return m.failure;
    }
  }

  if (created) {
    return succeed(
      created.before,
      {
        id: created.version?.id ?? null,
        versionString: created.version?.versionString ?? request.versionString,
        state: created.version?.state || 'PREPARE_FOR_SUBMISSION',
      },
      false,
    );
  }

  // ----- an unknown outcome is checked, not sent again
  const cause = unknown?.cause ?? 'unknown';
  let current: VersionListState | undefined;
  try {
    current = await withConnector(ctx, connection.input, (c) => c.readVersions());
  } catch {
    current = undefined;
  }
  if (current !== undefined && accepted !== undefined) {
    const known = new Set(accepted.versions.map((v) => v.id));
    const found = current.versions.filter(
      (v) =>
        !known.has(v.id) &&
        v.versionString !== null &&
        compareDottedVersions(v.versionString, request.versionString) === 0,
    )[0];
    if (found) {
      return succeed(
        accepted,
        { id: found.id, versionString: request.versionString, state: found.state },
        true,
        cause,
      );
    }
  }
  await markUnknown(db, claim);
  await audit(ctx, input, app, 'store.version_create_failed', {
    code: cause,
    outcome: 'unknown',
    readBack: current === undefined ? 'failed' : 'not_shown',
  });
  return failure(
    409,
    'outcome_unknown',
    'It is not known whether the version was created: App Store Connect did not answer in a way that says. Look at the app in App Store Connect, then preview again. Nothing is created until you confirm a new preview.',
  );
}

export { CREATABLE_RELEASE_TYPES };
