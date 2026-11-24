import { randomUUID } from 'node:crypto';
import {
  type ActorType,
  type ChecklistTemplateItem,
  computeReadiness,
  DEFAULT_CHECKLIST_TEMPLATES,
  type DueFlags,
  defaultTemplate,
  dueFlags,
  isBuiltinTemplateId,
  isPlatform,
  MAX_CHECKLIST_ITEMS,
  MAX_NOTE_LOCALES,
  MAX_TEMPLATES,
  PLATFORMS,
  type PlanPlatform,
  type Platform,
  platformMeta,
  type Readiness,
  type RolloutStepState,
  type RolloutSummary,
  releaseNotesLength,
  releaseNotesLimit,
} from '@kiln/core';
import { type Database, mapOrNull, oneOf, type Param, type Row, type Sql } from '@kiln/db';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import {
  loadRolloutSteps,
  loadRolloutStepsByPlan,
  purgeRolloutOfPlan,
  rolloutSummaryOf,
} from './plan-rollout.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * Release planning: checklists, release notes per locale, a target date and a blocked flag for
 * one version of one app. This is our own data in our own database. Nothing here reads a store
 * with a credential or writes to one.
 */

type Actor = { type: ActorType; id: string };

export type PlansContext = {
  db: Database;
  /** The clock. The deadline flags are computed from it, so tests control them. */
  now: () => number;
};

const notFound = (): Failure => failure(404, 'not_found');

// ---------------------------------------------------------------------------------------------
// Shapes

export type PlanItem = {
  id: string;
  position: number;
  text: string;
  required: boolean;
  done: boolean;
  doneBy: { id: string; name: string | null } | null;
  doneAt: number | null;
};

export type PlanNote = {
  locale: string;
  text: string;
  /** Characters, as the listing rules count them. */
  length: number;
  updatedAt: number;
};

export type PlanSummary = {
  id: string;
  appId: string;
  appName: string;
  appPlatform: Platform;
  appIdentifier: string;
  version: string;
  /** Null: the plan covers both platforms. */
  platform: PlanPlatform;
  /** A calendar day, `YYYY-MM-DD`, compared in UTC. */
  targetDate: string | null;
  blocked: boolean;
  blockedReason: string | null;
  /** Free planning notes, not store text. */
  notes: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The last sync saw this version live, so the deadline no longer matters. */
  released: boolean;
  due: DueFlags;
  readiness: Readiness;
  checklist: { total: number; done: number };
  /**
   * The staged rollout plan in short: how far it is, the next step, steps whose time has passed.
   * Null when the plan has no rollout plan. Planning data only; see `GET .../rollout` for the steps.
   */
  rollout: RolloutSummary | null;
};

export type PlanDetail = PlanSummary & { items: PlanItem[]; releaseNotes: PlanNote[] };

export type TemplateView = {
  id: string;
  name: string;
  description: string | null;
  items: ChecklistTemplateItem[];
  /** Ships with the product: not stored, cannot be changed or deleted. */
  builtin: boolean;
  createdAt: number | null;
  updatedAt: number | null;
};

// ---------------------------------------------------------------------------------------------
// Reading

const FROM = `FROM release_plans p
  JOIN apps a ON a.id = p.app_id AND a.workspace_id = p.workspace_id`;

const SELECT = `SELECT p.id, p.app_id, p.version, p.platform, p.target_date, p.blocked,
       p.blocked_reason, p.notes, p.created_by, p.created_at, p.updated_at, p.rollout_kind,
       a.name AS app_name, a.platform AS app_platform, a.identifier AS app_identifier,
       CASE WHEN EXISTS (
         SELECT 1 FROM app_releases r
          WHERE r.app_id = p.app_id AND r.workspace_id = p.workspace_id
            AND r.version = p.version AND r.status = 'live'
       ) THEN 1 ELSE 0 END AS released
  ${FROM}`;

const toItem = (r: Row): PlanItem => ({
  id: String(r.id),
  position: Number(r.position),
  text: String(r.text),
  required: Number(r.required) === 1,
  done: Number(r.done) === 1,
  doneBy: r.done_by ? { id: String(r.done_by), name: mapOrNull(r.done_by_name, String) } : null,
  doneAt: mapOrNull(r.done_at, Number),
});

const toNote = (r: Row): PlanNote => {
  const text = String(r.text);
  return {
    locale: String(r.locale),
    text,
    length: releaseNotesLength(text),
    updatedAt: Number(r.updated_at),
  };
};

function summarize(
  r: Row,
  items: PlanItem[],
  notes: PlanNote[],
  now: number,
  steps: readonly RolloutStepState[] = [],
): PlanSummary {
  const platform = mapOrNull(r.platform, String) as PlanPlatform;
  const targetDate = mapOrNull(r.target_date, String);
  const released = Number(r.released) === 1;
  return {
    id: String(r.id),
    appId: String(r.app_id),
    appName: String(r.app_name),
    appPlatform: oneOf(r.app_platform, PLATFORMS, 'platform'),
    appIdentifier: String(r.app_identifier),
    version: String(r.version),
    platform,
    targetDate,
    blocked: Number(r.blocked) === 1,
    blockedReason: mapOrNull(r.blocked_reason, String),
    notes: String(r.notes ?? ''),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    released,
    due: dueFlags(targetDate, now, { released }),
    readiness: computeReadiness({ items, notes, platform }),
    checklist: { total: items.length, done: items.filter((i) => i.done).length },
    rollout: rolloutSummaryOf(r.rollout_kind, steps, now),
  };
}

async function loadItems(sql: Sql, workspaceId: string, planIds?: string[]): Promise<PlanItem[][]> {
  const rows = await sql.query(
    `SELECT i.id, i.plan_id, i.position, i.text, i.required, i.done, i.done_by, i.done_at,
            u.display_name AS done_by_name
       FROM checklist_items i LEFT JOIN users u ON u.id = i.done_by
      WHERE i.workspace_id = ? ORDER BY i.plan_id, i.position, i.id`,
    [workspaceId],
  );
  return groupBy(rows, planIds, toItem);
}

async function loadNotes(sql: Sql, workspaceId: string, planIds?: string[]): Promise<PlanNote[][]> {
  const rows = await sql.query(
    `SELECT plan_id, locale, text, updated_at FROM release_notes
      WHERE workspace_id = ? ORDER BY plan_id, locale`,
    [workspaceId],
  );
  return groupBy(rows, planIds, toNote);
}

/** Rows grouped by `plan_id`, in the order of `planIds`. Without `planIds`, one group per plan seen. */
function groupBy<T>(rows: Row[], planIds: string[] | undefined, map: (r: Row) => T): T[][] {
  const byPlan = new Map<string, T[]>();
  for (const r of rows) {
    const id = String(r.plan_id);
    const list = byPlan.get(id);
    if (list) list.push(map(r));
    else byPlan.set(id, [map(r)]);
  }
  return (planIds ?? [...byPlan.keys()]).map((id) => byPlan.get(id) ?? []);
}

/** Every plan of the workspace, or of one app. Soonest deadline first, plans without one last. */
export async function listPlans(
  ctx: PlansContext,
  workspaceId: string,
  filter: { appId?: string } = {},
): Promise<PlanSummary[]> {
  const rows = filter.appId
    ? await ctx.db.query(`${SELECT} WHERE p.workspace_id = ? AND p.app_id = ?`, [
        workspaceId,
        filter.appId,
      ])
    : await ctx.db.query(`${SELECT} WHERE p.workspace_id = ?`, [workspaceId]);
  const ids = rows.map((r) => String(r.id));
  const now = ctx.now();
  const [items, notes, steps] = await Promise.all([
    loadItems(ctx.db, workspaceId, ids),
    loadNotes(ctx.db, workspaceId, ids),
    loadRolloutStepsByPlan(ctx.db, workspaceId, now),
  ]);
  return rows
    .map((r, i) =>
      summarize(r, items[i] ?? [], notes[i] ?? [], now, steps.get(ids[i] as string) ?? []),
    )
    .sort((a, b) => {
      if (a.targetDate !== b.targetDate) {
        if (a.targetDate === null) return 1;
        if (b.targetDate === null) return -1;
        return a.targetDate < b.targetDate ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
    });
}

export async function getPlan(
  sql: Sql,
  now: number,
  workspaceId: string,
  appId: string,
  planId: string,
): Promise<PlanDetail | undefined> {
  const [row] = await sql.query(
    `${SELECT} WHERE p.id = ? AND p.workspace_id = ? AND p.app_id = ?`,
    [planId, workspaceId, appId],
  );
  if (!row) return undefined;
  const items = (
    await sql.query(
      `SELECT i.id, i.plan_id, i.position, i.text, i.required, i.done, i.done_by, i.done_at,
              u.display_name AS done_by_name
         FROM checklist_items i LEFT JOIN users u ON u.id = i.done_by
        WHERE i.plan_id = ? AND i.workspace_id = ? ORDER BY i.position, i.id`,
      [planId, workspaceId],
    )
  ).map(toItem);
  const notes = (
    await sql.query(
      `SELECT plan_id, locale, text, updated_at FROM release_notes
        WHERE plan_id = ? AND workspace_id = ? ORDER BY locale`,
      [planId, workspaceId],
    )
  ).map(toNote);
  const steps =
    row.rollout_kind === 'steps' ? await loadRolloutSteps(sql, workspaceId, planId, now) : [];
  return { ...summarize(row, items, notes, now, steps), items, releaseNotes: notes };
}

// ---------------------------------------------------------------------------------------------
// Templates

const parseItems = (raw: unknown): ChecklistTemplateItem[] => {
  if (typeof raw !== 'string') return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const e = entry as { text?: unknown; required?: unknown };
      return typeof e?.text === 'string' ? [{ text: e.text, required: e.required === true }] : [];
    });
  } catch {
    return [];
  }
};

const toTemplate = (r: Row): TemplateView => ({
  id: String(r.id),
  name: String(r.name),
  description: null,
  items: parseItems(r.items_json),
  builtin: false,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** The templates that ship with the product, then the workspace's own by name. */
export async function listTemplates(sql: Sql, workspaceId: string): Promise<TemplateView[]> {
  const rows = await sql.query(
    'SELECT id, name, items_json, created_at, updated_at FROM checklist_templates WHERE workspace_id = ? ORDER BY name, id',
    [workspaceId],
  );
  return [
    ...DEFAULT_CHECKLIST_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      items: t.items.map((i) => ({ ...i })),
      builtin: true,
      createdAt: null,
      updatedAt: null,
    })),
    ...rows.map(toTemplate),
  ];
}

async function findTemplate(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<{ name: string; items: ChecklistTemplateItem[] } | undefined> {
  if (isBuiltinTemplateId(id)) return defaultTemplate(id);
  const [row] = await sql.query(
    'SELECT id, name, items_json, created_at, updated_at FROM checklist_templates WHERE id = ? AND workspace_id = ?',
    [id, workspaceId],
  );
  return row ? toTemplate(row) : undefined;
}

export type TemplateInput = { name: string; items: ChecklistTemplateItem[] };

export async function createTemplate(
  ctx: PlansContext,
  input: TemplateInput & { workspaceId: string },
  actor: Actor,
): Promise<Outcome<{ template: TemplateView }>> {
  return ctx.db.transaction(async (tx) => {
    const [count] = await tx.query(
      'SELECT COUNT(*) AS n FROM checklist_templates WHERE workspace_id = ?',
      [input.workspaceId],
    );
    if (Number(count?.n) >= MAX_TEMPLATES) {
      return failure(
        422,
        'too_many_templates',
        `A workspace can have ${MAX_TEMPLATES} templates.`,
        coded('plan.tooManyTemplates', { max: MAX_TEMPLATES }),
      );
    }
    const [same] = await tx.query(
      'SELECT id FROM checklist_templates WHERE workspace_id = ? AND name = ?',
      [input.workspaceId, input.name],
    );
    if (same)
      return failure(
        409,
        'already_exists',
        'A template with that name already exists.',
        coded('plan.templateNameTaken'),
      );
    const id = randomUUID();
    const at = ctx.now();
    await tx.execute(
      `INSERT INTO checklist_templates (id, workspace_id, name, items_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.workspaceId, input.name, JSON.stringify(input.items), actor.id, at, at],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist_template.create',
      target: { type: 'checklist_template', id },
      detail: { name: input.name, items: input.items.length },
      at,
    });
    const template: TemplateView = {
      id,
      name: input.name,
      description: null,
      items: input.items,
      builtin: false,
      createdAt: at,
      updatedAt: at,
    };
    return { ok: true as const, template };
  });
}

export async function updateTemplate(
  ctx: PlansContext,
  input: {
    workspaceId: string;
    id: string;
    name?: string | undefined;
    items?: ChecklistTemplateItem[] | undefined;
  },
  actor: Actor,
): Promise<Outcome<{ template: TemplateView }>> {
  if (isBuiltinTemplateId(input.id)) {
    return failure(
      409,
      'builtin_template',
      'This template ships with the product. Save a copy with your own wording instead.',
      coded('plan.templateBuiltin'),
    );
  }
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT id, name, items_json, created_at, updated_at FROM checklist_templates WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return notFound();
    const current = toTemplate(row);
    const name = input.name ?? current.name;
    if (name !== current.name) {
      const [same] = await tx.query(
        'SELECT id FROM checklist_templates WHERE workspace_id = ? AND name = ?',
        [input.workspaceId, name],
      );
      if (same)
        return failure(
          409,
          'already_exists',
          'A template with that name already exists.',
          coded('plan.templateNameTaken'),
        );
    }
    const items = input.items ?? current.items;
    const at = ctx.now();
    await tx.execute(
      'UPDATE checklist_templates SET name = ?, items_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      [name, JSON.stringify(items), at, input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist_template.update',
      target: { type: 'checklist_template', id: input.id },
      detail: { name, items: items.length },
      at,
    });
    return { ok: true as const, template: { ...current, name, items, updatedAt: at } };
  });
}

export async function deleteTemplate(
  ctx: PlansContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<Outcome<Record<never, never>>> {
  if (isBuiltinTemplateId(input.id)) {
    return failure(
      409,
      'builtin_template',
      'This template ships with the product and cannot be deleted.',
      coded('plan.templateBuiltinDelete'),
    );
  }
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT name FROM checklist_templates WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return notFound();
    await tx.execute('DELETE FROM checklist_templates WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist_template.delete',
      target: { type: 'checklist_template', id: input.id },
      detail: { name: String(row.name) },
      at: ctx.now(),
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Plans

export type CreatePlanInput = {
  workspaceId: string;
  appId: string;
  version: string;
  platform?: Platform | null | undefined;
  targetDate?: string | null | undefined;
  notes?: string | undefined;
  /** Items to start with: a workspace template id or a `builtin:` id. */
  templateId?: string | undefined;
};

export async function createPlan(
  ctx: PlansContext,
  input: CreatePlanInput,
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const app = await getApp(tx, input.workspaceId, input.appId);
    if (!app) return notFound();
    const platform = input.platform ?? null;
    if (platform !== null && platform !== app.platform) {
      return failure(
        422,
        'platform_mismatch',
        `This app is on ${app.platform}. A plan for it covers ${app.platform} or both platforms.`,
        coded('plan.platformMismatch', { platform: app.platform }),
      );
    }
    const [same] = await tx.query(
      'SELECT id FROM release_plans WHERE app_id = ? AND version = ? AND workspace_id = ?',
      [app.id, input.version, input.workspaceId],
    );
    if (same)
      return failure(409, 'already_exists', 'This app already has a plan for that version.', {
        planId: String(same.id),
        ...coded('plan.alreadyExists'),
      });
    let template: { name: string; items: ChecklistTemplateItem[] } | undefined;
    if (input.templateId !== undefined) {
      template = await findTemplate(tx, input.workspaceId, input.templateId);
      if (!template)
        return failure(
          404,
          'template_not_found',
          'That checklist template does not exist.',
          coded('notFound.checklistTemplate'),
        );
    }
    const id = randomUUID();
    const at = ctx.now();
    await tx.execute(
      `INSERT INTO release_plans
         (id, workspace_id, app_id, version, platform, target_date, blocked, blocked_reason, notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        app.id,
        input.version,
        platform,
        input.targetDate ?? null,
        input.notes ?? '',
        actor.id,
        at,
        at,
      ],
    );
    const items = template?.items ?? [];
    let position = 0;
    for (const item of items) {
      await insertItem(tx, input.workspaceId, id, position++, item);
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'plan.create',
      target: { type: 'release_plan', id },
      detail: {
        appId: app.id,
        version: input.version,
        platform,
        targetDate: input.targetDate ?? null,
        ...(template ? { template: template.name, items: items.length } : {}),
      },
      at,
    });
    const plan = (await getPlan(tx, at, input.workspaceId, app.id, id)) as PlanDetail;
    return { ok: true as const, plan };
  });
}

export type PlanPatch = {
  targetDate?: string | null | undefined;
  blocked?: boolean | undefined;
  /** Required with `blocked: true`; cleared when the plan is unblocked. */
  blockedReason?: string | null | undefined;
  notes?: string | undefined;
};

export async function updatePlan(
  ctx: PlansContext,
  input: { workspaceId: string; appId: string; planId: string; patch: PlanPatch },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const current = await getPlan(tx, ctx.now(), input.workspaceId, input.appId, input.planId);
    if (!current) return notFound();
    const { patch } = input;
    const targetDate = patch.targetDate === undefined ? current.targetDate : patch.targetDate;
    const blocked = patch.blocked ?? current.blocked;
    let blockedReason =
      patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason;
    if (blocked && (blockedReason ?? '').trim() === '') {
      return failure(
        422,
        'reason_required',
        'Say why the release is blocked.',
        coded('plan.blockReason'),
      );
    }
    if (!blocked) blockedReason = null;
    const notes = patch.notes ?? current.notes;
    const changed: string[] = [];
    if (targetDate !== current.targetDate) changed.push('targetDate');
    if (blocked !== current.blocked) changed.push('blocked');
    else if (blocked && blockedReason !== current.blockedReason) changed.push('blockedReason');
    if (notes !== current.notes) changed.push('notes');
    if (changed.length > 0) {
      const at = ctx.now();
      await tx.execute(
        `UPDATE release_plans SET target_date = ?, blocked = ?, blocked_reason = ?, notes = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        [targetDate, blocked ? 1 : 0, blockedReason, notes, at, input.planId, input.workspaceId],
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'plan.update',
        target: { type: 'release_plan', id: input.planId },
        detail: {
          appId: input.appId,
          version: current.version,
          changed,
          ...(changed.includes('targetDate') ? { targetDate } : {}),
          ...(changed.includes('blocked') || changed.includes('blockedReason')
            ? { blocked, ...(blocked ? { reason: blockedReason } : {}) }
            : {}),
        },
        at,
      });
    }
    const plan = (await getPlan(
      tx,
      ctx.now(),
      input.workspaceId,
      input.appId,
      input.planId,
    )) as PlanDetail;
    return { ok: true as const, plan };
  });
}

export async function deletePlan(
  ctx: PlansContext,
  input: { workspaceId: string; appId: string; planId: string },
  actor: Actor,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const plan = await getPlan(tx, ctx.now(), input.workspaceId, input.appId, input.planId);
    if (!plan) return false;
    for (const table of ['checklist_items', 'release_notes']) {
      await tx.execute(`DELETE FROM ${table} WHERE plan_id = ? AND workspace_id = ?`, [
        input.planId,
        input.workspaceId,
      ]);
    }
    await purgeRolloutOfPlan(tx, input.workspaceId, input.planId);
    await tx.execute('DELETE FROM release_plans WHERE id = ? AND workspace_id = ?', [
      input.planId,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'plan.delete',
      target: { type: 'release_plan', id: input.planId },
      detail: {
        appId: input.appId,
        version: plan.version,
        items: plan.items.length,
        locales: plan.releaseNotes.length,
      },
      at: ctx.now(),
    });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Checklist items

async function insertItem(
  tx: Sql,
  workspaceId: string,
  planId: string,
  position: number,
  item: ChecklistTemplateItem,
): Promise<string> {
  const id = randomUUID();
  await tx.execute(
    `INSERT INTO checklist_items (id, workspace_id, plan_id, position, text, required, done)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [id, workspaceId, planId, position, item.text, item.required ? 1 : 0],
  );
  return id;
}

const touch = (tx: Sql, workspaceId: string, planId: string, at: number) =>
  tx.execute('UPDATE release_plans SET updated_at = ? WHERE id = ? AND workspace_id = ?', [
    at,
    planId,
    workspaceId,
  ]);

type PlanRef = { workspaceId: string; appId: string; planId: string };

/** The plan row when it belongs to this workspace and app, else undefined. */
async function planRow(tx: Sql, ref: PlanRef): Promise<{ version: string } | undefined> {
  const [row] = await tx.query(
    'SELECT version FROM release_plans WHERE id = ? AND workspace_id = ? AND app_id = ?',
    [ref.planId, ref.workspaceId, ref.appId],
  );
  return row ? { version: String(row.version) } : undefined;
}

async function currentPlan(
  tx: Sql,
  ctx: PlansContext,
  ref: PlanRef,
): Promise<{ ok: true; plan: PlanDetail }> {
  return {
    ok: true,
    plan: (await getPlan(tx, ctx.now(), ref.workspaceId, ref.appId, ref.planId)) as PlanDetail,
  };
}

export async function addItem(
  ctx: PlansContext,
  input: PlanRef & { text: string; required: boolean },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail; itemId: string }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const [stats] = await tx.query(
      'SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM checklist_items WHERE plan_id = ? AND workspace_id = ?',
      [input.planId, input.workspaceId],
    );
    if (Number(stats?.n) >= MAX_CHECKLIST_ITEMS) {
      return failure(
        422,
        'too_many_items',
        `A checklist can have ${MAX_CHECKLIST_ITEMS} items.`,
        coded('plan.checklistFull', { max: MAX_CHECKLIST_ITEMS }),
      );
    }
    const itemId = await insertItem(
      tx,
      input.workspaceId,
      input.planId,
      Number(stats?.last) + 1,
      input,
    );
    const at = ctx.now();
    await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist.item_add',
      target: { type: 'release_plan', id: input.planId },
      detail: { version: plan.version, itemId, text: input.text, required: input.required },
      at,
    });
    return { ...(await currentPlan(tx, ctx, input)), itemId };
  });
}

export type ItemPatch = {
  text?: string | undefined;
  required?: boolean | undefined;
  done?: boolean | undefined;
};

export async function updateItem(
  ctx: PlansContext,
  input: PlanRef & { itemId: string; patch: ItemPatch },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const [item] = await tx.query(
      'SELECT id, text, required, done FROM checklist_items WHERE id = ? AND plan_id = ? AND workspace_id = ?',
      [input.itemId, input.planId, input.workspaceId],
    );
    if (!item) return notFound();
    const { patch } = input;
    const sets: string[] = [];
    const params: Param[] = [];
    const changed: string[] = [];
    if (patch.text !== undefined && patch.text !== String(item.text)) {
      sets.push('text = ?');
      params.push(patch.text);
      changed.push('text');
    }
    if (patch.required !== undefined && patch.required !== (Number(item.required) === 1)) {
      sets.push('required = ?');
      params.push(patch.required ? 1 : 0);
      changed.push('required');
    }
    const at = ctx.now();
    // Ticking an item that is already done keeps who and when from the first time.
    if (patch.done !== undefined && patch.done !== (Number(item.done) === 1)) {
      sets.push('done = ?', 'done_by = ?', 'done_at = ?');
      params.push(patch.done ? 1 : 0, patch.done ? actor.id : null, patch.done ? at : null);
      changed.push(patch.done ? 'done' : 'undone');
    }
    if (changed.length > 0) {
      await tx.execute(
        `UPDATE checklist_items SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
        [...params, input.itemId, input.workspaceId],
      );
      await touch(tx, input.workspaceId, input.planId, at);
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'checklist.item_update',
        target: { type: 'release_plan', id: input.planId },
        detail: { version: plan.version, itemId: input.itemId, changed },
        at,
      });
    }
    return currentPlan(tx, ctx, input);
  });
}

export async function deleteItem(
  ctx: PlansContext,
  input: PlanRef & { itemId: string },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const removed = await tx.execute(
      'DELETE FROM checklist_items WHERE id = ? AND plan_id = ? AND workspace_id = ?',
      [input.itemId, input.planId, input.workspaceId],
    );
    if (removed === 0) return notFound();
    const at = ctx.now();
    await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist.item_delete',
      target: { type: 'release_plan', id: input.planId },
      detail: { version: plan.version, itemId: input.itemId },
      at,
    });
    return currentPlan(tx, ctx, input);
  });
}

/** `order` must list every item of the plan exactly once. */
export async function reorderItems(
  ctx: PlansContext,
  input: PlanRef & { order: string[] },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const rows = await tx.query(
      'SELECT id FROM checklist_items WHERE plan_id = ? AND workspace_id = ?',
      [input.planId, input.workspaceId],
    );
    const known = new Set(rows.map((r) => String(r.id)));
    const same =
      input.order.length === known.size &&
      new Set(input.order).size === input.order.length &&
      input.order.every((id) => known.has(id));
    if (!same) {
      return failure(
        422,
        'order_mismatch',
        'The order must list every item of the checklist exactly once. Reload and try again.',
        coded('plan.checklistOrder'),
      );
    }
    for (const [position, id] of input.order.entries()) {
      await tx.execute(
        'UPDATE checklist_items SET position = ? WHERE id = ? AND workspace_id = ?',
        [position, id, input.workspaceId],
      );
    }
    const at = ctx.now();
    await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'checklist.reorder',
      target: { type: 'release_plan', id: input.planId },
      detail: { version: plan.version, items: input.order.length },
      at,
    });
    return currentPlan(tx, ctx, input);
  });
}

/** Appends the template's items that the checklist does not have yet (same text). */
export async function applyTemplate(
  ctx: PlansContext,
  input: PlanRef & { templateId: string },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail; added: number; skipped: number }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const template = await findTemplate(tx, input.workspaceId, input.templateId);
    if (!template)
      return failure(
        404,
        'template_not_found',
        'That checklist template does not exist.',
        coded('notFound.checklistTemplate'),
      );
    const existing = await tx.query(
      'SELECT text, position FROM checklist_items WHERE plan_id = ? AND workspace_id = ?',
      [input.planId, input.workspaceId],
    );
    const have = new Set(existing.map((r) => String(r.text)));
    const fresh = template.items.filter((i) => !have.has(i.text));
    if (existing.length + fresh.length > MAX_CHECKLIST_ITEMS) {
      return failure(
        422,
        'too_many_items',
        `A checklist can have ${MAX_CHECKLIST_ITEMS} items.`,
        coded('plan.checklistFull', { max: MAX_CHECKLIST_ITEMS }),
      );
    }
    let position = existing.reduce((max, r) => Math.max(max, Number(r.position)), -1) + 1;
    for (const item of fresh)
      await insertItem(tx, input.workspaceId, input.planId, position++, item);
    const at = ctx.now();
    if (fresh.length > 0) await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'plan.apply_template',
      target: { type: 'release_plan', id: input.planId },
      detail: {
        version: plan.version,
        template: template.name,
        added: fresh.length,
        skipped: template.items.length - fresh.length,
      },
      at,
    });
    return {
      ...(await currentPlan(tx, ctx, input)),
      added: fresh.length,
      skipped: template.items.length - fresh.length,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Release notes per locale

/** Sets the text of one locale (adding the locale), checked against the store limit of the plan. */
export async function setReleaseNotes(
  ctx: PlansContext,
  input: PlanRef & { locale: string; text: string },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const [plan] = await tx.query(
      'SELECT version, platform FROM release_plans WHERE id = ? AND workspace_id = ? AND app_id = ?',
      [input.planId, input.workspaceId, input.appId],
    );
    if (!plan) return notFound();
    const platform = mapOrNull(plan.platform, String) as PlanPlatform;
    const limit = releaseNotesLimit(platform);
    const length = releaseNotesLength(input.text);
    if (length > limit) {
      const store = isPlatform(platform)
        ? platformMeta(platform).storeNameWithArticle
        : 'Google Play (a plan for both platforms must fit the stricter store)';
      return failure(
        422,
        'notes_too_long',
        `Release notes for ${input.locale} are ${length} characters. ${store} allows ${limit}.`,
        {
          locale: input.locale,
          limit,
          actual: length,
          ...coded('plan.notesTooLong', { locale: input.locale, length, store, limit }),
        },
      );
    }
    const [existing] = await tx.query(
      'SELECT locale FROM release_notes WHERE plan_id = ? AND workspace_id = ? AND locale = ?',
      [input.planId, input.workspaceId, input.locale],
    );
    const at = ctx.now();
    if (existing) {
      await tx.execute(
        'UPDATE release_notes SET text = ?, updated_at = ? WHERE plan_id = ? AND workspace_id = ? AND locale = ?',
        [input.text, at, input.planId, input.workspaceId, input.locale],
      );
    } else {
      const [count] = await tx.query(
        'SELECT COUNT(*) AS n FROM release_notes WHERE plan_id = ? AND workspace_id = ?',
        [input.planId, input.workspaceId],
      );
      if (Number(count?.n) >= MAX_NOTE_LOCALES) {
        return failure(
          422,
          'too_many_locales',
          `A plan can have release notes for ${MAX_NOTE_LOCALES} locales.`,
          coded('plan.tooManyNoteLocales', { max: MAX_NOTE_LOCALES }),
        );
      }
      await tx.execute(
        'INSERT INTO release_notes (id, workspace_id, plan_id, locale, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), input.workspaceId, input.planId, input.locale, input.text, at],
      );
    }
    await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'plan.notes_set',
      target: { type: 'release_plan', id: input.planId },
      detail: { version: String(plan.version), locale: input.locale, length, added: !existing },
      at,
    });
    return currentPlan(tx, ctx, input);
  });
}

export async function deleteReleaseNotes(
  ctx: PlansContext,
  input: PlanRef & { locale: string },
  actor: Actor,
): Promise<Outcome<{ plan: PlanDetail }>> {
  return ctx.db.transaction(async (tx) => {
    const plan = await planRow(tx, input);
    if (!plan) return notFound();
    const removed = await tx.execute(
      'DELETE FROM release_notes WHERE plan_id = ? AND workspace_id = ? AND locale = ?',
      [input.planId, input.workspaceId, input.locale],
    );
    if (removed === 0) return notFound();
    const at = ctx.now();
    await touch(tx, input.workspaceId, input.planId, at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'plan.notes_delete',
      target: { type: 'release_plan', id: input.planId },
      detail: { version: plan.version, locale: input.locale },
      at,
    });
    return currentPlan(tx, ctx, input);
  });
}

// ---------------------------------------------------------------------------------------------
// Clean-up

/**
 * Removes every plan of an app with its items and notes. Plans of a deleted app are never shown
 * (they are found through the app), so nothing breaks without this; calling it from the app
 * deletion, in the same transaction, only keeps the tables tidy. Not audited here: the caller
 * audits the deletion of the app.
 */
export async function purgePlansOfApp(tx: Sql, workspaceId: string, appId: string): Promise<void> {
  const ids = (
    await tx.query('SELECT id FROM release_plans WHERE app_id = ? AND workspace_id = ?', [
      appId,
      workspaceId,
    ])
  ).map((r) => String(r.id));
  for (const id of ids) {
    await tx.execute('DELETE FROM checklist_items WHERE plan_id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ]);
    await tx.execute('DELETE FROM release_notes WHERE plan_id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ]);
    await purgeRolloutOfPlan(tx, workspaceId, id);
  }
  await tx.execute('DELETE FROM release_plans WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);
}
