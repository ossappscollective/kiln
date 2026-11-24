import { type Action, can } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import {
  countriesFor,
  dismissCard,
  insightsFor,
  listingChecksFor,
  restoreCards,
  visibleCount,
} from './service.ts';

/**
 * Insights of an app (docs/api/insights.md, docs/adr/0051-insights.md). Reads compute the cards from stored data and ask no store; the only
 * thing written is Kiln's own record of dismissed cards. Mounted under /api/workspaces.
 */

export type InsightsRoutesContext = { db: Sql; now: () => number };

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

const restoreBody = z.object({ cardId: z.string().min(1).max(200).optional() }).strict();

export function insightsRoutes(ctx: InsightsRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const base = '/:workspaceId/apps/:appId/insights';
  const open = async (c: Context<AppEnv>) => {
    const app = await getApp(db, ws(c), param(c, 'appId'));
    return app ? { app, role: c.get('role'), workspaceId: ws(c), now: ctx.now() } : null;
  };

  routes.get(base, needs('analytics.read'), async (c) => {
    const o = await open(c);
    if (!o) return c.json({ error: 'not_found' }, 404);
    return c.json(
      await insightsFor(db, { ...o, includeHidden: c.req.query('includeHidden') === '1' }),
    );
  });

  routes.get(`${base}/count`, needs('analytics.read'), async (c) => {
    const o = await open(c);
    if (!o) return c.json({ error: 'not_found' }, 404);
    return c.json({ count: await visibleCount(db, o) });
  });

  routes.get(`${base}/countries`, needs('analytics.read'), async (c) => {
    const o = await open(c);
    if (!o) return c.json({ error: 'not_found' }, 404);
    return c.json(await countriesFor(db, o));
  });

  routes.get(`${base}/listing-checks`, needs('listing.read'), async (c) => {
    const o = await open(c);
    if (!o) return c.json({ error: 'not_found' }, 404);
    return c.json(await listingChecksFor(db, o));
  });

  routes.post(`${base}/cards/:cardId/dismiss`, needs('aso.write'), async (c) => {
    const o = await open(c);
    if (!o) return c.json({ error: 'not_found' }, 404);
    const cardId = param(c, 'cardId');
    const userId = c.get('user').id;
    const done = await dismissCard(db, { ...o, cardId, userId });
    if (done === 'not_found') return c.json({ error: 'not_found' }, 404);
    await recordAudit(db, {
      workspaceId: o.workspaceId,
      actor: { type: 'user', id: userId },
      action: 'insights.dismissed',
      target: { type: 'app', id: o.app.id },
      detail: { appId: o.app.id, cardId },
      at: o.now,
    });
    return c.json({ ok: true });
  });

  routes.post(`${base}/restore`, needs('aso.write'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, restoreBody);
    if (!body.ok) return body.response;
    const restored = await restoreCards(db, {
      workspaceId: ws(c),
      appId: app.id,
      ...(body.data.cardId ? { cardId: body.data.cardId } : {}),
    });
    if (restored > 0) {
      await recordAudit(db, {
        workspaceId: ws(c),
        actor: { type: 'user', id: c.get('user').id },
        action: 'insights.restored',
        target: { type: 'app', id: app.id },
        detail: { appId: app.id, count: restored },
        at: ctx.now(),
      });
    }
    return c.json({ restored });
  });

  return routes;
}
