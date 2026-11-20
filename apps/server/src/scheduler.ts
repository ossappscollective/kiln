import type { Database } from '@mrm/db';
import { enqueue } from './jobs.ts';
import {
  type AsoQueueSummary,
  type AsoUpkeepSummary,
  asoUpkeep,
  queueAsoRefreshes,
} from './modules/aso/schedule.ts';
import { type AnalyticsQueueSummary, queueAnalyticsSyncs } from './modules/analytics/schedule.ts';
import { type AnalyticsUpkeepSummary, analyticsUpkeep } from './modules/analytics/store.ts';
import { APP_SYNC_QUEUE } from './services/apps.ts';
import { DEFAULT_POLL_MAX_MS, enqueueCiPoll } from './services/ci.ts';
import { ACTIVE_STATUSES, purgeOrphans } from './services/ci-runs.ts';
import { type ListingQueueSummary, queueListingReads } from './services/listing-schedule.ts';
import { type ReminderSummary, sendPlanReminders } from './services/plan-reminders.ts';
import { type ReleaseWatchSummary, sendReleaseWatch } from './services/release-watch.ts';
import {
  queueReviewSyncs,
  type ReviewQueueSummary,
  type ReviewUpkeepSummary,
  reviewUpkeep,
} from './modules/reviews/schedule.ts';
import {
  loadSyncPrefs,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
} from './services/sync-schedule.ts';

/**
 * A lightweight scheduler on top of the job queue: no cron, no extra process. Each tick it
 *
 *  - queues an `app.sync` job for every app whose last attempt is older than the sync interval
 *    (when the interval is on), spread out with jitter so a workspace does not sync all its apps
 *    in the same second;
 *  - queues a `ci.poll` for any repository that has a run still going but no poll waiting (a
 *    safety net: a poll chain normally keeps itself going, but a restart or a failed job can end
 *    it);
 *  - deletes rows left behind by a disconnected repository or a deleted app;
 *  - every reminder interval (when on), sends reminders about release plans: deadlines close or
 *    passed and rollout steps whose time has passed, as events (`services/plan-reminders.ts`). That
 *    is the one thing it does itself instead of queueing a job: a reminder is an event row, written
 *    once under a unique key, and it never touches a store.
 *
 * Syncs and polls are only queued; the worker runs them, so a sync still goes through the normal
 * handler, its audit trail and its retries. The clock, the jitter and the rate limiter are
 * injected, so tests drive `tick()` by hand.
 */

export { MAX_SYNC_INTERVAL_MINUTES, MIN_SYNC_INTERVAL_MINUTES };
/** Syncs the scheduler queues for one workspace in one tick: the rest wait for the next. */
export const DEFAULT_PER_WORKSPACE_PER_TICK = 5;
export const DEFAULT_MAX_PER_TICK = 100;
/** MRM_RELEASE_WATCH_INTERVAL_MINUTES: 0 (off) or from 5 minutes to a week. */
export const MIN_RELEASE_WATCH_INTERVAL_MINUTES = 5;
export const MAX_RELEASE_WATCH_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_RELEASE_WATCH_INTERVAL_MINUTES = 15;
/** MRM_REMINDER_INTERVAL_MINUTES: 0 (off) or from 5 minutes to a week. */
export const MIN_REMINDER_INTERVAL_MINUTES = 5;
export const MAX_REMINDER_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_REMINDER_INTERVAL_MINUTES = 15;
const MINUTE = 60_000;

export type SchedulerOptions = {
  db: Database;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Milliseconds between syncs of one app. 0 (the default) turns scheduled syncs off. */
  syncIntervalMs?: number;
  /** Milliseconds between reminder runs. 0 (the default here) turns plan reminders off. */
  reminderIntervalMs?: number;
  /**
   * Milliseconds between runs of the release watch (`release.stalled`, `review.unanswered`: services/release-watch.ts). 0 (the
   * default here) turns it off. Each signal is also off until its workspace setting turns it on (`release.stalledAfterHours`
   * is on by default, `reviews.unansweredReminderHours` is off).
   */
  releaseWatchIntervalMs?: number;
  /** Hours before the end of a target day that "due soon" starts. Default 24. */
  reminderLeadHours?: number;
  /** Most reminders one run sends. Default 100. */
  maxRemindersPerRun?: number;
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
  /**
   * Milliseconds between scheduled listing reads of one app (MRM_LISTING_INTERVAL_MINUTES). 0 (the
   * default) turns them off. They queue `app.listing` jobs (services/listing-schedule.ts), bounded
   * and spaced by `listing`, sharing `limiter` with the syncs.
   */
  listingIntervalMs?: number;
  listing?: { perTick?: number; perWorkspace?: number; spacingMs?: number; maxJitterMs?: number };
  /**
   * Milliseconds between scheduled reads of the customer reviews of one app
   * (MRM_REVIEW_SYNC_INTERVAL_MINUTES). 0 (the default) turns them off. They queue `review.sync`
   * jobs (services/review-schedule.ts), bounded and spaced by `reviews`, sharing `limiter`.
   */
  reviewSyncIntervalMs?: number;
  reviews?: { perTick?: number; perWorkspace?: number; spacingMs?: number; maxJitterMs?: number };
  /**
   * MRM_REVIEW_RETENTION_DAYS: reviews older than this are deleted, a bounded number per run, at
   * most once an hour. 0 keeps them all. Absent: no pruning (rows of deleted apps are still removed).
   */
  reviewRetentionDays?: number;
  /**
   * Milliseconds between scheduled ASO refreshes (keyword ranks and competitors from public store pages) of one
   * app (MRM_ASO_INTERVAL_MINUTES). 0 (the default) turns them off. They queue `aso.refresh` jobs
   * (services/aso-schedule.ts), bounded and spaced by `aso`, sharing `limiter`. `asoPlayEnabled` is
   * MRM_ASO_PLAY_UNOFFICIAL_ENABLED: while off, Google Play apps are skipped.
   */
  asoIntervalMs?: number;
  asoPlayEnabled?: boolean;
  aso?: { perTick?: number; perWorkspace?: number; spacingMs?: number; maxJitterMs?: number };
  /**
   * Milliseconds between scheduled analytics syncs of one app (MRM_ANALYTICS_INTERVAL_MINUTES, default 360). 0 or absent turns them
   * off. They queue `analytics.sync` jobs (services/analytics-schedule.ts), bounded and spaced by `analytics`, sharing `limiter`. A
   * workspace must also have turned on its setting `analytics.enabled`. The daily facts are never pruned; old run rows are, hourly.
   */
  analyticsIntervalMs?: number;
  analytics?: { perTick?: number; perWorkspace?: number; spacingMs?: number; maxJitterMs?: number };
  /** MRM_ASO_RETENTION_DAYS: rank checks and competitor snapshots older than this are deleted (at most once an hour). 0 keeps them. Absent: no pruning. */
  asoRetentionDays?: number;
  /** Runs started longer ago than this are no longer polled. Default 3 hours. */
  pollMaxMs?: number;
  /**
   * Prunes the clone folder (services/clone-upkeep.ts): `run` is called from a tick when
   * `intervalMs` has passed since the last run (the first tick runs it). It runs here, not through
   * the job queue, because the clones are on this machine's disk. Absent: no sweep.
   */
  cloneSweep?: { intervalMs: number; run: () => Promise<unknown> };
  /** The alert evaluator, digests and upkeep (services/alert-runner.ts): `run` is called from a tick when `intervalMs` has passed. Absent: no alerts pass. */
  alerts?: { intervalMs: number; run: () => Promise<unknown> };
  onError?: (message: string, error: unknown) => void;
};

export type TickSummary = {
  syncsQueued: number;
  /** Apps not queued, by reason. */
  skipped: {
    recent: number;
    alreadyQueued: number;
    rateLimited: number;
    capped: number;
    /** Apps of a workspace that turned its scheduled refresh off (`sync.enabled`). */
    disabled: number;
  };
  pollsQueued: number;
  purged: number;
  /** What the reminder run sent; null when none ran this tick (off, or not yet due). */
  reminders: ReminderSummary | null;
  /** What the release watch sent; absent when it did not run this tick (off, or not yet due). */
  releaseWatch?: ReleaseWatchSummary;
  /** What the scheduled listing reads queued; absent when they are off. */
  listings?: ListingQueueSummary;
  /** What the scheduled review reads queued; absent when they are off. */
  reviews?: ReviewQueueSummary;
  /** What the review upkeep deleted; set only in a tick where it ran. */
  reviewUpkeep?: ReviewUpkeepSummary;
  /** What the scheduled ASO refreshes queued; absent when they are off. */
  aso?: AsoQueueSummary;
  /** What the ASO upkeep deleted; set only in a tick where it ran. */
  asoUpkeep?: AsoUpkeepSummary;
  /** What the scheduled analytics syncs queued; absent when they are off. */
  analytics?: AnalyticsQueueSummary;
  /** What the analytics upkeep deleted; set only in a tick where it ran. */
  analyticsUpkeep?: AnalyticsUpkeepSummary;
  /** What a clone sweep returned; set only in a tick where one ran. */
  cloneSweep?: unknown;
  /** What the alerts pass returned; set only in a tick where one ran. */
  alerts?: unknown;
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
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_SYNC_INTERVAL_MINUTES ||
    minutes > MAX_SYNC_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The sync interval must be 0 (off) or from ${MIN_SYNC_INTERVAL_MINUTES} to ${MAX_SYNC_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

/** Minutes from MRM_REMINDER_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function reminderIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_REMINDER_INTERVAL_MINUTES ||
    minutes > MAX_REMINDER_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The reminder interval must be 0 (off) or from ${MIN_REMINDER_INTERVAL_MINUTES} to ${MAX_REMINDER_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

/** Minutes from MRM_RELEASE_WATCH_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function releaseWatchIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_RELEASE_WATCH_INTERVAL_MINUTES ||
    minutes > MAX_RELEASE_WATCH_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The release watch interval must be 0 (off) or from ${MIN_RELEASE_WATCH_INTERVAL_MINUTES} to ${MAX_RELEASE_WATCH_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db } = options;
  const now = options.now ?? Date.now;
  const interval = options.syncIntervalMs ?? 0;
  const tickMs = options.tickMs ?? MINUTE;
  /** A tenth of the interval of the workspace, at most 5 minutes, unless the options fix it. */
  const maxJitterFor = (intervalMs: number) =>
    options.maxJitterMs ?? Math.min(5 * MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const perWorkspace = options.perWorkspacePerTick ?? DEFAULT_PER_WORKSPACE_PER_TICK;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const pollMaxMs = options.pollMaxMs ?? DEFAULT_POLL_MAX_MS;
  const report = options.onError ?? ((message, error) => console.error(message, error));
  const reminderInterval = options.reminderIntervalMs ?? 0;
  const releaseWatchInterval = options.releaseWatchIntervalMs ?? 0;
  let lastReleaseWatchAt: number | undefined;
  const listingInterval = options.listingIntervalMs ?? 0;
  const reviewInterval = options.reviewSyncIntervalMs ?? 0;
  const asoInterval = options.asoIntervalMs ?? 0;
  let lastReviewUpkeepAt: number | undefined;
  let lastAsoUpkeepAt: number | undefined;
  let lastAnalyticsUpkeepAt: number | undefined;
  const analyticsInterval = options.analyticsIntervalMs ?? 0;
  /** When the reminders last ran in this process. Other instances have their own; the unique key keeps them apart. */
  let lastReminderAt: number | undefined;

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
    // Each workspace may have turned its refresh off or chosen its own interval (settings `sync.enabled`, `sync.intervalMinutes`).
    const prefs = await loadSyncPrefs(db);
    const taken = new Map<string, number>();
    const limited = new Set<string>();
    for (const app of apps) {
      const id = String(app.id);
      const workspaceId = String(app.workspace_id);
      const mine = prefs.get(workspaceId);
      if (mine?.enabled === false) {
        summary.skipped.disabled++;
        continue;
      }
      const wanted = mine?.intervalMinutes !== undefined ? mine.intervalMinutes * MINUTE : interval;
      const last = Math.max(Number(app.last_sync_attempt_at ?? 0), Number(app.last_synced_at ?? 0));
      if (last > 0 && at - last < wanted) {
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
      const maxJitter = maxJitterFor(wanted);
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

  let lastSweepAt: number | undefined;
  let lastAlertsAt: number | undefined;

  async function tick(): Promise<TickSummary> {
    const at = now();
    const summary: TickSummary = {
      syncsQueued: 0,
      skipped: { recent: 0, alreadyQueued: 0, rateLimited: 0, capped: 0, disabled: 0 },
      pollsQueued: 0,
      purged: 0,
      reminders: null,
    };
    summary.purged = await purgeOrphans(db);
    if (interval > 0) await queueSyncs(summary, at);
    await queuePolls(summary, at);
    if (
      reminderInterval > 0 &&
      (lastReminderAt === undefined || at - lastReminderAt >= reminderInterval)
    ) {
      lastReminderAt = at;
      // A failing reminder run must not stop syncs or polls, and nothing may escape the timer.
      try {
        summary.reminders = await sendPlanReminders(db, at, {
          ...(options.reminderLeadHours !== undefined
            ? { leadHours: options.reminderLeadHours }
            : {}),
          ...(options.maxRemindersPerRun !== undefined
            ? { maxPerRun: options.maxRemindersPerRun }
            : {}),
          onError: report,
        });
      } catch (error) {
        report('plan reminders failed', error);
      }
    }
    if (
      releaseWatchInterval > 0 &&
      (lastReleaseWatchAt === undefined || at - lastReleaseWatchAt >= releaseWatchInterval)
    ) {
      lastReleaseWatchAt = at;
      try {
        summary.releaseWatch = await sendReleaseWatch(db, at, {
          ...(options.maxRemindersPerRun !== undefined
            ? { maxPerRun: options.maxRemindersPerRun }
            : {}),
          onError: report,
        });
      } catch (error) {
        report('release watch failed', error);
      }
    }
    if (listingInterval > 0) {
      // Listing reads are optional work: a failure here must not stop syncs or polls.
      try {
        summary.listings = await queueListingReads(db, {
          now: at,
          intervalMs: listingInterval,
          ...(options.listing ?? {}),
          ...(options.jitter ? { jitter: options.jitter } : {}),
          ...(options.limiter ? { limiter: options.limiter } : {}),
        });
      } catch (error) {
        report('scheduled listing reads failed', error);
      }
    }
    if (reviewInterval > 0) {
      // Review reads are optional work: a failure here must not stop syncs or polls.
      try {
        summary.reviews = await queueReviewSyncs(db, {
          now: at,
          intervalMs: reviewInterval,
          ...(options.reviews ?? {}),
          ...(options.jitter ? { jitter: options.jitter } : {}),
          ...(options.limiter ? { limiter: options.limiter } : {}),
        });
      } catch (error) {
        report('scheduled review reads failed', error);
      }
    }
    if (
      options.reviewRetentionDays !== undefined &&
      (lastReviewUpkeepAt === undefined || at - lastReviewUpkeepAt >= 60 * MINUTE)
    ) {
      lastReviewUpkeepAt = at;
      try {
        summary.reviewUpkeep = await reviewUpkeep(db, {
          now: at,
          retentionDays: options.reviewRetentionDays,
        });
      } catch (error) {
        report('review upkeep failed', error);
      }
    }
    if (asoInterval > 0) {
      // ASO reads are optional work: a failure here must not stop syncs or polls.
      try {
        summary.aso = await queueAsoRefreshes(db, {
          now: at,
          intervalMs: asoInterval,
          playEnabled: options.asoPlayEnabled ?? false,
          ...(options.aso ?? {}),
          ...(options.jitter ? { jitter: options.jitter } : {}),
          ...(options.limiter ? { limiter: options.limiter } : {}),
        });
      } catch (error) {
        report('scheduled ASO refreshes failed', error);
      }
    }
    if (
      options.asoRetentionDays !== undefined &&
      (lastAsoUpkeepAt === undefined || at - lastAsoUpkeepAt >= 60 * MINUTE)
    ) {
      lastAsoUpkeepAt = at;
      try {
        summary.asoUpkeep = await asoUpkeep(db, {
          now: at,
          retentionDays: options.asoRetentionDays,
        });
      } catch (error) {
        report('ASO upkeep failed', error);
      }
    }
    if (analyticsInterval > 0) {
      // Analytics reads are optional work: a failure here must not stop syncs or polls.
      try {
        summary.analytics = await queueAnalyticsSyncs(db, {
          now: at,
          intervalMs: analyticsInterval,
          ...(options.analytics ?? {}),
          ...(options.jitter ? { jitter: options.jitter } : {}),
          ...(options.limiter ? { limiter: options.limiter } : {}),
        });
      } catch (error) {
        report('scheduled analytics syncs failed', error);
      }
      if (lastAnalyticsUpkeepAt === undefined || at - lastAnalyticsUpkeepAt >= 60 * MINUTE) {
        lastAnalyticsUpkeepAt = at;
        try {
          summary.analyticsUpkeep = await analyticsUpkeep(db, { now: at });
        } catch (error) {
          report('analytics upkeep failed', error);
        }
      }
    }
    const sweep = options.cloneSweep;
    if (
      sweep &&
      sweep.intervalMs > 0 &&
      (lastSweepAt === undefined || at - lastSweepAt >= sweep.intervalMs)
    ) {
      lastSweepAt = at;
      try {
        summary.cloneSweep = await sweep.run();
      } catch (error) {
        report('clone sweep failed', error);
      }
    }
    const alertsPass = options.alerts;
    if (
      alertsPass &&
      alertsPass.intervalMs > 0 &&
      (lastAlertsAt === undefined || at - lastAlertsAt >= alertsPass.intervalMs)
    ) {
      lastAlertsAt = at;
      try {
        summary.alerts = await alertsPass.run();
      } catch (error) {
        report('alerts pass failed', error);
      }
    }
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
