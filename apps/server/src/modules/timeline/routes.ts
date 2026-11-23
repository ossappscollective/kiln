import { type Action, can, isReportKind, type ReportKind } from '@kiln/core';
import type { Database } from '@kiln/db';
import { type Context, Hono, type Next } from 'hono';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { Failure } from '../../services/repositories.ts';
import { createEventBody, updateEventBody } from './events.ts';
import { buildReport, buildTimeline, createEvent, graphicsImpact, IMPACT_DAYS, removeEvent, updateEvent } from './service.ts';

/**
 * Timeline and reports of an app (docs/api/timeline.md, docs/api/reports.md, docs/adr/0053-timeline-and-reports.md). Everything is read from
 * what is stored; nothing here contacts a store. Reading needs `analytics.read` (every role); a person's own events need `aso.write`.
 * Mounted under /api/workspaces.
 */
const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => c.json(f.body, f.status);

export function timelineRoutes(ctx: { db: Database; now: () => number }) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const base = '/:workspaceId/apps/:appId';

  routes.get(`${base}/timeline`, needs('analytics.read'), async (c) => {
    const days = c.req.query('days');
    if (days !== undefined && days !== '' && (IMPACT_DAYS as readonly number[]).indexOf(Number(days)) === -1)
      return c.json({ error: 'invalid_request', issues: [{ path: 'days', message: 'Use 7, 14 or 28.' }] }, 400);
    const done = await buildTimeline(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      query: { metric: c.req.query('metric') || undefined, from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, days: days ? Number(days) : undefined },
    });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  routes.get(`${base}/timeline/graphics-impact`, needs('analytics.read'), async (c) => {
    const done = await graphicsImpact(ctx, { workspaceId: ws(c), appId: param(c, 'appId') });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  routes.post(`${base}/timeline/events`, needs('aso.write'), async (c) => {
    const body = await parseBody(c, createEventBody);
    if (!body.ok) return body.response;
    const done = await createEvent(ctx, { workspaceId: ws(c), appId: param(c, 'appId'), actor: actor(c), event: body.data });
    return done.ok ? c.json({ event: done.event }, 201) : respond(c, done);
  });

  routes.patch(`${base}/timeline/events/:eventId`, needs('aso.write'), async (c) => {
    const body = await parseBody(c, updateEventBody);
    if (!body.ok) return body.response;
    const done = await updateEvent(ctx, { workspaceId: ws(c), appId: param(c, 'appId'), eventId: param(c, 'eventId'), actor: actor(c), changes: body.data });
    return done.ok ? c.json({ event: done.event }) : respond(c, done);
  });

  routes.delete(`${base}/timeline/events/:eventId`, needs('aso.write'), async (c) => {
    const done = await removeEvent(ctx, { workspaceId: ws(c), appId: param(c, 'appId'), eventId: param(c, 'eventId'), actor: actor(c) });
    return done.ok ? c.json({ ok: true }) : respond(c, done);
  });

  routes.get(`${base}/reports`, needs('analytics.read'), async (c) => {
    const kind = c.req.query('kind') ?? 'week';
    if (!isReportKind(kind)) return c.json({ error: 'invalid_request', issues: [{ path: 'kind', message: 'Use week, month or year.' }] }, 400);
    const day = c.req.query('day') || undefined;
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: 'invalid_request', issues: [{ path: 'day', message: 'Use a date written YYYY-MM-DD.' }] }, 400);
    const done = await buildReport(ctx, { workspaceId: ws(c), appId: param(c, 'appId'), query: { kind: kind as ReportKind, day } });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  return routes;
}
