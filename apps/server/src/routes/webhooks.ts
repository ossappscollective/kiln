import { type Action, can } from '@kiln/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AppEnv, parseBody, queryInt } from '../http.ts';
import { coded, codingOf } from '../i18n/problem.ts';
import { memberRole } from '../services/accounts.ts';
import { createTestLimiter, type TestLimiter } from '../services/credential-tests.ts';
import {
  createWebhook,
  createWebhookBody,
  deleteWebhook,
  deliveryExists,
  getWebhook,
  listDeliveries,
  listWebhooks,
  MAX_DELIVERIES_LIMIT,
  redeliver,
  rotateWebhookSecret,
  sendTestEvent,
  updateWebhook,
  updateWebhookBody,
  type WebhookContext,
} from '../services/webhooks.ts';
export type WebhookRoutesContext = WebhookContext & {
  /** Tests and redeliveries per workspace per minute (default 10). */
  limiter?: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

/** A URL, a description and a short list of types. */
const WEBHOOK_BODY_LIMIT = 16 * 1024;

/** Webhook endpoints and their delivery log, mounted under /api/workspaces. Owners and admins, with a session. */
export function webhookRoutes(ctx: WebhookRoutesContext) {
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
    maxSize: WEBHOOK_BODY_LIMIT,
    onError: (c) =>
      c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413),
  });
  const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404);
  const tooMany = (c: Context<AppEnv>, wait: number) => {
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many requests. Try again in ${wait} seconds.`,
        ...coded('rate.requests', { count: wait }),
        retryAfterSeconds: wait,
      },
      429,
    );
  };

  app.get('/:workspaceId/webhooks', needs('webhooks.read'), async (c) =>
    c.json({ webhooks: await listWebhooks(db, ws(c)) }),
  );

  app.post('/:workspaceId/webhooks', needs('webhooks.manage'), small, async (c) => {
    const body = await parseBody(c, createWebhookBody);
    if (!body.ok) return body.response;
    const done = await createWebhook(ctx, { workspaceId: ws(c), ...body.data }, actor(c));
    if (!done.ok) {
      return c.json({ error: done.error, message: done.message, ...codingOf(done) }, done.status);
    }
    // The secret is in this response and nowhere else, ever.
    c.header('Cache-Control', 'no-store');
    return c.json({ webhook: done.endpoint, secret: done.secret }, 201);
  });

  app.get('/:workspaceId/webhooks/:id', needs('webhooks.read'), async (c) => {
    const found = await getWebhook(db, ws(c), param(c, 'id'));
    return found ? c.json({ webhook: found }) : notFound(c);
  });

  app.patch('/:workspaceId/webhooks/:id', needs('webhooks.manage'), small, async (c) => {
    const body = await parseBody(c, updateWebhookBody);
    if (!body.ok) return body.response;
    const done = await updateWebhook(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id'), ...body.data },
      actor(c),
    );
    if (!done.ok) {
      return c.json({ error: done.error, message: done.message, ...codingOf(done) }, done.status);
    }
    return c.json({ webhook: done.endpoint });
  });

  app.delete('/:workspaceId/webhooks/:id', needs('webhooks.manage'), async (c) => {
    const done = await deleteWebhook(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done ? c.body(null, 204) : notFound(c);
  });

  app.post('/:workspaceId/webhooks/:id/rotate-secret', needs('webhooks.manage'), async (c) => {
    const done = await rotateWebhookSecret(
      ctx,
      { workspaceId: ws(c), id: param(c, 'id') },
      actor(c),
    );
    if (!done.ok) return notFound(c);
    c.header('Cache-Control', 'no-store');
    return c.json({ secret: done.secret });
  });

  app.post('/:workspaceId/webhooks/:id/test', needs('webhooks.manage'), async (c) => {
    // An unknown id is a 404 and costs no slot.
    if (!(await getWebhook(db, ws(c), param(c, 'id')))) return notFound(c);
    const wait = limiter.take(ws(c));
    if (wait > 0) return tooMany(c, wait);
    const done = await sendTestEvent(ctx, { workspaceId: ws(c), id: param(c, 'id') }, actor(c));
    return done.ok ? c.json({ deliveryId: done.deliveryId }, 202) : notFound(c);
  });

  app.get('/:workspaceId/webhooks/:id/deliveries', needs('webhooks.read'), async (c) => {
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
    if (!(await getWebhook(db, ws(c), param(c, 'id')))) return notFound(c);
    return c.json({ deliveries: await listDeliveries(db, ws(c), param(c, 'id'), limit) });
  });

  app.post(
    '/:workspaceId/webhooks/:id/deliveries/:deliveryId/redeliver',
    needs('webhooks.manage'),
    async (c) => {
      const input = {
        workspaceId: ws(c),
        endpointId: param(c, 'id'),
        deliveryId: param(c, 'deliveryId'),
      };
      // An unknown endpoint or delivery is a 404 and costs no slot.
      if (!(await deliveryExists(db, input))) return notFound(c);
      const wait = limiter.take(ws(c));
      if (wait > 0) return tooMany(c, wait);
      const done = await redeliver(ctx, input, actor(c));
      return done.ok ? c.json({ deliveryId: done.deliveryId }, 202) : notFound(c);
    },
  );

  return app;
}
