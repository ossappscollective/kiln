import { EXPO_UPDATE_GROUP_ID } from '@kiln/connectors';
import { type Action, can } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { Failure } from '../../services/repositories.ts';
import { requireStepUp } from '../../services/step-up.ts';
import type { EasPart } from './parts.ts';
import {
  applyUpdateRollout,
  INSIGHTS_DEFAULT_DAYS,
  previewUpdateRollout,
  readUpdateInsights,
  readUpdateState,
  rolloutDisabledFailure,
  type UpdateContext,
} from './update.ts';

/** Reads of EAS Update per workspace per minute (a state read is two requests to Expo). */
export const EAS_UPDATE_READS_PER_MINUTE = 30;
/** Previews and applies of a rollout change per workspace per minute. */
export const EAS_UPDATE_WRITES_PER_MINUTE = 10;

/** The change and the update group it is about. */
export const rolloutRequestFields = {
  group: z.string().regex(EXPO_UPDATE_GROUP_ID, 'An update group id (a UUID).'),
  percentage: z.number().int().min(1).max(100),
};
export const rolloutPreviewBody = z.strictObject(rolloutRequestFields);
export const rolloutApplyBody = z.strictObject({
  ...rolloutRequestFields,
  confirmHash: z.string().regex(/^[0-9a-f]{64}$/, 'The confirmHash of the preview, 64 hexadecimal characters.'),
});

export type EasUpdateRoutesContext = {
  db: Database;
  update: UpdateContext;
  readLimiter: TestLimiter;
  writeLimiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/**
 * EAS Update of the Expo project an app is linked to (docs/api/eas-update.md, docs/adr/0037-eas-update.md). Reading needs `apps.read`
 * (the same people who may read the app). Raising a rollout needs `releases.rollout` (owners and admins), the switch
 * MRM_EAS_UPDATE_ROLLOUT_ENABLED and, when the workspace's policy covers `rollout`, a step-up confirmation. Not being a member and an
 * unknown app look the same (404).
 */
export function easUpdateRoutes(ctx: EasUpdateRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const slow = (c: Context<AppEnv>, limiter: TestLimiter) => {
    const wait = limiter.take(ws(c));
    if (wait <= 0) return undefined;
    return respond(c, {
      ok: false,
      status: 429,
      body: {
        error: 'rate_limited',
        message: `Too many Expo requests. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
      headers: { 'Retry-After': String(wait) },
    });
  };

  routes.get('/:workspaceId/apps/:appId/expo/updates', needs('apps.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const limited = slow(c, ctx.readLimiter);
    if (limited) return limited;
    const done = await readUpdateState(ctx.update, { workspaceId: ws(c), app }, actor(c));
    return done.ok ? c.json({ state: done.state }) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:appId/expo/updates/:group/insights', needs('apps.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const raw = c.req.query('days');
    const days = raw === undefined ? INSIGHTS_DEFAULT_DAYS : /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
    const limited = slow(c, ctx.readLimiter);
    if (limited) return limited;
    const done = await readUpdateInsights(
      ctx.update,
      { workspaceId: ws(c), app, group: param(c, 'group'), days },
      actor(c),
    );
    return done.ok ? c.json({ insights: done.insights }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:appId/expo/updates/rollout/preview', needs('releases.rollout'), async (c) => {
    if (!ctx.update.rolloutEnabled) return respond(c, rolloutDisabledFailure());
    const body = await parseBody(c, rolloutPreviewBody);
    if (!body.ok) return body.response;
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const limited = slow(c, ctx.writeLimiter);
    if (limited) return limited;
    const done = await previewUpdateRollout(ctx.update, { workspaceId: ws(c), app, request: body.data }, actor(c));
    return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
  });

  // The only route that changes anything at Expo. One update per request: no bulk change.
  routes.post('/:workspaceId/apps/:appId/expo/updates/rollout/apply', needs('releases.rollout'), async (c) => {
    if (!ctx.update.rolloutEnabled) return respond(c, rolloutDisabledFailure());
    // Before the step-up check: a refused request must not spend the person's confirmation.
    const limited = slow(c, ctx.writeLimiter);
    if (limited) return limited;
    const refusal = await requireStepUp({ db, now: ctx.update.now }, c, 'rollout', {
      id: param(c, 'appId'),
      hashField: 'confirmHash',
    });
    if (refusal) return refusal;
    const body = await parseBody(c, rolloutApplyBody);
    if (!body.ok) return body.response;
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const { confirmHash, ...request } = body.data;
    const done = await applyUpdateRollout(ctx.update, { workspaceId: ws(c), app, request, confirmHash }, actor(c));
    return done.ok ? c.json({ result: done.result }) : respond(c, done);
  });

  return routes;
}

/** The mount of the module part (parts.ts). */
export const easUpdatePart: EasPart = (app, services, deps) => {
  app.route(
    '/api/workspaces',
    easUpdateRoutes({
      db: services.db,
      update: {
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        deps,
        rolloutEnabled: deps?.updateRollout?.enabled === true,
      },
      readLimiter: createTestLimiter({ limit: EAS_UPDATE_READS_PER_MINUTE, now: services.now }),
      writeLimiter: createTestLimiter({ limit: EAS_UPDATE_WRITES_PER_MINUTE, now: services.now }),
    }),
  );
};
