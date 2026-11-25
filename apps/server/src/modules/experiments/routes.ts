import { type Action, can } from '@kiln/core';
import { type Context, Hono, type Next } from 'hono';
import { type AppEnv, parseBody } from '../../http.ts';
import { coded } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { Failure } from '../../services/repositories.ts';
import { createNoteBody, updateNoteBody } from './notes.ts';
import { createNote, listExperiments, removeNote, syncExperiments, updateNote } from './service.ts';
import type { ExperimentsContext } from './shared.ts';

/**
 * Store experiments and custom product pages of an app (docs/api/experiments.md). Reads and the sync are read-only toward the store; the manual
 * tracker (notes) is Kiln's own data. Nothing here starts, stops, creates or changes anything in a store. Mounted under /api/workspaces.
 */

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

export function experimentsRoutes(ctx: ExperimentsContext) {
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

  const base = '/:workspaceId/apps/:appId/experiments';

  routes.get(base, needs('aso.read'), async (c) => {
    const done = await listExperiments(ctx, { workspaceId: ws(c), appId: param(c, 'appId') });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  routes.post(`${base}/sync`, needs('apps.sync'), async (c) => {
    const appId = param(c, 'appId');
    // An unknown id is a 404 and costs no slot; a known one is counted before any decrypting or network call.
    if (!(await getApp(db, ws(c), appId))) return c.json({ error: 'not_found' }, 404);
    const wait = ctx.limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many syncs. Try again in ${wait} seconds.`,
          ...coded('sync.tooManySyncs', { count: wait }),
          retryAfterSeconds: wait,
        },
        429,
      );
    }
    const done = await syncExperiments(ctx, { workspaceId: ws(c), appId, actor: actor(c) });
    return done.ok ? c.json({ sync: done.result }) : respond(c, done);
  });

  routes.post(`${base}/notes`, needs('aso.write'), async (c) => {
    // An unknown app is a 404 before the body is looked at.
    if (!(await getApp(db, ws(c), param(c, 'appId')))) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, createNoteBody);
    if (!body.ok) return body.response;
    const done = await createNote(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      actor: actor(c),
      note: body.data,
    });
    return done.ok ? c.json({ note: done.note }, 201) : respond(c, done);
  });

  routes.patch(`${base}/notes/:noteId`, needs('aso.write'), async (c) => {
    // An unknown app is a 404 before the body is looked at.
    if (!(await getApp(db, ws(c), param(c, 'appId')))) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, updateNoteBody);
    if (!body.ok) return body.response;
    const done = await updateNote(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      noteId: param(c, 'noteId'),
      actor: actor(c),
      changes: body.data,
    });
    return done.ok ? c.json({ note: done.note }) : respond(c, done);
  });

  routes.delete(`${base}/notes/:noteId`, needs('aso.write'), async (c) => {
    const done = await removeNote(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      noteId: param(c, 'noteId'),
      actor: actor(c),
    });
    return done.ok ? c.json({ ok: true }) : respond(c, done);
  });

  return routes;
}
