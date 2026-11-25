import {
  type ConvertedPrices,
  type LivePrices,
  type PriceApplyResult,
  PriceDriftError,
  type PriceLineOutcome,
  type PricePreviewResult,
  ProductMissingError,
  type ScheduledPrice,
  type StoreError,
  type StorePriceWriteConnector,
  type StoreProductRef,
} from '@kiln/connectors';
import type { PriceChange, PricePoint } from '@kiln/core';
import type { Database } from '@kiln/db';
import type { PriceDeps } from './price-shared.ts';
import { bootMonetization, type FakeProductsStore } from './test-helpers.ts';

/** Fakes for the price tests: a price connector that shares its state with the fake products store, so a re-sync shows what was written. */

export type PriceBehavior = {
  /** Per territory: the store refuses this line with a code. */
  refuse?: Record<string, { code: PriceLineOutcome['code'] }>;
  /** Every line is sent and the answer is lost; `applied` says whether the store applied it anyway. */
  unknown?: { applied: boolean };
  /** The store writes another amount than asked (to see "store shows X"). */
  writeInstead?: string;
  /** The live read before the write fails. */
  readError?: StoreError | Error;
};

export const POINTS: PricePoint[] = [
  ...['99', '199', '299', '499', '599', '699'].map((a) => ({
    id: `usa-${a}`,
    territory: 'USA',
    currency: 'USD',
    amount: a,
  })),
  ...['99', '129', '199'].map((a) => ({
    id: `deu-${a}`,
    territory: 'DEU',
    currency: 'EUR',
    amount: a,
  })),
  ...['150', '200', '300'].map((a) => ({
    id: `jpn-${a}`,
    territory: 'JPN',
    currency: 'JPY',
    amount: a,
  })),
];

export class FakePriceStore implements StorePriceWriteConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  behavior: PriceBehavior = {};
  reads = 0;
  pointReads = 0;
  previews = 0;
  /** Every `apply` that got past the guard: what was sent. */
  writes: {
    productId: string;
    planId: string | null;
    lines: { territory: string; amount: string }[];
    existingSubscribers: string;
    effectiveDate: string | null;
  }[] = [];
  scheduled: (ScheduledPrice & { productId: string })[] = [];
  migrations: string[] = [];

  readonly products: FakeProductsStore;

  constructor(products: FakeProductsStore) {
    this.products = products;
    this.store = products.store;
  }

  #find(ref: StoreProductRef) {
    const p = this.products.products.find((x) => x.productId === ref.productId);
    if (!p) throw new ProductMissingError(this.store);
    return p;
  }

  async readPrices(ref: StoreProductRef, planId: string | null): Promise<LivePrices> {
    this.reads++;
    if (this.behavior.readError) throw this.behavior.readError;
    const p = this.#find(ref);
    return {
      current: p.prices
        .filter((x) => (planId === null ? true : x.planId === planId))
        .map((x) => ({ territory: x.territory, currency: x.currency, amount: x.amount })),
      scheduled: this.scheduled.filter((s) => s.productId === ref.productId),
    };
  }

  async pricePoints(_ref: StoreProductRef, territories: readonly string[]): Promise<PricePoint[]> {
    this.pointReads++;
    return this.store === 'appstoreconnect'
      ? POINTS.filter((p) => territories.includes(p.territory))
      : [];
  }

  async convertFromBase(base: { currency: string; amount: string }): Promise<ConvertedPrices> {
    return {
      regionsVersion: '2025/03',
      prices: [
        { territory: 'US', currency: base.currency, amount: base.amount },
        { territory: 'DE', currency: 'EUR', amount: String(Math.round(Number(base.amount) * 1.1)) },
        { territory: 'FR', currency: 'EUR', amount: '999' },
      ],
    };
  }

  async preview(_ref: StoreProductRef, change: PriceChange): Promise<PricePreviewResult> {
    this.previews++;
    return {
      mode: this.store === 'appstoreconnect' ? 'store' : 'local',
      lines: change.lines.map((l) => ({
        territory: l.territory,
        changeType: 'INCREASE_PRESERVABLE',
      })),
      requests: [],
    };
  }

  async apply(
    ref: StoreProductRef,
    change: PriceChange,
    guard: (live: LivePrices) => boolean,
  ): Promise<PriceApplyResult> {
    const live = await this.readPrices(ref, change.planId);
    if (!guard(live)) {
      throw new PriceDriftError(this.store, live);
    }
    const p = this.#find(ref);
    this.writes.push({
      productId: ref.productId,
      planId: change.planId,
      lines: change.lines.map((l) => ({ territory: l.territory, amount: l.newAmount })),
      existingSubscribers: change.existingSubscribers,
      effectiveDate: change.effectiveDate,
    });
    const lines: PriceLineOutcome[] = [];
    for (const l of change.lines) {
      const refused = this.behavior.refuse?.[l.territory];
      if (refused) {
        lines.push({
          territory: l.territory,
          outcome: 'failed',
          code: refused.code,
          message: 'refused',
        });
        continue;
      }
      const apply = () => {
        const row = p.prices.find(
          (x) =>
            x.territory === l.territory && (change.planId === null || x.planId === change.planId),
        );
        if (row) row.amount = this.behavior.writeInstead ?? l.newAmount;
      };
      if (this.behavior.unknown) {
        if (this.behavior.unknown.applied) apply();
        lines.push({ territory: l.territory, outcome: 'unknown', message: 'timed out' });
        continue;
      }
      apply();
      lines.push({ territory: l.territory, outcome: 'applied' });
    }
    if (change.existingSubscribers === 'opt_in' || change.existingSubscribers === 'opt_out')
      this.migrations.push(`${ref.productId}:${change.existingSubscribers}`);
    return {
      lines,
      ...(this.store === 'googleplay' && change.existingSubscribers !== 'preserve'
        ? { migration: { requested: true, outcome: 'applied' as const } }
        : {}),
    };
  }
}

export async function bootPrices(
  db: Database,
  opts: { server?: boolean; workspace?: boolean; deps?: PriceDeps } = {},
) {
  let fakes: { ios: FakePriceStore; android: FakePriceStore } | undefined;
  const holder: { current?: Awaited<ReturnType<typeof bootMonetization>> } = {};
  const factory = (input: { kind: string }) => {
    const t = holder.current;
    if (!t || !fakes) throw new Error('not booted');
    return input.kind === 'app_store_connect' ? fakes.ios : fakes.android;
  };
  const t = await bootMonetization(
    db,
    {},
    {
      prices: {
        enabled: opts.server ?? true,
        connectorFactory: factory as PriceDeps['connectorFactory'],
        ...opts.deps,
      },
    },
  );
  holder.current = t;
  fakes = { ios: new FakePriceStore(t.stores.ios), android: new FakePriceStore(t.stores.android) };
  if (opts.workspace !== false) {
    const res = await t.call(t.owner, 'PUT', '/settings', { 'prices.writeEnabled': true });
    if (res.status !== 200) throw new Error(`settings ${res.status}: ${res.text}`);
  }
  const productPath = (appId: string, productId: string, rest = '') =>
    `/apps/${appId}/products/${encodeURIComponent(productId)}${rest}`;
  const syncedAt = async (appId: string, productId: string): Promise<number> => {
    const res = await t.call(t.owner, 'GET', productPath(appId, productId));
    return res.body.product.syncedAt as number;
  };
  const stage = async (
    appId: string,
    productId: string,
    over: Record<string, unknown> = {},
    cookie = t.owner,
  ) => {
    const body = {
      planId: null,
      lines: [{ territory: 'JPN', newAmount: '200', pricePointId: 'jpn-200' }],
      effectiveDate: null,
      existingSubscribers: 'not_applicable',
      acknowledgements: [],
      seenSyncedAt: await syncedAt(appId, productId),
      ...over,
    };
    return t.call(cookie, 'PUT', productPath(appId, productId, '/prices/staged'), body);
  };
  const cart = (appId: string, cookie = t.owner) =>
    t.call(cookie, 'GET', `/apps/${appId}/pending/cart`);
  const publish = (
    appId: string,
    items: { id: string; version: string }[],
    confirmation?: string,
    cookie = t.owner,
    headers: Record<string, string> = {},
  ) =>
    t.app.request(`/api/workspaces/${t.workspaceId}/apps/${appId}/pending/publish`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ items, ...(confirmation === undefined ? {} : { confirmation }) }),
    });
  const priceItems = async (appId: string) =>
    (
      (await cart(appId)).body.cart.items as {
        id: string;
        version: string;
        kind: string;
        [k: string]: unknown;
      }[]
    ).filter((i) => i.kind === 'price');
  const audit = async (like = 'price.%') =>
    (
      await db.query(
        'SELECT action, actor_type, actor_id, detail FROM audit_events WHERE action LIKE ? ORDER BY created_at',
        [like],
      )
    ).map((r) => ({
      action: String(r.action),
      actorType: String(r.actor_type),
      actorId: String(r.actor_id),
      detail: JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>,
    }));
  return { ...t, fakes, productPath, syncedAt, stage, cart, publish, priceItems, audit };
}
export type PriceBoot = Awaited<ReturnType<typeof bootPrices>>;
