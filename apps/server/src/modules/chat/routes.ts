import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { coded, codingOf } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import {
  type ChatContext,
  type ChatFailure,
  createDestination,
  createDestinationBody,
  deleteDestination,
  getDestination,
  listDeliveries,
  listDestinations,
  MAX_DELIVERIES_LIMIT,
  replaceRoutes,
  routesBody,
  sendTestMessage,
  updateDestination,
  updateDestinationBody,
} from './destinations.ts';

export type ChatRoutesContext = ChatContext & {
  /** Test messages per workspace per minute (default 10). */
  limiter?: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

/** Routing rules and addresses are small. */
const CHAT_BODY_LIMIT = 32 * 1024;

/**
 * Chat destinations (Slack, Teams), their routing rules and delivery log, mounted under /api/workspaces (docs/api/chat-integrations.md).
 * Owners and admins, with a session. No answer ever carries the webhook URL: only its last four characters.
 */
export function chatRoutes(ctx: ChatRoutesContext) {
  const { db } = ctx;
  const limiter = ctx.limiter ?? createTestLimiter({ now: ctx.now });
  const app = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const small = bodyLimit({
    maxSize: CHAT_BODY_LIMIT,
    onError: (c) =>
      c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
  });
  const fail = (c: Context<AppEnv>, f: ChatFailure) =>
    c.json({ error: f.error, message: f.message, ...codingOf(f) }, f.status);
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);

  app.get('/:workspaceId/chat/destinations', needs('chat.read'), async (c) =>
    c.json({ destinations: await listDestinations(db, ws(c)) }),
  );

  app.post('/:workspaceId/chat/destinations', needs('chat.manage'), small, async (c) => {
    const body = await parseBody(c, createDestinationBody);
    if (!body.ok) return body.response;
    const done = await createDestination(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    return done.ok ? c.json({ destination: done.destination }, 201) : fail(c, done);
  });

  app.get('/:workspaceId/chat/destinations/:id', needs('chat.read'), async (c) => {
    const found = await getDestination(db, ws(c), param(c, 'id'));
    return found ? c.json({ destination: found }) : notFound(c);
  });

  app.patch('/:workspaceId/chat/destinations/:id', needs('chat.manage'), small, async (c) => {
    const body = await parseBody(c, updateDestinationBody);
    if (!body.ok) return body.response;
    const done = await updateDestination(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), ...body.data },
      actor(c),
    );
    return done.ok ? c.json({ destination: done.destination }) : fail(c, done);
  });

  app.put('/:workspaceId/chat/destinations/:id/routes', needs('chat.manage'), small, async (c) => {
    const body = await parseBody(c, routesBody);
    if (!body.ok) return body.response;
    const done = await replaceRoutes(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), routes: body.data.routes },
      actor(c),
    );
    return done.ok ? c.json({ destination: done.destination }) : fail(c, done);
  });

  app.delete('/:workspaceId/chat/destinations/:id', needs('chat.manage'), async (c) => {
    const done = await deleteDestination(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done ? c.body(null, 204) : notFound(c);
  });

  app.post('/:workspaceId/chat/destinations/:id/test', needs('chat.manage'), async (c) => {
    // An unknown id is a 404 and costs no slot.
    if (!(await getDestination(db, ws(c), param(c, 'id')))) return notFound(c);
    const wait = limiter.take(ws(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        {
          error: 'rate_limited',
          message: `Too many tests. Try again in ${wait} seconds.`,
          ...coded('rate.tests', { count: wait }),
          retryAfterSeconds: wait,
        },
        429,
      );
    }
    const done = await sendTestMessage(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done.ok ? c.json({ deliveryId: done.deliveryId }, 202) : fail(c, done);
  });

  app.get('/:workspaceId/chat/destinations/:id/deliveries', needs('chat.read'), async (c) => {
    const limit = queryInt(c.req.query('limit'), { fallback: 20, max: MAX_DELIVERIES_LIMIT });
    if (limit === undefined) {
      return c.json(
        {
          error: 'invalid_request',
          issues: [
            { path: 'limit', message: `Use a whole number from 1 to ${MAX_DELIVERIES_LIMIT}.` },
          ],
        },
        400,
      );
    }
    if (!(await getDestination(db, ws(c), param(c, 'id')))) return notFound(c);
    return c.json({ deliveries: await listDeliveries(db, ws(c), param(c, 'id'), limit) });
  });

  return app;
}
