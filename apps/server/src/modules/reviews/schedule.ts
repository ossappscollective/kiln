import { needsStoreAppId, parsePlatform } from '@mrm/core';
import type { Database } from '@mrm/db';
import { enqueue } from '../../jobs.ts';
import { purgeAiData } from '../../services/ai-suggestions.ts';
import { purgeOrphanTranslations } from '../../services/translation.ts';
import { pruneReviews, purgeOrphanReviewRows } from './service.ts';
import { REVIEW_SYNC_QUEUE, type ReviewSyncPayload } from './sync.ts';

/**
 * Scheduled review reads (MRM_REVIEW_SYNC_INTERVAL_MINUTES, off by default) and the data
 * protection upkeep (MRM_REVIEW_RETENTION_DAYS). The scheduler only queues `review.sync` jobs; the
 * worker runs them through the same read-only sync as the route.
 *
 * Rules, because every read is several requests against a quota (Google Play: 200 per hour per
 * app; Apple: a rolling hour per key):
 *
 * - Spaced and bounded: at most `perTick` apps per pass and `perWorkspace` per workspace, each job
 *   run `spacingMs` after the previous one, plus a jitter.
 * - Shared budget: each queued read takes a slot of the store rate limiter the sync route uses.
 * - One job per credential at a time, and never twice for one app.
 * - Backoff: an app is due an interval after its last attempt, and not before `backoff_until`
 *   (doubled for every failure in a row, up to six hours), so a broken credential is not hammered.
 * - An iOS app whose App Store id is not known yet (never synced) is skipped.
 *
 * Google Play serves only about the last 7 days of reviews, so for Play apps an interval of six
 * hours or less is recommended: a longer gap can lose reviews for good (docs/api/reviews.md).
 */

export const MIN_REVIEW_SYNC_INTERVAL_MINUTES = 15;
export const MAX_REVIEW_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_REVIEW_PER_TICK = 5;
export const DEFAULT_REVIEW_PER_WORKSPACE = 3;
export const DEFAULT_REVIEW_SPACING_MS = 5_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Minutes from MRM_REVIEW_SYNC_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function reviewSyncIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_REVIEW_SYNC_INTERVAL_MINUTES ||
    minutes > MAX_REVIEW_SYNC_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The review sync interval must be 0 (off) or from ${MIN_REVIEW_SYNC_INTERVAL_MINUTES} to ${MAX_REVIEW_SYNC_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export type ReviewQueueSummary = {
  queued: number;
  /** Apps not queued, by reason. */
  skipped: {
    recent: number;
    backoff: number;
    alreadyQueued: number;
    rateLimited: number;
    capped: number;
    notReady: number;
  };
};

export type ReviewQueueOptions = {
  now: number;
  /** Milliseconds between reads of one app. Must be above 0. */
  intervalMs: number;
  perTick?: number;
  perWorkspace?: number;
  spacingMs?: number;
  /** Largest jitter. Default a tenth of the interval, at most 5 minutes. */
  maxJitterMs?: number;
  jitter?: (key: string, maxMs: number) => number;
  /** Shared with the sync routes: `take(workspaceId)` returns seconds to wait, 0 when a slot was taken. */
  limiter?: { take(key: string): number };
};

/** Queues `review.sync` jobs for the apps that are due. Never reads a store itself. */
export async function queueReviewSyncs(
  db: Database,
  options: ReviewQueueOptions,
): Promise<ReviewQueueSummary> {
  const { now, intervalMs } = options;
  const perTick = options.perTick ?? DEFAULT_REVIEW_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_REVIEW_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_REVIEW_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? Math.min(5 * MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const summary: ReviewQueueSummary = {
    queued: 0,
    skipped: { recent: 0, backoff: 0, alreadyQueued: 0, rateLimited: 0, capped: 0, notReady: 0 },
  };

  const apps = await db.query(
    `SELECT a.id, a.workspace_id, a.platform, a.credential_id, a.store_app_id,
            s.last_attempt_at, s.backoff_until
       FROM apps a
       LEFT JOIN review_sync_state s
         ON s.app_id = a.id AND s.store = CASE WHEN a.platform = 'android' THEN 'googleplay' ELSE 'appstoreconnect' END
      ORDER BY COALESCE(s.last_attempt_at, 0), a.created_at, a.id`,
  );
  const jobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [REVIEW_SYNC_QUEUE],
  );
  const queuedApps = new Set<string>();
  const queuedCredentials = new Set<string>();
  for (const job of jobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<ReviewSyncPayload> | null;
      if (typeof payload?.appId === 'string') queuedApps.add(payload.appId);
      if (typeof payload?.credentialId === 'string') queuedCredentials.add(payload.credentialId);
    } catch {
      // A payload that is not JSON belongs to nobody we know.
    }
  }

  const perWorkspaceCount = new Map<string, number>();
  const limited = new Set<string>();
  const sharedWithIos = new Set(
    apps
      .filter((a) => String(a.platform) === 'ios' && a.store_app_id)
      .map((a) => `${String(a.workspace_id)}\u0000${String(a.store_app_id)}`),
  );
  for (const app of apps) {
    const id = String(app.id);
    const workspaceId = String(app.workspace_id);
    const credentialId = String(app.credential_id);
    const platform = parsePlatform(String(app.platform));
    if (platform === undefined) continue;
    const last = Number(app.last_attempt_at ?? 0);
    if (needsStoreAppId(platform) && !app.store_app_id) {
      summary.skipped.notReady++;
      continue;
    }
    // A macOS entry that shares its App Store Connect app with an iOS entry has the same customer reviews: not read twice.
    if (
      String(app.platform) === 'macos' &&
      sharedWithIos.has(`${workspaceId}\u0000${String(app.store_app_id)}`)
    ) {
      summary.skipped.notReady++;
      continue;
    }
    if (last > 0 && now - last < intervalMs) {
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
    if (queuedApps.has(id) || queuedCredentials.has(credentialId)) {
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
    const payload: ReviewSyncPayload = {
      workspaceId,
      appId: id,
      credentialId,
      requestedBy: 'scheduler',
    };
    await enqueue(db, REVIEW_SYNC_QUEUE, payload, {
      now,
      runAt: now + summary.queued * spacing + delay,
    });
    queuedApps.add(id);
    queuedCredentials.add(credentialId);
    perWorkspaceCount.set(workspaceId, (perWorkspaceCount.get(workspaceId) ?? 0) + 1);
    summary.queued++;
  }
  return summary;
}

export type ReviewUpkeepOptions = {
  now: number;
  /** MRM_REVIEW_RETENTION_DAYS. 0 keeps every review. */
  retentionDays: number;
  /** Most reviews deleted in one run. Default 1000. */
  maxRows?: number;
};

export type ReviewUpkeepSummary = { pruned: number; orphans: number };

/**
 * Data protection upkeep: deletes reviews older than the retention (by the store's date of the
 * review), a bounded number per run, and the rows of apps that no longer exist.
 */
export async function reviewUpkeep(
  db: Database,
  options: ReviewUpkeepOptions,
): Promise<ReviewUpkeepSummary> {
  const maxRows = options.maxRows ?? 1000;
  const pruned =
    options.retentionDays > 0
      ? await pruneReviews(db, options.now - options.retentionDays * DAY, maxRows)
      : 0;
  const orphans = await purgeOrphanReviewRows(db, maxRows);
  // Stored translations of reviews that are gone (pruned or deleted with their app).
  await purgeOrphanTranslations(db, maxRows).catch(() => 0);
  // AI suggestions older than their retention window, and old usage rows (counts only).
  await purgeAiData(db, options.now).catch(() => 0);
  return { pruned, orphans };
}
