import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { Failure, RepoContext } from '../../services/repositories.ts';
import { readAppEasConfig } from './config.ts';
import type { EasPart } from './parts.ts';

/** Reads of an app's `eas.json` per workspace per minute. Their own budget; most repeats hit the cached snapshot of the commit. */
export const EAS_CONFIG_READS_PER_MINUTE = 30;

export type EasConfigRoutesContext = {
  db: Database;
  /** The repository context of the other repository reads (clones, connector factory, timeout). */
  repo: RepoContext;
  limiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/**
 * `GET /apps/:appId/eas-config`: what `eas.json` of the app's repository says (docs/api/eas-config.md). It reads the repository,
 * like the other reads of it (the scan, the listing, the builds), so it needs `repositories.scan` (member and above); not being a
 * member and an unknown app look the same (404).
 */
export function easConfigRoutes(ctx: EasConfigRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  routes.get('/:workspaceId/apps/:appId/eas-config', needs('repositories.scan'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      return respond(c, {
        ok: false,
        status: 429,
        body: {
          error: 'rate_limited',
          message: `Too many repository reads. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        headers: { 'Retry-After': String(wait) },
      });
    }
    const done = await readAppEasConfig(ctx.repo, { workspaceId: ws(c), app }, actor(c));
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  return routes;
}

/** The mount of the module part (parts.ts). */
export const easConfigPart: EasPart = (app, services, _deps, shared) => {
  app.route(
    '/api/workspaces',
    easConfigRoutes({
      db: services.db,
      repo: shared.repo,
      limiter: createTestLimiter({ limit: EAS_CONFIG_READS_PER_MINUTE, now: services.now }),
    }),
  );
};
