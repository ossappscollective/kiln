import type { StoreConnector } from '@mrm/connectors';
import { type ActorType, storeSideId } from '@mrm/core';
import type { Database } from '@mrm/db';
import { enqueue, type Job, type JobHandler } from '../jobs.ts';
import {
  APP_SYNC_QUEUE,
  type AppsContext,
  credentialKindFor,
  getApp,
  type StoreConnectorInput,
  syncApp,
} from './apps.ts';
import { useCredentialSecret } from './credentials.ts';
import { listingDueAt } from './listing-drift.ts';
import { recordListingFailure, syncListing } from './listing-live.ts';

/**
 * Scheduled reads of the store listing (MRM_LISTING_INTERVAL_MINUTES, off by default).
 *
 * Without this a listing is read only when an app is synced (by hand, or by the `app.sync` job).
 * With it, the scheduler queues one `app.listing` job per app that is due, and the worker reads the
 * listing through the same read-only connector, credential use and snapshot recording as the sync's
 * listing step. Nothing here writes to a store.
 *
 * Rules, because a listing read is many requests (the texts, the categories and age rating, the
 * screenshots and previews of every locale: roughly up to a hundred for a large App Store listing):
 *
 * - Spaced and bounded: at most `perTick` apps per scheduler pass and `perWorkspace` per workspace,
 *   each one's job run `spacingMs` after the previous one, plus a jitter.
 * - Shared budget: each queued read takes a slot of the store rate limiter the sync route uses.
 * - One at a time per credential (Play allows one open edit per service account, and Apple's limit
 *   is per key): one job per credential is queued at a time, and a running job whose credential has
 *   another running listing job puts itself back a little later.
 * - Never twice for one app: not while the app has a queued or running `app.listing` or `app.sync`
 *   job; and the job claims the read with a compare-and-set on `listing_attempt_at`, so two instances
 *   that queued it at once read it once.
 * - Backoff: an app is due an interval after its last attempt (successful or not), doubled for every
 *   failure in a row (`listingBackoffMs`), so a broken credential is not hammered.
 * - It never throws out of the scheduler's timer, and a failed read is recorded on the app
 *   (`listing_error`, `listing_failures`), never retried by the queue.
 *
 * Audit: the use of the credential is audited as `credential.use` with the actor type `system` and
 * the queue name `app.listing` as its id, and `requestedBy: 'scheduler'` travels in the job payload
 * (the same convention as `app.sync`, docs/open-decisions.md, item 10).
 */

export const LISTING_READ_QUEUE = 'app.listing';
export const MIN_LISTING_INTERVAL_MINUTES = 30;
export const MAX_LISTING_INTERVAL_MINUTES = 7 * 24 * 60;
/** Reads queued in one scheduler pass, all workspaces together. */
export const DEFAULT_LISTING_PER_TICK = 3;
/** Reads queued in one scheduler pass for one workspace. */
export const DEFAULT_LISTING_PER_WORKSPACE = 2;
/** Between the run times of the reads queued in one pass. */
export const DEFAULT_LISTING_SPACING_MS = 15_000;
/** Longest one scheduled listing read may take. Longer than the sync's, because it reads every locale. */
export const DEFAULT_LISTING_TIMEOUT_MS = 4 * 60_000;
/** A read this recent (any path) is not started again by a second job. */
const CLAIM_GUARD_MS = 2 * 60_000;
/** How long a job waits when its credential is in use by another listing job. */
const DEFER_MS = 30_000;
const MAX_DEFERRALS = 10;
const MINUTE = 60_000;

/** MRM_LISTING_INTERVAL_MINUTES to milliseconds; 0 stays 0 (off). Throws on a value out of range. */
export function listingIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_LISTING_INTERVAL_MINUTES ||
    minutes > MAX_LISTING_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The listing read interval must be 0 (off) or from ${MIN_LISTING_INTERVAL_MINUTES} to ${MAX_LISTING_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export type ListingReadPayload = {
  workspaceId: string;
  appId: string;
  credentialId: string;
  requestedBy: string;
  /** How often the job has put itself back because its credential was busy. */
  deferrals?: number;
};

const isPayload = (value: unknown): value is ListingReadPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ListingReadPayload).workspaceId === 'string' &&
  typeof (value as ListingReadPayload).appId === 'string' &&
  typeof (value as ListingReadPayload).credentialId === 'string' &&
  typeof (value as ListingReadPayload).requestedBy === 'string';

// ---------------------------------------------------------------------------------------------
// Queueing (called by the scheduler's tick)

export type ListingQueueOptions = {
  /** Epoch milliseconds of this pass. */
  now: number;
  intervalMs: number;
  /** Reads queued in one pass. Default 3. */
  perTick?: number;
  /** Reads queued in one pass for one workspace. Default 2. */
  perWorkspace?: number;
  /** Delay between the run times of the reads queued in one pass. Default 15 seconds. */
  spacingMs?: number;
  /** A delay from 0 up to `maxMs` for one app, on top of the spacing. Default random. */
  jitter?: (key: string, maxMs: number) => number;
  /** Largest jitter. Default a tenth of the interval, at most a minute. */
  maxJitterMs?: number;
  /** The store rate limiter of the sync route (`take(workspaceId)` returns seconds to wait, 0 for a slot). */
  limiter?: { take(key: string): number };
};

export type ListingQueueSummary = {
  queued: number;
  /** Apps not queued, by reason. */
  skipped: {
    notDue: number;
    alreadyQueued: number;
    credentialBusy: number;
    capped: number;
    rateLimited: number;
  };
};

/** Apps and credentials that have an `app.listing` or `app.sync` job waiting or running. */
async function inFlight(db: Database): Promise<{ apps: Set<string>; credentials: Set<string> }> {
  const rows = await db.query(
    "SELECT queue, payload FROM jobs WHERE queue IN (?, ?) AND status IN ('queued', 'running')",
    [LISTING_READ_QUEUE, APP_SYNC_QUEUE],
  );
  const apps = new Set<string>();
  const credentials = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload)) as {
        appId?: unknown;
        credentialId?: unknown;
      } | null;
      if (typeof payload?.appId === 'string') apps.add(payload.appId);
      if (String(row.queue) === LISTING_READ_QUEUE && typeof payload?.credentialId === 'string') {
        credentials.add(payload.credentialId);
      }
    } catch {
      // A payload that is not JSON belongs to nobody we know.
    }
  }
  return { apps, credentials };
}

/**
 * Queues the listing reads that are due, within the bounds above. Never throws for one app: the
 * caller (the scheduler) wraps the whole pass too.
 */
export async function queueListingReads(
  db: Database,
  options: ListingQueueOptions,
): Promise<ListingQueueSummary> {
  const summary: ListingQueueSummary = {
    queued: 0,
    skipped: { notDue: 0, alreadyQueued: 0, credentialBusy: 0, capped: 0, rateLimited: 0 },
  };
  const { now: at, intervalMs } = options;
  if (intervalMs <= 0) return summary;
  const perTick = options.perTick ?? DEFAULT_LISTING_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_LISTING_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_LISTING_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? Math.min(MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));

  // Apps with a credential that still exists, the longest unattempted first.
  const apps = await db.query(
    `SELECT a.id, a.workspace_id, a.credential_id, s.listing_read_at, s.listing_attempt_at, s.listing_failures
       FROM apps a
       JOIN credentials c ON c.id = a.credential_id AND c.workspace_id = a.workspace_id
       LEFT JOIN app_listing_status s ON s.app_id = a.id AND s.workspace_id = a.workspace_id
      ORDER BY COALESCE(s.listing_attempt_at, s.listing_read_at, 0), a.created_at, a.id`,
  );
  const busy = await inFlight(db);
  const taken = new Map<string, number>();
  const limited = new Set<string>();
  for (const app of apps) {
    const id = String(app.id);
    const workspaceId = String(app.workspace_id);
    const credentialId = String(app.credential_id);
    const due = listingDueAt(
      intervalMs,
      {
        readAt:
          app.listing_read_at === null || app.listing_read_at === undefined
            ? null
            : Number(app.listing_read_at),
        attemptAt:
          app.listing_attempt_at === null || app.listing_attempt_at === undefined
            ? null
            : Number(app.listing_attempt_at),
      },
      Number(app.listing_failures ?? 0),
    );
    if (due !== null && due > at) {
      summary.skipped.notDue++;
      continue;
    }
    if (busy.apps.has(id)) {
      summary.skipped.alreadyQueued++;
      continue;
    }
    if (busy.credentials.has(credentialId)) {
      summary.skipped.credentialBusy++;
      continue;
    }
    if (summary.queued >= perTick || (taken.get(workspaceId) ?? 0) >= perWorkspace) {
      summary.skipped.capped++;
      continue;
    }
    if (limited.has(workspaceId) || (options.limiter?.take(workspaceId) ?? 0) > 0) {
      limited.add(workspaceId);
      summary.skipped.rateLimited++;
      continue;
    }
    const delay =
      summary.queued * spacing +
      Math.min(Math.max(Math.trunc(jitter(id, maxJitter)), 0), maxJitter);
    const payload: ListingReadPayload = {
      workspaceId,
      appId: id,
      credentialId,
      requestedBy: 'scheduler',
    };
    await enqueue(db, LISTING_READ_QUEUE, payload, { now: at, runAt: at + delay });
    busy.apps.add(id);
    busy.credentials.add(credentialId);
    taken.set(workspaceId, (taken.get(workspaceId) ?? 0) + 1);
    summary.queued++;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Running (the worker's handler)

export type ListingReadContext = AppsContext & {
  /** The scheduled interval in milliseconds, to check the app is still due when the job runs. */
  intervalMs?: number;
};

/** Apps whose read is running in this process: one read per app at a time. */
const running = new Set<string>();

/** Another running `app.listing` job for the same credential (not this one). */
async function credentialInUse(
  db: Database,
  job: Pick<Job, 'id'>,
  credentialId: string,
): Promise<boolean> {
  const rows = await db.query(
    "SELECT id, payload FROM jobs WHERE queue = ? AND status = 'running' AND id <> ?",
    [LISTING_READ_QUEUE, job.id],
  );
  return rows.some((row) => {
    try {
      return (
        (JSON.parse(String(row.payload)) as { credentialId?: unknown } | null)?.credentialId ===
        credentialId
      );
    } catch {
      return false;
    }
  });
}

/**
 * Claims the read of an app with a compare-and-set on `listing_attempt_at`: true for exactly one
 * of several that try at the same time (instances sharing a database), false when the app was
 * attempted within `CLAIM_GUARD_MS` or the claim was lost.
 */
export async function claimListingRead(
  db: Database,
  workspaceId: string,
  appId: string,
  at: number,
): Promise<boolean> {
  const changed = await db.execute(
    `UPDATE app_listing_status SET listing_attempt_at = ?
      WHERE app_id = ? AND workspace_id = ? AND (listing_attempt_at IS NULL OR listing_attempt_at <= ?)`,
    [at, appId, workspaceId, at - CLAIM_GUARD_MS],
  );
  if (changed > 0) return true;
  const [row] = await db.query(
    'SELECT app_id FROM app_listing_status WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  if (row) return false;
  try {
    await db.execute(
      'INSERT INTO app_listing_status (app_id, workspace_id, listing_attempt_at) VALUES (?, ?, ?)',
      [appId, workspaceId, at],
    );
    return true;
  } catch {
    // Another instance inserted the row first: it has the claim.
    return false;
  }
}

export type ListingReadOutcome =
  | { status: 'read'; recorded: number }
  | { status: 'failed'; error: string }
  | {
      status: 'skipped';
      reason: 'no_app' | 'running' | 'not_due' | 'claimed' | 'deferred' | 'synced' | 'unsupported';
    };

/**
 * One scheduled listing read of an app. Never throws for a store problem: a failure is recorded on
 * the app and returned. The rest (a database error) is thrown for the queue to deal with.
 */
export async function runListingRead(
  ctx: ListingReadContext,
  payload: ListingReadPayload,
  job: Pick<Job, 'id'>,
): Promise<ListingReadOutcome> {
  const { db } = ctx;
  const { workspaceId } = payload;
  const app = await getApp(db, workspaceId, payload.appId);
  if (!app) return { status: 'skipped', reason: 'no_app' };
  if (running.has(app.id)) return { status: 'skipped', reason: 'running' };
  const at = ctx.now();

  // Still due? A person may have refreshed it since the job was queued.
  if (ctx.intervalMs !== undefined && ctx.intervalMs > 0) {
    const [row] = await db.query(
      'SELECT listing_read_at, listing_attempt_at, listing_failures FROM app_listing_status WHERE app_id = ? AND workspace_id = ?',
      [app.id, workspaceId],
    );
    const due = listingDueAt(
      ctx.intervalMs,
      {
        readAt:
          row?.listing_read_at === null || row?.listing_read_at === undefined
            ? null
            : Number(row.listing_read_at),
        attemptAt:
          row?.listing_attempt_at === null || row?.listing_attempt_at === undefined
            ? null
            : Number(row.listing_attempt_at),
      },
      Number(row?.listing_failures ?? 0),
    );
    if (due !== null && due > at) return { status: 'skipped', reason: 'not_due' };
  }

  // One read per credential at a time.
  const deferrals = payload.deferrals ?? 0;
  if (deferrals < MAX_DEFERRALS && (await credentialInUse(db, job, app.credentialId))) {
    await enqueue(
      db,
      LISTING_READ_QUEUE,
      { ...payload, deferrals: deferrals + 1 },
      { now: at, runAt: at + DEFER_MS },
    );
    return { status: 'skipped', reason: 'deferred' };
  }

  running.add(app.id);
  try {
    if (!(await claimListingRead(db, workspaceId, app.id, at)))
      return { status: 'skipped', reason: 'claimed' };
    const actor = { type: 'system' as ActorType, id: LISTING_READ_QUEUE };
    const fail = async (error: string): Promise<ListingReadOutcome> => {
      await recordListingFailure(db, workspaceId, app.id, error, ctx.now());
      return { status: 'failed', error };
    };

    const [credential] = await db.query(
      'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
      [app.credentialId, workspaceId],
    );
    if (!credential)
      return fail(
        'The credential of this app no longer exists. Add the app again with a new credential.',
      );
    const kind = String(credential.kind);
    if (kind !== credentialKindFor[app.platform]) {
      return fail("This app's credential is not the kind its platform needs.");
    }
    // An iOS app that was never synced has no Apple id yet: the full sync finds it (and reads the
    // listing as its last step), so it is the right job for that app.
    const storeId = storeSideId(app.platform, app);
    if (!storeId) {
      running.delete(app.id);
      const done = await syncApp(ctx, { workspaceId, id: app.id }, actor, {
        trigger: 'job',
        requestedBy: payload.requestedBy,
      });
      return done.ok
        ? { status: 'skipped', reason: 'synced' }
        : { status: 'skipped', reason: 'unsupported' };
    }
    let secret: string | undefined;
    try {
      secret = await useCredentialSecret(
        db,
        ctx.masterKey,
        { workspaceId, id: app.credentialId, purpose: LISTING_READ_QUEUE },
        actor,
        ctx.now(),
      );
    } catch {
      return fail('The credential could not be decrypted. Enter its secret again.');
    }
    if (secret === undefined) return fail('The credential of this app no longer exists.');

    // Aborting also cancels the request the connector has in flight.
    const controller = new AbortController();
    const baseFetch = globalThis.fetch;
    const guardedFetch: typeof fetch = (input, init) =>
      baseFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal,
      });
    let connector: StoreConnector;
    try {
      connector = ctx.connectorFactory({
        kind: kind as StoreConnectorInput['kind'],
        secret,
        identifier: app.identifier,
        fetch: guardedFetch,
      });
    } catch {
      return fail('The store connection could not be set up from this credential.');
    }
    const result = await syncListing(
      { db, now: ctx.now, timeoutMs: ctx.timeoutMs },
      {
        workspaceId,
        app,
        appStoreId: storeId,
        connector,
        abort: () => controller.abort(),
        secret,
        actor,
      },
    );
    if (result.ok === true) return { status: 'read', recorded: result.recorded };
    if (result.ok === false) return { status: 'failed', error: result.error };
    return { status: 'skipped', reason: 'unsupported' };
  } finally {
    running.delete(app.id);
  }
}

/**
 * The worker's handler for `app.listing`. It does not throw for a store problem (the app keeps the
 * error and the scheduler backs off); a payload it does not know ends the job quietly.
 */
export function createListingReadHandler(ctx: ListingReadContext): JobHandler {
  return async (payload, job) => {
    if (!isPayload(payload)) return;
    await runListingRead({ ...ctx, timeoutMs: ctx.timeoutMs }, payload, job);
  };
}

/** For tests. */
export function forgetRunningListingReads(): void {
  running.clear();
}
