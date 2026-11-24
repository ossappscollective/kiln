import { type Action, can } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { type Context, Hono, type Next } from 'hono';
import type { AppEnv } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { Granularity } from './days.ts';
import { healthView, ratingsView } from './service.ts';

/** The ratings history and app health of an app (docs/api/ratings.md, docs/api/health.md): reads of stored data, nothing is asked of a store. */
export type RatingsRoutesContext = { db: Sql; now: () => number };

const int = (raw: string | undefined): number | undefined | 'bad' => {
  if (raw === undefined || raw === '') return undefined;
  return /^[0-9]{1,4}$/.test(raw) && Number(raw) >= 7 && Number(raw) <= 730 ? Number(raw) : 'bad';
};

export function ratingsRoutes(ctx: RatingsRoutesContext) {
  const routes = new Hono<AppEnv>();
  const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(ctx.db, param(c, 'workspaceId'), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const base = '/:workspaceId/apps/:appId';

  routes.get(`${base}/ratings`, needs('reviews.read'), async (c) => {
    const days = int(c.req.query('days'));
    const granularity = c.req.query('granularity');
    const country = c.req.query('country');
    const issues: { path: string; message: string }[] = [];
    if (days === 'bad') issues.push({ path: 'days', message: 'A whole number from 7 to 730.' });
    if (granularity !== undefined && !['day', 'week', 'month'].includes(granularity))
      issues.push({ path: 'granularity', message: 'Use day, week or month.' });
    if (country !== undefined && !/^(all|ALL|[A-Za-z]{2})$/.test(country))
      issues.push({ path: 'country', message: 'Use all or a two letter country code.' });
    if (issues.length > 0) return c.json({ error: 'invalid_request', issues }, 400);
    const app = await getApp(ctx.db, param(c, 'workspaceId'), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const view = await ratingsView(
      ctx,
      { ...app, workspaceId: param(c, 'workspaceId') },
      {
        ...(country
          ? { country: country.toUpperCase() === 'ALL' ? 'all' : country.toUpperCase() }
          : {}),
        ...(granularity ? { granularity: granularity as Granularity } : {}),
        ...(typeof days === 'number' ? { days } : {}),
      },
    );
    return c.json(view);
  });

  routes.get(`${base}/health`, needs('reviews.read'), async (c) => {
    const days = int(c.req.query('days'));
    if (days === 'bad')
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'days', message: 'A whole number from 7 to 730.' }],
        },
        400,
      );
    const app = await getApp(ctx.db, param(c, 'workspaceId'), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    return c.json(
      await healthView(
        ctx,
        { ...app, workspaceId: param(c, 'workspaceId') },
        typeof days === 'number' ? { days } : {},
      ),
    );
  });

  return routes;
}
