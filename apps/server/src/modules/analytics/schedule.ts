import type { Database } from '@mrm/db';
import { enqueue } from '../../jobs.ts';
import { ANALYTICS_SYNC_QUEUE, type AnalyticsSyncPayload } from './sync.ts';

/**
 * Scheduled analytics syncs (MRM_ANALYTICS_INTERVAL_MINUTES, default 360, 0 is off). The scheduler only queues `analytics.sync` jobs;
 * the worker runs them through the same read-only sync as the route (services/analytics-sync.ts). Analytics is OFF per workspace
 * until the setting `analytics.enabled` is on, so the interval alone never contacts a store.
 *
 * Rules, as for the reviews: spaced and bounded (`perTick`, `perWorkspace`, `spacingMs`, a jitter), one job per app and per
 * credential at a time, and an app is due an interval after its last attempt. Only apps that have something to read are queued: an
 * Android app always; an iOS or macOS app once it has an active report request, or the workspace has set the vendor number.
 */

export const MIN_ANALYTICS_INTERVAL_MINUTES = 15;
export const MAX_ANALYTICS_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_ANALYTICS_INTERVAL_MINUTES = 360;
export const DEFAULT_ANALYTICS_PER_TICK = 5;
export const DEFAULT_ANALYTICS_PER_WORKSPACE = 3;
export const DEFAULT_ANALYTICS_SPACING_MS = 10_000;
const MINUTE = 60_000;

/** Minutes from MRM_ANALYTICS_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function analyticsIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_ANALYTICS_INTERVAL_MINUTES ||
    minutes > MAX_ANALYTICS_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The analytics interval must be 0 (off) or from ${MIN_ANALYTICS_INTERVAL_MINUTES} to ${MAX_ANALYTICS_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export type AnalyticsQueueSummary = {
  queued: number;
  skipped: {
    recent: number;
    alreadyQueued: number;
    rateLimited: number;
    capped: number;
    notReady: number;
    off: number;
  };
};

export type AnalyticsQueueOptions = {
  now: number;
  intervalMs: number;
  perTick?: number;
  perWorkspace?: number;
  spacingMs?: number;
  maxJitterMs?: number;
  jitter?: (key: string, maxMs: number) => number;
  limiter?: { take(key: string): number };
};

/** Queues `analytics.sync` jobs for the apps that are due. Never reads a store itself. */
export async function queueAnalyticsSyncs(
  db: Database,
  options: AnalyticsQueueOptions,
): Promise<AnalyticsQueueSummary> {
  const { now, intervalMs } = options;
  const perTick = options.perTick ?? DEFAULT_ANALYTICS_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_ANALYTICS_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_ANALYTICS_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? Math.min(5 * MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const summary: AnalyticsQueueSummary = {
    queued: 0,
    skipped: { recent: 0, alreadyQueued: 0, rateLimited: 0, capped: 0, notReady: 0, off: 0 },
  };

  const settings = await db.query(
    "SELECT workspace_id, key, value_json FROM workspace_settings WHERE key IN ('analytics.enabled', 'analytics.appleVendorNumber')",
  );
  const enabled = new Set<string>();
  const vendor = new Set<string>();
  for (const row of settings) {
    const workspaceId = String(row.workspace_id);
    if (String(row.key) === 'analytics.enabled' && String(row.value_json) === 'true')
      enabled.add(workspaceId);
    if (
      String(row.key) === 'analytics.appleVendorNumber' &&
      /^"[0-9]{5,12}"$/.test(String(row.value_json))
    )
      vendor.add(workspaceId);
  }
  if (enabled.size === 0) {
    const [count] = await db.query('SELECT COUNT(*) AS n FROM apps');
    summary.skipped.off = Number(count?.n ?? 0);
    return summary;
  }

  const apps = await db.query(
    'SELECT id, workspace_id, platform, credential_id FROM apps ORDER BY created_at, id',
  );
  const withRequest = new Set(
    (
      await db.query(
        "SELECT DISTINCT app_id FROM analytics_report_requests WHERE status = 'active'",
      )
    ).map((r) => String(r.app_id)),
  );
  const attempts = new Map<string, number>();
  for (const row of await db.query(
    'SELECT app_id, MAX(last_attempt_at) AS last_attempt FROM analytics_source_state GROUP BY app_id',
  )) {
    if (row.last_attempt !== null && row.last_attempt !== undefined)
      attempts.set(String(row.app_id), Number(row.last_attempt));
  }
  const jobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [ANALYTICS_SYNC_QUEUE],
  );
  const queuedApps = new Set<string>();
  for (const job of jobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<AnalyticsSyncPayload> | null;
      if (typeof payload?.appId === 'string') queuedApps.add(payload.appId);
    } catch {
      // A payload that is not JSON belongs to nobody we know.
    }
  }
  // Due apps first: the ones read longest ago.
  const ordered = [...apps].sort(
    (a, b) => (attempts.get(String(a.id)) ?? 0) - (attempts.get(String(b.id)) ?? 0),
  );

  const perWorkspaceCount = new Map<string, number>();
  const limited = new Set<string>();
  for (const app of ordered) {
    const id = String(app.id);
    const workspaceId = String(app.workspace_id);
    if (!enabled.has(workspaceId)) {
      summary.skipped.off++;
      continue;
    }
    const apple = String(app.platform) !== 'android';
    if (apple && !withRequest.has(id) && !vendor.has(workspaceId)) {
      summary.skipped.notReady++;
      continue;
    }
    const last = attempts.get(id) ?? 0;
    if (last > 0 && now - last < intervalMs) {
      summary.skipped.recent++;
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
    const payload: AnalyticsSyncPayload = { workspaceId, appId: id, requestedBy: 'scheduler' };
    await enqueue(db, ANALYTICS_SYNC_QUEUE, payload, {
      now,
      runAt: now + summary.queued * spacing + delay,
    });
    queuedApps.add(id);
    perWorkspaceCount.set(workspaceId, (perWorkspaceCount.get(workspaceId) ?? 0) + 1);
    summary.queued++;
  }
  return summary;
}
