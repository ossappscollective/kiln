import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppEnv, parseBody, type Services } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { createToken, createTokenBody, listTokens, revokeToken } from '../services/tokens.ts';

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

/** The body is a name, a role and two short lists. */
const TOKEN_BODY_LIMIT = 16 * 1024;

/**
 * API token management, mounted under /api/workspaces. Owners and admins only, and only with a
 * session: an API token can never manage tokens (it is not in the operation registry's token set).
 */
export function tokenRoutes(services: Services) {
  const { db, now } = services;
  const app = new Hono<AppEnv>();

  // Not a member and no such workspace look the same (404). A member without the right gets 403.
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  app.get('/:workspaceId/tokens', needs('tokens.read'), async (c) =>
    c.json({ tokens: await listTokens(db, ws(c), now()) }),
  );

  app.post(
    '/:workspaceId/tokens',
    needs('tokens.manage'),
    bodyLimit({
      maxSize: TOKEN_BODY_LIMIT,
      onError: (c) =>
        c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
    }),
    async (c) => {
      const body = await parseBody(c, createTokenBody);
      if (!body.ok) return body.response;
      const done = await createToken(
        db,
        { workspaceId: ws(c), ...body.data },
        { id: c.get('user').id, role: c.get('role') },
        now(),
      );
      if (!done.ok) return c.json({ error: done.error, message: done.message }, done.status);
      // The token is in this response and nowhere else, ever.
      c.header('Cache-Control', 'no-store');
      return c.json({ token: done.token, summary: done.summary }, 201);
    },
  );

  app.delete('/:workspaceId/tokens/:id', needs('tokens.manage'), async (c) => {
    const done = await revokeToken(
      db,
      { workspaceId: ws(c), id: param(c, 'id') },
      { type: 'user', id: c.get('user').id },
      now(),
    );
    return done ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
