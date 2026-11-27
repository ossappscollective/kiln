import { type Action, can, canToken } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import type { Failure } from '../../services/repositories.ts';
import { getPolicy, requireStepUp, type StepUpAction } from '../../services/step-up.ts';
import type { AssetsContext } from '../listing/asset-repo.ts';
import { PRICE_STEP_UP, type PriceContext } from '../monetization/price-shared.ts';
import {
  defaultReplyConnectorFactory,
  type ReviewReplyConnectorFactory,
  type ReviewReplyContext,
} from '../reviews/replies.ts';
import { cartSummary, getCart } from './app-facts.ts';
import {
  type CartContext,
  type CartRights,
  cartItemDetail,
  discardCart,
  publishCart,
} from './cart.ts';
import { notWhilePublishing } from './publishing.ts';
import {
  type DraftConnectorFactory,
  type DraftContext,
  defaultDraftConnectorFactory,
} from './store-draft.ts';

/**
 * The pending cart (docs/api/pending.md, docs/adr/0054-pending-cart.md). Reads stored state; publishing delegates to the push of the
 * staged changes and to the reply send, with their switches and rights; nothing is sent that the request did not name.
 * Mounted under /api/workspaces.
 */
export type CartRoutesContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** The time to live of a batch publish claim (tests): while one runs for the app, the writes that guard themselves refuse. */
  publishClaimTtlMs?: number | undefined;
  repo: AssetsContext['repo'];
  /** The same seams as the push of staged changes. */
  draft?: {
    enabled?: boolean;
    connectorFactory?: DraftConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
  };
  /** Price changes (docs/adr/0062-price-writes.md): the switch, limits and connector of the price writes. */
  price: PriceContext;
  /** The same seams as the reply send of the reviews. */
  reply?: {
    enabled?: boolean;
    connectorFactory?: ReviewReplyConnectorFactory;
    timeoutMs?: number;
    claimTtlMs?: number;
    sendsPerHour?: number;
  };
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });
const respond = (c: Context<AppEnv>, f: Failure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const itemId = z.string().min(3).max(220);
export const cartPublishBody = z
  .object({
    items: z
      .array(z.object({ id: itemId, version: z.string().min(1).max(64) }).strict())
      .min(1)
      .max(200),
    /** The phrase a person types to send prices (`CHANGE 3 PRICES MAX 42%`). Needed only when the request names a price. */
    confirmation: z.string().max(80).optional(),
  })
  .strict();
export const cartDiscardBody = z.object({ ids: z.array(itemId).min(1).max(200) }).strict();

const STAGED_PREFIXES = ['listing:', 'graphics:', 'release:'];
const REPLY_PREFIXES = ['review_reply:'];
const PRICE_PREFIX = 'price:';

/** The cart's context (the seams of the push, the reply send and the price writes). Also what the pending routes read the same cart through. */
export function cartContextOf(ctx: CartRoutesContext): CartContext {
  const { db } = ctx;
  const draft: DraftContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    draftEnabled: ctx.draft?.enabled ?? false,
    draftConnectorFactory: ctx.draft?.connectorFactory ?? defaultDraftConnectorFactory,
    assets: { repo: ctx.repo },
    ...(ctx.draft?.timeoutMs !== undefined ? { draftTimeoutMs: ctx.draft.timeoutMs } : {}),
    ...(ctx.draft?.claimTtlMs !== undefined ? { claimTtlMs: ctx.draft.claimTtlMs } : {}),
  };
  const reply: ReviewReplyContext = {
    db,
    masterKey: ctx.masterKey,
    now: ctx.now,
    replyEnabled: ctx.reply?.enabled ?? false,
    replyConnectorFactory: ctx.reply?.connectorFactory ?? defaultReplyConnectorFactory,
    ...(ctx.reply?.timeoutMs !== undefined ? { replyTimeoutMs: ctx.reply.timeoutMs } : {}),
    ...(ctx.reply?.claimTtlMs !== undefined ? { claimTtlMs: ctx.reply.claimTtlMs } : {}),
    ...(ctx.reply?.sendsPerHour !== undefined ? { sendsPerHour: ctx.reply.sendsPerHour } : {}),
  };
  const cart: CartContext = {
    db,
    now: ctx.now,
    draft,
    reply,
    staged: { db, now: ctx.now, assets: { repo: ctx.repo } },
    price: ctx.price,
  };
  return cart;
}

export function cartRoutes(ctx: CartRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();
  /** Refused with `409 publish_in_progress` while a batch publish of the app runs (publishing.ts). */
  const notPublishing = notWhilePublishing({ db, now: ctx.now, claimTtlMs: ctx.publishClaimTtlMs });
  const cart = cartContextOf(ctx);

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  /** What the caller may do per kind: the member's role (already lowered to the token's ceiling) AND, for a token, its own list. */
  const rightsOf = (c: Context<AppEnv>): CartRights => {
    const role = c.get('role');
    const token = c.get('token');
    const allowed = (action: Action) =>
      can(role, action) &&
      (token === undefined || canToken(token.ceiling, token.actions as Action[] | null, action));
    return {
      push: allowed('store.push_draft'),
      reply: allowed('reviews.reply'),
      discardStaged: allowed('changesets.write'),
      discardReply: allowed('reviews.triage'),
      price: allowed('monetization.price'),
    };
  };

  // Registered before the per app routes; a path of its own (`/pending/cart-summary`), no per item payload.
  routes.get('/:workspaceId/pending/cart-summary', needs('listing.read'), async (c) => {
    const tokenApps = c.get('token')?.appIds ?? undefined;
    const summary = await cartSummary(cart, {
      workspaceId: ws(c),
      ...(tokenApps ? { appIds: tokenApps as string[] } : {}),
      rights: rightsOf(c),
    });
    c.header('Cache-Control', 'no-store');
    return c.json(summary);
  });

  routes.get('/:workspaceId/apps/:id/pending/cart', needs('listing.read'), async (c) => {
    const rights = rightsOf(c);
    const done = await getCart(cart, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      rights,
      claimTtlMs: ctx.publishClaimTtlMs,
    });
    c.header('Cache-Control', 'no-store');
    return done.ok
      ? c.json({
          cart: {
            items: done.items,
            can: rights,
            publishing: done.publishing,
            generatedAt: done.generatedAt,
          },
        })
      : respond(c, done);
  });

  // The full before and after of ONE item (the row preview of the cart drawer and of the Pending page): `?id=<kind>:<id>`, same right as the cart.
  routes.get('/:workspaceId/apps/:id/pending/cart/detail', needs('listing.read'), async (c) => {
    const id = itemId.safeParse(c.req.query('id') ?? '');
    if (!id.success) {
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'id', message: 'The id of a cart item: <kind>:<id>.' }],
        },
        400,
      );
    }
    const done = await cartItemDetail(cart, {
      workspaceId: ws(c),
      appId: param(c, 'id'),
      id: id.data,
      rights: rightsOf(c),
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json({ detail: done.detail }) : respond(c, done);
  });

  routes.post(
    '/:workspaceId/apps/:id/pending/publish',
    needs('listing.read'),
    notPublishing,
    async (c) => {
      const body = await parseBody(c, cartPublishBody);
      if (!body.ok) return body.response;
      // Writing a store draft, or sending a public reply, is a step-up action: ask before anything is read, only when the request names a
      // staged change or a reply. The button says "Publish", so a workspace that asks before "Publish to the stores" but not before "Write
      // a store draft" is asked here too. One action per request: two would need two confirmations.
      const names = (prefixes: readonly string[]) =>
        body.data.items.some((i) => prefixes.some((p) => i.id.startsWith(p)));
      const staged = names(STAGED_PREFIXES);
      const reply = names(REPLY_PREFIXES);
      if (staged || reply) {
        const policy = await getPolicy(db, ws(c));
        const asks = (a: StepUpAction) =>
          policy.mode === 'hard_actions' && policy.actions.includes(a);
        const action: StepUpAction | null =
          asks('store.publish') && (reply || !asks('store.push_draft'))
            ? 'store.publish'
            : staged
              ? 'store.push_draft'
              : null;
        if (action) {
          const refusal = await requireStepUp({ db, now: ctx.now }, c, action, {
            id: param(c, 'id'),
          });
          if (refusal) return refusal;
        }
      }
      // Sending a price is the strictest step-up action: asked before anything is read, only when the request names a price.
      if (body.data.items.some((i) => i.id.startsWith(PRICE_PREFIX))) {
        const refusal = await requireStepUp({ db, now: ctx.now }, c, PRICE_STEP_UP, {
          id: param(c, 'id'),
        });
        if (refusal) return refusal;
      }
      const done = await publishCart(cart, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        items: body.data.items,
        rights: rightsOf(c),
        actor: actor(c),
        confirmation: body.data.confirmation,
      });
      c.header('Cache-Control', 'no-store');
      return done.ok
        ? c.json({ result: { results: done.results, remaining: done.remaining } })
        : respond(c, done);
    },
  );

  routes.post(
    '/:workspaceId/apps/:id/pending/discard',
    needs('listing.read'),
    notPublishing,
    async (c) => {
      const body = await parseBody(c, cartDiscardBody);
      if (!body.ok) return body.response;
      const done = await discardCart(cart, {
        workspaceId: ws(c),
        appId: param(c, 'id'),
        ids: body.data.ids,
        rights: rightsOf(c),
        actor: actor(c),
      });
      c.header('Cache-Control', 'no-store');
      return done.ok
        ? c.json({ result: { results: done.results, remaining: done.remaining } })
        : respond(c, done);
    },
  );

  return routes;
}
