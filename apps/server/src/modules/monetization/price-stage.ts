import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPriceChange,
  type CurrentPrice,
  PRICE_ACKS,
  type PriceAck,
  type PriceChange,
  type PricePoint,
  summarizePriceChange,
  SUBSCRIBER_RULES,
  type SubscriberRule,
  supports,
  utcDate,
  validatePriceChange,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  currentOf,
  issueFailure,
  PRICE_PURPOSE,
  type PriceContext,
  priceDisabledFailure,
  priceSwitch,
  type StagedPrice,
} from './price-shared.ts';
import {
  type Actor,
  connect,
  mapStoreError,
  notSupportedFailure,
  StoreTimeout,
  timeoutFailure,
  withConnector,
} from './shared.ts';
import { getStoredProduct, readStoredProductRef } from './snapshot.ts';

/**
 * Staging a price change, and the two reads that help a person make one (docs/adr/0062-price-writes.md). Staging writes only Kiln's own table; the
 * store is READ (price points) and never written. The server is the author: the client names territories, amounts and a price point; the current
 * price, the currency and every rule come from the stored snapshot and the pure validation of `@kiln/core`.
 */

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export type StagePriceInput = {
  workspaceId: string;
  appId: string;
  productId: string;
  planId: string | null;
  lines: { territory: string; newAmount: string; pricePointId?: string | undefined }[];
  effectiveDate: string | null;
  existingSubscribers: SubscriberRule;
  acknowledgements: PriceAck[];
  /** The `syncedAt` of the product as the person's screen showed it: a newer snapshot is refused (`409 stale_snapshot`). */
  seenSyncedAt: number;
  actor: Actor;
};

/** What a cart row and the staged list show of a change, without recomputing in the web. */
export type StagedPriceView = {
  id: string;
  productId: string;
  planId: string | null;
  store: string;
  kind: PriceChange['kind'];
  effectiveDate: string | null;
  existingSubscribers: SubscriberRule;
  acknowledgements: PriceAck[];
  lines: {
    territory: string;
    currency: string;
    before: string;
    after: string;
    percentBp: number | null;
    direction: 'increase' | 'decrease' | 'same';
    pricePointId: string | null;
  }[];
  currencies: string[];
  largestBp: number;
  createdAt: number;
  createdBy: string;
  version: string;
};

export const hashOf = (change: PriceChange): string => sha(canonicalPriceChange(change));

export function viewOf(row: StagedPrice): StagedPriceView {
  const summary = summarizePriceChange(row.change);
  return {
    id: row.id,
    productId: row.change.productId,
    planId: row.change.planId,
    store: row.change.store,
    kind: row.change.kind,
    effectiveDate: row.change.effectiveDate,
    existingSubscribers: row.change.existingSubscribers,
    acknowledgements: row.change.acknowledgements,
    lines: summary.lines.map((l, i) => ({
      territory: l.territory,
      currency: l.currency,
      before: l.before,
      after: l.after,
      percentBp: l.percentBp,
      direction: l.direction,
      pricePointId: row.change.lines[i]?.pricePointId ?? null,
    })),
    currencies: summary.currencies,
    largestBp: summary.largestBp,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    version: row.valueHash,
  };
}

const parseRow = (r: Record<string, unknown>): StagedPrice | undefined => {
  try {
    const change = JSON.parse(String(r.payload_json)) as PriceChange;
    if (!change || !Array.isArray(change.lines)) return undefined;
    return {
      id: String(r.id),
      change,
      syncedAt: Number(r.synced_at),
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      valueHash: String(r.value_hash),
    };
  } catch {
    return undefined;
  }
};

export async function listStagedPrices(
  db: Database,
  workspaceId: string,
  appId: string,
): Promise<StagedPrice[]> {
  const rows = await db.query(
    'SELECT * FROM staged_price_changes WHERE workspace_id = ? AND app_id = ? ORDER BY created_at, id',
    [workspaceId, appId],
  );
  return rows.map(parseRow).filter((r): r is StagedPrice => r !== undefined);
}

/** Removes Kiln's draft only. No store is contacted. */
export async function unstagePrice(
  ctx: Pick<PriceContext, 'db' | 'now'>,
  input: { workspaceId: string; appId: string; id: string; actor: Actor },
): Promise<{ ok: true } | Failure> {
  const [row] = await ctx.db.query(
    'SELECT * FROM staged_price_changes WHERE id = ? AND workspace_id = ? AND app_id = ?',
    [input.id, input.workspaceId, input.appId],
  );
  const staged = row ? parseRow(row) : undefined;
  if (!row || !staged) return failure(404, 'not_found');
  await ctx.db.execute('DELETE FROM staged_price_changes WHERE id = ?', [input.id]);
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'price.discarded',
    target: { type: 'app', id: input.appId },
    detail: {
      appId: input.appId,
      productId: staged.change.productId,
      store: staged.change.store,
      planId: staged.change.planId,
      territories: staged.change.lines.map((l) => l.territory),
    },
    at: ctx.now(),
  });
  return { ok: true };
}

type Resolved = {
  app: ManagedApp;
  ref: { productId: string; kind: PriceChange['kind']; storeRef: string | null };
  baseTerritory: string | null;
  syncedAt: number;
  rows: { planId: string | null; territory: string; currency: string; amount: string }[];
};

async function resolve(
  ctx: PriceContext,
  input: { workspaceId: string; appId: string; productId: string },
): Promise<{ ok: true; resolved: Resolved } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'priceWrite')) return notSupportedFailure();
  const notFound = () =>
    failure(
      404,
      'product_not_found',
      'No such product. Sync the app first.',
      coded('notFound.product'),
    );
  const ref = await readStoredProductRef(ctx.db, input.workspaceId, app.id, input.productId);
  const detail = ref
    ? await getStoredProduct(ctx.db, input.workspaceId, app.id, input.productId)
    : undefined;
  if (!ref || !detail) return notFound();
  return {
    ok: true,
    resolved: {
      app,
      ref: { productId: ref.productId, kind: ref.kind, storeRef: ref.storeRef },
      baseTerritory: detail.baseTerritory,
      syncedAt: detail.syncedAt,
      rows: detail.prices.map((p) => ({
        planId: p.planId,
        territory: p.territory,
        currency: p.currency,
        amount: p.amount,
      })),
    },
  };
}

const samePlan = (a: string | null, b: string | null) => (a ?? '') === (b ?? '');

/** Apple's price points of a product in some territories, read from the store (a read; nothing is written). */
async function readPoints(
  ctx: PriceContext,
  workspaceId: string,
  app: ManagedApp,
  ref: Resolved['ref'],
  territories: readonly string[],
  actor: Actor,
): Promise<{ ok: true; points: PricePoint[] } | Failure> {
  const conn = await connect(ctx, workspaceId, app, PRICE_PURPOSE, actor);
  if (!conn.ok) return conn;
  try {
    const points = await withConnector(ctx.factory, conn.connection.input, ctx.timeoutMs, (c) =>
      c.pricePoints(ref, territories),
    );
    return { ok: true, points };
  } catch (error) {
    if (error instanceof StoreTimeout) return timeoutFailure();
    return mapStoreError(error, conn.connection.secret).failure;
  }
}

/** `GET .../price-points`: the price points of one territory, with the ones nearest to an amount first when one is given. */
export async function listPricePoints(
  ctx: PriceContext,
  input: { workspaceId: string; appId: string; productId: string; territory: string; actor: Actor },
): Promise<
  { ok: true; pricePoints: PricePoint[]; currency: string | null; applicable: boolean } | Failure
> {
  const r = await resolve(ctx, input);
  if (!r.ok) return r;
  const { app, ref, rows } = r.resolved;
  if (storeFor(app.platform) !== 'appstoreconnect')
    return { ok: true, pricePoints: [], currency: null, applicable: false };
  if (!/^[A-Z]{3}$/.test(input.territory))
    return failure(
      422,
      'invalid_price',
      'Not a territory of this store.',
      coded('prices.badTerritory'),
    );
  const got = await readPoints(ctx, input.workspaceId, app, ref, [input.territory], input.actor);
  if (!got.ok) return got;
  const currency =
    rows.find((x) => x.territory === input.territory)?.currency ?? got.points[0]?.currency ?? null;
  const sorted = got.points.slice().sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  return { ok: true, pricePoints: sorted, currency, applicable: true };
}

/** `POST .../price-convert`: Google Play's regional prices derived from one base price (a read; the person still reviews and stages them). */
export async function convertPrices(
  ctx: PriceContext,
  input: {
    workspaceId: string;
    appId: string;
    productId: string;
    planId: string | null;
    baseTerritory: string;
    amount: string;
    actor: Actor;
  },
): Promise<
  | {
      ok: true;
      prices: { territory: string; currency: string; amount: string; current: string | null }[];
      regionsVersion: string | null;
    }
  | Failure
> {
  const r = await resolve(ctx, input);
  if (!r.ok) return r;
  const { app, rows } = r.resolved;
  if (storeFor(app.platform) !== 'googleplay')
    return failure(
      422,
      'not_applicable',
      'Only Google Play converts one price to other regions.',
      coded('prices.convertNotApplicable'),
    );
  const base = rows.find(
    (x) => samePlan(x.planId, input.planId) && x.territory === input.baseTerritory,
  );
  if (!base || !/^\d{1,15}$/.test(input.amount) || BigInt(input.amount) <= BigInt(0)) {
    return failure(
      422,
      'invalid_price',
      'Name a base territory the plan has a price in, and an amount in minor units.',
      coded('prices.convertBase'),
    );
  }
  const conn = await connect(ctx, input.workspaceId, app, PRICE_PURPOSE, input.actor);
  if (!conn.ok) return conn;
  try {
    const out = await withConnector(ctx.factory, conn.connection.input, ctx.timeoutMs, async (c) =>
      c.convertFromBase
        ? c.convertFromBase({ currency: base.currency, amount: input.amount })
        : { prices: [], regionsVersion: null },
    );
    const own = rows.filter((x) => samePlan(x.planId, input.planId));
    return {
      ok: true,
      regionsVersion: out.regionsVersion,
      // Only regions the plan already has, in the currency it already has: a converted price in another currency is never offered.
      prices: out.prices
        .map((p) => {
          const mine = own.find((x) => x.territory === p.territory);
          return mine && mine.currency === p.currency
            ? {
                territory: p.territory,
                currency: p.currency,
                amount: p.amount,
                current: mine.amount,
              }
            : undefined;
        })
        .filter(
          (p): p is { territory: string; currency: string; amount: string; current: string } =>
            p !== undefined,
        ),
    };
  } catch (error) {
    if (error instanceof StoreTimeout) return timeoutFailure();
    return mapStoreError(error, conn.connection.secret).failure;
  }
}

/** Stages (replaces) the price change of one product and plan. Everything is checked again here; the answer is the staged view. */
export async function stagePrice(
  ctx: PriceContext,
  input: StagePriceInput,
): Promise<{ ok: true; staged: StagedPriceView } | Failure> {
  const sw = await priceSwitch(ctx, input.workspaceId);
  if (!sw.enabled) return priceDisabledFailure(sw);
  const r = await resolve(ctx, input);
  if (!r.ok) return r;
  const { app, ref, baseTerritory, syncedAt, rows } = r.resolved;
  if (input.seenSyncedAt !== syncedAt) {
    return failure(
      409,
      'stale_snapshot',
      'The product was synced again since you opened it. Reload it and review the prices again.',
      coded('prices.staleSnapshot'),
    );
  }
  const store = storeFor(app.platform);
  const own = rows.filter((x) => samePlan(x.planId, input.planId));
  const lines: PriceChange['lines'] = [];
  for (const l of input.lines) {
    const now = own.find((x) => x.territory === l.territory);
    // Territory and currency come from the snapshot: a territory the product has no price in is reported by the validation below.
    lines.push({
      territory: l.territory,
      currency: now?.currency ?? '',
      currentAmount: now?.amount ?? '',
      newAmount: l.newAmount,
      ...(l.pricePointId ? { pricePointId: l.pricePointId } : {}),
    });
  }
  const change: PriceChange = {
    store,
    productId: ref.productId,
    kind: ref.kind,
    planId: input.planId,
    baseTerritory: store === 'appstoreconnect' ? baseTerritory : null,
    lines,
    effectiveDate: input.effectiveDate,
    existingSubscribers: input.existingSubscribers,
    acknowledgements: input.acknowledgements,
  };
  if (
    !(SUBSCRIBER_RULES as readonly string[]).includes(change.existingSubscribers) ||
    change.acknowledgements.some((a) => !(PRICE_ACKS as readonly string[]).includes(a))
  ) {
    return failure(
      422,
      'invalid_price',
      'Not a known choice for existing subscribers or acknowledgement.',
      coded('prices.badChoice'),
    );
  }
  // Rows that are not in the snapshot have no currency: report the territory instead of a currency error.
  const missing = lines.filter((l) => l.currentAmount === '');
  if (missing.length > 0)
    return issueFailure(
      missing.map((l) => ({ code: 'unknown_territory' as const, territory: l.territory })),
    );
  let points: PricePoint[] | undefined;
  if (store === 'appstoreconnect') {
    const got = await readPoints(
      ctx,
      input.workspaceId,
      app,
      ref,
      [...new Set(lines.map((l) => l.territory))],
      input.actor,
    );
    if (!got.ok) return got;
    points = got.points;
  }
  const current: CurrentPrice[] = currentOf(own);
  const issues = validatePriceChange(change, {
    current,
    pricePoints: points,
    today: utcDate(ctx.now()),
    limits: ctx.limits,
  });
  if (issues.length > 0) return issueFailure(issues);

  const now = ctx.now();
  const id = randomUUID();
  const valueHash = hashOf(change);
  const planKey = input.planId ?? '';
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      'DELETE FROM staged_price_changes WHERE app_id = ? AND product_id = ? AND plan_id = ?',
      [app.id, ref.productId, planKey],
    );
    await tx.execute(
      `INSERT INTO staged_price_changes (id, workspace_id, app_id, product_id, plan_id, store, payload_json, value_hash, synced_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        app.id,
        ref.productId,
        planKey,
        store,
        JSON.stringify(change),
        valueHash,
        syncedAt,
        input.actor.id,
        now,
        now,
      ],
    );
  });
  const staged: StagedPrice = {
    id,
    change,
    syncedAt,
    createdBy: input.actor.id,
    createdAt: now,
    valueHash,
  };
  const view = viewOf(staged);
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'price.staged',
    target: { type: 'app', id: app.id },
    detail: {
      appId: app.id,
      productId: ref.productId,
      store,
      planId: change.planId,
      effectiveDate: change.effectiveDate,
      existingSubscribers: change.existingSubscribers,
      acknowledgements: change.acknowledgements,
      lines: view.lines.map((l) => ({
        territory: l.territory,
        currency: l.currency,
        before: l.before,
        after: l.after,
        percentBp: l.percentBp,
      })),
    },
    at: now,
  });
  return { ok: true, staged: view };
}
