import { type Action, can, checkSecret, credentialKinds } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Services, parseBody, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { requireStepUp } from '../services/step-up.ts';
import { MAX_AUDIT_LIMIT, listAudit } from '../services/audit.ts';
import {
  createCredential,
  deleteCredential,
  listCredentials,
  rotateCredential,
} from '../services/credentials.ts';

const createBody = z.object({
  kind: z.enum(credentialKinds),
  label: z.string().trim().min(1).max(100),
  secret: z.string().min(1).max(64 * 1024),
});
const rotateBody = z.object({ secret: z.string().min(1).max(64 * 1024) });

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

export function workspaceRoutes(services: Services) {
  const { db, masterKey, now } = services;
  const app = new Hono<AppEnv>();

  /**
   * Not a member and no such workspace look the same (404), so ids cannot be probed.
   * A member without the right gets 403.
   */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

  app.get('/:workspaceId/credentials', needs('credentials.read'), async (c) =>
    c.json({ credentials: await listCredentials(db, ws(c)) }),
  );

  app.post('/:workspaceId/credentials', needs('credentials.write'), async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    const problem = checkSecret(body.data.kind, body.data.secret);
    if (problem) return c.json({ error: 'invalid_secret', message: problem }, 400);
    const credential = await createCredential(
      db,
      masterKey,
      { workspaceId: ws(c), ...body.data },
      actor(c),
      now(),
    );
    return c.json({ credential }, 201);
  });

  app.put('/:workspaceId/credentials/:id', needs('credentials.write'), async (c) => {
    const body = await parseBody(c, rotateBody);
    if (!body.ok) return body.response;
    const done = await rotateCredential(
      db,
      masterKey,
      { workspaceId: ws(c), id: param(c, 'id'), secret: body.data.secret },
      actor(c),
      now(),
    );
    if (done.ok) return c.body(null, 204);
    if (done.reason === 'invalid_secret') return c.json({ error: 'invalid_secret', message: done.message }, 400);
    return c.json({ error: 'not_found' }, 404);
  });

  app.delete('/:workspaceId/credentials/:id', needs('credentials.write'), async (c) => {
    const stepUpRefusal = await requireStepUp({ db, now }, c, 'credential.delete', { id: param(c, 'id') });
    if (stepUpRefusal) return stepUpRefusal;
    const done = await deleteCredential(
      db,
      { workspaceId: ws(c), id: param(c, 'id') },
      actor(c),
      now(),
    );
    return done ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/:workspaceId/audit', needs('audit.read'), async (c) => {
    const limit = queryInt(c.req.query('limit'), { fallback: 100, max: MAX_AUDIT_LIMIT });
    if (limit === undefined) {
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'limit', message: `Use a whole number from 1 to ${MAX_AUDIT_LIMIT}.` }],
        },
        400,
      );
    }
    return c.json({ events: await listAudit(db, ws(c), limit) });
  });

  return app;
}
