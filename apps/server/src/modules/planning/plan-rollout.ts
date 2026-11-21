import { randomUUID } from 'node:crypto';
import {
  type ActorType,
  APPLE_PHASED_SCHEDULE,
  checkRolloutAction,
  compareRollout,
  PLATFORMS,
  type Platform,
  type ReleaseState,
  type RolloutAction,
  type RolloutComparison,
  type RolloutDoneSource,
  type RolloutIssue,
  type RolloutKind,
  type RolloutStepInput,
  type RolloutStepState,
  type RolloutStepStatus,
  type RolloutSummary,
  rolloutTemplate,
  type StoreRollout,
  storeFamilyOf,
  storeRollout,
  summarizeRollout,
  supports,
  validateRolloutSteps,
} from '@kiln/core';
import { mapOrNull, oneOf, type Row, type Sql } from '@kiln/db';
import { recordAudit } from '../../services/audit.ts';
import type { EventType } from '../../services/event-types.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import type { PlansContext } from './plans.ts';

/**
 * Staged rollout steps of a release plan. PLANNING DATA ONLY: nothing here reads a store with a
 * credential or writes to one. A step marked done changes no rollout; the store's own share (what
 * the last sync saw) is shown next to the plan and compared with it, and a step is marked done
 * from the store only when a person asks for it.
 */

type Actor = { type: ActorType; id: string };

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Shapes

export type RolloutStepView = RolloutStepState & {
  /** 1-based. */
  position: number;
  doneBy: { id: string; name: string | null } | null;
  doneSource: RolloutDoneSource | null;
  /** Open, and its planned time has passed. */
  due: boolean;
};

export type AppleRolloutView = {
  /** Expected day 1 (epoch milliseconds), when the person set one. */
  startsAt: number | null;
  /** Apple's fixed schedule; `date` is the UTC calendar day when `startsAt` is set. */
  schedule: { day: number; percent: number; date: string | null }[];
  note: string;
};

export type RolloutView = {
  /** Always true: this is our own planning data and changes nothing in a store. */
  planningOnly: true;
  /** Null: this plan has no rollout plan. */
  kind: RolloutKind | null;
  /** The built-in template the plan started from, if any. */
  template: string | null;
  steps: RolloutStepView[];
  apple: AppleRolloutView | null;
  summary: RolloutSummary | null;
  /** What the last sync saw of the release in the store, read only. Null: no such release synced. */
  store: StoreRollout | null;
  comparison: RolloutComparison | null;
};

const APPLE_NOTE =
  'Apple releases to users with automatic updates over 7 days on a fixed schedule. This is shown for information: the percentages cannot be changed, and the share Apple has reached is not read from the store.';

// ---------------------------------------------------------------------------------------------
// Reading

const toStep = (r: Row, now: number): RolloutStepView => {
  const plannedAt = mapOrNull(r.planned_at, Number);
  const status = String(r.status) as RolloutStepStatus;
  return {
    id: String(r.id),
    position: Number(r.position) + 1,
    percent: Number(r.percent),
    plannedAt,
    note: mapOrNull(r.note, String),
    status,
    doneAt: mapOrNull(r.done_at, Number),
    doneBy: r.done_by ? { id: String(r.done_by), name: mapOrNull(r.done_by_name, String) } : null,
    doneSource: mapOrNull(r.done_source, String) as RolloutDoneSource | null,
    due: status === 'planned' && plannedAt !== null && plannedAt <= now,
  };
};

const STEP_COLUMNS = `s.id, s.plan_id, s.position, s.percent, s.planned_at, s.note, s.status, s.done_at,
       s.done_by, s.done_source, u.display_name AS done_by_name`;

/** The steps of one plan, in order. */
export async function loadRolloutSteps(
  sql: Sql,
  workspaceId: string,
  planId: string,
  now: number,
): Promise<RolloutStepView[]> {
  const rows = await sql.query(
    `SELECT ${STEP_COLUMNS} FROM plan_rollout_steps s LEFT JOIN users u ON u.id = s.done_by
      WHERE s.plan_id = ? AND s.workspace_id = ? ORDER BY s.position, s.id`,
    [planId, workspaceId],
  );
  return rows.map((r) => toStep(r, now));
}

/** The steps of every plan of the workspace, by plan id. */
export async function loadRolloutStepsByPlan(
  sql: Sql,
  workspaceId: string,
  now: number,
): Promise<Map<string, RolloutStepView[]>> {
  const rows = await sql.query(
    `SELECT ${STEP_COLUMNS} FROM plan_rollout_steps s LEFT JOIN users u ON u.id = s.done_by
      WHERE s.workspace_id = ? ORDER BY s.plan_id, s.position, s.id`,
    [workspaceId],
  );
  const byPlan = new Map<string, RolloutStepView[]>();
  for (const r of rows) {
    const id = String(r.plan_id);
    const list = byPlan.get(id);
    if (list) list.push(toStep(r, now));
    else byPlan.set(id, [toStep(r, now)]);
  }
  return byPlan;
}

/** The compact summary a plan carries in lists. Null when the plan has no rollout plan. */
export function rolloutSummaryOf(
  kind: unknown,
  steps: readonly RolloutStepState[],
  now: number,
): RolloutSummary | null {
  if (kind !== 'steps' && kind !== 'apple_phased') return null;
  return summarizeRollout(kind, kind === 'steps' ? steps : [], now);
}

type Details = { rolloutFraction?: unknown };

function parseFraction(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = (JSON.parse(raw) as Details | null)?.rolloutFraction;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What the last sync saw of this version of the app, read from the synced snapshot (no store call).
 * On Google Play the production track is preferred, then a release that is rolling out or live.
 */
export async function observeStore(
  sql: Sql,
  workspaceId: string,
  appId: string,
  version: string,
): Promise<StoreRollout | null> {
  const rows = await sql.query(
    `SELECT platform, track, status, raw_state, details_json, synced_at FROM app_releases
      WHERE app_id = ? AND workspace_id = ? AND version = ? ORDER BY track, id`,
    [appId, workspaceId, version],
  );
  if (rows.length === 0) return null;
  const rank = (r: Row) =>
    (String(r.track ?? '') === 'production' ? 0 : 10) +
    (r.status === 'rolling_out' || r.status === 'live' || r.status === 'halted' ? 0 : 5);
  const best = [...rows].sort((a, b) => rank(a) - rank(b))[0] as Row;
  return storeRollout({
    platform: oneOf(best.platform, PLATFORMS, 'platform'),
    status: mapOrNull(best.status, String) as ReleaseState | null,
    rawState: mapOrNull(best.raw_state, String),
    fraction: parseFraction(best.details_json),
    syncedAt: mapOrNull(best.synced_at, Number),
  });
}

type PlanFacts = {
  id: string;
  version: string;
  appId: string;
  appPlatform: Platform;
  createdAt: number;
  kind: RolloutKind | null;
  template: string | null;
  startAt: number | null;
};

async function planFacts(sql: Sql, ref: RolloutRef): Promise<PlanFacts | undefined> {
  const [r] = await sql.query(
    `SELECT p.id, p.version, p.app_id, p.created_at, p.rollout_kind, p.rollout_template, p.rollout_start_at,
            a.platform AS app_platform
       FROM release_plans p JOIN apps a ON a.id = p.app_id AND a.workspace_id = p.workspace_id
      WHERE p.id = ? AND p.workspace_id = ? AND p.app_id = ?`,
    [ref.planId, ref.workspaceId, ref.appId],
  );
  if (!r) return undefined;
  const kind = mapOrNull(r.rollout_kind, String);
  return {
    id: String(r.id),
    version: String(r.version),
    appId: String(r.app_id),
    appPlatform: oneOf(r.app_platform, PLATFORMS, 'platform'),
    createdAt: Number(r.created_at),
    kind: kind === 'steps' || kind === 'apple_phased' ? kind : null,
    template: mapOrNull(r.rollout_template, String),
    startAt: mapOrNull(r.rollout_start_at, Number),
  };
}

function appleView(startAt: number | null): AppleRolloutView {
  return {
    startsAt: startAt,
    schedule: APPLE_PHASED_SCHEDULE.map((s) => ({
      day: s.day,
      percent: s.percent,
      date:
        startAt === null ? null : new Date(startAt + (s.day - 1) * DAY).toISOString().slice(0, 10),
    })),
    note: APPLE_NOTE,
  };
}

async function buildView(
  sql: Sql,
  ref: RolloutRef,
  plan: PlanFacts,
  now: number,
): Promise<RolloutView> {
  const steps =
    plan.kind === 'steps' ? await loadRolloutSteps(sql, ref.workspaceId, plan.id, now) : [];
  const store =
    plan.kind === null ? null : await observeStore(sql, ref.workspaceId, plan.appId, plan.version);
  return {
    planningOnly: true,
    kind: plan.kind,
    template: plan.template,
    steps,
    apple: plan.kind === 'apple_phased' ? appleView(plan.startAt) : null,
    summary: rolloutSummaryOf(plan.kind, steps, now),
    store,
    comparison: plan.kind === 'steps' ? compareRollout(steps, store) : null,
  };
}

export type RolloutRef = { workspaceId: string; appId: string; planId: string };

export async function getRollout(
  ctx: PlansContext,
  ref: RolloutRef,
): Promise<RolloutView | undefined> {
  const plan = await planFacts(ctx.db, ref);
  return plan ? buildView(ctx.db, ref, plan, ctx.now()) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Writing the plan

export type SetRolloutInput =
  | { kind: 'steps'; template?: string | undefined; steps: RolloutStepInput[] }
  | { kind: 'apple_phased'; template?: string | undefined; startsAt?: number | null | undefined };

const notFound = (): Failure => failure(404, 'not_found');
const touch = (tx: Sql, workspaceId: string, planId: string, at: number) =>
  tx.execute('UPDATE release_plans SET updated_at = ? WHERE id = ? AND workspace_id = ?', [
    at,
    planId,
    workspaceId,
  ]);

const invalid = (issues: RolloutIssue[]) =>
  failure(422, 'invalid_rollout', issues[0]?.message ?? 'This rollout plan is not valid.', {
    issues,
  });

/** Reminders about steps that no longer exist or no longer apply. */
const dropStepReminders = (tx: Sql, planId: string, itemIds?: string[]) =>
  itemIds === undefined
    ? tx.execute("DELETE FROM plan_reminders WHERE plan_id = ? AND kind = 'rollout_step_due'", [
        planId,
      ])
    : itemIds.length === 0
      ? Promise.resolve(0)
      : tx.execute(
          `DELETE FROM plan_reminders WHERE plan_id = ? AND kind = 'rollout_step_due' AND item_id IN (${itemIds.map(() => '?').join(', ')})`,
          [planId, ...itemIds],
        );

/**
 * Sets the rollout plan: replaces the list of steps (or switches to Apple's phased release). Steps
 * sent with an id keep their status; steps without one are new and open; steps left out are
 * removed (a done step cannot be). Planning data only.
 */
export async function setRollout(
  ctx: PlansContext,
  input: RolloutRef & { body: SetRolloutInput },
  actor: Actor,
): Promise<Outcome<{ rollout: RolloutView }>> {
  const { body } = input;
  return ctx.db.transaction(async (tx) => {
    const plan = await planFacts(tx, input);
    if (!plan) return notFound();
    if (body.template !== undefined) {
      const template = rolloutTemplate(body.template);
      if (
        !template ||
        template.kind !== body.kind ||
        (template.platform !== null &&
          storeFamilyOf(template.platform) !== storeFamilyOf(plan.appPlatform))
      ) {
        return failure(
          422,
          'template_not_found',
          'That rollout template does not exist or does not fit this app.',
        );
      }
    }
    const at = ctx.now();
    const existing =
      plan.kind === 'steps' ? await loadRolloutSteps(tx, input.workspaceId, plan.id, at) : [];

    if (body.kind === 'apple_phased') {
      if (!supports(plan.appPlatform, 'phasedRelease')) {
        return failure(
          422,
          'rollout_platform_mismatch',
          "Apple's phased release is for an iOS or macOS app.",
        );
      }
      if (existing.some((s) => s.status === 'done')) {
        return failure(
          409,
          'rollout_has_done_steps',
          'This plan has steps that are done. Reopen them before switching to the phased release.',
        );
      }
      const startsAt = body.startsAt ?? null;
      if (startsAt !== null && (!Number.isInteger(startsAt) || startsAt < plan.createdAt)) {
        return invalid([
          { path: 'startsAt', message: 'Day 1 cannot be before the plan was created.' },
        ]);
      }
      const unchanged =
        plan.kind === 'apple_phased' &&
        plan.startAt === startsAt &&
        plan.template === (body.template ?? null);
      if (!unchanged) {
        await tx.execute('DELETE FROM plan_rollout_steps WHERE plan_id = ? AND workspace_id = ?', [
          plan.id,
          input.workspaceId,
        ]);
        await dropStepReminders(tx, plan.id);
        await tx.execute(
          `UPDATE release_plans SET rollout_kind = 'apple_phased', rollout_template = ?, rollout_start_at = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
          [body.template ?? null, startsAt, at, plan.id, input.workspaceId],
        );
        await recordAudit(tx, {
          workspaceId: input.workspaceId,
          actor,
          action: 'plan.rollout_set',
          target: { type: 'release_plan', id: plan.id },
          detail: { appId: plan.appId, version: plan.version, kind: 'apple_phased', startsAt },
          at,
        });
      }
    } else {
      const onlyImmediate = body.steps.length === 1 && body.steps[0]?.percent === 100;
      if (supports(plan.appPlatform, 'phasedRelease') && !onlyImmediate) {
        return failure(
          422,
          'rollout_platform_mismatch',
          "Apple's phased release has a fixed schedule. Use it, or plan a single step at 100%.",
        );
      }
      const checked = validateRolloutSteps(body.steps, { planCreatedAt: plan.createdAt, existing });
      if (!checked.ok) return invalid(checked.issues);
      const keep = new Set(body.steps.flatMap((s) => (s.id ? [s.id] : [])));
      const removed = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
      const before = JSON.stringify(existing.map((s) => [s.id, s.percent, s.plannedAt, s.note]));
      const stored = new Map(existing.map((s) => [s.id, s]));
      const ids: string[] = [];
      for (const [position, step] of body.steps.entries()) {
        const id = step.id ?? randomUUID();
        ids.push(id);
        const current = stored.get(id);
        if (current) {
          await tx.execute(
            'UPDATE plan_rollout_steps SET position = ?, percent = ?, planned_at = ?, note = ? WHERE id = ? AND plan_id = ? AND workspace_id = ?',
            [
              position,
              step.percent,
              step.plannedAt ?? null,
              step.note ?? null,
              id,
              plan.id,
              input.workspaceId,
            ],
          );
        } else {
          await tx.execute(
            `INSERT INTO plan_rollout_steps (id, workspace_id, plan_id, position, percent, planned_at, note, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')`,
            [
              id,
              input.workspaceId,
              plan.id,
              position,
              step.percent,
              step.plannedAt ?? null,
              step.note ?? null,
            ],
          );
        }
      }
      for (const id of removed) {
        await tx.execute(
          'DELETE FROM plan_rollout_steps WHERE id = ? AND plan_id = ? AND workspace_id = ?',
          [id, plan.id, input.workspaceId],
        );
      }
      await dropStepReminders(tx, plan.id, removed);
      const after = JSON.stringify(
        body.steps.map((s, i) => [ids[i], s.percent, s.plannedAt ?? null, s.note ?? null]),
      );
      const changed =
        before !== after || plan.kind !== 'steps' || plan.template !== (body.template ?? null);
      if (changed) {
        await tx.execute(
          `UPDATE release_plans SET rollout_kind = 'steps', rollout_template = ?, rollout_start_at = NULL, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
          [body.template ?? null, at, plan.id, input.workspaceId],
        );
        await recordAudit(tx, {
          workspaceId: input.workspaceId,
          actor,
          action: 'plan.rollout_set',
          target: { type: 'release_plan', id: plan.id },
          detail: {
            appId: plan.appId,
            version: plan.version,
            kind: 'steps',
            ...(body.template ? { template: body.template } : {}),
            percents: body.steps.map((s) => s.percent),
          },
          at,
        });
      }
    }
    const fresh = (await planFacts(tx, input)) as PlanFacts;
    return { ok: true as const, rollout: await buildView(tx, input, fresh, at) };
  });
}

/** Removes the rollout plan (its steps, done or not). Planning data only. */
export async function clearRollout(
  ctx: PlansContext,
  input: RolloutRef,
  actor: Actor,
): Promise<Outcome<{ rollout: RolloutView }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planFacts(tx, input);
    if (!plan) return notFound();
    if (plan.kind !== null) {
      const at = ctx.now();
      const steps = (
        await tx.query(
          'SELECT COUNT(*) AS n FROM plan_rollout_steps WHERE plan_id = ? AND workspace_id = ?',
          [plan.id, input.workspaceId],
        )
      )[0];
      await tx.execute('DELETE FROM plan_rollout_steps WHERE plan_id = ? AND workspace_id = ?', [
        plan.id,
        input.workspaceId,
      ]);
      await dropStepReminders(tx, plan.id);
      await tx.execute(
        'UPDATE release_plans SET rollout_kind = NULL, rollout_template = NULL, rollout_start_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?',
        [at, plan.id, input.workspaceId],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'plan.rollout_clear',
        target: { type: 'release_plan', id: plan.id },
        detail: {
          appId: plan.appId,
          version: plan.version,
          kind: plan.kind,
          steps: Number(steps?.n ?? 0),
        },
        at,
      });
    }
    const fresh = (await planFacts(tx, input)) as PlanFacts;
    return { ok: true as const, rollout: await buildView(tx, input, fresh, ctx.now()) };
  });
}

// ---------------------------------------------------------------------------------------------
// Moving a step

const ACTION_EVENT: Record<RolloutAction, EventType> = {
  complete: 'plan.rollout_step_done',
  skip: 'plan.rollout_step_skipped',
  reopen: 'plan.rollout_step_reopened',
};
const ACTION_AUDIT: Record<RolloutAction, string> = {
  complete: 'plan.rollout_step_done',
  skip: 'plan.rollout_step_skipped',
  reopen: 'plan.rollout_step_reopened',
};

/**
 * Completes, skips or reopens one step. `fromStore` (complete only) records that a person confirmed
 * the step against the share the last sync saw; it is refused unless that share has reached the
 * step. Nothing is ever completed without a call like this one. The state change is written with a
 * guard on the old status, so two servers racing on one step cannot both win.
 */
export async function rolloutStepAction(
  ctx: PlansContext,
  input: RolloutRef & { stepId: string; action: RolloutAction; fromStore?: boolean | undefined },
  actor: Actor,
): Promise<Outcome<{ rollout: RolloutView }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planFacts(tx, input);
    if (!plan) return notFound();
    if (plan.kind !== 'steps') {
      return failure(409, 'no_rollout_steps', 'This plan has no rollout steps to change.');
    }
    const at = ctx.now();
    const steps = await loadRolloutSteps(tx, input.workspaceId, plan.id, at);
    const checked = checkRolloutAction(steps, input.stepId, input.action);
    if (!checked.ok) {
      return failure(checked.code === 'step_not_found' ? 404 : 409, checked.code, checked.message);
    }
    const index = steps.findIndex((s) => s.id === input.stepId);
    const step = steps[index] as RolloutStepView;
    if (!checked.noop) {
      let source: RolloutDoneSource | null = null;
      if (input.action === 'complete') {
        source = 'manual';
        if (input.fromStore) {
          const store = await observeStore(tx, input.workspaceId, plan.appId, plan.version);
          if (!store || store.percent === null) {
            return failure(
              409,
              'store_share_unknown',
              'The store has not reported a rollout share for this version, so there is nothing to confirm against.',
            );
          }
          if (store.percent < step.percent) {
            return failure(
              409,
              'store_not_at_step',
              `The store says ${store.percent}%, which is below this step (${step.percent}%).`,
              {
                storePercent: store.percent,
                stepPercent: step.percent,
              },
            );
          }
          source = 'store';
        }
      }
      const done = input.action === 'complete';
      const moved = await tx.execute(
        `UPDATE plan_rollout_steps SET status = ?, done_at = ?, done_by = ?, done_source = ?
          WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status = ?`,
        [
          checked.to,
          done ? at : null,
          done ? actor.id : null,
          source,
          step.id,
          plan.id,
          input.workspaceId,
          step.status,
        ],
      );
      if (moved === 0) {
        return failure(
          409,
          'step_changed',
          'Someone else changed this step. Reload and try again.',
        );
      }
      await touch(tx, input.workspaceId, plan.id, at);
      const detail = {
        appId: plan.appId,
        version: plan.version,
        stepId: step.id,
        index: index + 1,
        total: steps.length,
        percent: step.percent,
        ...(source ? { source } : {}),
      };
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: ACTION_AUDIT[input.action],
        target: { type: 'release_plan', id: plan.id },
        detail,
        at,
      });
      await emitEvent(tx, {
        workspaceId: input.workspaceId,
        type: ACTION_EVENT[input.action],
        subject: { appId: plan.appId },
        payload: { planId: plan.id, ...detail, actor: { type: actor.type, id: actor.id } },
        at,
      });
    }
    return { ok: true as const, rollout: await buildView(tx, input, plan, ctx.now()) };
  });
}

// ---------------------------------------------------------------------------------------------
// Clean-up

/** Removes the rollout steps and reminder log of a plan (for plan deletion). */
export async function purgeRolloutOfPlan(
  tx: Sql,
  workspaceId: string,
  planId: string,
): Promise<void> {
  await tx.execute('DELETE FROM plan_rollout_steps WHERE plan_id = ? AND workspace_id = ?', [
    planId,
    workspaceId,
  ]);
  await tx.execute('DELETE FROM plan_reminders WHERE plan_id = ? AND workspace_id = ?', [
    planId,
    workspaceId,
  ]);
}
