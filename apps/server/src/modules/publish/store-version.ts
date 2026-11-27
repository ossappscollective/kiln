import { createHash } from 'node:crypto';
import {
  AppleVersionConnector,
  CREATABLE_RELEASE_TYPES,
  type CreatableReleaseType,
  type ReviewCarryResult,
  StoreError,
  type StoreVersionRow,
  type VersionCreateRequest,
  VersionDriftError,
  type VersionListState,
  VersionOutcomeUnknownError,
} from '@kiln/connectors';
import {
  createReleaseRules,
  newestNonEditableVersion,
  sameVersion,
  nextVersion,
  type Platform,
  type ReviewSummary,
  supports,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitCacheEvent } from '../../services/cache-registry.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import { connect, DRAFT_ENV, mapStoreError } from './store-draft.ts';

/**
 * CREATING the next App Store version (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md): the dead end of the
 * release stepper ("no version a build can be attached to"). A STORE WRITE, but a reversible one: the version starts in
 * `PREPARE_FOR_SUBMISSION` and App Store Connect lets a person delete it there. It is gated like the draft push it prepares for:
 *
 * - Off unless `versionEnabled`, which is the draft-write switch (KILN_STORE_DRAFT_WRITE_ENABLED): `409 store_draft_disabled`, no
 *   connector built. The right is `store.push_draft` (checked by the route, with the step-up of that action).
 * - Preview (a store read: the versions of the platform, the checks), then create with the preview's `confirmHash`. The versions are
 *   READ AGAIN right before the write (the guard of the connector): a different list is `409 state_changed` with a new preview, a
 *   blocking check is `409 blocked`. No typed phrase: a draft version can be deleted in App Store Connect.
 * - Refused (checks, data): a version string that is not one to three dotted numbers, one that is not higher than every version the
 *   store lists, one that already exists, and an editable version that already exists for the platform (it is the one to use).
 * - One write in flight per app and platform: the claim table of the draft push (`store_draft_claims`), so a push and a create
 *   exclude each other. Never retried. A lost answer: the versions are read back (`confirmedByReread`) or the answer is
 *   `409 outcome_unknown` (look in App Store Connect; a new preview settles it).
 * - Writes the version, and then the App Review Information of the previous version onto it (docs/api/review-information.md): a version
 *   made through the API starts without it, and a submit needs the contact there. Blank attributes only, never over a filled one, a failure
 *   is a warning (the version stays created). No text, no build, no review submission, no release. Google Play has no such thing: a
 *   version is a release (`422 not_supported`).
 * - Audit (`store.version_created`, `store.version_create_failed`) holds ids, the version string and hashes, and for the review information
 *   an outcome, the version it came from and a COUNT of attributes. Never a credential, a token, a store response body, or a contact name,
 *   phone number, email address, demo account or note.
 * - `previewReviewCopy` / `applyReviewCopy`: the same copy for a version that already exists (the repair of one made without it).
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const VERSION_ENV = DRAFT_ENV;
export const VERSION_PURPOSE = 'store.version_create';
export const DEFAULT_VERSION_TIMEOUT_MS = 120_000;
/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
export const DEFAULT_VERSION_CLAIM_TTL_MS = 300_000;

// ---------------------------------------------------------------------------------------------
// Context

export type VersionConnector = Pick<AppleVersionConnector, 'readVersions' | 'createVersion'> &
  Partial<Pick<AppleVersionConnector, 'previewReviewInformation' | 'carryOverReviewInformation'>>;
export type VersionConnectorInput = {
  secret: string;
  storeAppId?: string | null;
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
  /** KILN_STORE_DRAFT_WRITE_ENABLED. */
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
      coded('publish.inProgress.version'),
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

/** The versions the store lists, as the one rule of @kiln/core reads them (`createReleaseRules`). */
const factsOf = (versions: readonly StoreVersionRow[]) =>
  versions.map((v) => ({ version: v.versionString, editable: v.editable }));

/** The newest version the store lists that cannot be edited: the one the next version has to be higher than. */
export const liveVersionOf = (versions: readonly StoreVersionRow[]): string | null =>
  newestNonEditableVersion(factsOf(versions));

/**
 * The refusals of creating a version, from the ONE rule in @kiln/core (`createReleaseRules`, which the web asks before it offers a
 * button; this server stays the authority and words each refusal).
 */
export function evaluateChecks(request: VersionInput, state: VersionListState): VersionChecks {
  const blocking: VersionCheck[] = [];
  const warnings: VersionCheck[] = [];
  const wanted = request.versionString;
  const rules = createReleaseRules(wanted, factsOf(state.versions));
  const reasons = rules.ok ? [] : rules.reasons;
  const editable = state.versions.filter((v) => v.editable);
  for (const reason of reasons) {
    if (reason === 'invalid_version') {
      blocking.push({
        code: 'invalid_version',
        message:
          'A version is one to three numbers separated by periods, for example 3.1.2. Letters, a leading "v" and suffixes are not allowed.',
      });
    } else if (reason === 'editable_version_exists') {
      blocking.push({
        code: 'editable_version_exists',
        message: `Version ${label(editable[0] as StoreVersionRow)} can still be edited, so there is no need for another. Attach the build to it.`,
      });
    } else if (reason === 'version_exists') {
      const same = state.versions.filter(
        (v) => v.versionString !== null && sameVersion(v.versionString, wanted),
      );
      blocking.push({
        code: 'version_exists',
        message: `Version ${label((same[0] ?? state.versions[0]) as StoreVersionRow)} already exists in App Store Connect.`,
      });
    } else {
      blocking.push({
        code: 'not_higher',
        message: `The new version must be higher than ${liveVersionOf(state.versions)}, the newest version in App Store Connect that cannot be edited.`,
      });
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
  if (!supports(app.platform, 'versionCreation'))
    return failure(
      422,
      'not_supported',
      'Google Play has no versions to create: a version there is a release, made in the release steps.',
      coded('publish.playNoVersions'),
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
  /** What will be carried over from the previous version's App Review Information (masked). Null: not looked at. */
  reviewInformation: ReviewInformationView | null;
  /** Null while a check blocks. */
  confirmHash: string | null;
  /** Always true: a version in Prepare for Submission can be deleted in App Store Connect. */
  reversible: true;
  note: string;
};

const NOTE =
  'Creates an editable draft version in App Store Connect and copies the App Review Information of the previous version to it when that has some. Nothing is submitted. A version in Prepare for Submission can be deleted in App Store Connect.';

/** The App Review Information of a version as the API and the screens show it: an outcome, where it came from, a count and a masked summary. */
export type ReviewInformationView = {
  outcome: ReviewCarryResult['outcome'];
  /** The version string it comes from (null: there is none). */
  from: string | null;
  fieldsCopied: number;
  summary: ReviewSummary | null;
  /** `failed`: the kind of the failure. */
  code?: string;
};

const reviewViewOf = (r: ReviewCarryResult): ReviewInformationView => ({
  outcome: r.outcome,
  from: r.from?.versionString ?? null,
  fieldsCopied: r.fieldsCopied,
  summary: r.summary,
  ...(r.code !== undefined ? { code: r.code } : {}),
});

function previewOf(
  workspaceId: string,
  app: ManagedApp,
  request: VersionInput,
  state: VersionListState,
  review: ReviewCarryResult | null = null,
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
    reviewInformation: review === null ? null : reviewViewOf(review),
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
  let review: ReviewCarryResult | null = null;
  try {
    const read = await withConnector(ctx, connection.input, async (c) => {
      const versions = await c.readVersions();
      // The previous version's App Review Information, masked: a read that never throws (a failure is part of the answer).
      const look = c.previewReviewInformation ? await c.previewReviewInformation(versions.versions) : null;
      return { versions, look };
    });
    state = read.versions;
    review = read.look;
  } catch (error) {
    if (error instanceof VersionTimeout)
      return failure(
        504,
        'timeout',
        'The store did not answer in time. Nothing was changed.',
        coded('store.noAnswerNothingChanged'),
      );
    return mapped(error, connection.secret).failure;
  }
  await clearUnknown(ctx.db, app);
  return { ok: true, preview: previewOf(input.workspaceId, app, request, state, review) };
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
  /** What was done with the previous version's App Review Information (a count and a masked summary). Null: not tried. */
  reviewInformation: ReviewInformationView | null;
  createdAt: number;
  note: string;
};

async function audit(
  ctx: VersionContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  action:
    | 'store.version_created'
    | 'store.version_create_failed'
    | 'store.review_information_copied'
    | 'store.review_information_copy_failed',
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

/** The audit record of a carry-over: an outcome, where it came from, a count. */
const reviewAuditOf = (r: ReviewCarryResult): Record<string, unknown> => ({
  outcome: r.outcome,
  ...(r.from ? { fromVersion: r.from.versionString, fromVersionId: r.from.id } : {}),
  fieldsCopied: r.fieldsCopied,
  ...(r.code !== undefined ? { code: r.code } : {}),
});

/** The warning a person reads when the review information could not be carried over (no value in it). */
const reviewWarning = (r: ReviewCarryResult): VersionCheck =>
  r.outcome === 'no_source'
    ? {
        code: 'review_information_missing',
        message:
          'No earlier version has App Review Information to copy, so the new version has none. Fill in App Review Information (contact first and last name, phone number, email address) in App Store Connect before submitting.',
      }
    : {
        code: 'review_information_not_copied',
        message:
          'The App Review Information of the previous version could not be copied to the new version. Copy it from the submit checklist, or fill it in App Store Connect before submitting.',
      };

/** Carries the review information onto the version; null when it cannot be tried (no version id, or a connector without it). Never throws. */
async function carryReview(
  ctx: VersionContext,
  input: Omit<VersionConnectorInput, 'fetch'>,
  versions: readonly StoreVersionRow[],
  versionId: string | null,
): Promise<ReviewCarryResult | null> {
  if (versionId === null) return null;
  try {
    return await withConnector(ctx, input, async (c) =>
      c.carryOverReviewInformation
        ? c.carryOverReviewInformation(versions, versionId)
        : null,
    );
  } catch (error) {
    return {
      outcome: 'failed',
      from: null,
      fieldsCopied: 0,
      summary: null,
      code: error instanceof VersionTimeout ? 'timeout' : 'unexpected',
    };
  }
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
    // The previous version's App Review Information goes onto the new version (blank attributes only). It never fails the create: the
    // version exists either way, and a failure is a warning with the repair action behind it.
    const review = await carryReview(ctx, connection.input, before.versions, version.id);
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
          // Counts and the version it came from: never a name, a phone number, an email address, a demo account or a note.
          ...(review ? { reviewInformation: reviewAuditOf(review) } : {}),
        },
        tx,
      );
    });
    await releaseClaim(db, claim);
    // A version now exists in the store: the readiness, the images view and the notes history read the editable version.
    emitCacheEvent('release_changed', { workspaceId: input.workspaceId, appId: app.id });
    const warnings = evaluateChecks(request, before).warnings;
    if (review && (review.outcome === 'failed' || review.outcome === 'no_source'))
      warnings.push(reviewWarning(review));
    return {
      ok: true,
      result: {
        app: view,
        version,
        reversible: true,
        confirmedByReread: reread,
        warnings,
        reviewInformation: review ? reviewViewOf(review) : null,
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
          { checks: blocked, ...coded('publish.blocked.version') },
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
        {
          preview: previewOf(input.workspaceId, app, request, error.current),
          ...coded('publish.versionsChanged'),
        },
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
        sameVersion(v.versionString, request.versionString),
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
    coded('publish.unknown.version'),
  );
}

// ---------------------------------------------------------------------------------------------
// Copy the App Review Information to a version that already exists (the repair)

/** The editable version the copy is for, and what copying would do. Masked: no name, phone number, email address, account or note. */
export type ReviewCopyPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  /** The one editable version (the one that would go to review). */
  version: { versionString: string | null; state: string };
  reviewInformation: ReviewInformationView;
  /** True when copying would write something (`created` or `merged`). */
  canCopy: boolean;
  /** Null while nothing would be copied. */
  confirmHash: string | null;
  note: string;
};

const COPY_NOTE =
  'Copies the contact, demo account and notes of the previous version onto the draft version where the draft has nothing. A value that is already filled in is never changed. Attachments are not copied. Nothing is submitted.';

const reviewCopyHash = (input: {
  workspaceId: string;
  appId: string;
  targetId: string;
  look: ReviewCarryResult;
}): string =>
  sha(
    JSON.stringify({
      v: 1,
      workspaceId: input.workspaceId,
      appId: input.appId,
      targetId: input.targetId,
      fromId: input.look.from?.id ?? null,
      outcome: input.look.outcome,
      fieldsCopied: input.look.fieldsCopied,
    }),
  );

type ReviewCopyRead =
  | { kind: 'unsupported' }
  | { kind: 'no_version' }
  | { kind: 'several' }
  | {
      kind: 'read';
      target: StoreVersionRow;
      versions: StoreVersionRow[];
      look: ReviewCarryResult;
    };

/** Reads the versions and what a copy would do for the one editable version. Never writes. */
async function readReviewCopy(c: VersionConnector): Promise<ReviewCopyRead> {
  if (!c.previewReviewInformation || !c.carryOverReviewInformation) return { kind: 'unsupported' };
  const state = await c.readVersions();
  const editable = state.versions.filter((v) => v.editable);
  if (editable.length === 0) return { kind: 'no_version' };
  if (editable.length > 1) return { kind: 'several' };
  const target = editable[0] as StoreVersionRow;
  const look = await c.previewReviewInformation(state.versions, target.id);
  return { kind: 'read', target, versions: state.versions, look };
}

const reviewCopyRefusal = (read: Exclude<ReviewCopyRead, { kind: 'read' }>): Failure =>
  read.kind === 'unsupported'
    ? failure(422, 'not_supported', 'This server cannot copy App Review Information.')
    : read.kind === 'several'
      ? failure(
          409,
          'several_editable_versions',
          'App Store Connect has more than one editable version of this app, so it is not clear which one to copy the review information to. Remove the extra one first.',
        )
      : failure(
          409,
          'no_editable_version',
          'There is no editable App Store version to copy the review information to.',
        );

/** `POST .../review-information/preview`: what copying would do (a store read). Writes nothing. */
export async function previewReviewCopy(
  ctx: VersionContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; preview: ReviewCopyPreview } | Failure> {
  if (!ctx.versionEnabled) return versionDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const unsupported = ready(app);
  if (unsupported) return unsupported;
  const connected = await connect(ctx, input.workspaceId, app, input.actor, VERSION_PURPOSE);
  if (!connected.ok) return connected;
  const { connection } = connected;
  let read: ReviewCopyRead;
  try {
    read = await withConnector(ctx, connection.input, readReviewCopy);
  } catch (error) {
    if (error instanceof VersionTimeout)
      return failure(
        504,
        'timeout',
        'The store did not answer in time. Nothing was changed.',
        coded('store.noAnswerNothingChanged'),
      );
    return mapped(error, connection.secret).failure;
  }
  if (read.kind !== 'read') return reviewCopyRefusal(read);
  return {
    ok: true,
    preview: reviewCopyPreviewOf(input.workspaceId, app, read.target, read.look),
  };
}

function reviewCopyPreviewOf(
  workspaceId: string,
  app: ManagedApp,
  target: StoreVersionRow,
  look: ReviewCarryResult,
): ReviewCopyPreview {
  const canCopy = look.outcome === 'created' || look.outcome === 'merged';
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    version: { versionString: target.versionString, state: target.state },
    reviewInformation: reviewViewOf(look),
    canCopy,
    confirmHash: canCopy
      ? reviewCopyHash({ workspaceId, appId: app.id, targetId: target.id, look })
      : null,
    note: COPY_NOTE,
  };
}

export type ReviewCopyResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { versionString: string | null; state: string };
  reviewInformation: ReviewInformationView;
  copiedAt: number;
  note: string;
};

/**
 * `POST .../review-information`: re-reads, checks the preview's hash, writes the blank attributes once (a POST when the version has no
 * detail, a PATCH of its blank attributes otherwise). Idempotent: it can be done again after a lost answer. The audit holds ids, an
 * outcome and a count.
 */
export async function applyReviewCopy(
  ctx: VersionContext,
  input: { workspaceId: string; appId: string; confirmHash: string; actor: Actor },
): Promise<{ ok: true; result: ReviewCopyResult } | Failure> {
  if (!ctx.versionEnabled) return versionDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const unsupported = ready(app);
  if (unsupported) return unsupported;
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
  const failed = async (code: string, outcome: string, f: Failure, extra: Record<string, unknown> = {}) => {
    await audit(ctx, { ...input }, app, 'store.review_information_copy_failed', { code, outcome, ...extra });
    return stop(f);
  };

  type Done =
    | { kind: 'refused'; failure: Failure; code: string }
    | { kind: 'changed'; target: StoreVersionRow; look: ReviewCarryResult }
    | { kind: 'done'; target: StoreVersionRow; done: ReviewCarryResult };
  let outcome: Done;
  try {
    outcome = await withConnector(ctx, connection.input, async (c): Promise<Done> => {
      const read = await readReviewCopy(c);
      if (read.kind !== 'read')
        return { kind: 'refused', failure: reviewCopyRefusal(read), code: read.kind };
      const hash = reviewCopyHash({
        workspaceId: input.workspaceId,
        appId: app.id,
        targetId: read.target.id,
        look: read.look,
      });
      const canCopy = read.look.outcome === 'created' || read.look.outcome === 'merged';
      if (!canCopy || hash !== input.confirmHash)
        return { kind: 'changed', target: read.target, look: read.look };
      const done = await (c.carryOverReviewInformation as NonNullable<VersionConnector['carryOverReviewInformation']>)(
        read.versions,
        read.target.id,
      );
      return { kind: 'done', target: read.target, done };
    });
  } catch (error) {
    if (error instanceof VersionTimeout)
      return failed(
        'timeout',
        'unknown',
        failure(
          504,
          'timeout',
          'The store did not answer in time. Preview again to see what the version holds now; copying again is safe.',
        ),
      );
    const m = mapped(error, connection.secret);
    return failed(m.code, 'failed', m.failure);
  }
  if (outcome.kind === 'refused') return failed(outcome.code, 'refused', outcome.failure);
  if (outcome.kind === 'changed') {
    return failed(
      'state_changed',
      'refused',
      failure(
        409,
        'state_changed',
        'What the store holds changed since this was previewed, or there is nothing left to copy, so nothing was written. Review the new preview.',
        { preview: reviewCopyPreviewOf(input.workspaceId, app, outcome.target, outcome.look) },
      ),
    );
  }
  const { done, target } = outcome;
  if (done.outcome === 'failed')
    return failed(
      done.code ?? 'failed',
      'failed',
      failure(
        502,
        'store_rejected',
        'App Store Connect did not accept the review information. Fill it in App Store Connect (the version page, App Review Information), or try again.',
        { cause: done.code ?? 'failed', ...(done.httpStatus !== undefined ? { storeStatus: done.httpStatus } : {}) },
      ),
    );
  const at = ctx.now();
  await db.transaction(async (tx) => {
    await audit(
      ctx,
      { ...input },
      app,
      'store.review_information_copied',
      { versionId: target.id, versionString: target.versionString, ...reviewAuditOf(done) },
      tx,
    );
  });
  await releaseClaim(db, claim);
  return {
    ok: true,
    result: {
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      version: { versionString: target.versionString, state: target.state },
      reviewInformation: reviewViewOf(done),
      copiedAt: at,
      note: 'The review information was copied to the draft version. Nothing was submitted.',
    },
  };
}

export { CREATABLE_RELEASE_TYPES };
