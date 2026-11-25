import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, type Services } from '../../http.ts';
import { coded } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { Failure } from '../../services/repositories.ts';
import type { ModuleShared } from '../module.ts';
import type { EasDeps } from './index.ts';
import { detectExpoProject, getExpoLink, removeExpoLink, setExpoLink } from './link.ts';
/** The body of `PUT .../apps/{appId}/expo`: the Expo credential and the project (a UUID or `@account/slug`). */
export const setLinkBody = z.strictObject({
  credentialId: z.string().min(1).max(100),
  project: z.string().trim().min(1).max(200),
});

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/** Settings of one app: which Expo project it belongs to. Reading needs `apps.read`; changing it needs `apps.write` (owners and admins). */
export function easLinkRoutes(
  services: Services,
  deps: EasDeps | undefined,
  shared: ModuleShared,
  limiter: TestLimiter = createTestLimiter({ limit: 20, now: services.now }),
) {
  const { db, masterKey, now } = services;
  const app = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const appOf = (c: Context<AppEnv>) => getApp(db, ws(c), param(c, 'appId'));

  app.get('/:workspaceId/apps/:appId/expo', needs('apps.read'), async (c) => {
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    return c.json({ link: await getExpoLink(db, ws(c), param(c, 'appId')) });
  });

  // Registered before nothing that could read `detect` as an id: the path has a fixed word.
  app.get('/:workspaceId/apps/:appId/expo/detect', needs('apps.write'), async (c) => {
    const found = await appOf(c);
    if (!found) return c.json({ error: 'not_found' }, 404);
    const done = await detectExpoProject(shared.repo, { workspaceId: ws(c), app: found }, actor(c));
    return done.ok ? c.json({ detection: done.detection }) : respond(c, done);
  });

  app.put('/:workspaceId/apps/:appId/expo', needs('apps.write'), async (c) => {
    const body = await parseBody(c, setLinkBody);
    if (!body.ok) return body.response;
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const wait = limiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message: `Too many Expo checks. Try again in ${wait} seconds.`,
          ...coded('rate.expo', { count: wait }),
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const done = await setExpoLink(
      { db, masterKey, now, deps },
      { workspaceId: ws(c), appId: param(c, 'appId'), ...body.data },
      actor(c),
    );
    return done.ok ? c.json({ link: done.link }) : respond(c, done);
  });

  app.delete('/:workspaceId/apps/:appId/expo', needs('apps.write'), async (c) => {
    if (!(await appOf(c))) return c.json({ error: 'not_found' }, 404);
    const removed = await removeExpoLink(
      { db, now },
      { workspaceId: ws(c), appId: param(c, 'appId') },
      actor(c),
    );
    return removed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
