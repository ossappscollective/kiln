import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { appPipeline, pipelineSummary } from './release-pipeline.ts';

export type ReleasePipelineRoutesContext = { db: Database; now: () => number };

/**
 * Where the release of an app is between a CI run and live, and whether it is stalled (docs/api/release-pipeline.md).
 * Read-only and from stored data only: no store and no GitHub call. Mounted under /api/workspaces.
 */
export function releasePipelineRoutes(ctx: ReleasePipelineRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
  const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.get('/:workspaceId/apps/:id/release/pipeline', needs('apps.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const found = await appPipeline(db, { workspaceId: ws(c), appId: app.id, now: ctx.now() });
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({
      app: found.app,
      pipeline: found.pipeline,
      lastSyncedAt: found.lastSyncedAt,
      generatedAt: ctx.now(),
    });
  });

  routes.get('/:workspaceId/release/pipeline/summary', needs('apps.read'), async (c) => {
    const tokenApps = c.get('token')?.appIds ?? undefined;
    const summary = await pipelineSummary(db, {
      workspaceId: ws(c),
      ...(tokenApps ? { appIds: tokenApps as string[] } : {}),
      now: ctx.now(),
    });
    return c.json(summary);
  });

  return routes;
}
