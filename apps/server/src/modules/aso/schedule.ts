import { needsStoreAppId, parsePlatform, supports } from '@kiln/core';
import type { Database } from '@kiln/db';
import { enqueue } from '../../jobs.ts';
import { ASO_CLAIM_TTL_MS, ASO_REFRESH_QUEUE, type AsoRefreshPayload } from './service.ts';

/**
 * Scheduled ASO refreshes (MRM_ASO_INTERVAL_MINUTES, off by default) and the data protection upkeep
 * (MRM_ASO_RETENTION_DAYS). The scheduler only queues `aso.refresh` jobs; the worker runs them through
 * the same service as the route (`refreshApp`), which takes the claim, checks only what is due, and shares
 * the per source rate limits and the cache.
 *
 * Rules (the stores are public services, not ours: be a quiet visitor):
 *
 * - Spaced and bounded: at most `perTick` apps per pass and `perWorkspace` per workspace, each job run
 *   `spacingMs` after the previous one, plus a jitter.
 * - Only apps that have something to look at (a tracked keyword or a followed competitor).
 * - An app is due an interval after its last attempt; when its last refresh left work over (it stopped at the
 *   per run cap, the time or a rate limit) it is due again after the shorter of the interval and 30 minutes.
 * - Backoff: not before `backoff_until` (doubled for every failed refresh in a row, up to six hours).
 * - Never twice for one app: not while a job is queued or running, nor while a live claim is held.
 * - A Google Play app is skipped while MRM_ASO_PLAY_UNOFFICIAL_ENABLED is off; an iOS app whose App Store id
 *   is not known yet (never synced) is skipped.
 */

export const MIN_ASO_INTERVAL_MINUTES = 60;
export const MAX_ASO_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_ASO_PER_TICK = 5;
export const DEFAULT_ASO_PER_WORKSPACE = 3;
export const DEFAULT_ASO_SPACING_MS = 20_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DEFERRED_RETRY_MS = 30 * MINUTE;

/** Minutes from MRM_ASO_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function asoIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_ASO_INTERVAL_MINUTES ||
    minutes > MAX_ASO_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The ASO interval must be 0 (off) or from ${MIN_ASO_INTERVAL_MINUTES} to ${MAX_ASO_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export type AsoQueueSummary = {
  queued: number;
  /** Apps not queued, by reason. */
  skipped: {
    recent: number;
    backoff: number;
    alreadyQueued: number;
    claimed: number;
    rateLimited: number;
    capped: number;
    notReady: number;
    playOff: number;
  };
};

export type AsoQueueOptions = {
  now: number;
  /** Milliseconds between refreshes of one app. Must be above 0. */
  intervalMs: number;
  /** MRM_ASO_PLAY_UNOFFICIAL_ENABLED. */
  playEnabled: boolean;
  perTick?: number;
  perWorkspace?: number;
  spacingMs?: number;
  /** Largest jitter. Default a tenth of the interval, at most 10 minutes. */
  maxJitterMs?: number;
  jitter?: (key: string, maxMs: number) => number;
  /** Shared with the refresh route: `take(workspaceId)` returns seconds to wait, 0 when a slot was taken. */
  limiter?: { take(key: string): number };
};

const deferredOf = (raw: unknown): boolean => {
  if (typeof raw !== 'string') return false;
  try {
    return (JSON.parse(raw) as { deferred?: unknown } | null)?.deferred === true;
  } catch {
    return false;
  }
};

/** Queues `aso.refresh` jobs for the apps that are due. Never reads a store itself. */
export async function queueAsoRefreshes(
  db: Database,
  options: AsoQueueOptions,
): Promise<AsoQueueSummary> {
  const { now, intervalMs } = options;
  const perTick = options.perTick ?? DEFAULT_ASO_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_ASO_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_ASO_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? Math.min(10 * MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const summary: AsoQueueSummary = {
    queued: 0,
    skipped: {
      recent: 0,
      backoff: 0,
      alreadyQueued: 0,
      claimed: 0,
      rateLimited: 0,
      capped: 0,
      notReady: 0,
      playOff: 0,
    },
  };

  const apps = await db.query(
    `SELECT a.id, a.workspace_id, a.platform, a.store_app_id,
            s.last_attempt_at, s.backoff_until, s.claimed_at, s.last_result
       FROM apps a
       LEFT JOIN aso_app_state s ON s.app_id = a.id
      WHERE EXISTS (SELECT 1 FROM aso_keywords k WHERE k.app_id = a.id)
         OR EXISTS (SELECT 1 FROM aso_competitors c WHERE c.app_id = a.id)
      ORDER BY COALESCE(s.last_attempt_at, 0), a.created_at, a.id`,
  );
  const jobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [ASO_REFRESH_QUEUE],
  );
  const queuedApps = new Set<string>();
  for (const job of jobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<AsoRefreshPayload> | null;
      if (typeof payload?.appId === 'string') queuedApps.add(payload.appId);
    } catch {
      // A payload that is not JSON belongs to nobody we know.
    }
  }

  const perWorkspaceCount = new Map<string, number>();
  const limited = new Set<string>();
  for (const app of apps) {
    const id = String(app.id);
    const workspaceId = String(app.workspace_id);
    const platform = parsePlatform(String(app.platform));
    if (platform === undefined) continue;
    if (supports(platform, 'unofficialSearch') && !options.playEnabled) {
      summary.skipped.playOff++;
      continue;
    }
    if (needsStoreAppId(platform) && !app.store_app_id) {
      summary.skipped.notReady++;
      continue;
    }
    const last = Number(app.last_attempt_at ?? 0);
    const wait = deferredOf(app.last_result) ? Math.min(intervalMs, DEFERRED_RETRY_MS) : intervalMs;
    if (last > 0 && now - last < wait) {
      summary.skipped.recent++;
      continue;
    }
    if (
      app.backoff_until !== null &&
      app.backoff_until !== undefined &&
      Number(app.backoff_until) > now
    ) {
      summary.skipped.backoff++;
      continue;
    }
    if (
      app.claimed_at !== null &&
      app.claimed_at !== undefined &&
      now - Number(app.claimed_at) < ASO_CLAIM_TTL_MS
    ) {
      summary.skipped.claimed++;
      continue;
    }
    if (queuedApps.has(id)) {
      summary.skipped.alreadyQueued++;
      continue;
    }
    if (summary.queued >= perTick || (perWorkspaceCount.get(workspaceId) ?? 0) >= perWorkspace) {
      summary.skipped.capped++;
      continue;
    }
    if (limited.has(workspaceId) || (options.limiter?.take(workspaceId) ?? 0) > 0) {
      limited.add(workspaceId);
      summary.skipped.rateLimited++;
      continue;
    }
    const delay = Math.min(Math.max(Math.trunc(jitter(id, maxJitter)), 0), maxJitter);
    const payload: AsoRefreshPayload = { workspaceId, appId: id, requestedBy: 'scheduler' };
    await enqueue(db, ASO_REFRESH_QUEUE, payload, {
      now,
      runAt: now + summary.queued * spacing + delay,
    });
    queuedApps.add(id);
    perWorkspaceCount.set(workspaceId, (perWorkspaceCount.get(workspaceId) ?? 0) + 1);
    summary.queued++;
  }
  return summary;
}

export type AsoUpkeepOptions = {
  now: number;
  /** MRM_ASO_RETENTION_DAYS. 0 keeps everything. */
  retentionDays: number;
  /** Most rows deleted per table in one run. Default 2000. */
  maxRows?: number;
};

export type AsoUpkeepSummary = { rankChecks: number; snapshots: number; orphans: number };

/**
 * Data protection upkeep: deletes rank checks and competitor snapshots older than the retention, a
 * bounded number per run, and the rows of apps that no longer exist. The newest snapshot of each competitor is
 * never deleted (it is what the next look is compared with, and what the list shows).
 */
export async function asoUpkeep(
  db: Database,
  options: AsoUpkeepOptions,
): Promise<AsoUpkeepSummary> {
  const maxRows = options.maxRows ?? 2000;
  let rankChecks = 0;
  let snapshots = 0;
  if (options.retentionDays > 0) {
    const cutoff = options.now - options.retentionDays * DAY;
    rankChecks = await db.execute(
      'DELETE FROM aso_rank_checks WHERE id IN (SELECT id FROM aso_rank_checks WHERE checked_at < ? ORDER BY checked_at LIMIT ?)',
      [cutoff, maxRows],
    );
    snapshots = await db.execute(
      `DELETE FROM aso_competitor_snapshots WHERE id IN (
         SELECT s.id FROM aso_competitor_snapshots s
          WHERE s.checked_at < ?
            AND EXISTS (SELECT 1 FROM aso_competitor_snapshots n
                         WHERE n.competitor_id = s.competitor_id
                           AND (n.checked_at > s.checked_at OR (n.checked_at = s.checked_at AND n.id > s.id)))
          ORDER BY s.checked_at LIMIT ?)`,
      [cutoff, maxRows],
    );
  }
  let orphans = 0;
  for (const table of [
    'aso_competitor_snapshots',
    'aso_rank_checks',
    'aso_competitors',
    'aso_keywords',
  ]) {
    orphans += await db.execute(
      `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE app_id NOT IN (SELECT id FROM apps) LIMIT ?)`,
      [maxRows],
    );
  }
  orphans += await db.execute(
    'DELETE FROM aso_app_state WHERE app_id NOT IN (SELECT id FROM apps)',
  );
  return { rankChecks, snapshots, orphans };
}

export type AsoRefreshAllSummary = {
  queued: number;
  /** Apps not queued, by reason. */
  skipped: { alreadyQueued: number; notReady: number; playOff: number; capped: number };
};

export const MAX_REFRESH_ALL_APPS = 25;

/**
 * Queues a refresh of every app of a workspace that has something to look at (an admin asked). Each job
 * checks what is due and, because a person asked, everything up to the per run cap. Never reads a store itself.
 */
export async function queueAsoRefreshAll(
  db: Database,
  input: {
    workspaceId: string;
    now: number;
    playEnabled: boolean;
    requestedBy: string;
    spacingMs?: number;
    max?: number;
  },
): Promise<AsoRefreshAllSummary> {
  const max = input.max ?? MAX_REFRESH_ALL_APPS;
  const spacing = input.spacingMs ?? DEFAULT_ASO_SPACING_MS;
  const summary: AsoRefreshAllSummary = {
    queued: 0,
    skipped: { alreadyQueued: 0, notReady: 0, playOff: 0, capped: 0 },
  };
  const apps = await db.query(
    `SELECT a.id, a.platform, a.store_app_id FROM apps a
      WHERE a.workspace_id = ?
        AND (EXISTS (SELECT 1 FROM aso_keywords k WHERE k.app_id = a.id)
          OR EXISTS (SELECT 1 FROM aso_competitors c WHERE c.app_id = a.id))
      ORDER BY a.created_at, a.id`,
    [input.workspaceId],
  );
  const jobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [ASO_REFRESH_QUEUE],
  );
  const queuedApps = new Set<string>();
  for (const job of jobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<AsoRefreshPayload> | null;
      if (typeof payload?.appId === 'string') queuedApps.add(payload.appId);
    } catch {
      // Not ours.
    }
  }
  for (const app of apps) {
    const id = String(app.id);
    const platform = parsePlatform(String(app.platform));
    if (platform === undefined) continue;
    if (supports(platform, 'unofficialSearch') && !input.playEnabled) {
      summary.skipped.playOff++;
      continue;
    }
    if (needsStoreAppId(platform) && !app.store_app_id) {
      summary.skipped.notReady++;
      continue;
    }
    if (queuedApps.has(id)) {
      summary.skipped.alreadyQueued++;
      continue;
    }
    if (summary.queued >= max) {
      summary.skipped.capped++;
      continue;
    }
    const payload: AsoRefreshPayload = {
      workspaceId: input.workspaceId,
      appId: id,
      requestedBy: input.requestedBy,
      force: true,
    };
    await enqueue(db, ASO_REFRESH_QUEUE, payload, {
      now: input.now,
      runAt: input.now + summary.queued * spacing,
    });
    queuedApps.add(id);
    summary.queued++;
  }
  return summary;
}
