import type { Database } from '@mrm/db';
import { enqueue } from './jobs.ts';
import { APP_SYNC_QUEUE } from './services/apps.ts';
import { DEFAULT_POLL_MAX_MS, enqueueCiPoll } from './services/ci.ts';
import { ACTIVE_STATUSES, purgeOrphans } from './services/ci-runs.ts';

/**
 * A lightweight scheduler on top of the job queue: no cron, no extra process. Each tick it
 *
 *  - queues an `app.sync` job for every app whose last attempt is older than the sync interval
 *    (when the interval is on), spread out with jitter so a workspace does not sync all its apps
 *    in the same second;
 *  - queues a `ci.poll` for any repository that has a run still going but no poll waiting (a
 *    safety net: a poll chain normally keeps itself going, but a restart or a failed job can end
 *    it);
 *  - deletes rows left behind by a disconnected repository or a deleted app.
 *
 * It only ever queues jobs; the worker runs them, so a sync still goes through the normal
 * handler, its audit trail and its retries. The clock, the jitter and the rate limiter are
 * injected, so tests drive `tick()` by hand.
 */

export const MIN_SYNC_INTERVAL_MINUTES = 5;
export const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
/** Syncs the scheduler queues for one workspace in one tick: the rest wait for the next. */
export const DEFAULT_PER_WORKSPACE_PER_TICK = 5;
export const DEFAULT_MAX_PER_TICK = 100;
const MINUTE = 60_000;

export type SchedulerOptions = {
  db: Database;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Milliseconds between syncs of one app. 0 (the default) turns scheduled syncs off. */
  syncIntervalMs?: number;
  /** How often `start` runs a tick. Default one minute. */
  tickMs?: number;
  /**
   * A delay from 0 up to `maxMs`, for one app, added to the run time of its sync job.
   * Default: random. Tests pass a fixed one.
   */
  jitter?: (key: string, maxMs: number) => number;
  /** Largest jitter. Default a tenth of the interval, at most 5 minutes. */
  maxJitterMs?: number;
  /**
   * The per workspace rate limit of syncs (`take(workspaceId)` returns the seconds to wait, 0 when
   * a slot was taken). Pass the one the sync route uses, so scheduled and manual syncs share one
   * budget. Without it only `perWorkspacePerTick` limits.
   */
  limiter?: { take(key: string): number };
  perWorkspacePerTick?: number;
  maxPerTick?: number;
  /** Runs started longer ago than this are no longer polled. Default 3 hours. */
  pollMaxMs?: number;
  onError?: (message: string, error: unknown) => void;
};

export type TickSummary = {
  syncsQueued: number;
  /** Apps not queued, by reason. */
  skipped: { recent: number; alreadyQueued: number; rateLimited: number; capped: number };
  pollsQueued: number;
  purged: number;
};

export type Scheduler = {
  /** One pass. Exposed for tests and for `start`. */
  tick(): Promise<TickSummary>;
  start(): void;
  stop(): Promise<void>;
};

/** Minutes from MRM_SYNC_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function syncIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (!Number.isInteger(minutes) || minutes < MIN_SYNC_INTERVAL_MINUTES || minutes > MAX_SYNC_INTERVAL_MINUTES) {
    throw new Error(
      `The sync interval must be 0 (off) or from ${MIN_SYNC_INTERVAL_MINUTES} to ${MAX_SYNC_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db } = options;
  const now = options.now ?? Date.now;
  const interval = options.syncIntervalMs ?? 0;
  const tickMs = options.tickMs ?? MINUTE;
  const maxJitter = options.maxJitterMs ?? Math.min(5 * MINUTE, Math.floor(interval / 10));
  const jitter = options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const perWorkspace = options.perWorkspacePerTick ?? DEFAULT_PER_WORKSPACE_PER_TICK;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const pollMaxMs = options.pollMaxMs ?? DEFAULT_POLL_MAX_MS;
  const report = options.onError ?? ((message, error) => console.error(message, error));

  /** The ids of apps that have an `app.sync` job waiting or running. */
  async function appsInQueue(): Promise<Set<string>> {
    const rows = await db.query(
      "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
      [APP_SYNC_QUEUE],
    );
    const ids = new Set<string>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.payload)) as { appId?: unknown } | null;
        if (typeof payload?.appId === 'string') ids.add(payload.appId);
      } catch {
        // A payload that is not JSON belongs to nobody we know.
      }
    }
    return ids;
  }

  async function queueSyncs(summary: TickSummary, at: number): Promise<void> {
    const apps = await db.query(
      `SELECT id, workspace_id, last_synced_at, last_sync_attempt_at FROM apps
        ORDER BY COALESCE(last_sync_attempt_at, 0), created_at, id`,
    );
    const inQueue = await appsInQueue();
    const taken = new Map<string, number>();
    const limited = new Set<string>();
    for (const app of apps) {
      const id = String(app.id);
      const workspaceId = String(app.workspace_id);
      const last = Math.max(Number(app.last_sync_attempt_at ?? 0), Number(app.last_synced_at ?? 0));
      if (last > 0 && at - last < interval) {
        summary.skipped.recent++;
        continue;
      }
      if (inQueue.has(id)) {
        summary.skipped.alreadyQueued++;
        continue;
      }
      if (summary.syncsQueued >= maxPerTick || (taken.get(workspaceId) ?? 0) >= perWorkspace) {
        summary.skipped.capped++;
        continue;
      }
      if (limited.has(workspaceId) || (options.limiter?.take(workspaceId) ?? 0) > 0) {
        limited.add(workspaceId);
        summary.skipped.rateLimited++;
        continue;
      }
      const delay = Math.min(Math.max(Math.trunc(jitter(id, maxJitter)), 0), maxJitter);
      await enqueue(
        db,
        APP_SYNC_QUEUE,
        { workspaceId, appId: id, requestedBy: 'scheduler' },
        { now: at, runAt: at + delay },
      );
      inQueue.add(id);
      taken.set(workspaceId, (taken.get(workspaceId) ?? 0) + 1);
      summary.syncsQueued++;
    }
  }

  async function queuePolls(summary: TickSummary, at: number): Promise<void> {
    const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
    const rows = await db.query(
      `SELECT DISTINCT workspace_id, repository_id FROM workflow_runs
        WHERE status IN (${marks}) AND started_at > ?`,
      [...ACTIVE_STATUSES, at - pollMaxMs],
    );
    for (const row of rows) {
      const queued = await enqueueCiPoll(
        { db, now: () => at },
        {
          workspaceId: String(row.workspace_id),
          repositoryId: String(row.repository_id),
          startedAt: at,
          attempt: 0,
          requestedBy: 'scheduler',
        },
      );
      if (queued) summary.pollsQueued++;
    }
  }

  async function tick(): Promise<TickSummary> {
    const at = now();
    const summary: TickSummary = {
      syncsQueued: 0,
      skipped: { recent: 0, alreadyQueued: 0, rateLimited: 0, capped: 0 },
      pollsQueued: 0,
      purged: 0,
    };
    summary.purged = await purgeOrphans(db);
    if (interval > 0) await queueSyncs(summary, at);
    await queuePolls(summary, at);
    return summary;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> = Promise.resolve();
  let stopped = true;

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick()
        .catch((error) => report('scheduler tick failed', error))
        .then(() => schedule(tickMs));
    }, delay);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      // The first pass waits a little, so a restart does not queue work before the server is up.
      schedule(Math.min(10_000, tickMs));
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
