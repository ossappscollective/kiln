import {
  DEFAULT_REMINDER_LEAD_HOURS,
  type DeadlineReminderKind,
  deadlineReminder,
  MAX_REMINDER_LEAD_HOURS,
  REMINDER_STALE_DAYS,
  rolloutStepReminderDue,
} from '@mrm/core';
import type { Database, Param, Row } from '@mrm/db';
import { recordAudit } from '../../services/audit.ts';
import type { EventType } from '../../services/event-types.ts';
import { emitEvent } from '../../services/events.ts';

/**
 * Reminders about release plans: a deadline that is close, a deadline that has passed, a rollout
 * step whose planned time has passed. Each one is an event (`plan.deadline_due_soon`,
 * `plan.deadline_overdue`, `plan.rollout_step_due`), so it flows through the event log, the SSE
 * stream and signed webhooks. There is no email and no push notification: a webhook receiver or a
 * script is how a reminder reaches a person today.
 *
 * What "the deadline" is: a plan's target date (a calendar day in UTC; it ends at the start of the
 * next UTC day, the moment `dueFlags` calls it overdue). Checklist items have no due date of their
 * own, so the checklist's deadline is the plan's.
 *
 * Safe to run often and from several server instances sharing one database:
 *  - Every reminder has a row in `plan_reminders` with the primary key (plan id, item id, kind,
 *    due date or planned time). A reminder is sent only by the run whose
 *    `INSERT ... ON CONFLICT DO NOTHING` added that row, in the same transaction as the event, so
 *    a second tick, a restart or a second instance never sends it again, and there is no other lock.
 *  - Changing a date or a planned time is a new key: the reminder is armed again.
 *  - A run sends at most `maxPerRun` reminders; the rest wait for the next run.
 *  - The candidates are found with queries that already leave out what was sent, so old rows never
 *    use up the limit. Anything older than REMINDER_STALE_DAYS past due is not sent (it is no news).
 * Nothing here touches a store, and a failing reminder is reported and skipped, never thrown.
 */

/** The audit actor of a reminder: no person did it, like the background sync's `app.sync`. */
export const REMINDER_ACTOR = { type: 'system' as const, id: 'plan.reminders' };

export const DEFAULT_MAX_REMINDERS_PER_RUN = 100;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DEADLINE_ITEM = 'target_date';

export type ReminderOptions = {
  /** Hours before the end of the target day that "due soon" starts. Default 24. */
  leadHours?: number;
  /** Most reminders sent by one run. Default 100. */
  maxPerRun?: number;
  onError?: (message: string, error: unknown) => void;
};

export type ReminderSummary = {
  dueSoon: number;
  overdue: number;
  stepsDue: number;
  /** A reminder that could not be sent (reported, tried again next run). */
  failed: number;
  /** The limit was reached: more reminders are waiting for the next run. */
  capped: boolean;
};

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Plans whose release is out are not open: no reminders. */
const NOT_RELEASED = `NOT EXISTS (
  SELECT 1 FROM app_releases r
   WHERE r.app_id = p.app_id AND r.workspace_id = p.workspace_id AND r.version = p.version AND r.status = 'live')`;

type Candidate = {
  planId: string;
  workspaceId: string;
  appId: string;
  appName: string;
  appPlatform: string;
  version: string;
  kind: 'due_soon' | 'overdue' | 'rollout_step_due';
  itemId: string;
  dueKey: string;
  event: EventType;
  payload: Record<string, unknown>;
};

const PLAN_COLUMNS = `p.id AS plan_id, p.workspace_id, p.app_id, p.version, p.platform AS plan_platform,
  a.name AS app_name, a.platform AS app_platform`;
const PLAN_FROM = `FROM release_plans p JOIN apps a ON a.id = p.app_id AND a.workspace_id = p.workspace_id`;

function leadHoursOf(options: ReminderOptions): number {
  const hours = options.leadHours ?? DEFAULT_REMINDER_LEAD_HOURS;
  return Number.isFinite(hours)
    ? Math.min(Math.max(Math.trunc(hours), 1), MAX_REMINDER_LEAD_HOURS)
    : DEFAULT_REMINDER_LEAD_HOURS;
}

const base = (r: Row) => ({
  planId: String(r.plan_id),
  workspaceId: String(r.workspace_id),
  appId: String(r.app_id),
  appName: String(r.app_name),
  appPlatform: String(r.app_platform),
  version: String(r.version),
});

async function deadlineCandidates(
  db: Database,
  at: number,
  kind: DeadlineReminderKind,
  leadHours: number,
  limit: number,
): Promise<Candidate[]> {
  // The date window is exact up to one day at its old edge; `deadlineReminder` decides the rest.
  const window: [string, string] =
    kind === 'due_soon'
      ? [isoDate(at - DAY), isoDate(at + leadHours * HOUR - DAY)]
      : [isoDate(at - DAY - REMINDER_STALE_DAYS * DAY), isoDate(at - DAY)];
  const rows = await db.query(
    `SELECT ${PLAN_COLUMNS}, p.target_date, p.blocked,
            (SELECT COUNT(*) FROM checklist_items i
              WHERE i.plan_id = p.id AND i.workspace_id = p.workspace_id AND i.required = 1 AND i.done = 0) AS open_required
       ${PLAN_FROM}
      WHERE p.target_date IS NOT NULL AND p.target_date ${kind === 'due_soon' ? '>' : '>='} ? AND p.target_date <= ?
        AND ${NOT_RELEASED}
        AND NOT EXISTS (
          SELECT 1 FROM plan_reminders m
           WHERE m.plan_id = p.id AND m.item_id = '${DEADLINE_ITEM}' AND m.kind = ? AND m.due_key = p.target_date)
      ORDER BY p.target_date, p.id LIMIT ?`,
    [window[0], window[1], kind, limit],
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const targetDate = String(r.target_date);
    const due = deadlineReminder(targetDate, at, { leadHours });
    if (due.kind !== kind) continue;
    out.push({
      ...base(r),
      kind,
      itemId: DEADLINE_ITEM,
      dueKey: targetDate,
      event: kind === 'due_soon' ? 'plan.deadline_due_soon' : 'plan.deadline_overdue',
      payload: {
        planId: String(r.plan_id),
        appName: String(r.app_name),
        platform: String(r.app_platform),
        version: String(r.version),
        targetDate,
        ...(kind === 'due_soon' ? { hoursLeft: due.hoursLeft } : { daysOverdue: due.daysOverdue }),
        blocked: Number(r.blocked) === 1,
        openRequiredItems: Number(r.open_required),
      },
    });
  }
  return out;
}

async function stepCandidates(db: Database, at: number, limit: number): Promise<Candidate[]> {
  const rows = await db.query(
    `SELECT ${PLAN_COLUMNS}, s.id AS step_id, s.position, s.percent, s.planned_at, s.status,
            (SELECT COUNT(*) FROM plan_rollout_steps x WHERE x.plan_id = p.id) AS total
       FROM plan_rollout_steps s
       JOIN release_plans p ON p.id = s.plan_id AND p.workspace_id = s.workspace_id
       JOIN apps a ON a.id = p.app_id AND a.workspace_id = p.workspace_id
      WHERE s.status = 'planned' AND s.planned_at IS NOT NULL AND s.planned_at <= ? AND s.planned_at >= ?
        AND ${NOT_RELEASED}
        AND NOT EXISTS (
          SELECT 1 FROM plan_reminders m
           WHERE m.plan_id = p.id AND m.item_id = s.id AND m.kind = 'rollout_step_due'
             AND m.due_key = CAST(s.planned_at AS TEXT))
      ORDER BY s.planned_at, s.id LIMIT ?`,
    [at, at - REMINDER_STALE_DAYS * DAY, limit],
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const plannedAt = Number(r.planned_at);
    if (!rolloutStepReminderDue({ status: 'planned', plannedAt }, at)) continue;
    out.push({
      ...base(r),
      kind: 'rollout_step_due',
      itemId: String(r.step_id),
      dueKey: String(plannedAt),
      event: 'plan.rollout_step_due',
      payload: {
        planId: String(r.plan_id),
        appName: String(r.app_name),
        platform: String(r.app_platform),
        version: String(r.version),
        stepId: String(r.step_id),
        index: Number(r.position) + 1,
        total: Number(r.total),
        percent: Number(r.percent),
        plannedAt,
        minutesLate: Math.max(0, Math.floor((at - plannedAt) / 60_000)),
      },
    });
  }
  return out;
}

/**
 * Sends one reminder, once. Returns false when another run (or instance) already did, or when the
 * plan or step changed since it was found.
 */
async function send(db: Database, c: Candidate, at: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Still true? A date or step edited since the scan must not send a stale reminder.
    if (c.kind === 'rollout_step_due') {
      const [step] = await tx.query(
        'SELECT status, planned_at FROM plan_rollout_steps WHERE id = ? AND plan_id = ? AND workspace_id = ?',
        [c.itemId, c.planId, c.workspaceId],
      );
      if (step?.status !== 'planned' || String(step.planned_at) !== c.dueKey) return false;
    } else {
      const [plan] = await tx.query(
        'SELECT target_date FROM release_plans WHERE id = ? AND workspace_id = ?',
        [c.planId, c.workspaceId],
      );
      if (!plan || String(plan.target_date) !== c.dueKey) return false;
    }
    const params: Param[] = [c.planId, c.workspaceId, c.itemId, c.kind, c.dueKey, at];
    const added = await tx.execute(
      `INSERT INTO plan_reminders (plan_id, workspace_id, item_id, kind, due_key, sent_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      params,
    );
    if (added === 0) return false;
    // An older date of the same item is forgotten, so going back to it later arms it again.
    await tx.execute(
      'DELETE FROM plan_reminders WHERE plan_id = ? AND item_id = ? AND kind = ? AND due_key <> ?',
      [c.planId, c.itemId, c.kind, c.dueKey],
    );
    await emitEvent(tx, {
      workspaceId: c.workspaceId,
      type: c.event,
      subject: { appId: c.appId },
      payload: { ...c.payload, actor: REMINDER_ACTOR },
      at,
    });
    await recordAudit(tx, {
      workspaceId: c.workspaceId,
      actor: REMINDER_ACTOR,
      action: 'plan.reminder',
      target: { type: 'release_plan', id: c.planId },
      detail: {
        appId: c.appId,
        version: c.version,
        kind: c.kind,
        itemId: c.itemId,
        due: c.dueKey,
        event: c.event,
      },
      at,
    });
    return true;
  });
}

/**
 * One pass over the open plans. `at` is the clock (epoch milliseconds). Never throws for one bad
 * reminder; a query failure propagates to the caller (the scheduler reports it).
 */
export async function sendPlanReminders(
  db: Database,
  at: number,
  options: ReminderOptions = {},
): Promise<ReminderSummary> {
  const report = options.onError ?? ((message, error) => console.error(message, error));
  const leadHours = leadHoursOf(options);
  const max = Math.max(1, Math.trunc(options.maxPerRun ?? DEFAULT_MAX_REMINDERS_PER_RUN));
  const summary: ReminderSummary = {
    dueSoon: 0,
    overdue: 0,
    stepsDue: 0,
    failed: 0,
    capped: false,
  };
  let sent = 0;

  const run = async (
    find: (limit: number) => Promise<Candidate[]>,
    count: (s: ReminderSummary) => void,
  ) => {
    const room = Math.max(max - sent, 0);
    // One extra row tells whether more are waiting (also when the limit is already used up).
    const found = await find(room + 1);
    if (found.length > room) summary.capped = true;
    for (const c of found.slice(0, room)) {
      try {
        if (await send(db, c, at)) {
          sent++;
          count(summary);
        }
      } catch (error) {
        summary.failed++;
        report(`plan reminder ${c.kind} for plan ${c.planId} failed`, error);
      }
    }
  };

  await run(
    (n) => deadlineCandidates(db, at, 'due_soon', leadHours, n),
    (s) => {
      s.dueSoon++;
    },
  );
  await run(
    (n) => deadlineCandidates(db, at, 'overdue', leadHours, n),
    (s) => {
      s.overdue++;
    },
  );
  await run(
    (n) => stepCandidates(db, at, n),
    (s) => {
      s.stepsDue++;
    },
  );
  return summary;
}
