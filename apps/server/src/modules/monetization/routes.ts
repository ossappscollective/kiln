import { type Action, can } from '@kiln/core';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import { getApp } from '../../services/apps.ts';
import type { Failure } from '../../services/repositories.ts';
import { requireStepUp } from '../../services/step-up.ts';
import { dryRunPrices } from './price-publish.ts';
import { priceSwitch } from './price-shared.ts';
import { convertPrices, listPricePoints, listStagedPrices, stagePrice } from './price-stage.ts';
import { getProduct, listProducts, syncProducts } from './service.ts';
import { type MonetizationContext, productWriteDisabledFailure } from './shared.ts';
import { applyLocalization, previewLocalization } from './write.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * In-app purchases and subscriptions of an app (docs/api/products.md). Reads and the sync are read-only toward the store. The one write,
 * the localization of a product, is OFF unless KILN_STORE_PRODUCT_WRITE_ENABLED=true. Mounted under /api/workspaces.
 */

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const hash64 = /^[0-9a-f]{64}$/;
/** The service enforces the exact limits after normalizing line breaks; these only keep a body small. */
const localizationBody = z
  .object({
    apply: z.boolean(),
    name: z.string().max(400),
    description: z.string().max(4000),
    previewHash: z
      .string()
      .regex(hash64, 'The previewHash of the preview, 64 hexadecimal characters.')
      .optional(),
  })
  .strict();

const priceStageBody = z
  .object({
    planId: z.string().min(1).max(100).nullable(),
    lines: z
      .array(
        z
          .object({
            territory: z.string().min(2).max(3),
            newAmount: z.string().regex(/^\d{1,15}$/, 'Minor units, digits only: 499 is 4.99.'),
            pricePointId: z.string().min(1).max(400).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(250),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    existingSubscribers: z.enum(['preserve', 'apply', 'opt_in', 'opt_out', 'not_applicable']),
    acknowledgements: z.array(z.enum(['large_change', 'large_absolute', 'existing_subscribers'])).max(3),
    seenSyncedAt: z.number().int().min(0),
  })
  .strict();
const priceConvertBody = z
  .object({ planId: z.string().min(1).max(100).nullable(), baseTerritory: z.string().length(2), amount: z.string().regex(/^\d{1,15}$/) })
  .strict();
const dryRunBody = z.object({ ids: z.array(z.string().min(3).max(220)).max(200).optional() }).strict();

export function monetizationRoutes(ctx: MonetizationContext) {
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

  routes.get('/:workspaceId/apps/:appId/products', needs('apps.read'), async (c) => {
    const done = await listProducts(ctx, { workspaceId: ws(c), appId: param(c, 'appId') });
    return done.ok ? c.json(done.view) : respond(c, done);
  });

  // Declared before the product route so `sync` is never read as a product id (it is a POST, the product route a GET: no clash either way).
  routes.post('/:workspaceId/apps/:appId/products/sync', needs('apps.sync'), async (c) => {
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
    const done = await syncProducts(ctx, { workspaceId: ws(c), appId, actor: actor(c) });
    // The second step (docs/adr/0039-revenuecat.md): the RevenueCat read of a linked app, whether or not the store step worked. It has its
    // own result; its failure never changes the store snapshot or the store answer, and null means the app has no link.
    const revenuecat = await ctx.revenueCatStep({ workspaceId: ws(c), appId, actor: actor(c) });
    return done.ok
      ? c.json({ sync: done.result, revenuecat })
      : respond(c, revenuecat ? { ...done, body: { ...done.body, revenuecat } } : done);
  });

  // ---- Price changes (docs/adr/0062-price-writes.md). Staging writes Kiln's own table only; sending is done from the cart. ----
  routes.get('/:workspaceId/apps/:appId/products/:productId/price-points', needs('monetization.price'), async (c) => {
    const done = await listPricePoints(ctx.price, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      productId: param(c, 'productId'),
      territory: (c.req.query('territory') ?? '').toUpperCase(),
      actor: actor(c),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ pricePoints: done.pricePoints, currency: done.currency, applicable: done.applicable }) : respond(c, done);
  });

  routes.post('/:workspaceId/apps/:appId/products/:productId/price-convert', needs('monetization.price'), async (c) => {
    const body = await parseBody(c, priceConvertBody);
    if (!body.ok) return body.response;
    const done = await convertPrices(ctx.price, { workspaceId: ws(c), appId: param(c, 'appId'), productId: param(c, 'productId'), actor: actor(c), ...body.data });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ prices: done.prices, regionsVersion: done.regionsVersion }) : respond(c, done);
  });

  routes.put('/:workspaceId/apps/:appId/products/:productId/prices/staged', needs('monetization.price'), async (c) => {
    const body = await parseBody(c, priceStageBody);
    if (!body.ok) return body.response;
    const done = await stagePrice(ctx.price, { workspaceId: ws(c), appId: param(c, 'appId'), productId: param(c, 'productId'), actor: actor(c), ...body.data });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ staged: done.staged }) : respond(c, done);
  });

  // The dry run: reads the store and shows what a send would do. Writes nothing, takes no claim, needs no phrase and no step-up.
  routes.post('/:workspaceId/apps/:appId/prices/dry-run', needs('monetization.price'), async (c) => {
    const body = await parseBody(c, dryRunBody);
    if (!body.ok) return body.response;
    const app = await getApp(db, ws(c), param(c, 'appId'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const all = await listStagedPrices(db, ws(c), app.id);
    const named = body.data.ids ? new Set(body.data.ids) : undefined;
    const rows = all.filter((r) => !named || named.has(`price:${r.id}`));
    c.header('Cache-Control', 'no-store');
    const done = await dryRunPrices(ctx.price, { workspaceId: ws(c), app, rows, actor: actor(c) });
    return done.ok ? c.json({ dryRun: { items: done.items, writesEnabled: (await priceSwitch(ctx.price, ws(c))).enabled } }) : respond(c, done);
  });

  routes.get('/:workspaceId/apps/:appId/products/:productId', needs('apps.read'), async (c) => {
    const done = await getProduct(ctx, {
      workspaceId: ws(c),
      appId: param(c, 'appId'),
      productId: param(c, 'productId'),
    });
    return done.ok
      ? c.json({ app: done.app, product: done.product, sync: done.sync })
      : respond(c, done);
  });

  // The only route that can change anything in a store: the display name and description of one locale of one product. `apply: false` is a
  // preview (reads the store, writes nothing); `apply: true` needs the `previewHash` of a preview of exactly these texts.
  routes.put(
    '/:workspaceId/apps/:appId/products/:productId/localizations/:locale',
    needs('monetization.write'),
    async (c) => {
      if (!ctx.writeEnabled) return respond(c, productWriteDisabledFailure());
      const raw: unknown = await c.req.json().catch(() => undefined);
      const applying =
        typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).apply === true;
      if (applying) {
        const refusal = await requireStepUp({ db, now: ctx.now }, c, 'store.push_draft', {
          id: param(c, 'appId'),
          hashField: 'previewHash',
        });
        if (refusal) return refusal;
      }
      const body = await parseBody(c, localizationBody);
      if (!body.ok) return body.response;
      const target = {
        workspaceId: ws(c),
        appId: param(c, 'appId'),
        productId: param(c, 'productId'),
        locale: param(c, 'locale'),
        name: body.data.name,
        description: body.data.description,
        actor: actor(c),
      };
      c.header('Cache-Control', 'no-store');
      if (!body.data.apply) {
        const done = await previewLocalization(ctx, target);
        return done.ok ? c.json({ preview: done.preview }) : respond(c, done);
      }
      if (!body.data.previewHash) {
        return c.json(
          {
            error: 'invalid_request',
            issues: [
              {
                path: 'previewHash',
                message: 'Required to apply: send the previewHash of a preview.',
              },
            ],
          },
          400,
        );
      }
      const done = await applyLocalization(ctx, { ...target, previewHash: body.data.previewHash });
      return done.ok ? c.json({ result: done.result }) : respond(c, done);
    },
  );

  return routes;
}
