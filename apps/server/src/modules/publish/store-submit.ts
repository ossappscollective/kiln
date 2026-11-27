import { createHash } from 'node:crypto';
import {
  AppleSubmitConnector,
  appleScope,
  connectorFactory,
  DRAFT_IMAGE_READY_STATES,
  PlaySubmitConnector,
  type StoreConnectorInput,
  type StoreSubmitConnector,
  SubmitDriftError,
  SubmitOutcomeUnknownError,
  type SubmitState,
  submitKey,
} from '@kiln/connectors';
import {
  byFamily,
  type DraftContent,
  evaluateDraftContent,
  evaluateReviewInformation,
  needsStoreAppId,
  REVIEW_CODES,
  type Platform,
  supports,
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
import {
  deletePush,
  emptyManifest,
  loadPush,
  manifestMismatches,
  type PushRecord,
  requestOfManifest,
} from './store-draft-record.ts';

/**
 * Submitting the store's DRAFT for review: the most consequential STORE WRITE of this server, and one it cannot take
 * back. It is written down in docs/adr/0010-store-submit.md and docs/api/submit.md. The design copies the other store
 * writes (ADR 0007, 0008, 0009) and adds what an irreversible step needs:
 *
 * - Off unless `submitEnabled` (KILN_STORE_SUBMIT_ENABLED, default false), separately from the draft switch: every function
 *   answers `409 store_submit_disabled` and no connector is built.
 * - A role action of its own, `store.submit` (owner and admin; a token only when its actions name it), checked by the route.
 * - It needs a prior SUCCESSFUL draft push of this app (`store_draft_pushes`: hashes and ids of what was written) and
 *   READS THE STORE AGAIN: if the store's draft no longer holds what was pushed (or nothing was pushed) it refuses
 *   (`409 nothing_pushed`, a blocking `draft_differs`). The version, the build and the state of the store are part of what
 *   is confirmed.
 * - Preview (what goes to review, which version and build, what cannot be undone, the checks), then apply with the
 *   `confirmHash` of that preview AND the typed confirmation phrase. The store is read again right before the write (the
 *   guard of the connector): a different state is `409 state_changed` with a new preview; a blocking check is `409 blocked`.
 * - Never releases anything and never changes a rollout: App Store versions whose release type is not manual are blocked,
 *   Google Play tracks are read but never written (see the connectors).
 * - One submit in flight per app and platform (`store_submit_claims`; a push in flight, or one whose outcome is unknown,
 *   blocks it). Never retried. A lost answer: the store is READ BACK. App Store shows the version in review (success,
 *   `confirmedByReread`) or not (nothing was submitted as far as the store shows). Google Play shows no review state, so
 *   its unknown outcome stays unknown (`409 outcome_unknown`) until the person has looked in Play Console and previewed again.
 * - Audit (`listing.submitted`, `listing.submit_failed`) and the event `listing.submitted` hold ids, counts and hashes. Never a
 *   text, a credential, a token or a store response body.
 */

type Actor = { type: 'user' | 'token' | 'system'; id: string };

export const SUBMIT_ENV = 'KILN_STORE_SUBMIT_ENABLED';
export const SUBMIT_PURPOSE = 'store.submit';
/** Two to four requests to a store. */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;
/** Longer than the timeout, so a claim is never trusted less than the write it guards can still run. */
export const DEFAULT_SUBMIT_CLAIM_TTL_MS = 300_000;
/** A draft push claim older than this is not trusted as "in flight" (the push's own time to live). */
const DRAFT_CLAIM_TTL_MS = 300_000;

// ---------------------------------------------------------------------------------------------
// Context

export type SubmitConnectorInput = StoreConnectorInput;
export type SubmitConnectorFactory = (input: SubmitConnectorInput) => StoreSubmitConnector;

export const defaultSubmitConnectorFactory: SubmitConnectorFactory =
  connectorFactory<StoreSubmitConnector>({
    app_store_connect: (input) =>
      AppleSubmitConnector.fromSecret(input.secret, {
        appStoreId: input.storeAppId ?? '',
        platform: appleScope(input),
        fetch: input.fetch,
      }),
    google_play: (input) =>
      new PlaySubmitConnector({
        serviceAccount: input.secret,
        packageName: input.identifier,
        fetch: input.fetch,
      }),
  });

export type SubmitContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** KILN_STORE_SUBMIT_ENABLED. */
  submitEnabled: boolean;
  submitConnectorFactory: SubmitConnectorFactory;
  submitTimeoutMs?: number;
  claimTtlMs?: number;
};

// ---------------------------------------------------------------------------------------------
// Failures

export const submitDisabledFailure = (): Failure =>
  failure(
    409,
    'store_submit_disabled',
    `Submitting drafts for store review is switched off on this server. Set ${SUBMIT_ENV}=true to turn it on (see docs/deployment.md).`,
    {
      envName: SUBMIT_ENV,
    },
  );

class SubmitTimeout extends Error {}

/** Runs `job` with a connector whose requests are aborted after the timeout. */
async function withConnector<T>(
  ctx: SubmitContext,
  input: Omit<SubmitConnectorInput, 'fetch'>,
  job: (connector: StoreSubmitConnector) => Promise<T>,
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
      reject(new SubmitTimeout('timeout'));
    }, ctx.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS);
  });
  try {
    const work = job(ctx.submitConnectorFactory({ ...input, fetch: guardedFetch }));
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The claim: one submit in flight per app and platform

type Claim = { appId: string; platform: Platform; at: number };

async function takeClaim(
  ctx: SubmitContext,
  input: { workspaceId: string; app: ManagedApp; actor: Actor },
): Promise<{ ok: true; claim: Claim } | Failure> {
  const { db } = ctx;
  const ttl = ctx.claimTtlMs ?? DEFAULT_SUBMIT_CLAIM_TTL_MS;
  const claim: Claim = { appId: input.app.id, platform: input.app.platform, at: ctx.now() };
  const busy = () =>
    failure(
      409,
      'write_in_progress',
      'A submit for this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.submit'),
    );
  const insert = () =>
    db.execute(
      `INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES (?, ?, ?, 'submit', 'writing', ?, ?) ON CONFLICT (app_id, platform) DO NOTHING`,
      [claim.appId, claim.platform, input.workspaceId, input.actor.id, claim.at],
    );
  if ((await insert()) === 1) return { ok: true, claim };
  const [existing] = await db.query(
    'SELECT status, claim_at FROM store_submit_claims WHERE app_id = ? AND platform = ?',
    [claim.appId, claim.platform],
  );
  if (!existing) return (await insert()) === 1 ? { ok: true, claim } : busy();
  if (String(existing.status) === 'unknown') {
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the last submit of this app reached the store. Look at the app in App Store Connect or Play Console, then preview the submit again: that reads the store and shows where it stands. Nothing is submitted until you confirm a new preview.',
      coded('publish.unknown.submit'),
    );
  }
  const startedAt = Number(existing.claim_at);
  if (claim.at - startedAt < ttl) return busy();
  // A submit that started long ago and never finished (a process died): its outcome is unknown. The re-read and the
  // hash refuse a submit that no longer fits the store (App Store: a version already in review is `already_submitted`).
  const taken = await db.execute(
    `UPDATE store_submit_claims SET claim_at = ?, claimed_by = ?, workspace_id = ?
      WHERE app_id = ? AND platform = ? AND status = 'writing' AND claim_at = ?`,
    [claim.at, input.actor.id, input.workspaceId, claim.appId, claim.platform, startedAt],
  );
  return taken === 1 ? { ok: true, claim } : busy();
}

const releaseClaim = (sql: Sql, claim: Claim) =>
  sql.execute(
    "DELETE FROM store_submit_claims WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );
const markUnknown = (sql: Sql, claim: Claim) =>
  sql.execute(
    "UPDATE store_submit_claims SET status = 'unknown' WHERE app_id = ? AND platform = ? AND claim_at = ? AND status = 'writing'",
    [claim.appId, claim.platform, claim.at],
  );
/** A successful read of the store settles an unknown outcome: the person sees where things stand. */
const clearUnknown = (sql: Sql, app: ManagedApp) =>
  sql.execute(
    "DELETE FROM store_submit_claims WHERE app_id = ? AND platform = ? AND status = 'unknown'",
    [app.id, app.platform],
  );

type InFlight = { submit: 'writing' | 'unknown' | null; push: 'writing' | 'unknown' | null };

/** The claims that bear on a submit: its own, and the draft push's (a push in flight changes what would be submitted). */
async function inFlightOf(ctx: SubmitContext, app: ManagedApp): Promise<InFlight> {
  const now = ctx.now();
  const own = (
    await ctx.db.query(
      'SELECT status, claim_at FROM store_submit_claims WHERE app_id = ? AND platform = ?',
      [app.id, app.platform],
    )
  )[0];
  const push = (
    await ctx.db.query(
      'SELECT status, claim_at FROM store_draft_claims WHERE app_id = ? AND platform = ?',
      [app.id, app.platform],
    )
  )[0];
  const ttl = ctx.claimTtlMs ?? DEFAULT_SUBMIT_CLAIM_TTL_MS;
  const pick = (
    row: Record<string, unknown> | undefined,
    limit: number,
  ): 'writing' | 'unknown' | null => {
    if (!row) return null;
    if (String(row.status) === 'unknown') return 'unknown';
    return now - Number(row.claim_at) < limit ? 'writing' : null;
  };
  return { submit: pick(own, ttl), push: pick(push, DRAFT_CLAIM_TTL_MS) };
}

// ---------------------------------------------------------------------------------------------
// Connection

type Connection = { input: Omit<SubmitConnectorInput, 'fetch'>; secret: string };

async function connect(
  ctx: SubmitContext,
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
      { workspaceId, id: app.credentialId, purpose: SUBMIT_PURPOSE },
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
// Checks

export type SubmitCheck = {
  code: string;
  /** `blocking`: the submit is refused until it is fixed. `warning`: shown, does not stop it. */
  severity: 'blocking' | 'warning';
  message: string;
  locale?: string;
  /** The field, set or item the check is about. */
  item?: string;
  /** Set for a finding of `store-asset-specs` or of the listing field specs. */
  rule?: string;
  source?: string;
  verified?: boolean;
  /** The names and numbers of the sentence (`missing`: the attributes; `from`: the version the review information can be copied from). */
  params?: Record<string, string | number>;
};

export type SubmitChecks = { blocking: SubmitCheck[]; warnings: SubmitCheck[]; canSubmit: boolean };

const isBlank = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === '';

/** Checks against the state read from the store and the record of the push. Pure. */
export function evaluateChecks(input: {
  app: Pick<ManagedApp, 'platform'>;
  record: PushRecord;
  state: SubmitState;
  inFlight: InFlight;
}): SubmitCheck[] {
  const { app, record, state } = input;
  const out: SubmitCheck[] = [];
  const add = (check: SubmitCheck) => out.push(check);
  const ios = !supports(app.platform, 'transactionalEdits');

  if (input.inFlight.push === 'writing')
    add({
      code: 'push_in_progress',
      severity: 'blocking',
      message: 'A draft push for this app is in progress. Wait for it to finish.',
    });
  if (input.inFlight.push === 'unknown') {
    add({
      code: 'push_outcome_unknown',
      severity: 'blocking',
      message:
        'It is not known whether the last draft push reached the store. Preview the push again first (staged changes), then submit.',
    });
  }

  if (state.alreadySubmitted) {
    add({
      code: 'already_submitted',
      severity: 'blocking',
      message: `The App Store version is already in review or past it (${state.version?.state ?? 'unknown state'}). It cannot be submitted again.`,
    });
    return out;
  }
  if (ios && state.version === null)
    add({
      code: 'no_version',
      severity: 'blocking',
      message: 'There is no App Store version to submit.',
    });
  if (ios && state.version && record.versionId !== null && record.versionId !== state.version.id) {
    add({
      code: 'version_changed',
      severity: 'blocking',
      message: `The draft was pushed to version ${record.versionString ?? record.versionId}, but the version that would be submitted is ${state.version.versionString ?? state.version.id}. Push the draft again.`,
    });
  }

  if (ios && state.version) {
    const type = state.version.releaseType;
    if (type === null) {
      add({
        code: 'release_not_manual',
        severity: 'blocking',
        message:
          'The release type of the version could not be read, so it is not known whether an approval would release it. Sync the app and read the preview again.',
      });
    } else if (type === 'AFTER_APPROVAL') {
      // The person's own setting in App Store Connect is respected: approval is the release, and the
      // typed confirmation of this submit is the last step they take here.
      add({
        code: 'releases_after_approval',
        severity: 'warning',
        message:
          'This version is set to release automatically after approval. When Apple approves it, it goes live without another step here. Change the release type in App Store Connect first if you want to release it yourself.',
      });
    } else if (type !== 'MANUAL') {
      add({
        code: 'releases_by_itself',
        severity: 'warning',
        message: `This version is set to release by itself (${type}). It goes live as that setting says once Apple approves it. Change the release type in App Store Connect first if you want to release it yourself.`,
      });
    }
    if (state.build === null)
      add({
        code: 'no_build',
        severity: 'blocking',
        message:
          'No build is attached to the version. Attach a processed build in App Store Connect.',
      });
    else if (state.build.expired === true)
      add({
        code: 'build_expired',
        severity: 'blocking',
        message: `Build ${state.build.version ?? state.build.id} has expired. Attach another build in App Store Connect.`,
      });
    else if (state.build.processingState !== null && state.build.processingState !== 'VALID') {
      add({
        code: 'build_not_valid',
        severity: 'blocking',
        message: `Build ${state.build.version ?? state.build.id} is not ready (${state.build.processingState}).`,
      });
    }
    // App Review Information: judged from presence facts (`evaluateReviewInformation`, one pure rule for the submit and the plan). A
    // version whose review information was not read is not judged. The version it can be copied from is named when there is one.
    for (const finding of evaluateReviewInformation(state.reviewDetail)) {
      const from = state.reviewSource?.versionString ?? null;
      add({
        ...(finding as SubmitCheck),
        params: { ...(finding.params ?? {}), ...(from !== null ? { from } : {}) },
      });
    }
    if (state.openReviewSubmissions !== null && state.openReviewSubmissions > 0) {
      add({
        code: 'open_review_submission',
        severity: 'warning',
        message: `${state.openReviewSubmissions} review submission(s) of this app are open but not submitted. This server creates its own and leaves those alone.`,
      });
    }
  }

  if (!ios) {
    add({
      code: 'play_review_state_unknown',
      severity: 'warning',
      message:
        'Google Play does not show the review state through its API: this server cannot tell whether changes are already in review (Google refuses a second send while they are) and cannot confirm the send afterwards.',
    });
    add({
      code: 'play_pending_changes',
      severity: 'warning',
      message:
        'Everything held back for this app goes to review, not only what this server pushed: changes made in Play Console go with it. Google does not list them through the API.',
    });
    const rolling = state.tracks.flatMap((t) =>
      t.releases.filter((r) => r.status === 'inProgress').map(() => t.track),
    );
    if (rolling.length > 0) {
      add({
        code: 'play_rollout_in_progress',
        severity: 'warning',
        message: `A staged rollout is in progress on ${[...new Set(rolling)].join(', ')}. Submitting does not change it.`,
      });
    }
  }

  // The store's draft must still hold what was pushed.
  if (state.draft === null) {
    add({
      code: 'draft_unreadable',
      severity: 'blocking',
      message: 'The store’s draft could not be read.',
    });
  } else {
    const differs = manifestMismatches(record.manifest, state.draft);
    for (const m of differs.slice(0, 30)) {
      add({
        code: 'draft_differs',
        severity: 'blocking',
        message: `${m.type === 'text' ? 'The text' : 'The screenshots'} ${m.item} (${m.locale}) in the store no longer match what was pushed. Push the draft again.`,
        locale: m.locale,
        item: m.item,
      });
    }
    if (differs.length > 30)
      add({
        code: 'draft_differs',
        severity: 'blocking',
        message: `${differs.length - 30} more pushed items differ.`,
      });
  }

  // The listing as the store holds it: the content rules are the pure ones of `@kiln/core` (`evaluateDraftContent`), the same that
  // judge the draft a push WOULD leave before anything is sent (`predictDraft`, the plan's `readiness`). Only what the store alone
  // knows (an image still being processed) is checked here.
  for (const finding of evaluateDraftContent(draftContentOf(ios, state.locales)))
    add(finding as SubmitCheck);
  for (const locale of state.locales)
    for (const set of locale.assets)
      for (const image of set.images)
        if (image.state !== null && !DRAFT_IMAGE_READY_STATES.includes(image.state)) {
          add({
            code: 'image_not_ready',
            severity: 'blocking',
            message: `A ${set.target} image in ${locale.locale} is ${image.state}, not processed.`,
            locale: locale.locale,
            item: set.target,
          });
        }
  return out;
}

/** The locales a store reports, in the plain shape the content rules read (sizes and counts, never bytes). */
export function draftContentOf(
  ios: boolean,
  locales: readonly SubmitState['locales'][number][],
): DraftContent {
  return {
    store: ios ? 'app_store' : 'google_play',
    locales: locales.map((l) => ({
      locale: l.locale,
      text: l.text,
      assets: l.assets.map((set) => ({
        kind: set.kind,
        device: set.device,
        target: set.target,
        images: set.images.map((i) => ({ width: i.width, height: i.height })),
      })),
    })),
  };
}

const split = (items: SubmitCheck[]): SubmitChecks => {
  const blocking = items.filter((i) => i.severity === 'blocking');
  return {
    blocking,
    warnings: items.filter((i) => i.severity === 'warning'),
    canSubmit: blocking.length === 0,
  };
};

// ---------------------------------------------------------------------------------------------
// The confirmation

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** What the person confirms: this app, the pushed draft, and the store exactly as it was read. */
export function submitConfirmHash(input: {
  workspaceId: string;
  app: { id: string; platform: Platform };
  record: PushRecord;
  state: SubmitState;
}): string {
  const body = JSON.stringify({
    v: 1,
    workspaceId: input.workspaceId,
    appId: input.app.id,
    platform: input.app.platform,
    pushed: {
      confirmHash: input.record.confirmHash,
      versionId: input.record.versionId,
      items: sha(JSON.stringify(input.record.manifest)),
    },
    store: submitKey(input.state),
  });
  return sha(body);
}

/** The text the person types to confirm. Needs no store read, so a wrong one is refused before anything else. */
export const confirmationPhrase = (
  app: Pick<ManagedApp, 'identifier'>,
  record: Pick<PushRecord, 'versionString'>,
): string => `submit ${app.identifier}${record.versionString ? ` ${record.versionString}` : ''}`;

// ---------------------------------------------------------------------------------------------
// Config and state

export type SubmitConfig = {
  enabled: boolean;
  envName: string;
  action: 'store.submit';
  /** The lowest role that can submit. A token needs `store.submit` named in its actions. */
  minimumRole: 'admin';
  /** Always true: nothing here can recall a submission. */
  irreversible: true;
  /** Always false: a submit never releases a version and never changes a rollout. */
  releases: false;
  note: string;
};

export const submitConfig = (ctx: Pick<SubmitContext, 'submitEnabled'>): SubmitConfig => ({
  enabled: ctx.submitEnabled,
  envName: SUBMIT_ENV,
  action: 'store.submit',
  minimumRole: 'admin',
  irreversible: true,
  releases: false,
  note: 'Submitting hands the pushed draft to the store’s review. It cannot be recalled from here and never releases a version or changes a rollout (docs/api/submit.md).',
});

export type SubmitStateView = {
  enabled: boolean;
  /** A successful draft push is recorded and not yet submitted. */
  pushed: boolean;
  push: {
    pushedAt: number;
    pushedBy: string;
    versionString: string | null;
    texts: number;
    assetSets: number;
  } | null;
  inFlight: { submit: boolean; push: boolean };
  /** An earlier submit or push whose outcome is unknown: preview again to settle it. */
  unknownOutcome: { submit: boolean; push: boolean };
};

/** `GET .../store-submit`: the database only, no store is contacted. */
export async function getSubmitState(
  ctx: SubmitContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; state: SubmitStateView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const record = await loadPush(ctx.db, app.id, app.platform);
  const inFlight = await inFlightOf(ctx, app);
  return {
    ok: true,
    state: {
      enabled: ctx.submitEnabled,
      pushed: record !== undefined,
      push: record
        ? {
            pushedAt: record.pushedAt,
            pushedBy: record.pushedBy,
            versionString: record.versionString,
            texts: record.manifest.text.length,
            assetSets: record.manifest.assets.length,
          }
        : null,
      inFlight: { submit: inFlight.submit === 'writing', push: inFlight.push === 'writing' },
      unknownOutcome: { submit: inFlight.submit === 'unknown', push: inFlight.push === 'unknown' },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Preview

export type SubmitPreview = {
  app: { id: string; name: string; platform: Platform; store: string };
  /** App Store: the version that goes to review. Google Play: null (the changes of the app go to review). */
  version: {
    id: string;
    versionString: string | null;
    state: string;
    releaseType: string | null;
  } | null;
  build: {
    id: string;
    version: string | null;
    processingState: string | null;
    expired: boolean | null;
  } | null;
  /** What goes to review, per locale: counts of text fields that hold a value and the screenshot sets. */
  contents: {
    locales: {
      locale: string;
      textFields: number;
      screenshotSets: { target: string; device: string | null; images: number }[];
    }[];
    /** What this server pushed and the draft still holds. */
    pushed: { pushedAt: number; pushedBy: string; texts: number; assetSets: number };
    /** Google Play: changes outside this server's pushes go too, and are not listed by Google. */
    includesChangesNotPushedHere: boolean;
  };
  /** Google Play: read only, never written by a submit. App Store: empty. */
  tracks: SubmitState['tracks'];
  /** What cannot be undone from this server. */
  irreversible: string[];
  /** Always true. */
  submits: true;
  /** Always false: a submit never releases a version and never changes a rollout. */
  releases: false;
  checks: SubmitChecks;
  /** Null while a blocking check stands: nothing can be confirmed. */
  confirmHash: string | null;
  /** What the person types to confirm (null while blocked). The apply request carries it as `confirmation`. */
  confirmation: { phrase: string; instruction: string } | null;
  /**
   * False when the person's own confirmation (password or passkey, see `stepUpCovers`) stands in for the typed phrase: the
   * screen then shows no phrase field and the apply request needs none.
   */
  confirmationRequired: boolean;
  readAt: number;
};

const irreversibleOf = (platform: Platform, record: PushRecord): string[] =>
  !supports(platform, 'transactionalEdits')
    ? [
        `${record.versionString ? `Version ${record.versionString}` : 'The version'} is handed to App Review. This server cannot withdraw it: only App Store Connect can.`,
        'Once submitted the version and its listing can no longer be edited here.',
        'Nothing is released: the version stays unreleased after approval until you release it in App Store Connect.',
      ]
    : [
        'The held back changes of the app are sent to Google Play review. This server cannot cancel the review: only Play Console can.',
        'This server cannot read the review state afterwards, so it cannot confirm the send if Google’s answer is lost.',
        'No track and no rollout is changed.',
      ];

function previewOf(
  ctx: SubmitContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    record: PushRecord;
    state: SubmitState;
    inFlight: InFlight;
    stepUpCovers?: boolean | undefined;
  },
): SubmitPreview {
  const { app, record, state } = input;
  const checks = split(evaluateChecks({ app, record, state, inFlight: input.inFlight }));
  const ready = checks.canSubmit;
  return {
    app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
    version: state.version,
    build: state.build,
    contents: {
      locales: state.locales.map((l) => ({
        locale: l.locale,
        textFields: Object.values(l.text).filter((v) => !isBlank(v)).length,
        screenshotSets: l.assets
          .filter((a) => a.kind === 'screenshot')
          .map((a) => ({ target: a.target, device: a.device, images: a.images.length })),
      })),
      pushed: {
        pushedAt: record.pushedAt,
        pushedBy: record.pushedBy,
        texts: record.manifest.text.length,
        assetSets: record.manifest.assets.length,
      },
      includesChangesNotPushedHere: supports(app.platform, 'transactionalEdits'),
    },
    tracks: state.tracks,
    irreversible: irreversibleOf(app.platform, record),
    submits: true,
    releases: false,
    checks,
    confirmHash: ready
      ? submitConfirmHash({ workspaceId: input.workspaceId, app, record, state })
      : null,
    confirmation: ready
      ? {
          phrase: confirmationPhrase(app, record),
          instruction: `Type "${confirmationPhrase(app, record)}" to confirm. This cannot be undone from here.`,
        }
      : null,
    confirmationRequired: input.stepUpCovers !== true,
    readAt: ctx.now(),
  };
}

const noPush = (): Failure =>
  failure(
    409,
    'nothing_pushed',
    'No draft push of this app is recorded, so there is nothing to submit. Push the staged changes as a draft first (staged changes), then submit.',
    coded('publish.noDraftPush'),
  );

/** `POST .../store-submit/preview`: reads the store and shows what would go to review and what stands in the way. Writes nothing. */
export async function previewSubmit(
  ctx: SubmitContext,
  input: { workspaceId: string; appId: string; actor: Actor; stepUpCovers?: boolean | undefined },
): Promise<{ ok: true; preview: SubmitPreview } | Failure> {
  if (!ctx.submitEnabled) return submitDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const record = await loadPush(ctx.db, app.id, app.platform);
  if (!record) return noPush();
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return connected;
  const { connection } = connected;
  let state: SubmitState;
  try {
    state = await withConnector(ctx, connection.input, (connector) =>
      connector.readSubmitState(requestOfManifest(record.manifest)),
    );
  } catch (error) {
    if (error instanceof SubmitTimeout)
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
  return {
    ok: true,
    preview: previewOf(ctx, {
      workspaceId: input.workspaceId,
      app,
      record,
      state,
      inFlight,
      stepUpCovers: input.stepUpCovers,
    }),
  };
}

/** The checks that need no draft push to be known: the state of the version and of the build it carries now. */
export const EARLY_CODES: readonly string[] = [
  'already_submitted',
  'no_version',
  'release_not_manual',
  'no_build',
  'build_expired',
  'build_not_valid',
  ...REVIEW_CODES,
];
/** Of those, the ones a push of the staged release fields can fix (it attaches the build). */
export const BUILD_CODES: readonly string[] = ['no_build', 'build_expired', 'build_not_valid'];

/** The checks that need no draft push (a version that cannot be submitted, a build that is missing, expired or not processed) from the state read. Pure. */
export const earlyChecksOf = (
  app: Pick<ManagedApp, 'platform'>,
  state: SubmitState,
): SubmitCheck[] => {
  const record: PushRecord = {
    appId: '',
    platform: app.platform,
    versionId: null,
    versionString: null,
    confirmHash: '',
    manifest: emptyManifest(),
    pushedBy: '',
    pushedAt: 0,
    updatedAt: 0,
  };
  return split(
    evaluateChecks({ app, record, state, inFlight: { submit: null, push: null } }),
  ).blocking.filter((c) => EARLY_CODES.includes(c.code));
};

/**
 * What the store holds now, read once for the plan: the version, the build and EVERY locale of the draft with its texts and its sets of
 * graphics (counts and pixel sizes). The plan judges what a push would leave from it (`submit-readiness.ts`); the checks that depend on
 * the push itself are not known here. Writes nothing; a failed read is a failure the plan turns into "nothing known" (it says so itself).
 */
export async function readStateForPlan(
  ctx: SubmitContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; state: SubmitState } | Failure> {
  if (!ctx.submitEnabled) return submitDisabledFailure();
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const connected = await connect(ctx, input.workspaceId, app, input.actor);
  if (!connected.ok) return connected;
  const { connection } = connected;
  try {
    const state = await withConnector(ctx, connection.input, (connector) =>
      connector.readSubmitState(requestOfManifest(emptyManifest())),
    );
    return { ok: true, state };
  } catch (error) {
    if (error instanceof SubmitTimeout)
      return failure(504, 'timeout', 'The store did not answer in time. Nothing was changed.');
    return mapStoreError(error, connection.secret).failure;
  }
}

// ---------------------------------------------------------------------------------------------
// Apply

export type SubmitResult = {
  app: { id: string; name: string; platform: Platform; store: string };
  version: { id: string; versionString: string | null } | null;
  /** App Store: the review submission. Google Play: null. */
  submission: { id: string; state: string | null } | null;
  via: 'review_submission' | 'edit_commit';
  /** Always true. */
  submitted: true;
  /** Always false: nothing was released and no rollout changed. */
  released: false;
  /** True when the store did not answer and reading it back showed the submission. */
  confirmedByReread: boolean;
  submittedAt: number;
  note: string;
};

const NOTE_IOS =
  'The version is in the store’s review queue. It will not be released by this server: release it in App Store Connect after approval.';
const NOTE_PLAY =
  'The changes were sent to Google Play review. No track or rollout was changed. Follow the review in Play Console.';

async function auditFailed(
  ctx: SubmitContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  app: ManagedApp,
  state: SubmitState | undefined,
  extra: Record<string, unknown>,
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'listing.submit_failed',
    target: { type: 'app', id: app.id },
    // Ids, counts and outcomes: never a text, a credential, a token or a store response.
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
  ctx: SubmitContext,
  input: { workspaceId: string; actor: Actor; confirmHash: string },
  s: {
    app: ManagedApp;
    claim: Claim;
    before: SubmitState;
    submissionId: string | null;
    submissionState: string | null;
    via: 'review_submission' | 'edit_commit';
    reread: boolean;
    cause?: string;
  },
): Promise<{ ok: true; result: SubmitResult }> {
  const at = ctx.now();
  // The review now holds what was pushed: what the store shows and what blocks a submit are different from a moment ago.
  emitCacheEvent('publish', { workspaceId: input.workspaceId, appId: s.app.id });
  const store = storeFor(s.app.platform);
  const version =
    s.before.version === null
      ? null
      : { id: s.before.version.id, versionString: s.before.version.versionString };
  await ctx.db.transaction(async (tx) => {
    // What was pushed is now with the store's review: the record is spent.
    await deletePush(tx, s.app.id, s.app.platform);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'listing.submitted',
      target: { type: 'app', id: s.app.id },
      detail: {
        appId: s.app.id,
        store,
        platform: s.app.platform,
        ...(version ? { versionId: version.id } : {}),
        ...(s.before.build ? { buildId: s.before.build.id } : {}),
        ...(s.submissionId ? { submissionId: s.submissionId } : {}),
        via: s.via,
        confirmedByReread: s.reread,
        hash: input.confirmHash,
        ...(s.cause ? { cause: s.cause } : {}),
      },
      at,
    });
    await emitEvent(tx, {
      workspaceId: input.workspaceId,
      type: 'listing.submitted',
      subject: { appId: s.app.id },
      payload: {
        appId: s.app.id,
        store,
        platform: s.app.platform,
        ...(version?.versionString ? { versionString: version.versionString } : {}),
        ...(s.submissionId ? { submissionId: s.submissionId } : {}),
        via: s.via,
        released: false,
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
      version,
      submission: s.submissionId === null ? null : { id: s.submissionId, state: s.submissionState },
      via: s.via,
      submitted: true,
      released: false,
      confirmedByReread: s.reread,
      submittedAt: at,
      note: byFamily(s.app.platform, { apple: NOTE_IOS, google: NOTE_PLAY }),
    },
  };
}

/**
 * `POST .../store-submit`: re-reads the store, checks it is still what `confirmHash` was made from and that nothing
 * blocks, writes once. See the file comment. Never retried, never releases.
 */
export async function applySubmit(
  ctx: SubmitContext,
  input: {
    workspaceId: string;
    appId: string;
    confirmHash: string;
    confirmation: string;
    actor: Actor;
    /** A person's own confirmation stands in for the typed phrase (the route checked the grant). */
    stepUpCovers?: boolean | undefined;
  },
): Promise<{ ok: true; result: SubmitResult } | Failure> {
  if (!ctx.submitEnabled) return submitDisabledFailure();
  const { db } = ctx;
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const record = await loadPush(db, app.id, app.platform);
  if (!record) return noPush();
  const phrase = confirmationPhrase(app, record);
  if (input.stepUpCovers !== true && input.confirmation.trim() !== phrase) {
    return failure(
      422,
      'confirmation_mismatch',
      `The confirmation does not match. Type "${phrase}" exactly. Nothing was submitted.`,
      { phrase, ...coded('confirm.mismatchSubmitted', { phrase }) },
    );
  }
  const flights = await inFlightOf(ctx, app);
  if (flights.push === 'writing')
    return failure(
      409,
      'write_in_progress',
      'A draft push for this app is in progress. Wait for it to finish.',
      coded('publish.inProgress.draftPush'),
    );
  if (flights.push === 'unknown') {
    return failure(
      409,
      'push_outcome_unknown',
      'It is not known whether the last draft push reached the store. Preview that push again first (staged changes), then submit.',
      coded('publish.unknown.draftBeforeSubmit'),
    );
  }

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

  let accepted: SubmitState | undefined;
  let blocked: SubmitChecks | undefined;
  let unknown: { cause: string } | undefined;
  let done: Awaited<ReturnType<StoreSubmitConnector['submit']>> | undefined;
  try {
    done = await withConnector(ctx, connection.input, (connector) =>
      connector.submit({
        request: requestOfManifest(record.manifest),
        guard: (current) => {
          const checks = split(
            evaluateChecks({ app, record, state: current, inFlight: { submit: null, push: null } }),
          );
          if (!checks.canSubmit) {
            blocked = checks;
            return false;
          }
          const same =
            submitConfirmHash({ workspaceId: input.workspaceId, app, record, state: current }) ===
            input.confirmHash;
          if (same) accepted = current;
          return same;
        },
      }),
    );
  } catch (error) {
    if (error instanceof SubmitDriftError) {
      if (blocked) {
        await auditFailed(ctx, input, app, error.current, {
          code: 'blocked',
          outcome: 'refused',
          blocking: blocked.blocking.map((b) => b.code).slice(0, 20),
        });
        await releaseClaim(db, claim);
        return failure(
          409,
          'blocked',
          'Something stands in the way of submitting, so nothing was submitted. See `checks`.',
          { checks: blocked, ...coded('publish.blocked.submit') },
        );
      }
      await auditFailed(ctx, input, app, error.current, {
        code: 'state_changed',
        outcome: 'refused',
      });
      await releaseClaim(db, claim);
      return failure(
        409,
        'state_changed',
        'The store changed since this was previewed, so nothing was submitted. Review the new preview and confirm it.',
        {
          preview: previewOf(ctx, {
            workspaceId: input.workspaceId,
            app,
            record,
            state: error.current,
            inFlight: { submit: null, push: null },
            stepUpCovers: input.stepUpCovers,
          }),
          ...coded('publish.changedSinceSubmit'),
        },
      );
    }
    if (error instanceof SubmitOutcomeUnknownError || error instanceof SubmitTimeout) {
      unknown = { cause: error instanceof SubmitTimeout ? 'timeout' : 'network' };
    } else {
      const mapped = mapStoreError(error, connection.secret);
      await auditFailed(ctx, input, app, accepted, { code: mapped.code, outcome: 'failed' });
      await releaseClaim(db, claim);
      return mapped.failure;
    }
  }

  if (done) {
    return succeed(ctx, input, {
      app,
      claim,
      before: done.before,
      submissionId: done.submissionId,
      submissionState: done.submissionState,
      via: done.via,
      reread: false,
    });
  }

  // ----- an unknown outcome is checked, not sent again
  const cause = unknown?.cause ?? 'unknown';
  if (supports(app.platform, 'transactionalEdits')) {
    // Google Play shows no review state: reading cannot settle it.
    await markUnknown(db, claim);
    await auditFailed(ctx, input, app, accepted, { code: cause, outcome: 'unknown' });
    return failure(
      409,
      'outcome_unknown',
      'Google Play did not answer, so it is not known whether the changes were sent to review. Google Play shows no review state through its API: look at the app in Play Console. Nothing is sent again until you preview and confirm again (Google refuses a second send while changes are in review).',
      coded('publish.playSubmitUnknown'),
    );
  }
  let current: SubmitState | undefined;
  try {
    current = await withConnector(ctx, connection.input, (connector) =>
      connector.readSubmitState(requestOfManifest(record.manifest)),
    );
  } catch {
    current = undefined;
  }
  if (current === undefined) {
    await markUnknown(db, claim);
    await auditFailed(ctx, input, app, accepted, {
      code: cause,
      outcome: 'unknown',
      readBack: 'failed',
    });
    return failure(
      409,
      'outcome_unknown',
      'It is not known whether the version was submitted: the store did not answer and could not be read back. Look at the app in App Store Connect, then preview again. Nothing is submitted until you confirm a new preview.',
      coded('publish.unknown.submitReached'),
    );
  }
  if (current.alreadySubmitted && accepted !== undefined) {
    return succeed(ctx, input, {
      app,
      claim,
      before: accepted,
      submissionId: null,
      submissionState: null,
      via: 'review_submission',
      reread: true,
      cause,
    });
  }
  await auditFailed(ctx, input, app, accepted, { code: 'not_applied', outcome: 'failed', cause });
  await releaseClaim(db, claim);
  return failure(
    502,
    'write_failed',
    'The store did not answer, and reading it back shows the version was not submitted. Nothing was submitted as far as the store shows. Preview again to try again.',
    { outcome: 'not_applied', ...coded('publish.submitNotApplied') },
  );
}
