import { type Action, can, supports } from '@kiln/core';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { listExpoLinks } from '../eas/link.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import type { Failure } from '../../services/repositories.ts';
import {
  detectRevenueCat,
  getRevenueCatLink,
  type LinkContext,
  planRevenueCat,
  removeRevenueCatLink,
  setRevenueCatLink,
} from './link.ts';
import { getRevenueCatMetrics } from './metrics.ts';
import { readRevenueCatSyncStatus } from './snapshot.ts';
import { notLinkedFailure, syncRevenueCat } from './sync.ts';
import { getRevenueCatProductsView } from './view.ts';

import { coded } from '../../i18n/problem.ts';
/** The body of `PUT .../apps/{appId}/revenuecat`: the RevenueCat credential, the project and the RevenueCat app. */
export const setLinkBody = z.strictObject({
  credentialId: z.string().min(1).max(100),
  projectId: z.string().trim().min(1).max(255),
  revenueCatAppId: z.string().trim().min(1).max(255),
});

/** The query of `GET .../revenuecat/plan`: the RevenueCat credential to read with. */
export const planQuery = z.strictObject({ credentialId: z.string().min(1).max(100) });

/** The query of `GET .../apps/{appId}/revenuecat/detect`. */
export const detectQuery = z.strictObject({
  credentialId: z.string().min(1).max(100),
  projectId: z.string().trim().min(1).max(255).optional(),
});

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const tooMany = (wait: number, what: string): Failure => ({
  ok: false,
  status: 429,
  body: {
    error: 'rate_limited',
    message: `Too many ${what}. Try again in ${wait} seconds.`,
    ...coded('rate.requests', { count: wait }),
    retryAfterSeconds: wait,
  },
  headers: { 'Retry-After': String(wait) },
});

/**
 * Settings of one app: which RevenueCat project and app it belongs to, and the read of the project configuration
 * (docs/api/revenuecat.md). Reading needs `apps.read`; linking, unlinking and detecting need `apps.write` (owners and admins); the sync
 * needs `apps.sync`. Nothing here changes anything in RevenueCat.
 */
export function revenueCatRoutes(
  ctx: LinkContext & { syncLimiter: TestLimiter; linkLimiter: TestLimiter },
) {
  const { db } = ctx;
  const app = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const appOf = (c: Context<AppEnv>) => getApp(db, ws(c), param(c, 'appId'));

  app.get('/:workspaceId/apps/:appId/revenuecat', needs('apps.read'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({
      supported: supports(found.platform, 'revenueCat'),
      link: await getRevenueCatLink(db, ws(c), found.id),
      sync: await readRevenueCatSyncStatus(db, ws(c), found.id),
    });
  });

  // Fixed words after the app id: never read as an id.
  app.get('/:workspaceId/apps/:appId/revenuecat/products', needs('apps.read'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({
      supported: supports(found.platform, 'revenueCat'),
      ...(await getRevenueCatProductsView(db, ws(c), found.id)),
    });
  });

  // The stored metrics overview (docs/adr/0043-revenuecat-metrics.md): reads the database, never RevenueCat. `apps.read`: viewers see it.
  app.get('/:workspaceId/apps/:appId/revenuecat/metrics', needs('apps.read'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({
      supported: supports(found.platform, 'revenueCat'),
      linked: (await getRevenueCatLink(db, ws(c), found.id)) !== null,
      ...(await getRevenueCatMetrics(db, ws(c), found.id)),
    });
  });

  app.get('/:workspaceId/apps/:appId/revenuecat/detect', needs('apps.write'), async (c) => {
    const query = detectQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        {
          error: 'invalid_request',
          issues: query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.linkLimiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait, 'RevenueCat checks'));
    const done = await detectRevenueCat(
      ctx,
      { workspaceId: ws(c), app: found, ...query.data },
      actor(c),
    );
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ options: done.options }) : respond(c, done);
  });

  // Workspace level: which app records have a RevenueCat or an Expo link. Database only; lets the web app show "Connect your apps" with one
  // read instead of one per record.
  app.get('/:workspaceId/integration-links', needs('apps.read'), async (c) => {
    const rc = await db.query(
      'SELECT app_id FROM app_revenuecat_links WHERE workspace_id = ? ORDER BY app_id',
      [ws(c)],
    );
    const expo = await listExpoLinks(db, ws(c));
    return c.json({
      revenuecat: rc.map((r) => String(r.app_id)),
      expo: expo.map((l) => l.appId),
    });
  });

  // Workspace level: one proposal per app record from one read of RevenueCat (the "Connect your apps" flow). Saves nothing.
  app.get('/:workspaceId/revenuecat/plan', needs('apps.write'), async (c) => {
    const query = planQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        {
          error: 'invalid_request',
          issues: query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const wait = ctx.linkLimiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait, 'RevenueCat checks'));
    const done = await planRevenueCat(ctx, { workspaceId: ws(c), ...query.data }, actor(c));
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ plan: done.plan }) : respond(c, done);
  });

  app.put('/:workspaceId/apps/:appId/revenuecat', needs('apps.write'), async (c) => {
    const body = await parseBody(c, setLinkBody);
    if (!body.ok) return body.response;
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.linkLimiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait, 'RevenueCat checks'));
    const done = await setRevenueCatLink(
      ctx,
      { workspaceId: ws(c), appId: param(c, 'appId'), ...body.data },
      actor(c),
    );
    return done.ok ? c.json({ link: done.link }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:appId/revenuecat', needs('apps.write'), async (c) => {
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const removed = await removeRevenueCatLink(
      ctx,
      { workspaceId: ws(c), appId: param(c, 'appId') },
      actor(c),
    );
    return removed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  // The same read as the second step of `POST .../products/sync`, alone, so a person can retry only this half.
  app.post('/:workspaceId/apps/:appId/revenuecat/sync', needs('apps.sync'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    if (!(await getRevenueCatLink(db, ws(c), found.id))) return respond(c, notLinkedFailure());
    const wait = ctx.syncLimiter.take(ws(c));
    if (wait > 0) return respond(c, tooMany(wait, 'syncs'));
    const done = await syncRevenueCat(ctx, {
      workspaceId: ws(c),
      appId: found.id,
      actor: actor(c),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ sync: done.result }) : respond(c, done);
  });

  return app;
}
