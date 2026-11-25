import { AsoError } from '@kiln/connectors';
import {
  competitorReviewLimits,
  effectiveReviewSchedule,
  nextReviewRunAt,
  normalizeReviewSchedule,
  offSchedule,
  type ReviewSchedule,
  type ReviewScheduleMode,
  reviewReadBackoffMs,
  reviewReadDue,
} from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import { refreshCompetitorReviews } from './competitor-reviews.ts';
import type { AsoSources } from './net.ts';
import { asoErrorCode } from './service.ts';

/**
 * Scheduled reads of the public reviews of followed App Store competitors (docs/adr/0065-ai-review-privacy-and-competitor-schedule.md).
 *
 * No new loop: the scheduler tick calls `queueCompetitorReviewReads`, which only queues one `aso.competitor_reviews` job per app that has
 * something due; the worker runs it through the same `refreshCompetitorReviews` as the Read button, with the same SSRF-safe fetch, the Apple
 * limit and cool-down, and the per-workspace limiter. A schedule is off by default, per app (daily or weekly, in the app's time zone or UTC),
 * with an optional override per competitor. Apple only: Google Play has no official API for the reviews of another app. Reading is independent
 * of the AI switches: they only decide whether a later AI step may use the reviews, and no such step exists yet.
 */

export const COMPETITOR_REVIEWS_QUEUE = 'aso.competitor_reviews';
export type CompetitorReviewsPayload = { workspaceId: string; appId: string; requestedBy: string };

const MINUTE = 60_000;
export const DEFAULT_REVIEWS_PER_TICK = 5;
export const DEFAULT_REVIEWS_PER_WORKSPACE = 3;
export const DEFAULT_REVIEWS_SPACING_MS = 20_000;
/** After this many failures in a row a slot is given up (the next slot tries again) instead of retrying after each backoff. */
const MAX_RETRIES_PER_SLOT = 4;
/** The failure alert is raised once per streak, at the second failure in a row (one blip is not news). */
const ALERT_AT_FAILURES = 2;

export type AppReviewSchedule = {
  schedule: ReviewSchedule;
  paused: boolean;
  maxCompetitors: number;
  maxReviews: number;
  updatedAt: number | null;
  updatedBy: string | null;
};

export const defaultAppReviewSchedule = (): AppReviewSchedule => ({
  schedule: offSchedule(),
  paused: false,
  maxCompetitors: competitorReviewLimits.maxCompetitorsDefault,
  maxReviews: competitorReviewLimits.maxReviewsDefault,
  updatedAt: null,
  updatedBy: null,
});

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toSchedule(row: Record<string, unknown> | undefined): AppReviewSchedule {
  if (!row) return defaultAppReviewSchedule();
  return {
    schedule: {
      mode: String(row.mode) as ReviewScheduleMode,
      weekday: num(row.weekday),
      timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
    },
    paused: Number(row.paused) !== 0,
    maxCompetitors: Number(row.max_competitors),
    maxReviews: Number(row.max_reviews),
    updatedAt: Number(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export async function getAppReviewSchedule(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppReviewSchedule> {
  const [row] = await sql.query(
    'SELECT mode, weekday, timezone, paused, max_competitors, max_reviews, updated_at, updated_by FROM competitor_review_schedules WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, appId],
  );
  return toSchedule(row);
}

export type ScheduleIssue = { path: string; message: string };
export type ScheduleChange = { field: string; from: unknown; to: unknown };

const intIn = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Saves the schedule of an app (mode, weekday, time zone, pause and the two cost guards). Audited with who and from → to. */
export async function setAppReviewSchedule(
  db: Database,
  input: { workspaceId: string; appId: string; actorId: string; body: unknown; at: number },
): Promise<
  | { ok: true; value: AppReviewSchedule; changes: ScheduleChange[] }
  | { ok: false; issues: ScheduleIssue[] }
> {
  const before = await getAppReviewSchedule(db, input.workspaceId, input.appId);
  const raw = (typeof input.body === 'object' && input.body !== null ? input.body : {}) as Record<
    string,
    unknown
  >;
  const checked = normalizeReviewSchedule(raw, before.schedule);
  const issues: ScheduleIssue[] = checked.ok ? [] : [...checked.issues];
  const next: AppReviewSchedule = {
    ...before,
    schedule: checked.ok ? checked.value : before.schedule,
  };
  if (raw.paused !== undefined) {
    if (typeof raw.paused === 'boolean') next.paused = raw.paused;
    else issues.push({ path: 'paused', message: 'Use true or false.' });
  }
  if (raw.maxCompetitors !== undefined) {
    if (intIn(raw.maxCompetitors, 1, competitorReviewLimits.maxCompetitorsMax))
      next.maxCompetitors = raw.maxCompetitors as number;
    else
      issues.push({
        path: 'maxCompetitors',
        message: `A whole number from 1 to ${competitorReviewLimits.maxCompetitorsMax}.`,
      });
  }
  if (raw.maxReviews !== undefined) {
    if (intIn(raw.maxReviews, 1, competitorReviewLimits.maxReviewsMax))
      next.maxReviews = raw.maxReviews as number;
    else
      issues.push({
        path: 'maxReviews',
        message: `A whole number from 1 to ${competitorReviewLimits.maxReviewsMax}.`,
      });
  }
  if (issues.length > 0) return { ok: false, issues };
  const changes: ScheduleChange[] = [];
  const pairs: [string, unknown, unknown][] = [
    ['mode', before.schedule.mode, next.schedule.mode],
    ['weekday', before.schedule.weekday, next.schedule.weekday],
    ['timezone', before.schedule.timezone, next.schedule.timezone],
    ['paused', before.paused, next.paused],
    ['maxCompetitors', before.maxCompetitors, next.maxCompetitors],
    ['maxReviews', before.maxReviews, next.maxReviews],
  ];
  for (const [field, from, to] of pairs) if (from !== to) changes.push({ field, from, to });
  if (changes.length === 0) return { ok: true, value: before, changes };
  await db.transaction(async (tx) => {
    const args = [
      next.schedule.mode,
      next.schedule.weekday,
      next.schedule.timezone,
      next.paused ? 1 : 0,
      next.maxCompetitors,
      next.maxReviews,
      input.actorId,
      input.at,
    ];
    const updated = await tx.execute(
      'UPDATE competitor_review_schedules SET mode = ?, weekday = ?, timezone = ?, paused = ?, max_competitors = ?, max_reviews = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ?',
      [...args, input.workspaceId, input.appId],
    );
    if (Number(updated) === 0) {
      await tx.execute(
        'INSERT INTO competitor_review_schedules (app_id, workspace_id, mode, weekday, timezone, paused, max_competitors, max_reviews, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [input.appId, input.workspaceId, ...args],
      );
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.actorId },
      action: 'aso.competitor_review_schedule_update',
      target: { type: 'app', id: input.appId },
      detail: { appId: input.appId, changes },
      at: input.at,
    });
  });
  return {
    ok: true,
    value: await getAppReviewSchedule(db, input.workspaceId, input.appId),
    changes,
  };
}

/** The override of one competitor: `mode` null follows the app. Apple competitors only (the route checks the store). */
export async function setCompetitorOverride(
  db: Database,
  input: {
    workspaceId: string;
    appId: string;
    competitorId: string;
    actorId: string;
    body: unknown;
    at: number;
  },
): Promise<
  | { ok: true; override: { mode: ReviewScheduleMode; weekday: number | null } | null }
  | { ok: false; issues: ScheduleIssue[] }
> {
  const raw = (typeof input.body === 'object' && input.body !== null ? input.body : {}) as Record<
    string,
    unknown
  >;
  const [row] = await db.query(
    'SELECT review_schedule, review_weekday FROM aso_competitors WHERE id = ? AND workspace_id = ? AND app_id = ?',
    [input.competitorId, input.workspaceId, input.appId],
  );
  const before = row?.review_schedule
    ? { mode: String(row.review_schedule), weekday: num(row.review_weekday) }
    : null;
  let mode: string | null;
  let weekday: number | null = null;
  if (raw.mode === null) {
    mode = null;
  } else {
    const checked = normalizeReviewSchedule(
      { mode: raw.mode, weekday: raw.weekday },
      offSchedule(),
    );
    if (!checked.ok) return { ok: false, issues: checked.issues };
    mode = checked.value.mode;
    weekday = checked.value.weekday;
  }
  if (before?.mode !== mode || before?.weekday !== weekday) {
    await db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE aso_competitors SET review_schedule = ?, review_weekday = ?, review_schedule_at = ? WHERE id = ? AND workspace_id = ?',
        [mode, weekday, input.at, input.competitorId, input.workspaceId],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: { type: 'user', id: input.actorId },
        action: 'aso.competitor_review_schedule_update',
        target: { type: 'aso_competitor', id: input.competitorId },
        detail: {
          appId: input.appId,
          competitorId: input.competitorId,
          changes: [{ field: 'override', from: before?.mode ?? null, to: mode }],
        },
        at: input.at,
      });
    });
  }
  return {
    ok: true,
    override: mode === null ? null : { mode: mode as ReviewScheduleMode, weekday },
  };
}

// ---------------------------------------------------------------------------------------------
// What is shown

export type CompetitorReviewState = {
  competitorId: string;
  name: string;
  store: string;
  /** false: Google Play (no official API). */
  supported: boolean;
  override: { mode: ReviewScheduleMode; weekday: number | null } | null;
  effective: ReviewSchedule;
  lastReadAt: number | null;
  newCount: number;
  failures: number;
  /** The coded reason of the last failed read (`timeout`, `rate_limited`, `unavailable_...`, `failed`), null after a good read. */
  lastError: string | null;
  backoffUntil: number | null;
  nextRunAt: number | null;
};

const COLUMNS =
  'id, workspace_id, app_id, store, name, review_schedule, review_weekday, review_schedule_at, reviews_checked_at, reviews_new_count, reviews_failures, reviews_backoff_until, reviews_last_error, reviews_attempt_at, added_at';

const overrideOf = (
  row: Record<string, unknown>,
): { mode: ReviewScheduleMode; weekday: number | null } | null =>
  row.review_schedule
    ? { mode: String(row.review_schedule) as ReviewScheduleMode, weekday: num(row.review_weekday) }
    : null;

/** The schedule of an app and the state of every competitor, for the Competitors section. Reads the database only. */
export async function reviewScheduleView(
  sql: Sql,
  workspaceId: string,
  appId: string,
  now: number,
) {
  const app = await getAppReviewSchedule(sql, workspaceId, appId);
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM aso_competitors WHERE workspace_id = ? AND app_id = ? ORDER BY added_at, id`,
    [workspaceId, appId],
  );
  const competitors: CompetitorReviewState[] = rows.map((row) => {
    const override = overrideOf(row);
    const effective = effectiveReviewSchedule(app.schedule, override);
    const supported = String(row.store) === 'app_store';
    const changedAt = Math.max(app.updatedAt ?? 0, num(row.review_schedule_at) ?? 0);
    return {
      competitorId: String(row.id),
      name: String(row.name),
      store: String(row.store),
      supported,
      override,
      effective: supported ? effective : offSchedule(),
      lastReadAt: num(row.reviews_checked_at),
      newCount: Number(row.reviews_new_count ?? 0),
      failures: Number(row.reviews_failures ?? 0),
      lastError:
        row.reviews_last_error === null || row.reviews_last_error === undefined
          ? null
          : String(row.reviews_last_error),
      backoffUntil: num(row.reviews_backoff_until),
      nextRunAt: supported
        ? nextReviewRunAt({
            schedule: effective,
            key: String(row.id),
            now,
            lastAttemptAt: num(row.reviews_attempt_at),
            changedAt,
            backoffUntil: num(row.reviews_backoff_until),
            paused: app.paused,
          })
        : null,
    };
  });
  const upcoming = competitors.map((c) => c.nextRunAt).filter((t): t is number => t !== null);
  return {
    ...app,
    competitors,
    nextRunAt: upcoming.length === 0 ? null : Math.min(...upcoming),
    limits: {
      maxCompetitors: competitorReviewLimits.maxCompetitorsMax,
      maxReviews: competitorReviewLimits.maxReviewsMax,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The scheduler side: queue what is due

export type CompetitorReviewsQueueSummary = {
  queued: number;
  skipped: { notDue: number; alreadyQueued: number; capped: number; rateLimited: number };
};

export type CompetitorReviewsQueueOptions = {
  now: number;
  perTick?: number;
  perWorkspace?: number;
  spacingMs?: number;
  /** Largest extra delay of a job, on top of the per competitor slot jitter. Default 5 minutes. */
  maxJitterMs?: number;
  jitter?: (key: string, maxMs: number) => number;
  /** Shared with the other store reads: `take(workspaceId)` returns seconds to wait, 0 when a slot was taken. */
  limiter?: { take(key: string): number };
};

type DueRow = Record<string, unknown>;

/** The competitors of an app that are due now, oldest attempt first. */
function dueOf(app: AppReviewSchedule, rows: DueRow[], now: number): DueRow[] {
  return rows
    .filter((row) => {
      if (String(row.store) !== 'app_store') return false;
      const changedAt = Math.max(app.updatedAt ?? 0, num(row.review_schedule_at) ?? 0);
      return reviewReadDue({
        schedule: effectiveReviewSchedule(app.schedule, overrideOf(row)),
        key: String(row.id),
        now,
        lastAttemptAt: num(row.reviews_attempt_at),
        changedAt,
        backoffUntil: num(row.reviews_backoff_until),
        paused: app.paused,
      }).due;
    })
    .sort((a, b) => (num(a.reviews_attempt_at) ?? 0) - (num(b.reviews_attempt_at) ?? 0));
}

/** Queues `aso.competitor_reviews` jobs for the apps that have a competitor due. Never reads a store itself. */
export async function queueCompetitorReviewReads(
  db: Database,
  options: CompetitorReviewsQueueOptions,
): Promise<CompetitorReviewsQueueSummary> {
  const { now } = options;
  const perTick = options.perTick ?? DEFAULT_REVIEWS_PER_TICK;
  const perWorkspace = options.perWorkspace ?? DEFAULT_REVIEWS_PER_WORKSPACE;
  const spacing = options.spacingMs ?? DEFAULT_REVIEWS_SPACING_MS;
  const maxJitter = options.maxJitterMs ?? 5 * MINUTE;
  const jitter =
    options.jitter ?? ((_key: string, max: number) => Math.floor(Math.random() * (max + 1)));
  const summary: CompetitorReviewsQueueSummary = {
    queued: 0,
    skipped: { notDue: 0, alreadyQueued: 0, capped: 0, rateLimited: 0 },
  };

  const rows = await db.query(
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `c.${c}`)
      .join(', ')}
       FROM aso_competitors c
       LEFT JOIN competitor_review_schedules s ON s.app_id = c.app_id
      WHERE c.store = 'app_store' AND (s.mode IN ('daily', 'weekly') OR c.review_schedule IN ('daily', 'weekly'))
      ORDER BY c.app_id, c.id`,
  );
  const byApp = new Map<string, DueRow[]>();
  for (const row of rows)
    byApp.set(String(row.app_id), [...(byApp.get(String(row.app_id)) ?? []), row]);
  const queuedJobs = await db.query(
    "SELECT payload FROM jobs WHERE queue = ? AND status IN ('queued', 'running')",
    [COMPETITOR_REVIEWS_QUEUE],
  );
  const queued = new Set<string>();
  for (const job of queuedJobs) {
    try {
      const payload = JSON.parse(String(job.payload)) as Partial<CompetitorReviewsPayload> | null;
      if (typeof payload?.appId === 'string') queued.add(payload.appId);
    } catch {
      // not ours
    }
  }
  const perWorkspaceCount = new Map<string, number>();
  const limited = new Set<string>();
  for (const [appId, list] of byApp) {
    const workspaceId = String(list[0]?.workspace_id);
    const app = await getAppReviewSchedule(db, workspaceId, appId);
    if (dueOf(app, list, now).length === 0) {
      summary.skipped.notDue += 1;
      continue;
    }
    if (queued.has(appId)) {
      summary.skipped.alreadyQueued += 1;
      continue;
    }
    if (summary.queued >= perTick || (perWorkspaceCount.get(workspaceId) ?? 0) >= perWorkspace) {
      summary.skipped.capped += 1;
      continue;
    }
    if (limited.has(workspaceId) || (options.limiter?.take(workspaceId) ?? 0) > 0) {
      limited.add(workspaceId);
      summary.skipped.rateLimited += 1;
      continue;
    }
    const delay = Math.min(Math.max(Math.trunc(jitter(appId, maxJitter)), 0), maxJitter);
    const payload: CompetitorReviewsPayload = { workspaceId, appId, requestedBy: 'scheduler' };
    await enqueue(db, COMPETITOR_REVIEWS_QUEUE, payload, {
      now,
      runAt: now + summary.queued * spacing + delay,
    });
    perWorkspaceCount.set(workspaceId, (perWorkspaceCount.get(workspaceId) ?? 0) + 1);
    summary.queued += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// The worker side: read what is due

export type CompetitorReviewsRunSummary = {
  read: number;
  unchanged: number;
  failed: number;
  newReviews: number;
  skipped: number;
};

const isPayload = (v: unknown): v is CompetitorReviewsPayload =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as CompetitorReviewsPayload).workspaceId === 'string' &&
  typeof (v as CompetitorReviewsPayload).appId === 'string';

/** Reads the due competitors of one app, at most `maxCompetitors`, one after the other. A failure is recorded per competitor with a backoff; never throws. */
export async function runCompetitorReviewReads(
  ctx: { db: Database; now: () => number; sources: Pick<AsoSources, 'appleReviews'> },
  input: { workspaceId: string; appId: string },
): Promise<CompetitorReviewsRunSummary> {
  const summary: CompetitorReviewsRunSummary = {
    read: 0,
    unchanged: 0,
    failed: 0,
    newReviews: 0,
    skipped: 0,
  };
  const read = ctx.sources.appleReviews?.bind(ctx.sources);
  if (!read) return summary;
  const app = await getAppReviewSchedule(ctx.db, input.workspaceId, input.appId);
  const rows = await ctx.db.query(
    `SELECT ${COLUMNS}, external_id, country FROM aso_competitors WHERE workspace_id = ? AND app_id = ? AND store = 'app_store' ORDER BY added_at, id`,
    [input.workspaceId, input.appId],
  );
  const due = dueOf(app, rows, ctx.now()).slice(0, app.maxCompetitors);
  summary.skipped = rows.length - due.length;
  for (const row of due) {
    const id = String(row.id);
    const before = num(row.reviews_attempt_at);
    const startedAt = ctx.now();
    await ctx.db.execute('UPDATE aso_competitors SET reviews_attempt_at = ? WHERE id = ?', [
      startedAt,
      id,
    ]);
    try {
      const out = await refreshCompetitorReviews(
        { db: ctx.db, now: ctx.now, read },
        {
          workspaceId: input.workspaceId,
          competitor: {
            id,
            appId: input.appId,
            store: 'app_store',
            externalId: String(row.external_id),
            country: String(row.country),
          },
          actorId: COMPETITOR_REVIEWS_QUEUE,
          options: { scheduled: true, maxReviews: app.maxReviews },
        },
      );
      if (!out.ok) continue;
      await ctx.db.execute(
        'UPDATE aso_competitors SET reviews_failures = 0, reviews_backoff_until = NULL, reviews_last_error = NULL WHERE id = ?',
        [id],
      );
      if (out.state === 'unchanged') summary.unchanged += 1;
      else if (out.state === 'read') {
        summary.read += 1;
        summary.newReviews += out.newCount;
      }
    } catch (error) {
      summary.failed += 1;
      const code = asoErrorCode(error);
      const ourLimit = error instanceof AsoError && error.kind === 'rate_limited';
      const failures = Number(row.reviews_failures ?? 0) + (ourLimit ? 0 : 1);
      const at = ctx.now();
      const wait = Math.max(
        reviewReadBackoffMs(Math.max(failures, 1)),
        ourLimit ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
      );
      // Until the retries of this slot are used up the slot stays unserved, so the read is tried again when the backoff ends.
      const attempt = failures >= MAX_RETRIES_PER_SLOT ? at : before;
      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          'UPDATE aso_competitors SET reviews_failures = ?, reviews_backoff_until = ?, reviews_last_error = ?, reviews_attempt_at = ? WHERE id = ?',
          [failures, at + wait, code, attempt, id],
        );
        if (failures === ALERT_AT_FAILURES) {
          // The generic "reading reviews keeps failing" alert of the app, once per streak (docs/alerts.md). Ids and a code, never a name or text.
          await emitEvent(tx, {
            workspaceId: input.workspaceId,
            type: 'review.sync_failed',
            subject: { appId: input.appId },
            payload: {
              appId: input.appId,
              store: 'app_store',
              source: 'competitor',
              competitorId: id,
              code,
              transient: true,
              failures,
            },
            at,
          });
        }
      });
    }
  }
  return summary;
}

export function createCompetitorReviewsHandler(ctx: {
  db: Database;
  now: () => number;
  sources: Pick<AsoSources, 'appleReviews'>;
}): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await runCompetitorReviewReads(ctx, {
      workspaceId: payload.workspaceId,
      appId: payload.appId,
    }).catch(() => undefined);
  };
}
