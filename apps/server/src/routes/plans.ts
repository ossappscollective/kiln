import {
  type Action,
  MAX_BLOCKED_REASON_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_TEXT_LENGTH,
  MAX_PLAN_NOTES_LENGTH,
  MAX_PLAN_VERSION_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  can,
  isPlanLocale,
  isPlanVersion,
  isTargetDate,
} from '@mrm/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getApp } from '../services/apps.ts';
import {
  type PlansContext,
  addItem,
  applyTemplate,
  createPlan,
  createTemplate,
  deleteItem,
  deletePlan,
  deleteReleaseNotes,
  deleteTemplate,
  getPlan,
  listPlans,
  listTemplates,
  reorderItems,
  setReleaseNotes,
  updateItem,
  updatePlan,
  updateTemplate,
} from '../services/plans.ts';
import type { Failure } from '../services/repositories.ts';

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => c.json(f.body, f.status);

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]+$/, 'One line, please.');

const version = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PLAN_VERSION_LENGTH)
  .refine(isPlanVersion, 'Start with a letter or digit; then letters, digits, dots, hyphens, plus signs and underscores.');
const targetDate = z.string().refine(isTargetDate, 'A date written YYYY-MM-DD.');
const planNotes = z.string().max(MAX_PLAN_NOTES_LENGTH);
const reason = z.string().trim().max(MAX_BLOCKED_REASON_LENGTH);
const id = z.string().min(1).max(100);

const createBody = z.strictObject({
  version,
  platform: z.enum(['ios', 'android']).nullable().optional(),
  targetDate: targetDate.nullable().optional(),
  notes: planNotes.optional(),
  templateId: id.optional(),
});

const patchBody = z
  .strictObject({
    targetDate: targetDate.nullable().optional(),
    blocked: z.boolean().optional(),
    blockedReason: reason.nullable().optional(),
    notes: planNotes.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to change.');

const itemBody = z.strictObject({
  text: oneLine(MAX_CHECKLIST_TEXT_LENGTH),
  required: z.boolean().default(false),
});

const itemPatchBody = z
  .strictObject({
    text: oneLine(MAX_CHECKLIST_TEXT_LENGTH).optional(),
    required: z.boolean().optional(),
    done: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to change.');

const orderBody = z.strictObject({ order: z.array(id).max(MAX_CHECKLIST_ITEMS) });
const applyBody = z.strictObject({ templateId: id });
// Generous in UTF-16 units; the exact limit is the store's, in characters, and answers 422 with numbers.
const notesBody = z.strictObject({ text: z.string().max(MAX_PLAN_NOTES_LENGTH * 4) });

const templateItem = z.strictObject({
  text: oneLine(MAX_CHECKLIST_TEXT_LENGTH),
  required: z.boolean().default(false),
});
const templateBody = z.strictObject({
  name: oneLine(MAX_TEMPLATE_NAME_LENGTH),
  items: z.array(templateItem).min(1).max(MAX_CHECKLIST_ITEMS),
});
const templatePatchBody = z
  .strictObject({
    name: oneLine(MAX_TEMPLATE_NAME_LENGTH).optional(),
    items: z.array(templateItem).min(1).max(MAX_CHECKLIST_ITEMS).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to change.');

/** Bodies here are text of a few hundred characters; a whole checklist or a locale's notes fit well inside. */
const PLAN_BODY_LIMIT = 32 * 1024;
const TEMPLATE_BODY_LIMIT = 64 * 1024;

/** Release plan and checklist template routes. Mounted under /api/workspaces. */
export function planRoutes(ctx: PlansContext) {
  const { db } = ctx;
  const app = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);
  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);
  const small = bodyLimit({ maxSize: PLAN_BODY_LIMIT, onError: tooLarge });
  const big = bodyLimit({ maxSize: TEMPLATE_BODY_LIMIT, onError: tooLarge });

  const ref = (c: Context<AppEnv>) => ({
    workspaceId: ws(c),
    appId: param(c, 'id'),
    planId: param(c, 'planId'),
  });

  // --- Plans -----------------------------------------------------------------------------------

  app.get('/:workspaceId/plans', needs('plans.read'), async (c) => c.json({ plans: await listPlans(ctx, ws(c)) }));

  app.get('/:workspaceId/apps/:id/plans', needs('plans.read'), async (c) => {
    if (!(await getApp(db, ws(c), param(c, 'id')))) return notFound(c);
    return c.json({ plans: await listPlans(ctx, ws(c), { appId: param(c, 'id') }) });
  });

  app.post('/:workspaceId/apps/:id/plans', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    const done = await createPlan(ctx, { workspaceId: ws(c), appId: param(c, 'id'), ...body.data }, actor(c));
    return done.ok ? c.json({ plan: done.plan }, 201) : respond(c, done);
  });

  app.get('/:workspaceId/apps/:id/plans/:planId', needs('plans.read'), async (c) => {
    const r = ref(c);
    const plan = await getPlan(db, ctx.now(), r.workspaceId, r.appId, r.planId);
    return plan ? c.json({ plan }) : notFound(c);
  });

  app.patch('/:workspaceId/apps/:id/plans/:planId', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, patchBody);
    if (!body.ok) return body.response;
    const done = await updatePlan(ctx, { ...ref(c), patch: body.data }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:id/plans/:planId', needs('plans.write'), async (c) =>
    (await deletePlan(ctx, ref(c), actor(c))) ? c.body(null, 204) : notFound(c),
  );

  // --- Checklist -------------------------------------------------------------------------------

  app.post('/:workspaceId/apps/:id/plans/:planId/items', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, itemBody);
    if (!body.ok) return body.response;
    const done = await addItem(ctx, { ...ref(c), ...body.data }, actor(c));
    return done.ok ? c.json({ plan: done.plan, itemId: done.itemId }, 201) : respond(c, done);
  });

  // Before `/items/:itemId`, so "order" is never read as an item id.
  app.put('/:workspaceId/apps/:id/plans/:planId/items/order', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, orderBody);
    if (!body.ok) return body.response;
    const done = await reorderItems(ctx, { ...ref(c), order: body.data.order }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.patch('/:workspaceId/apps/:id/plans/:planId/items/:itemId', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, itemPatchBody);
    if (!body.ok) return body.response;
    const done = await updateItem(ctx, { ...ref(c), itemId: param(c, 'itemId'), patch: body.data }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:id/plans/:planId/items/:itemId', needs('plans.write'), async (c) => {
    const done = await deleteItem(ctx, { ...ref(c), itemId: param(c, 'itemId') }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.post('/:workspaceId/apps/:id/plans/:planId/apply-template', needs('plans.write'), small, async (c) => {
    const body = await parseBody(c, applyBody);
    if (!body.ok) return body.response;
    const done = await applyTemplate(ctx, { ...ref(c), templateId: body.data.templateId }, actor(c));
    return done.ok ? c.json({ plan: done.plan, added: done.added, skipped: done.skipped }) : respond(c, done);
  });

  // --- Release notes ---------------------------------------------------------------------------

  const localeProblem = (c: Context<AppEnv>) =>
    c.json(
      { error: 'invalid_request', issues: [{ path: 'locale', message: 'A locale code such as en-US, de or default.' }] },
      400,
    );

  app.put('/:workspaceId/apps/:id/plans/:planId/notes/:locale', needs('plans.write'), small, async (c) => {
    const locale = param(c, 'locale');
    if (!isPlanLocale(locale)) return localeProblem(c);
    const body = await parseBody(c, notesBody);
    if (!body.ok) return body.response;
    const done = await setReleaseNotes(ctx, { ...ref(c), locale, text: body.data.text }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:id/plans/:planId/notes/:locale', needs('plans.write'), async (c) => {
    const locale = param(c, 'locale');
    if (!isPlanLocale(locale)) return localeProblem(c);
    const done = await deleteReleaseNotes(ctx, { ...ref(c), locale }, actor(c));
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  // --- Checklist templates ---------------------------------------------------------------------

  app.get('/:workspaceId/checklist-templates', needs('plans.read'), async (c) =>
    c.json({ templates: await listTemplates(db, ws(c)) }),
  );

  app.post('/:workspaceId/checklist-templates', needs('plans.write'), big, async (c) => {
    const body = await parseBody(c, templateBody);
    if (!body.ok) return body.response;
    const done = await createTemplate(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    return done.ok ? c.json({ template: done.template }, 201) : respond(c, done);
  });

  app.patch('/:workspaceId/checklist-templates/:templateId', needs('plans.write'), big, async (c) => {
    const body = await parseBody(c, templatePatchBody);
    if (!body.ok) return body.response;
    const done = await updateTemplate(ctx, { workspaceId: ws(c), id: param(c, 'templateId'), ...body.data }, actor(c));
    return done.ok ? c.json({ template: done.template }) : respond(c, done);
  });

  app.delete('/:workspaceId/checklist-templates/:templateId', needs('plans.write'), async (c) => {
    const done = await deleteTemplate(ctx, { workspaceId: ws(c), id: param(c, 'templateId') }, actor(c));
    return done.ok ? c.body(null, 204) : respond(c, done);
  });

  return app;
}
