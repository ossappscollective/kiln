import {
  type Action,
  can,
  TESTFLIGHT_FILTER_MAX_CHARS,
  TESTFLIGHT_MAX_PAGE as MAX_PAGE,
} from '@kiln/core';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { Failure } from '../../services/repositories.ts';
import {
  crashGroups,
  decodeCursor,
  getTestflightItem,
  listTestflight,
  screenshotLinks,
  syncTestflight,
  triageItem,
} from './service.ts';
import { rateLimitedBody, type TestflightContext } from './shared.ts';
import {
  isTriageStatus,
  type ListFilter,
  MAX_NOTE_CHARS,
  TRIAGE_STATUSES,
  type TriageStatus,
} from './store.ts';

export { MAX_PAGE };

/**
 * TestFlight beta feedback and crash submissions of an app (docs/api/testflight-feedback.md). Reads and the sync are read-only toward Apple; the
 * triage (status, assignee, note) is Kiln's own data. Nothing here deletes or changes anything in App Store Connect. Mounted under /api/workspaces.
 */

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

export const DEFAULT_PAGE = 50;

const triageBody = z
  .object({
    status: z.enum(TRIAGE_STATUSES).optional(),
    assigneeUserId: z.string().min(1).max(100).nullable().optional(),
    internalNote: z.string().max(MAX_NOTE_CHARS).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    'Send at least one of status, assigneeUserId and internalNote.',
  );

type Issue = { path: string; message: string };

const list = (c: Context<AppEnv>, name: string): string[] =>
  (c.req.queries(name) ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');

/** The filter and paging of `GET /testflight`, or the issues to answer 400 with. */
export function parseListQuery(
  c: Context<AppEnv>,
): { ok: true; filter: ListFilter } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const kindRaw = c.req.query('kind') ?? 'feedback';
  if (kindRaw !== 'feedback' && kindRaw !== 'crash')
    issues.push({ path: 'kind', message: 'Use feedback or crash.' });
  const filter: ListFilter = {
    kind: kindRaw === 'crash' ? 'crash' : 'feedback',
    limit: DEFAULT_PAGE,
  };
  const build = c.req.query('build');
  if (build) {
    if (build.length <= TESTFLIGHT_FILTER_MAX_CHARS) filter.build = build;
    else issues.push({ path: 'build', message: `At most ${TESTFLIGHT_FILTER_MAX_CHARS} characters.` });
  }
  const version = c.req.query('version');
  if (version) {
    if (version.length <= TESTFLIGHT_FILTER_MAX_CHARS) filter.version = version;
    else issues.push({ path: 'version', message: `At most ${TESTFLIGHT_FILTER_MAX_CHARS} characters.` });
  }
  const statuses = list(c, 'status');
  if (statuses.length > 0) {
    if (statuses.every(isTriageStatus)) filter.statuses = [...new Set(statuses)] as TriageStatus[];
    else issues.push({ path: 'status', message: `Use ${TRIAGE_STATUSES.join(', ')}.` });
  }
  const tester = c.req.query('tester');
  if (tester) {
    if (/^[0-9A-Fa-f]{6}$/.test(tester)) filter.tester = tester.toUpperCase();
    else
      issues.push({
        path: 'tester',
        message: 'The six character code of a tester, as the list shows it.',
      });
  }
  const signature = c.req.query('signature');
  if (signature) {
    if (signature.length <= 200) filter.signature = signature;
    else issues.push({ path: 'signature', message: 'At most 200 characters.' });
  }
  const limit = queryInt(c.req.query('limit'), { fallback: DEFAULT_PAGE, max: MAX_PAGE });
  if (limit === undefined)
    issues.push({ path: 'limit', message: `A whole number from 1 to ${MAX_PAGE}.` });
  else filter.limit = limit;
  const cursor = c.req.query('cursor');
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) filter.before = decoded;
    else issues.push({ path: 'cursor', message: 'Not a cursor of this list.' });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, filter };
}

export function testflightRoutes(ctx: TestflightContext) {
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
  /** The tester's email is personal data of a third party: only who may change settings (administrators) is shown it. */
  const mayViewEmail = (c: Context<AppEnv>) => can(c.get('role'), 'settings.write');

  const base = '/:workspaceId/apps/:appId/testflight';

  routes.get(base, needs('reviews.read'), async (c) => {
    const query = parseListQuery(c);
    if (!query.ok) return c.json({ error: 'invalid_request', issues: query.issues }, 400);
    const done = await listTestflight(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      filter: query.filter,
      mayViewEmail: mayViewEmail(c),
    });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  routes.get(`${base}/crash-groups`, needs('reviews.read'), async (c) => {
    const done = await crashGroups(ctx, { workspaceId: ws(c), appId: param(c, 'appId') });
    return done.ok ? c.json(done.groups) : respond(c, done);
  });

  routes.post(`${base}/sync`, needs('reviews.sync'), async (c) => {
    const appId = param(c, 'appId');
    // An unknown id is a 404 and costs no slot; a known one is counted before any decrypting or network call.
    if (!(await getApp(db, ws(c), appId))) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(rateLimitedBody(wait), 429);
    }
    const done = await syncTestflight(ctx, { workspaceId: ws(c), appId, actor: actor(c) });
    return done.ok ? c.json({ sync: done.result }) : respond(c, done);
  });

  routes.get(`${base}/:id`, needs('reviews.read'), async (c) => {
    const done = await getTestflightItem(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      id: param(c, 'id'),
      mayViewEmail: mayViewEmail(c),
    });
    return done.ok ? c.json({ item: done.item }) : respond(c, done);
  });

  routes.get(`${base}/:id/screenshots`, needs('reviews.read'), async (c) => {
    const appId = param(c, 'appId');
    if (!(await getApp(db, ws(c), appId))) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(rateLimitedBody(wait), 429);
    }
    const done = await screenshotLinks(ctx, {
      workspaceId: ws(c),
      appId,
      id: param(c, 'id'),
      actor: actor(c),
    });
    if (!done.ok) return respond(c, done);
    // Short lived links: nothing to keep in a cache.
    c.header('Cache-Control', 'no-store');
    return c.json({ screenshots: done.screenshots });
  });

  routes.patch(`${base}/:id`, needs('reviews.triage'), async (c) => {
    // An unknown app is a 404 before the body is looked at.
    if (!(await getApp(db, ws(c), param(c, 'appId')))) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, triageBody);
    if (!body.ok) return body.response;
    const done = await triageItem(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      id: param(c, 'id'),
      actor: actor(c),
      changes: body.data,
      mayViewEmail: mayViewEmail(c),
    });
    return done.ok ? c.json({ item: done.item }) : respond(c, done);
  });

  return routes;
}
