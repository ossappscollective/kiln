import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv, Services } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import type { Failure } from '../../services/repositories.ts';
import type { ModuleShared } from '../module.ts';
import type { EasDeps } from './index.ts';
import { getEasStatus, refreshEasStatus } from './status.ts';

import { coded } from '../../i18n/problem.ts';
const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/**
 * EAS Build and Submit status of one app record (docs/adr/0036-eas-build-submit-status.md): the stored snapshot (database only) and a manual read
 * from Expo. Reading needs `builds.read`, like the other builds of an app; a manual read needs `apps.sync` and shares the budget of the app syncs.
 */
export function easStatusRoutes(
  services: Services,
  deps: EasDeps | undefined,
  shared: ModuleShared,
  limiter: TestLimiter = shared.appSyncLimiter,
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

  // The address of a build file is returned only with the download switch on and the right to download (ADR 0061).
  const artifactUrls = (c: Context<AppEnv>) =>
    deps?.buildsDownloadEnabled === true && can(c.get('role'), 'builds.download');

  app.get('/:workspaceId/apps/:appId/eas/status', needs('builds.read'), async (c) => {
    const found = await getApp(db, ws(c), param(c, 'appId'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({ status: await getEasStatus(db, ws(c), found, artifactUrls(c)) });
  });

  app.post('/:workspaceId/apps/:appId/eas/status/refresh', needs('apps.sync'), async (c) => {
    if (!(await getApp(db, ws(c), param(c, 'appId')))) return c.json({ error: 'not_found' }, 404);
    const wait = limiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message: `Too many reads. Try again in ${wait} seconds.`,
          ...coded('rate.reads', { count: wait }),
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const done = await refreshEasStatus(
      { db, masterKey, now, deps },
      { workspaceId: ws(c), appId: param(c, 'appId') },
      actor(c),
      { trigger: 'manual', artifactUrls: artifactUrls(c) },
    );
    return done.ok ? c.json({ status: done.status }) : respond(c, done);
  });

  return app;
}
