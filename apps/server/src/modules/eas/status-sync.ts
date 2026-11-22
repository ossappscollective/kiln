import { parsePlatform } from '@kiln/core';
import type { Database } from '@kiln/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import type { EasDeps } from './index.ts';
import {
  ACTIVE_BUILD_STATUSES,
  ACTIVE_SUBMISSION_STATUSES,
  easPlatformOf,
  refreshEasStatus,
} from './status.ts';

/**
 * Scheduled reads of EAS builds and submissions (KILN_EAS_STATUS_INTERVAL_MINUTES, default 30, 0 is off; docs/adr/0036-eas-build-submit-status.md).
 * The scheduler only queues `eas.status` jobs; the worker runs them through the same read-only read as the manual route (`refreshEasStatus`).
 * Only app records that have a link, a usable Expo credential and a platform EAS builds for are queued, so a workspace without Expo costs nothing.
 *
 * Rules, as for the reviews: spaced and bounded (`perTick`, `perWorkspace`, `spacingMs`, a jitter), one job per app and per credential at a time,
 * a shared per workspace budget, and a backoff after a failure (doubled for every failure in a row, up to six hours) so a revoked token is not
 * hammered. One difference: an app record whose snapshot holds a build or a submission that has not ended is read again after
 * `activeIntervalMs` (three minutes by default, never more than the interval), which is how a running build is followed.
 */

export const EAS_STATUS_QUEUE = 'eas.status';
export const MIN_EAS_STATUS_INTERVAL_MINUTES = 5;
export const MAX_EAS_STATUS_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_EAS_STATUS_INTERVAL_MINUTES = 30;
export const DEFAULT_EAS_STATUS_PER_TICK = 5;
export const DEFAULT_EAS_STATUS_PER_WORKSPACE = 3;
export const DEFAULT_EAS_STATUS_SPACING_MS = 5_000;
export const DEFAULT_EAS_ACTIVE_INTERVAL_MS = 3 * 60_000;
const MINUTE = 60_000;

/** Minutes from KILN_EAS_STATUS_INTERVAL_MINUTES to milliseconds; 0 stays 0. Throws on a value out of range. */
export function easStatusIntervalMs(minutes: number): number {
  if (minutes === 0) return 0;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_EAS_STATUS_INTERVAL_MINUTES ||
    minutes > MAX_EAS_STATUS_INTERVAL_MINUTES
  ) {
    throw new Error(
      `The EAS status interval must be 0 (off) or from ${MIN_EAS_STATUS_INTERVAL_MINUTES} to ${MAX_EAS_STATUS_INTERVAL_MINUTES} minutes.`,
    );
  }
  return minutes * MINUTE;
}

export type EasStatusPayload = { workspaceId: string; appId: string; requestedBy: string };

const isPayload = (value: unknown): value is EasStatusPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as EasStatusPayload).workspaceId === 'string' &&
  typeof (value as EasStatusPayload).appId === 'string';

export type EasStatusQueueSummary = {
  queued: number;
  /** App records not queued, by reason. */
  skipped: {
    recent: number;
    backoff: number;
    alreadyQueued: number;
    rateLimited: number;
    capped: number;
    notReady: number;
  };
};

export type EasStatusQueueOptions = {
  now: number;
  /** Milliseconds between reads of one app record. Must be above 0. */
  intervalMs: number;
  /** Between reads while a build or a submission has not ended. Default three minutes (never above `intervalMs`). */
  activeIntervalMs?: number;
  perTick?: number;
  perWorkspace?: number;
  spacingMs?: number;
  /** Largest jitter. Default a tenth of the interval, at most 5 minutes. */
  maxJitterMs?: number;
  jitter?: (key: string, maxMs: number) => number;
  /** Shared with the sync routes: `take(workspaceId)` returns seconds to wait, 0 when a slot was taken. */
  limiter?: { take(key: string): number };
};

/** Queues `eas.status` jobs for the app records that are due. Never reads Expo itself. */
export async function queueEasStatusSyncs(
  db: Database,
  options: EasStatusQueueOptions,
): Promise<EasStatusQueueSummary> {
  const { now, intervalMs } = options;
  const activeMs = Math.min(options.activeIntervalMs ?? DEFAULT_EAS_ACTIVE_INTERVAL_MS, intervalMs);
  const perTick = options.perTick ?? DEFAULT_EAS_STATUS_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_EAS_STATUS_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_EAS_STATUS_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? Math.min(5 * MINUTE, Math.floor(intervalMs / 10));
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const summary: EasStatusQueueSummary = {
    queued: 0,
    skipped: { recent: 0, backoff: 0, alreadyQueued: 0, rateLimited: 0, capped: 0, notReady: 0 },
  };

  const buildMarks = ACTIVE_BUILD_STATUSES.map(() => '?').join(', ');
  const submissionMarks = ACTIVE_SUBMISSION_STATUSES.map(() => '?').join(', ');
  const apps = await db.query(
    `SELECT l.app_id, l.workspace_id, l.credential_id, a.platform, s.last_attempt_at, s.backoff_until,
            (SELECT COUNT(*) FROM eas_builds b WHERE b.app_id = l.app_id AND b.status IN (${buildMarks})) AS active_builds,
            (SELECT COUNT(*) FROM eas_submissions u WHERE u.app_id = l.app_id AND u.status IN (${submissionMarks})) AS active_submissions
       FROM app_expo_links l
       JOIN apps a ON a.id = l.app_id AND a.workspace_id = l.workspace_id
       JOIN credentials c ON c.id = l.credential_id AND c.workspace_id = l.workspace_id AND c.kind = 'expo'
       LEFT JOIN eas_status_sync s ON s.app_id = l.app_id
      ORDER BY COALESCE(s.last_attempt_at, 0), l.created_at, l.app_id`,
    [...ACTIVE_BUILD_STATUSES, ...ACTIVE_SUBMISSION_STATUSES],
  );
  const jobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [EAS_STATUS_QUEUE],
  );
  const queuedApps = new Set<string>();
  const queuedCredentials = new Set<string>();
  const credentialOfApp = new Map(apps.map((a) => [String(a.app_id), String(a.credential_id)]));
  for (const job of jobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<EasStatusPayload> | null;
      if (typeof payload?.appId === 'string') {
        queuedApps.add(payload.appId);
        const credentialId = credentialOfApp.get(payload.appId);
        if (credentialId) queuedCredentials.add(credentialId);
      }
    } catch {
      // A payload that is not JSON belongs to nobody we know.
    }
  }

  const perWorkspaceCount = new Map<string, number>();
  const limited = new Set<string>();
  for (const app of apps) {
    const id = String(app.app_id);
    const workspaceId = String(app.workspace_id);
    const credentialId = String(app.credential_id);
    const platform = parsePlatform(String(app.platform));
    if (platform === undefined || easPlatformOf(platform) === null) {
      summary.skipped.notReady++;
      continue;
    }
    const last = Number(app.last_attempt_at ?? 0);
    const wanted =
      Number(app.active_builds) + Number(app.active_submissions) > 0 ? activeMs : intervalMs;
    if (last > 0 && now - last < wanted) {
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
    const payload: EasStatusPayload = { workspaceId, appId: id, requestedBy: 'scheduler' };
    await enqueue(db, EAS_STATUS_QUEUE, payload, {
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

export type EasStatusJobContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps?: EasDeps | undefined;
};

/** The worker's handler: one read of one app record, as the system. A failure is recorded by the read itself, never thrown into the queue. */
export function createEasStatusHandler(ctx: EasStatusJobContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await refreshEasStatus(
      { db: ctx.db, masterKey: ctx.masterKey, now: ctx.now, deps: ctx.deps },
      { workspaceId: payload.workspaceId, appId: payload.appId },
      { type: 'system', id: EAS_STATUS_QUEUE },
      { trigger: 'job' },
    ).catch(() => undefined);
  };
}
