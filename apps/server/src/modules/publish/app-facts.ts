import type { Platform, StoreId } from '@kiln/core';
import { getApp, listApps, type ManagedApp } from '../../services/apps.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  type CartContext,
  type CartItem,
  type CartKind,
  type CartRights,
  loadCart,
} from './cart.ts';
import { type CurrentReadiness, peekCurrentReadiness } from './current-readiness.ts';
import {
  itemsOf,
  loadPendingFacts,
  nextStepsOf,
  PENDING_KINDS,
  type PendingItem,
  type PendingKind,
  type PendingView,
  type PublishStep,
  stagedViewFor,
  totalsOf,
} from './pending.ts';
import { type LastPublish, readLastPublish } from './publish-runs.ts';
import { type Publishing, readPublishing } from './publishing.ts';

/**
 * ONE projection of what an app has waiting (docs/state-model.md "The pending count", docs/api/pending.md).
 *
 * Before: the cart count, the pending summary, the pending view, the publishing claims and the alert each read the stored state their own
 * way and gave their own number (a pushed draft was 0 in the cart and 1 in the view; three staged texts were 3 in the cart and 1 in the view;
 * a screenshot set was a row per file in the alert). Now `readAppFacts` reads the stored state ONCE per app and the endpoints are views of it:
 *
 *   GET /pending/cart-summary        `cartSummaryOf(facts)`   (apps with a non-empty cart)
 *   GET /apps/{id}/pending/cart      `getCart` = `facts.cart`
 *   GET /pending/summary             `pendingSummaryOf(facts)`
 *   GET /apps/{id}/pending           `getPending` = `pendingViewOf(facts)`
 *   GET /pending/publishing          `facts.publishing`, `facts.lastPublish` (read through the same function)
 *   the alert `pending.stale`        the same staged item rule (`staged-unpushed.ts`), one item per text, set and field
 *   MCP                              the same operations
 *
 * THE DEFINITIONS (the state model decides, nothing else):
 * - `pendingCount`: the length of the cart: one item per staged text, per staged graphics SET (never a row per file) and per staged
 *   release field, plus staged prices and reply drafts. It is what a publish writes. `isUnpushed` (core) decides what is staged.
 * - `awaitingSubmit`: 1 when a draft was pushed to the store and waits for its submit, else 0. It is NOT in `pendingCount`: there is nothing
 *   to publish for it, only to submit. Every surface names it ("waiting to be submitted"), none adds it to the cart number.
 * - `awaitingRelease`: draft releases, approved versions and due rollout steps that wait for a person (not in `pendingCount`).
 * - `blocking`: pending items with an error (a quality of the same items, never another count). `waiting`: informational items (in review).
 * - Blockers: `lastPublish` carries the blockers of a RUN (history); `currentReadiness` is the reading of the store now. A surface shows
 *   the current ones whenever there is a reading.
 *
 * Stored state only, no store is read (readiness is the 30 second reading kept by `current-readiness.ts`, never started from here).
 */

export type AppFacts = {
  appId: string;
  app: { id: string; name: string; platform: Platform; store: StoreId };
  pendingCount: number;
  /** Cart items per kind. */
  cartKinds: Partial<Record<CartKind, number>>;
  /** The staged part of the cart (texts, sets, release fields). */
  stagedUnpushed: number;
  awaitingSubmit: number;
  awaitingRelease: number;
  blocking: number;
  waiting: number;
  /** The list of the Pending page (a staged text per language is ONE `listing_text` item there). */
  items: PendingItem[];
  /** The cart items; only when asked for (`withCart`). */
  cart: CartItem[];
  publishing: Publishing | null;
  /** The latest run that did not complete (dismissed ones included: the caller decides). */
  lastPublish: LastPublish | null;
  currentReadiness: CurrentReadiness | null;
  lastSyncedAt: number | null;
};

/** What the counts need: membership of the cart never depends on a right, so a caller without a request has none. */
export const COUNT_ONLY_RIGHTS: CartRights = {
  push: false,
  reply: false,
  discardStaged: false,
  discardReply: false,
  price: false,
};

export type FactsContext = Pick<CartContext, 'db' | 'now' | 'draft' | 'reply' | 'price'>;

/** What the pending list says about the steps that wait for a person (neither is in the cart count). */
export const waitingStepsOf = (
  items: readonly PendingItem[],
): { awaitingSubmit: number; awaitingRelease: number } => ({
  awaitingSubmit: items.filter((i) => i.kind === 'pushed_draft').length,
  awaitingRelease: items.filter(
    (i) => i.kind === 'draft_release' || i.kind === 'approved' || i.kind === 'rollout_step',
  ).length,
});

/** The staged part of a cart: texts, graphics sets and release fields (prices and replies are not staged changes). */
export const stagedUnpushedOf = (cart: readonly Pick<CartItem, 'kind'>[]): number =>
  cart.filter((i) => i.kind === 'listing' || i.kind === 'graphics' || i.kind === 'release').length;

/**
 * The facts of the apps of a workspace (all of them, or `appIds`). Only apps that have something (a cart, an item, a publish, a failure)
 * are returned unless `includeQuiet` (the per app view wants the app even when it holds nothing).
 */
export async function readAppFacts(
  ctx: FactsContext,
  input: {
    workspaceId: string;
    appIds?: readonly string[] | undefined;
    rights?: CartRights | undefined;
    claimTtlMs?: number | undefined;
    includeQuiet?: boolean;
    withCart?: boolean;
    /** At most this many apps get a cart built (the cost is one cart per app that holds something). */
    maxCartApps?: number;
  },
): Promise<AppFacts[]> {
  const { db } = ctx;
  const { workspaceId } = input;
  const now = ctx.now();
  const rights = input.rights ?? COUNT_ONLY_RIGHTS;
  const wanted = input.appIds === undefined ? undefined : new Set(input.appIds);
  const apps = (await listApps(db, workspaceId)).filter(
    (a) => wanted === undefined || wanted.has(a.id),
  );
  const single = apps.length === 1 && wanted !== undefined ? apps[0] : undefined;
  const running = await readPublishing(db, {
    workspaceId,
    appIds: input.appIds,
    now,
    ttlMs: input.claimTtlMs,
  });
  const failed = await readLastPublish(db, { workspaceId, appIds: input.appIds });
  const pending = await loadPendingFacts(db, {
    workspaceId,
    ...(single ? { appId: single.id } : {}),
    now,
  });
  // Who holds anything that can be in a cart: staged changes (the one `isUnpushed` rule, read by `loadPendingFacts`), staged prices, reply drafts.
  const holding = new Set<string>(pending.unpushed);
  for (const sql of [
    'SELECT DISTINCT app_id FROM staged_price_changes WHERE workspace_id = ?',
    "SELECT DISTINCT app_id FROM review_reply_drafts WHERE workspace_id = ? AND status IN ('draft', 'failed', 'sending', 'unknown')",
  ]) {
    for (const r of await db.query(sql, [workspaceId])) holding.add(String(r.app_id));
  }
  let carts = 0;
  const out: AppFacts[] = [];
  for (const app of apps) {
    const view = await stagedViewFor(db, workspaceId, app, pending, now);
    const items = itemsOf(app, pending, view);
    let cart: CartItem[] = [];
    if (holding.has(app.id) && carts < (input.maxCartApps ?? Number.POSITIVE_INFINITY)) {
      carts += 1;
      cart = (await loadCart(ctx, { workspaceId, app, rights, loaded: { facts: pending, view } }))
        .items;
    }
    const cartKinds: Partial<Record<CartKind, number>> = {};
    for (const i of cart) cartKinds[i.kind] = (cartKinds[i.kind] ?? 0) + 1;
    const totals = totalsOf(items);
    const lastPublish = failed.get(app.id) ?? null;
    const publishing = running.get(app.id) ?? null;
    const hasFailure = lastPublish !== null && !lastPublish.dismissed;
    if (
      input.includeQuiet !== true &&
      cart.length === 0 &&
      items.length === 0 &&
      publishing === null &&
      !hasFailure
    )
      continue;
    out.push({
      appId: app.id,
      app: { id: app.id, name: app.name, platform: app.platform, store: storeFor(app.platform) },
      pendingCount: cart.length,
      cartKinds,
      stagedUnpushed: stagedUnpushedOf(cart),
      ...waitingStepsOf(items),
      blocking: totals.blocking,
      waiting: totals.items - totals.actionable,
      items,
      cart: input.withCart === true ? cart : [],
      publishing,
      lastPublish,
      currentReadiness: peekCurrentReadiness(workspaceId, app.id, now),
      lastSyncedAt: app.lastSyncedAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The endpoints, as views of the facts

export type CartSummaryApp = {
  /** Both `appId` and `id`, so a token limited to some apps is filtered by the usual rule. */
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: StoreId };
  /** Items in this app's cart (exactly the length of its `GET /apps/{id}/pending/cart`). */
  count: number;
  kinds: Partial<Record<CartKind, number>>;
};
export type CartSummary = {
  /** Only apps with something in the cart. */
  apps: CartSummaryApp[];
  totals: { apps: number; count: number };
  generatedAt: number;
};

/** Apps read per request at most (the cost is one cart per app that has anything; the rest of the apps cost no cart at all). */
export const CART_SUMMARY_MAX_APPS = 200;

/** `GET /pending/cart-summary`: the count of every cart of the workspace. `appIds` limits the apps (a token limited to some apps). */
export async function cartSummary(
  ctx: FactsContext,
  input: { workspaceId: string; appIds?: readonly string[] | undefined; rights: CartRights },
): Promise<CartSummary> {
  const facts = await readAppFacts(ctx, {
    workspaceId: input.workspaceId,
    appIds: input.appIds,
    rights: input.rights,
    maxCartApps: CART_SUMMARY_MAX_APPS,
  });
  const lines: CartSummaryApp[] = facts
    .filter((f) => f.pendingCount > 0)
    .map((f) => ({
      appId: f.appId,
      id: f.appId,
      app: f.app,
      count: f.pendingCount,
      kinds: f.cartKinds,
    }));
  lines.sort(
    (a, b) =>
      b.count - a.count || a.app.name.localeCompare(b.app.name) || a.appId.localeCompare(b.appId),
  );
  return {
    apps: lines,
    totals: { apps: lines.length, count: lines.reduce((n, l) => n + l.count, 0) },
    generatedAt: ctx.now(),
  };
}

/** `GET /apps/{id}/pending/cart`: the items of ONE app's cart and its publishing claim. */
export async function getCart(
  ctx: FactsContext,
  input: {
    workspaceId: string;
    appId: string;
    rights: CartRights;
    claimTtlMs?: number | undefined;
  },
): Promise<
  { ok: true; items: CartItem[]; publishing: Publishing | null; generatedAt: number } | Failure
> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const [facts] = await readAppFacts(ctx, {
    workspaceId: input.workspaceId,
    appIds: [app.id],
    rights: input.rights,
    claimTtlMs: input.claimTtlMs,
    includeQuiet: true,
    withCart: true,
  });
  return {
    ok: true,
    items: facts?.cart ?? [],
    publishing: facts?.publishing ?? null,
    generatedAt: ctx.now(),
  };
}

/** `GET /apps/{id}/pending`: the stored state only, no store is contacted. */
export async function getPending(
  ctx: FactsContext,
  input: { workspaceId: string; appId: string; claimTtlMs?: number | undefined },
): Promise<{ ok: true; pending: PendingView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const [facts] = await readAppFacts(ctx, {
    workspaceId: input.workspaceId,
    appIds: [app.id],
    claimTtlMs: input.claimTtlMs,
    includeQuiet: true,
  });
  if (!facts) return failure(404, 'not_found');
  return { ok: true, pending: pendingViewOf(app, facts, ctx.now()) };
}

export function pendingViewOf(app: ManagedApp, facts: AppFacts, now: number): PendingView {
  const totals = totalsOf(facts.items);
  return {
    app: facts.app,
    platforms: [{ platform: app.platform, store: facts.app.store, items: facts.items, totals }],
    totals: {
      ...totals,
      count: facts.pendingCount,
      stagedUnpushed: facts.stagedUnpushed,
      awaitingSubmit: facts.awaitingSubmit,
      awaitingRelease: facts.awaitingRelease,
      platforms: facts.items.length > 0 ? [app.platform] : [],
      nextSteps: nextStepsOf(facts.items),
    },
    lastSyncedAt: facts.lastSyncedAt,
    publishing: facts.publishing,
    lastPublish: facts.lastPublish,
    currentReadiness: facts.currentReadiness,
    generatedAt: now,
  };
}

export type PendingSummaryApp = {
  /** Both `appId` and `id`, so a token limited to some apps is filtered by the usual rule. */
  appId: string;
  id: string;
  app: { id: string; name: string; platform: Platform; store: StoreId };
  /** The pending count: the length of the app's cart (see `AppFacts`). Same number as `cart-summary`. */
  count: number;
  /** The staged part of `count` (texts, graphics sets, release fields). */
  stagedUnpushed: number;
  /** 1 when a pushed draft waits for its submit. Not in `count`. */
  awaitingSubmit: number;
  /** Draft releases, approved versions and due rollout steps. Not in `count`. */
  awaitingRelease: number;
  /** Items with an error. */
  blocking: number;
  /** Informational items (in review): nothing to do. */
  waiting: number;
  kinds: PendingKind[];
  nextSteps: PublishStep[];
  /** A batch publish of this app is running now (see `PendingView.publishing`); null when none is. */
  publishing: Publishing | null;
  /** The latest publish of this app that did not complete (see `PendingView.lastPublish`); null when none. */
  lastPublish: LastPublish | null;
  /** A reading of the store that is still fresh (see `PendingView.currentReadiness`); null when none. */
  currentReadiness: CurrentReadiness | null;
};

export type PendingSummary = {
  /** Only apps with something pending or in review; an app that is not listed has nothing. */
  apps: PendingSummaryApp[];
  totals: {
    apps: number;
    count: number;
    blocking: number;
    awaitingSubmit: number;
    awaitingRelease: number;
  };
  generatedAt: number;
};

/** `GET /pending/summary`: one line per app that has something, from stored state. */
export async function pendingSummary(
  ctx: FactsContext,
  input: {
    workspaceId: string;
    appIds?: readonly string[] | undefined;
    claimTtlMs?: number | undefined;
  },
): Promise<PendingSummary> {
  const facts = await readAppFacts(ctx, {
    workspaceId: input.workspaceId,
    appIds: input.appIds,
    claimTtlMs: input.claimTtlMs,
  });
  const lines: PendingSummaryApp[] = facts.map((f) => {
    const actionable = f.items.filter((i) => i.nextStep !== null);
    return {
      appId: f.appId,
      id: f.appId,
      app: f.app,
      count: f.pendingCount,
      stagedUnpushed: f.stagedUnpushed,
      awaitingSubmit: f.awaitingSubmit,
      awaitingRelease: f.awaitingRelease,
      blocking: f.blocking,
      waiting: f.waiting,
      kinds: PENDING_KINDS.filter((k) => actionable.some((i) => i.kind === k)),
      nextSteps: nextStepsOf(f.items),
      publishing: f.publishing,
      lastPublish: f.lastPublish,
      currentReadiness: f.currentReadiness,
    };
  });
  lines.sort(
    (a, b) =>
      b.blocking - a.blocking ||
      b.count - a.count ||
      a.app.name.localeCompare(b.app.name) ||
      a.appId.localeCompare(b.appId),
  );
  const sum = (pick: (l: PendingSummaryApp) => number) => lines.reduce((n, l) => n + pick(l), 0);
  return {
    apps: lines,
    totals: {
      apps: lines.filter((l) => l.count > 0 || l.awaitingSubmit > 0 || l.awaitingRelease > 0)
        .length,
      count: sum((l) => l.count),
      blocking: sum((l) => l.blocking),
      awaitingSubmit: sum((l) => l.awaitingSubmit),
      awaitingRelease: sum((l) => l.awaitingRelease),
    },
    generatedAt: ctx.now(),
  };
}
