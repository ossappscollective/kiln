import { type Action, can } from '@mrm/core';
import type { Database } from '@mrm/db';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { type AppEnv, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { getApp } from '../services/apps.ts';
import { isListingField } from '../services/listing-drift.ts';
import {
  getDrift,
  getHistory,
  getLiveListing,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  parseHistoryCursor,
} from '../services/listing-live.ts';
import { recordAppliedChangeSets, refreshRepoListing } from '../services/listing-repo.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import type { Failure, RepoContext } from '../services/repositories.ts';

export type ListingRoutesContext = {
  db: Database;
  now: () => number;
  /** Used only to read the repository side of an app's listing (GitHub, read-only). */
  repo: RepoContext;
  /** Repository reads per workspace per minute. Its own budget, like the sync's. */
  limiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const LOCALE = /^[A-Za-z0-9_-]{1,35}$/;

/**
 * Live listing, drift and history of an app's store listing. Everything here reads the tool's own
 * database, except `repo-refresh`, which reads the repository on GitHub. No route writes to a store,
 * and none changes the store listing in any way. Mounted under /api/workspaces.
 */
export function listingRoutes(ctx: ListingRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  routes.get('/:workspaceId/apps/:id/listing/live', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    return c.json(await getLiveListing(db, ws(c), app));
  });

  routes.get('/:workspaceId/apps/:id/listing/drift', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    // Derived data: change sets applied since the last look. A failure here must not hide the rest.
    await recordAppliedChangeSets(db, ws(c), app, ctx.now()).catch(() => 0);
    return c.json(await getDrift(db, ws(c), app));
  });

  routes.get('/:workspaceId/apps/:id/listing/history', needs('listing.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    const issues: { path: string; message: string }[] = [];
    const locale = c.req.query('locale');
    const field = c.req.query('field');
    if (locale !== undefined && !LOCALE.test(locale)) {
      issues.push({ path: 'locale', message: 'A locale such as en-US.' });
    }
    if (field !== undefined && !isListingField(app.platform, field)) {
      issues.push({ path: 'field', message: `Not a listing field of an ${app.platform} app.` });
    }
    const limit = queryInt(c.req.query('limit'), {
      fallback: HISTORY_DEFAULT_LIMIT,
      max: HISTORY_MAX_LIMIT,
    });
    if (limit === undefined) {
      issues.push({ path: 'limit', message: `A whole number from 1 to ${HISTORY_MAX_LIMIT}.` });
    }
    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor === undefined || rawCursor === '' ? undefined : parseHistoryCursor(rawCursor);
    if (rawCursor !== undefined && rawCursor !== '' && cursor === undefined) {
      issues.push({ path: 'cursor', message: 'Use the nextCursor of the previous page.' });
    }
    if (issues.length > 0 || limit === undefined) return c.json({ error: 'invalid_request', issues }, 400);
    await recordAppliedChangeSets(db, ws(c), app, ctx.now()).catch(() => 0);
    return c.json(await getHistory(db, ws(c), app, { locale, field, limit, cursor }));
  });

  // Reads the linked repository on GitHub and records its listing. Needs the right to read
  // repository listings from GitHub (member and up), and shares the rate limit of store reads.
  routes.post('/:workspaceId/apps/:id/listing/repo-refresh', needs('repositories.scan'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return notFound(c);
    if (!app.repositoryId) {
      return c.json(
        { error: 'no_repository', message: 'This app is not linked to a repository. Link one to compare it.' },
        422,
      );
    }
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many repository reads. Try again in ${wait} seconds.`,
          retryAfterSeconds: wait,
        },
        429,
      );
    }
    const done = await refreshRepoListing(ctx.repo, { workspaceId: ws(c), app }, actor(c));
    if (!done.ok) return respond(c, done);
    const { ok: _ok, ...result } = done;
    return c.json(result);
  });

  return routes;
}
