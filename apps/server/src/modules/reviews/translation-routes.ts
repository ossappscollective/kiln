import { type Action, can, translationLimits } from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';
import {
  auditReviewTranslation,
  type TranslationContext,
  type TranslationFailure,
  testTranslation,
  translateReviews,
} from '../../services/translation.ts';

export type ReviewTranslationRoutesContext = TranslationContext & {
  /** Requests per workspace per minute (default built in createApp: 20). */
  limiter: TestLimiter;
};

const languageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/, 'A language tag such as en, pt-BR or zh-Hant.')
  .max(35);
const translateBody = z
  .object({
    reviewIds: z.array(z.string().min(1).max(100)).min(1).max(translationLimits.maxReviewIds),
    target: languageTag.optional(),
  })
  .strict();

const ws = (c: Context<AppEnv>) => c.req.param('workspaceId') ?? '';
const respond = (c: Context<AppEnv>, f: TranslationFailure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

/**
 * Translating reviews (docs/api/reviews.md, "Translation"). The server reads the text of each review
 * from its own database: the request names reviews, never carries text, so it is no free proxy.
 * Nothing here logs or audits review text. Mounted under /api/workspaces.
 */
export function reviewTranslationRoutes(ctx: ReviewTranslationRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  const limited = (c: Context<AppEnv>) => {
    const wait = ctx.limiter.take(ws(c));
    if (wait === 0) return undefined;
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many translation requests. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
      429,
    );
  };

  routes.post('/:workspaceId/apps/:id/reviews/translate', needs('reviews.translate'), async (c) => {
    const app = await getApp(db, ws(c), c.req.param('id') ?? '');
    if (!app) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, translateBody);
    if (!body.ok) return body.response;
    const slow = limited(c);
    if (slow) return slow;
    const actor = { type: 'user' as const, id: c.get('user').id };
    const done = await translateReviews(ctx, ws(c), app.id, body.data.reviewIds, {
      ...(body.data.target ? { target: body.data.target } : {}),
      actor,
    });
    if (!done.ok) {
      await auditReviewTranslation(db, {
        workspaceId: ws(c),
        appId: app.id,
        actor,
        at: ctx.now(),
        trigger: 'request',
        ok: false,
        code: String(done.body.error),
      }).catch(() => undefined);
      return respond(c, done);
    }
    await auditReviewTranslation(db, {
      workspaceId: ws(c),
      appId: app.id,
      actor,
      at: ctx.now(),
      trigger: 'request',
      ok: true,
      provider: done.provider,
      target: done.target,
      reviews: done.stats.reviews,
      fromCache: done.stats.fromCache,
      chars: done.stats.chars,
    });
    return c.json({
      provider: done.provider,
      target: done.target,
      translations: done.translations,
      notFound: done.notFound,
      cached: done.stats.reviews > 0 && done.stats.fromCache === done.stats.reviews,
    });
  });

  // Translates one fixed word with the saved settings, to check the provider, the key and the address.
  routes.post('/:workspaceId/translate/test', needs('settings.write'), async (c) => {
    const slow = limited(c);
    if (slow) return slow;
    const outcome = await testTranslation(ctx, ws(c), { type: 'user', id: c.get('user').id });
    return c.json(outcome);
  });

  return routes;
}
