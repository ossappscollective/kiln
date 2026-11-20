import { randomUUID } from 'node:crypto';
import { AppStoreReviewsConnector, connectorFactory, fetchRatingSummary, type ListReviewsResult, PLAY_REVIEW_WINDOW_MS, PlayReviewsConnector, type RatingSummary, redactSecrets, secretStrings, type StoreConnectorInput, StoreError, StoreRateLimitError, type StoreReview, type StoreReviewConnector } from '@mrm/connectors';
import { type ActorType, needsStoreAppId, type Platform, storeOf, supports } from '@mrm/core';
import type { Database, Param, Row, Sql } from '@mrm/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import { credentialKindFor, getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { parseResponse, type StoreKey } from './service.ts';
import {
  type AutoTranslateSummary,
  autoTranslateNewReviews,
  type TranslationContext } from '../../services/translation.ts';
import { lowRatingThresholdFor } from '../../services/workspace-settings.ts';

/**
 * Reads the customer reviews of an app from its store (read only) into `app_reviews`.
 *
 * - Idempotent: a review is upserted by the store's id, so reading it again changes nothing. An
 *   edit (rating, text) and a developer response that appears, changes or goes away are applied to
 *   the stored row; our own triage fields (status, assignee, note) are never touched by a sync.
 * - Incremental: App Store reviews are read newest first, from `since` (the last success minus an
 *   overlap that catches edits and new responses on recent reviews), and an unfinished first read
 *   continues from a saved cursor. Google Play serves only about the last 7 days, whatever is asked,
 *   so each read takes that whole window; a previous success older than the window means reviews
 *   were missed for good, which is recorded as a `gap` (never hidden).
 * - Quiet baseline: the first read of an app makes no `review.new_low_rating` events (the same rule
 *   as the first app sync); later reads emit one per low review, once (`low_rating_notified_at`).
 *   A failure streak emits `review.sync_failed` once (`failure_notified_at`).
 * - One read at a time per app and per credential (Apple's limit is per key, Play's quota per app),
 *   with a timeout like the app sync; the route and the scheduler share the store rate limiter.
 * - A failure is remembered (`review_sync_state`: error, streak, backoff) and returned; nothing
 *   thrown here reaches the scheduler or the job worker.
 *
 * - `review.new`: every review that is new in a read, as one event each (up to MAX_NEW_REVIEW_EVENTS_PER_SYNC), or one
 *   grouped event with the count for the first read of an app and for a bigger read. It feeds the alert `review.new`.
 *
 * Events carry ids and the rating only, never review text or a display name.
 */

type Actor = { type: ActorType; id: string };

/** The app with the workspace it was found in (the row type has no workspace id). */
type RunApp = ManagedApp & { workspaceId: string };

export const REVIEW_SYNC_QUEUE = 'review.sync';
export const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;
/**
 * Ratings at or below the threshold are "low" (`review.new_low_rating`). This is the default of the
 * workspace setting `reviews.lowRatingThreshold` (services/workspace-settings.ts), which wins.
 */
export const LOW_RATING_THRESHOLD = 2;
/** Most low-rating events one read emits; the rest are recorded as notified without an event. */
export const MAX_LOW_RATING_EVENTS_PER_SYNC = 50;
/**
 * `review.new` (docs/api/events.md): up to this many new reviews in one read are one event each; more than
 * this, or the first read of an app, are ONE grouped event with the count, so a first sync never floods.
 */
export const MAX_NEW_REVIEW_EVENTS_PER_SYNC = 10;
/** Most reviews one read takes; an App Store backlog continues from the cursor next time. */
export const MAX_REVIEWS_PER_SYNC = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** App Store: read this far before the last success, to see edits and responses on recent reviews. */
export const APPLE_OVERLAP_MS = 14 * DAY_MS;
const MIN_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const MAX_ERROR_LENGTH = 500;
const MAX_WARNINGS = 10;

export const reviewBackoffMs = (failures: number): number =>
  Math.min(MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

/** The store behind a platform. */
export const storeFor = (platform: Platform): StoreKey => storeOf(platform);

// ---------------------------------------------------------------------------------------------
// Connectors

export type ReviewConnectorInput = StoreConnectorInput;

export type ReviewConnectorFactory = (input: ReviewConnectorInput) => StoreReviewConnector;

export const defaultReviewConnectorFactory: ReviewConnectorFactory = connectorFactory<StoreReviewConnector>({
  app_store_connect: (input) =>
    AppStoreReviewsConnector.fromSecret(input.secret, {
          appStoreId: input.storeAppId ?? '',
          fetch: input.fetch }),
  google_play: (input) =>
    new PlayReviewsConnector({
          serviceAccount: input.secret,
          packageName: input.identifier,
          fetch: input.fetch }) });

/** The optional store-wide rating (public iTunes lookup). Replaced by a fake in tests. */
export type RatingFetcher = (input: {
  appStoreId: string;
  country: string;
  platform?: 'ios' | 'macos';
}) => Promise<RatingSummary | undefined>;

export const defaultRatingFetcher: RatingFetcher = (input) => fetchRatingSummary(input);

/** The storefront whose store-wide rating is kept. One for now; documented in docs/api/reviews.md. */
export const RATING_COUNTRY = 'US';

export type ReviewsContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  connectorFactory: ReviewConnectorFactory;
  /** `null` turns the store-wide rating off. Default: the real iTunes lookup. */
  ratingFetcher?: RatingFetcher | null;
  /** Longest one read may take. Default 90 seconds. */
  timeoutMs: number;
  /** The threshold when the workspace has not set `reviews.lowRatingThreshold`. Default LOW_RATING_THRESHOLD. */
  lowRatingThreshold?: number;
  /**
   * Seams of the optional automatic translation after a sync (workspace setting `translation.mode`
   * = auto). Tests replace the network; production passes `allowPrivateUrls` from the config.
   */
  translation?: Pick<
    TranslationContext,
    'allowPrivateUrls' | 'fetch' | 'resolve' | 'exchange' | 'timeoutMs'
  >;
};

// ---------------------------------------------------------------------------------------------
// State

export type ReviewSyncResult = {
  at: number;
  fetched: number;
  added: number;
  updated: number;
  /** Reviews whose developer response appeared, changed or went away. */
  responses: number;
  skipped: number;
  /** False when the read stopped before the end (limits, rate-limit reserve, page cap). */
  complete: boolean;
  /** Reviews were missed: the previous success is older than the store's window (Play). */
  gap: { from: number; to: number } | null;
  warnings: string[];
  /** Whether this was the quiet first read (no events). */
  baseline: boolean;
  lowRatingEvents: number;
  /** The threshold this read used (the workspace setting at that time). */
  lowRatingThreshold?: number;
  ratingSummary: 'stored' | 'unchanged' | 'unavailable' | 'off';
  /** Automatic translation of the new reviews (mode `auto` only). A failure there never fails the sync. */
  translation?: AutoTranslateSummary;
};

export type ReviewSyncState = {
  store: StoreKey;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** The scheduler does not try again before this. A manual sync ignores it. */
  backoffUntil: number | null;
  /** When a gap was last detected (reviews missed for good), or null. */
  lastGapAt: number | null;
  /** An App Store backlog is left: the next read continues. */
  moreToRead: boolean;
  lastResult: ReviewSyncResult | null;
};

export async function getSyncState(
  sql: Sql,
  workspaceId: string,
  appId: string,
  store: StoreKey,
): Promise<ReviewSyncState> {
  const [row] = await sql.query(
    `SELECT cursor, last_attempt_at, last_success_at, last_error, consecutive_failures, backoff_until,
            last_gap_at, last_result
       FROM review_sync_state WHERE app_id = ? AND store = ? AND workspace_id = ?`,
    [appId, store, workspaceId],
  );
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  let lastResult: ReviewSyncResult | null = null;
  if (row && typeof row.last_result === 'string') {
    try {
      lastResult = JSON.parse(row.last_result) as ReviewSyncResult;
    } catch {
      lastResult = null;
    }
  }
  return {
    store,
    lastAttemptAt: n(row?.last_attempt_at),
    lastSuccessAt: n(row?.last_success_at),
    lastError:
      row?.last_error === null || row?.last_error === undefined ? null : String(row.last_error),
    consecutiveFailures: Number(row?.consecutive_failures ?? 0),
    backoffUntil: n(row?.backoff_until),
    lastGapAt: n(row?.last_gap_at),
    moreToRead: typeof row?.cursor === 'string' && row.cursor !== '',
    lastResult };
}

type Cursor = { c: string; s: number | null };

function parseCursor(raw: unknown): Cursor | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const v = JSON.parse(raw) as Partial<Cursor>;
    return typeof v.c === 'string'
      ? { c: v.c, s: typeof v.s === 'number' ? v.s : null }
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Failures

class SyncTimeout extends Error {}

type Classified = {
  failure: Failure;
  message: string;
  transient: boolean;
  retryAfterSeconds?: number;
};

function classify(error: unknown, secret: string): Classified {
  const clean = (text: string) =>
    redactSecrets(text, secret ? secretStrings(secret) : []).slice(0, MAX_ERROR_LENGTH);
  const make = (
    status: Failure['status'],
    code: string,
    message: string,
    transient: boolean,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>,
  ): Classified => {
    const safe = clean(message);
    return {
      failure: {
        ok: false,
        status,
        body: { error: code, message: safe, ...extra },
        ...(headers ? { headers } : {}) },
      message: safe,
      transient };
  };
  if (error instanceof SyncTimeout)
    return make(504, 'timeout', 'The store did not answer in time. Try again.', true);
  if (error instanceof StoreRateLimitError) {
    const wait = error.retryAfterSeconds;
    return {
      ...make(
        429,
        'rate_limited',
        error.message,
        true,
        { retryAfterSeconds: wait },
        { 'Retry-After': String(wait) },
      ),
      retryAfterSeconds: wait };
  }
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
      case 'invalid_input':
        return make(422, 'store_auth', error.message, false);
      case 'forbidden':
      case 'api_disabled':
        return make(422, 'store_forbidden', error.message, false);
      case 'not_found':
        return make(422, 'store_not_found', error.message, false);
      case 'server':
      case 'network':
      case 'edit_invalid':
        return make(502, 'store_unavailable', error.message, true);
      default:
        return make(502, 'store_unavailable', error.message, false);
    }
  }
  // Not ours to explain, and the text may echo what was sent. Nothing of it is kept.
  return make(
    502,
    'sync_failed',
    'The review sync could not be completed. Try again in a moment.',
    false,
  );
}

async function recordFailure(
  ctx: ReviewsContext,
  app: RunApp,
  c: Classified,
  actor: Actor,
  trigger: ReviewSyncTrigger,
): Promise<void> {
  const at = ctx.now();
  const store = storeFor(app.platform);
  await ctx.db.transaction(async (tx) => {
    const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      app.id,
      app.workspaceId,
    ]);
    if (!still) return;
    const [row] = await tx.query(
      'SELECT consecutive_failures, failure_notified_at FROM review_sync_state WHERE app_id = ? AND store = ?',
      [app.id, store],
    );
    const failures = Number(row?.consecutive_failures ?? 0) + 1;
    const wait = Math.max(reviewBackoffMs(failures), (c.retryAfterSeconds ?? 0) * 1000);
    const notify = row?.failure_notified_at === null || row?.failure_notified_at === undefined;
    await tx.execute(
      `INSERT INTO review_sync_state
         (app_id, store, workspace_id, last_attempt_at, last_error, consecutive_failures, backoff_until, failure_notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, store) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
         consecutive_failures = excluded.consecutive_failures, backoff_until = excluded.backoff_until,
         failure_notified_at = COALESCE(review_sync_state.failure_notified_at, excluded.failure_notified_at)`,
      [app.id, store, app.workspaceId, at, c.message, failures, at + wait, notify ? at : null],
    );
    await recordAudit(tx, {
      workspaceId: app.workspaceId,
      actor,
      action: 'reviews.sync',
      target: { type: 'app', id: app.id },
      detail: { ok: false, store, code: String(c.failure.body.error), ...trigger },
      at });
    if (notify) {
      await emitEvent(tx, {
        workspaceId: app.workspaceId,
        type: 'review.sync_failed',
        subject: { appId: app.id },
        payload: {
          appId: app.id,
          store,
          code: String(c.failure.body.error),
          transient: c.transient,
          failures },
        at });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The sync

export type ReviewSyncTrigger = { trigger: 'request' } | { trigger: 'job'; requestedBy: string };
export type ReviewSyncFailure = Failure & { transient: boolean };

/** Apps being read right now, in this process. A second read of the same app is refused. */
const running = new Set<string>();

/** One read at a time per credential in this process (Apple's limit is per key, Play's quota per app). */
const credentialQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = credentialQueues.get(key) ?? Promise.resolve();
  const run = previous.then(job, job);
  const tail = run.catch(() => undefined);
  credentialQueues.set(key, tail);
  tail.finally(() => {
    if (credentialQueues.get(key) === tail) credentialQueues.delete(key);
  });
  return run;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

const responseJson = (r: StoreReview['developerResponse']): string | null =>
  r ? JSON.stringify({ body: r.body, at: r.at ?? null, state: r.state ?? null }) : null;

/** Reads the app's reviews. A failure is remembered on the app's review sync state and returned. */
export async function syncReviews(
  ctx: ReviewsContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
  trigger: ReviewSyncTrigger = { trigger: 'request' },
): Promise<{ ok: true; sync: ReviewSyncResult; state: ReviewSyncState } | ReviewSyncFailure> {
  const found = await getApp(ctx.db, input.workspaceId, input.id);
  if (!found) return { ...failure(404, 'not_found'), transient: false };
  const app: RunApp = { ...found, workspaceId: input.workspaceId };
  if (running.has(app.id)) {
    return {
      ...failure(409, 'sync_in_progress', 'The reviews of this app are already being read.'),
      transient: false };
  }
  running.add(app.id);
  try {
    return await run(ctx, app, actor, trigger);
  } catch (error) {
    // Nothing may escape: a bug here must not stop the scheduler or the worker.
    const c = classify(error, '');
    await recordFailure(ctx, app, c, actor, trigger).catch(() => undefined);
    return { ...c.failure, transient: c.transient };
  } finally {
    running.delete(app.id);
  }
}

/**
 * Customer reviews belong to the App Store Connect APP, not to one platform. A macOS record that shares the store
 * app id of an iOS record (universal purchase) would read and store the same reviews a second time, so its reviews are
 * the iOS record's. Returns the id of that iOS record, or null when the app's reviews are its own.
 */
export async function reviewsOwnedByOtherRecord(
  sql: Sql,
  workspaceId: string,
  app: { platform: Platform; storeAppId: string | null },
): Promise<string | null> {
  if (app.platform !== 'macos' || !app.storeAppId) return null;
  const [owner] = await sql.query(
    "SELECT id FROM apps WHERE workspace_id = ? AND platform = 'ios' AND store_app_id = ? ORDER BY created_at, id",
    [workspaceId, app.storeAppId],
  );
  return owner ? String(owner.id) : null;
}

async function run(ctx: ReviewsContext, app: RunApp, actor: Actor, trigger: ReviewSyncTrigger) {
  const { db } = ctx;
  const workspaceId = app.workspaceId;
  const store = storeFor(app.platform);
  const stop = async (c: Classified): Promise<ReviewSyncFailure> => {
    await recordFailure(ctx, app, c, actor, trigger);
    return { ...c.failure, transient: c.transient };
  };
  const plain = (status: Failure['status'], code: string, message: string) =>
    stop({ failure: failure(status, code, message), message, transient: false });

  if (await reviewsOwnedByOtherRecord(db, workspaceId, app)) {
    return {
      ...failure(
        409,
        'reviews_shared',
        'The customer reviews of an App Store Connect app are shared by its iOS and macOS entries. They are read once, for the iOS entry.',
      ),
      transient: false } as ReviewSyncFailure;
  }

  const [credential] = await db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential) {
    return plain(
      422,
      'credential_not_found',
      'The credential of this app no longer exists. Add the app again with a new credential.',
    );
  }
  const kind = String(credential.kind);
  if (kind !== credentialKindFor[app.platform]) {
    return plain(
      422,
      'credential_kind',
      "This app's credential is not the kind its platform needs.",
    );
  }
  if (needsStoreAppId(app.platform) && !app.storeAppId) {
    return plain(
      422,
      'app_not_synced',
      'The App Store id of this app is not known yet. Sync the app first, then read its reviews.',
    );
  }
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: REVIEW_SYNC_QUEUE },
      actor,
      ctx.now(),
    );
  } catch {
    return plain(
      422,
      'credential_unreadable',
      'The credential could not be decrypted. Enter its secret again.',
    );
  }
  if (secret === undefined)
    return plain(422, 'credential_not_found', 'The credential of this app no longer exists.');

  const before = await getSyncState(db, workspaceId, app.id, store);
  const [stateRow] = await db.query(
    'SELECT cursor FROM review_sync_state WHERE app_id = ? AND store = ?',
    [app.id, store],
  );
  const saved = parseCursor(stateRow?.cursor);
  const startedAt = ctx.now();
  const baseline = before.lastSuccessAt === null;

  // What to ask for. Play ignores `since` on purpose (a developer reply does not change the user
  // comment's time, and the whole window is a handful of requests).
  const since = !supports(app.platform, 'reviewsSinceCursor')
    ? undefined
    : saved
      ? (saved.s ?? undefined)
      : before.lastSuccessAt !== null
        ? before.lastSuccessAt - APPLE_OVERLAP_MS
        : undefined;
  const gap =
    supports(app.platform, 'limitedReviewWindow') &&
    before.lastSuccessAt !== null &&
    startedAt - before.lastSuccessAt > PLAY_REVIEW_WINDOW_MS
      ? { from: before.lastSuccessAt, to: startedAt }
      : null;

  // Aborting also cancels the request the connector has in flight.
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = (target, init) =>
    baseFetch(target, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncTimeout('timeout'));
    }, ctx.timeoutMs);
  });
  let read: ListReviewsResult;
  try {
    const connector = ctx.connectorFactory({
      kind: kind as ReviewConnectorInput['kind'],
      secret,
      identifier: app.identifier,
      storeAppId: app.storeAppId,
      fetch: guardedFetch });
    const work = serialized(app.credentialId, () =>
      connector.listReviews({
        ...(since !== undefined ? { since } : {}),
        ...(saved ? { cursor: saved.c } : {}),
        limit: MAX_REVIEWS_PER_SYNC }),
    );
    work.catch(() => undefined);
    read = await Promise.race([work, timedOut]);
  } catch (error) {
    return stop(classify(error, secret));
  } finally {
    clearTimeout(timer);
  }

  const at = ctx.now();
  // The workspace setting, read once per sync: a change applies from the next read on.
  const threshold = await lowRatingThresholdFor(
    db,
    workspaceId,
    ctx.lowRatingThreshold ?? LOW_RATING_THRESHOLD,
  );
  const warnings = [...read.warnings];
  if (gap) {
    const missedUntil = gap.to - PLAY_REVIEW_WINDOW_MS;
    warnings.unshift(
      `Gap: the last successful read was ${Math.floor((gap.to - gap.from) / DAY_MS)} days ago, and Google Play serves only about the last 7 days. Reviews written before ${new Date(missedUntil).toISOString().slice(0, 10)} since then could not be read and are not in this inbox.`,
    );
  }
  const done = await db.transaction(async (tx) => {
    // The app may have been deleted while the store was being read.
    const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      app.id,
      workspaceId,
    ]);
    if (!still) return undefined;
    const wanted = new Map<string, StoreReview>();
    for (const review of read.reviews) wanted.set(review.storeReviewId, review);
    const existing = new Map<string, Row>();
    const ids = [...wanted.keys()];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows = await tx.query(
        `SELECT id, store_review_id, rating, title, body, author_name, territory, language, app_version,
                build_number, device, created_at, updated_at, developer_response, low_rating_notified_at
           FROM app_reviews WHERE app_id = ? AND store_review_id IN (${chunk.map(() => '?').join(', ')})`,
        [app.id, ...chunk],
      );
      for (const row of rows) existing.set(String(row.store_review_id), row);
    }

    let added = 0;
    let updated = 0;
    let responses = 0;
    let events = 0;
    let lowSeen = 0;
    const addedIds: string[] = [];
    const addedRatings: { id: string; storeReviewId: string; rating: number }[] = [];
    const untouched: string[] = [];
    const notify = async (
      id: string,
      review: StoreReview,
      source: 'new' | 'edited',
    ): Promise<number | null> => {
      lowSeen++;
      if (baseline || events >= MAX_LOW_RATING_EVENTS_PER_SYNC) return at;
      events++;
      await emitEvent(tx, {
        workspaceId,
        type: 'review.new_low_rating',
        subject: { appId: app.id },
        // Ids and the rating only: never the text or the display name.
        payload: {
          reviewId: id,
          storeReviewId: review.storeReviewId,
          appId: app.id,
          store,
          rating: review.rating,
          threshold,
          source },
        at });
      return at;
    };

    for (const review of wanted.values()) {
      const response = responseJson(review.developerResponse);
      const old = existing.get(review.storeReviewId);
      if (!old) {
        const id = randomUUID();
        const notified = review.rating <= threshold ? await notify(id, review, 'new') : null;
        await tx.execute(
          `INSERT INTO app_reviews
             (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory,
              language, app_version, build_number, device, created_at, updated_at, first_seen_at, fetched_at,
              developer_response, status, low_rating_notified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
          [
            id,
            workspaceId,
            app.id,
            store,
            review.storeReviewId,
            review.rating,
            review.title ?? null,
            review.body,
            review.authorName ?? null,
            review.territory ?? null,
            review.language ?? null,
            review.appVersion ?? null,
            review.buildNumber ?? null,
            review.device ?? null,
            review.createdAt,
            review.updatedAt,
            at,
            at,
            response,
            notified,
          ],
        );
        added++;
        addedIds.push(id);
        addedRatings.push({ id, storeReviewId: review.storeReviewId, rating: review.rating });
        continue;
      }
      const edited =
        Number(old.rating) !== review.rating ||
        !same(old.title, review.title) ||
        String(old.body) !== review.body ||
        !same(old.author_name, review.authorName) ||
        !same(old.territory, review.territory) ||
        !same(old.language, review.language) ||
        !same(old.app_version, review.appVersion) ||
        !same(old.build_number, review.buildNumber) ||
        !same(old.device, review.device) ||
        Number(old.updated_at) !== review.updatedAt;
      const oldResponse = responseJson(
        (() => {
          const parsed = parseResponse(old.developer_response);
          return parsed
            ? {
                body: parsed.body,
                ...(parsed.at !== null ? { at: parsed.at } : {}),
                ...(parsed.state !== null ? { state: parsed.state } : {}) }
            : undefined;
        })(),
      );
      const responseChanged = oldResponse !== response;
      let notified: number | null | undefined;
      // Threshold semantics (docs/api/reviews.md): a review notifies at most once, when it is first seen
      // low or when its rating changes to a low one. Raising the threshold never re-emits for reviews
      // already stored (the store read overlaps, so they come back); only a changed rating counts.
      if (
        Number(old.rating) !== review.rating &&
        review.rating <= threshold &&
        (old.low_rating_notified_at === null || old.low_rating_notified_at === undefined)
      ) {
        notified = await notify(String(old.id), review, 'edited');
      }
      if (!edited && !responseChanged && notified === undefined) {
        untouched.push(String(old.id));
        continue;
      }
      if (edited) updated++;
      if (responseChanged) responses++;
      // created_at stays: Google Play sends a modification time only, and the first one we saw is the creation.
      await tx.execute(
        `UPDATE app_reviews SET rating = ?, title = ?, body = ?, author_name = ?, territory = ?, language = ?,
                app_version = ?, build_number = ?, device = ?, updated_at = ?, fetched_at = ?,
                developer_response = ?, low_rating_notified_at = COALESCE(low_rating_notified_at, ?)
          WHERE id = ? AND app_id = ?`,
        [
          review.rating,
          review.title ?? null,
          review.body,
          review.authorName ?? null,
          review.territory ?? null,
          review.language ?? null,
          review.appVersion ?? null,
          review.buildNumber ?? null,
          review.device ?? null,
          review.updatedAt,
          at,
          response,
          notified ?? null,
          String(old.id),
          app.id,
        ],
      );
    }
    // `review.new`: ids, store, platform and rating only (never a title, a text or a name). The first read of
    // an app and a big read are one grouped event; otherwise one per review.
    if (added > 0) {
      const common = { appId: app.id, store, platform: app.platform };
      if (baseline || added > MAX_NEW_REVIEW_EVENTS_PER_SYNC) {
        await emitEvent(tx, {
          workspaceId,
          type: 'review.new',
          subject: { appId: app.id },
          payload: { ...common, grouped: true, count: added, baseline },
          at });
      } else {
        for (const r of addedRatings) {
          await emitEvent(tx, {
            workspaceId,
            type: 'review.new',
            subject: { appId: app.id },
            payload: {
              ...common,
              reviewId: r.id,
              storeReviewId: r.storeReviewId,
              rating: r.rating },
            at });
        }
      }
    }
    for (let i = 0; i < untouched.length; i += 200) {
      const chunk = untouched.slice(i, i + 200);
      await tx.execute(
        `UPDATE app_reviews SET fetched_at = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        [at, ...chunk],
      );
    }
    if (lowSeen > events && !baseline) {
      warnings.push(
        `${lowSeen - events} low ratings were recorded without an event (more than ${MAX_LOW_RATING_EVENTS_PER_SYNC} in one read).`,
      );
    }
    const result: ReviewSyncResult = {
      at,
      fetched: wanted.size,
      added,
      updated,
      responses,
      skipped: read.skipped,
      complete: read.complete,
      gap,
      warnings: warnings.slice(0, MAX_WARNINGS),
      baseline,
      lowRatingEvents: events,
      lowRatingThreshold: threshold,
      ratingSummary: 'off' };
    const cursor: Param = read.nextCursor
      ? JSON.stringify({ c: read.nextCursor, s: since ?? null } satisfies Cursor)
      : null;
    await tx.execute(
      `INSERT INTO review_sync_state
         (app_id, store, workspace_id, cursor, last_attempt_at, last_success_at, last_error,
          consecutive_failures, backoff_until, failure_notified_at, last_gap_at, last_result)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?)
       ON CONFLICT (app_id, store) DO UPDATE SET
         cursor = excluded.cursor, last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at, last_error = NULL, consecutive_failures = 0,
         backoff_until = NULL, failure_notified_at = NULL,
         last_gap_at = COALESCE(excluded.last_gap_at, review_sync_state.last_gap_at),
         last_result = excluded.last_result`,
      [app.id, store, workspaceId, cursor, at, at, gap ? at : null, JSON.stringify(result)],
    );
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'reviews.sync',
      target: { type: 'app', id: app.id },
      // Counts only: no review text, no names.
      detail: {
        ok: true,
        store,
        fetched: result.fetched,
        added,
        updated,
        responses,
        complete: result.complete,
        gap: gap !== null,
        baseline,
        ...trigger },
      at });
    return { result, addedIds };
  });
  if (!done) return { ...failure(404, 'not_found'), transient: false } as ReviewSyncFailure;
  const outcome = done.result;

  // Best effort, after the reviews are safe: the store-wide rating of an iOS app.
  let changed = false;
  if (supports(app.platform, 'storeWideRating') && app.storeAppId && ctx.ratingFetcher !== null) {
    const fetcher = ctx.ratingFetcher ?? defaultRatingFetcher;
    outcome.ratingSummary = await recordRatingSummary(ctx, app, app.storeAppId, fetcher);
    changed = true;
  }
  // Best effort too: translate the new reviews when the workspace set translation to `auto`. It never
  // throws, never fails the sync, and records its own failure in the summary and the audit log.
  const translation = await autoTranslateNewReviews(
    { db, masterKey: ctx.masterKey, now: ctx.now, ...(ctx.translation ?? {}) },
    workspaceId,
    app.id,
    done.addedIds,
  );
  if (translation) {
    outcome.translation = translation;
    changed = true;
  }
  if (changed) {
    await db
      .execute('UPDATE review_sync_state SET last_result = ? WHERE app_id = ? AND store = ?', [
        JSON.stringify(outcome),
        app.id,
        store,
      ])
      .catch(() => 0);
  }
  return {
    ok: true as const,
    sync: outcome,
    state: await getSyncState(db, workspaceId, app.id, store) };
}

const milli = (v: number | undefined): number | null =>
  v === undefined ? null : Math.round(v * 1000);

/** Stores the store-wide rating when it differs from the last one stored for the storefront. */
async function recordRatingSummary(
  ctx: ReviewsContext,
  app: RunApp,
  appStoreId: string,
  fetcher: RatingFetcher,
): Promise<ReviewSyncResult['ratingSummary']> {
  let summary: RatingSummary | undefined;
  try {
    summary = await fetcher({
      appStoreId,
      country: RATING_COUNTRY,
      ...(app.platform === 'macos' ? { platform: 'macos' as const } : {}) });
  } catch {
    return 'unavailable';
  }
  if (!summary) return 'unavailable';
  const next = {
    average: milli(summary.averageRating),
    count: summary.ratingCount ?? null,
    currentAverage: milli(summary.currentVersionAverage),
    currentCount: summary.currentVersionCount ?? null };
  try {
    const [last] = await ctx.db.query(
      `SELECT average_milli, rating_count, current_average_milli, current_count FROM app_rating_summaries
        WHERE app_id = ? AND store = 'appstoreconnect' AND territory = ? ORDER BY observed_at DESC LIMIT 1`,
      [app.id, summary.country],
    );
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    if (
      last &&
      n(last.average_milli) === next.average &&
      n(last.rating_count) === next.count &&
      n(last.current_average_milli) === next.currentAverage &&
      n(last.current_count) === next.currentCount
    ) {
      return 'unchanged';
    }
    await ctx.db.execute(
      `INSERT INTO app_rating_summaries
         (id, workspace_id, app_id, store, territory, average_milli, rating_count, current_average_milli, current_count, observed_at)
       VALUES (?, ?, ?, 'appstoreconnect', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        app.workspaceId,
        app.id,
        summary.country,
        next.average,
        next.count,
        next.currentAverage,
        next.currentCount,
        ctx.now(),
      ],
    );
    return 'stored';
  } catch {
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------------------------
// As a job

export type ReviewSyncPayload = {
  workspaceId: string;
  appId: string;
  credentialId?: string;
  requestedBy: string;
};

export function enqueueReviewSync(
  ctx: Pick<ReviewsContext, 'db' | 'now'>,
  payload: ReviewSyncPayload,
  options: { runAt?: number } = {},
): Promise<string> {
  return enqueue(ctx.db, REVIEW_SYNC_QUEUE, payload, {
    now: ctx.now(),
    ...(options.runAt !== undefined ? { runAt: options.runAt } : {}) });
}

const isPayload = (value: unknown): value is ReviewSyncPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ReviewSyncPayload).workspaceId === 'string' &&
  typeof (value as ReviewSyncPayload).appId === 'string' &&
  typeof (value as ReviewSyncPayload).requestedBy === 'string';

/**
 * The worker's handler for `review.sync`. A failure, transient or not, is recorded on the app's
 * review sync state with a backoff (the scheduler honours it), so the queue does not retry it
 * within seconds: this never throws.
 */
export function createReviewSyncHandler(ctx: ReviewsContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await syncReviews(
      ctx,
      { workspaceId: payload.workspaceId, id: payload.appId },
      { type: 'system', id: REVIEW_SYNC_QUEUE },
      { trigger: 'job', requestedBy: payload.requestedBy },
    ).catch(() => undefined);
  };
}
