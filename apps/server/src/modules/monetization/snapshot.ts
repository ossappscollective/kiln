import {
  formatMinor,
  type ListProductsResult,
  productHash,
  type StoreProductKind,
  type StoreProductState,
  sameLocale,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';

/**
 * The stored copy of an app's in-app products (migration 45): what the last successful sync read, how the last sync went, and the views the routes
 * answer with. Nothing here talks to a store. A sync REPLACES the copy in one transaction, so a reader sees the old snapshot or the new one.
 */

export type ProductPriceView = {
  planId: string | null;
  territory: string;
  currency: string;
  /** Minor units as a string of digits: `"499"` is 4.99 USD. */
  amount: string;
  /** For a person to read: `"4.99"`. */
  display: string;
};

export type ProductSummary = {
  productId: string;
  kind: StoreProductKind;
  referenceName: string;
  state: StoreProductState;
  rawState: string | null;
  group: string | null;
  period: string | null;
  /** The display name of one locale (`en-US` when there is one, else the first), or null when the store has no localization. */
  name: string | null;
  locales: string[];
  /** The price in the base territory, else the United States, else the first one; null when there is none. */
  price: ProductPriceView | null;
  territoryCount: number;
  syncedAt: number;
};

export type ProductDetail = ProductSummary & {
  baseTerritory: string | null;
  localizations: { locale: string; name: string; description: string }[];
  prices: ProductPriceView[];
  availability: { territories: string[]; availableInNewTerritories: boolean | null } | null;
  plans: { id: string; state: string; period: string | null }[];
  offers: { id: string; planId: string; state: string }[];
};

export type ProductSyncStatus = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  /** A redacted sentence about the last failure; null after a good sync. */
  lastError: string | null;
  /** Syncs in a row that failed. */
  failures: number;
  productCount: number;
  /** False when the last sync stopped at a cap: the list may not be everything the store has. */
  complete: boolean;
  warnings: string[];
};

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing the snapshot

/** Multi-row inserts, in chunks small enough for every database's limit on parameters. */
async function insertRows(
  tx: Sql,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const perStatement = Math.max(1, Math.floor(500 / columns.length));
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const marks = `(${columns.map(() => '?').join(', ')})`;
    await tx.execute(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => marks).join(', ')}`,
      chunk.flat() as never[],
    );
  }
}

/**
 * Stores what a sync read. A complete list replaces everything the app had; an incomplete one (the read stopped at a cap) replaces only the
 * products it lists and deletes nothing, because the others may exist in the store.
 */
export async function replaceSnapshot(
  tx: Sql,
  input: { workspaceId: string; appId: string; result: ListProductsResult; at: number },
): Promise<void> {
  const { workspaceId, appId, result, at } = input;
  const tables = ['store_product_prices', 'store_product_localizations', 'store_products'];
  if (result.complete) {
    for (const table of tables)
      await tx.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [
        appId,
        workspaceId,
      ]);
  } else {
    for (const product of result.products) {
      for (const table of tables)
        await tx.execute(
          `DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ? AND product_id = ?`,
          [appId, workspaceId, product.productId],
        );
    }
  }
  await insertRows(
    tx,
    'store_products',
    [
      'app_id',
      'product_id',
      'workspace_id',
      'store_ref',
      'kind',
      'reference_name',
      'state',
      'raw_state',
      'group_name',
      'period',
      'base_territory',
      'availability_json',
      'detail_json',
      'raw_hash',
      'synced_at',
    ],
    result.products.map((p) => [
      appId,
      p.productId,
      workspaceId,
      p.storeRef,
      p.kind,
      p.referenceName,
      p.state,
      p.rawState,
      p.group,
      p.period,
      p.baseTerritory,
      p.availability ? JSON.stringify(p.availability) : null,
      JSON.stringify({ plans: p.plans, offers: p.offers }),
      productHash(p),
      at,
    ]),
  );
  await insertRows(
    tx,
    'store_product_localizations',
    ['app_id', 'product_id', 'locale', 'workspace_id', 'name', 'description', 'store_ref'],
    result.products.flatMap((p) =>
      p.localizations.map((l) => [
        appId,
        p.productId,
        l.locale,
        workspaceId,
        l.name,
        l.description,
        l.ref ?? null,
      ]),
    ),
  );
  await insertRows(
    tx,
    'store_product_prices',
    ['app_id', 'product_id', 'plan_id', 'territory', 'workspace_id', 'currency', 'amount'],
    result.products.flatMap((p) =>
      p.prices.map((x) => [
        appId,
        p.productId,
        x.planId ?? '',
        x.territory,
        workspaceId,
        x.currency,
        x.amount,
      ]),
    ),
  );
  const [{ n } = { n: 0 }] = await tx.query(
    'SELECT COUNT(*) AS n FROM store_products WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  await tx.execute(
    `INSERT INTO store_product_sync (app_id, workspace_id, last_attempt_at, last_synced_at, last_error, failures, product_count, complete, warnings_json)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET workspace_id = excluded.workspace_id, last_attempt_at = excluded.last_attempt_at,
       last_synced_at = excluded.last_synced_at, last_error = NULL, failures = 0, product_count = excluded.product_count,
       complete = excluded.complete, warnings_json = excluded.warnings_json`,
    [
      appId,
      workspaceId,
      at,
      at,
      Number(n),
      result.complete ? 1 : 0,
      JSON.stringify(result.warnings.slice(0, 50).map((w) => w.slice(0, 300))),
    ],
  );
}

/** A failed sync keeps the last good snapshot and says what went wrong. */
export async function recordSyncFailure(
  sql: Sql,
  input: { workspaceId: string; appId: string; message: string; at: number },
): Promise<void> {
  await sql.execute(
    `INSERT INTO store_product_sync (app_id, workspace_id, last_attempt_at, last_error, failures)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       failures = store_product_sync.failures + 1`,
    [input.appId, input.workspaceId, input.at, input.message.slice(0, 500)],
  );
}

/** After a write the stored text is the one the store now has, so the next read shows it without a sync. */
export async function storeLocalizationText(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    productId: string;
    locale: string;
    name: string;
    description: string;
  },
): Promise<void> {
  await sql.execute(
    `UPDATE store_product_localizations SET name = ?, description = ?
      WHERE app_id = ? AND workspace_id = ? AND product_id = ? AND locale = ?`,
    [
      input.name,
      input.description,
      input.appId,
      input.workspaceId,
      input.productId,
      input.locale,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Reading the snapshot

export async function readSyncStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<ProductSyncStatus | null> {
  const [row] = await sql.query(
    `SELECT last_attempt_at, last_synced_at, last_error, failures, product_count, complete, warnings_json
       FROM store_product_sync WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  if (!row) return null;
  return {
    lastAttemptAt: num(row.last_attempt_at),
    lastSyncedAt: num(row.last_synced_at),
    lastError: text(row.last_error),
    failures: Number(row.failures),
    productCount: Number(row.product_count),
    complete: Number(row.complete) === 1,
    warnings: parseJson<string[]>(row.warnings_json, []),
  };
}

/** The price to show in a list: the base territory's, else the United States', else the first, within the first plan. */
export function headlinePrice(
  prices: readonly ProductPriceView[],
  baseTerritory: string | null,
): ProductPriceView | null {
  const plans = [...new Set(prices.map((p) => p.planId ?? ''))].sort();
  const plan = plans[0];
  if (plan === undefined) return null;
  const ofPlan = prices.filter((p) => (p.planId ?? '') === plan);
  for (const territory of [baseTerritory, 'USA', 'US']) {
    const found = territory ? ofPlan.find((p) => p.territory === territory) : undefined;
    if (found) return found;
  }
  return [...ofPlan].sort((a, b) => (a.territory < b.territory ? -1 : 1))[0] ?? null;
}

const priceView = (row: Record<string, unknown>): ProductPriceView => ({
  planId: String(row.plan_id) === '' ? null : String(row.plan_id),
  territory: String(row.territory),
  currency: String(row.currency),
  amount: String(row.amount),
  display: formatMinor(String(row.amount), String(row.currency)),
});

type Row = Record<string, unknown>;

function summaryOf(
  row: Row,
  localizations: readonly { locale: string; name: string }[],
  prices: readonly ProductPriceView[],
): ProductSummary {
  const preferred =
    localizations.find((l) => sameLocale(l.locale, 'en-US')) ??
    localizations.find((l) => l.locale.toLowerCase().startsWith('en')) ??
    localizations[0];
  return {
    productId: String(row.product_id),
    kind: String(row.kind) as StoreProductKind,
    referenceName: String(row.reference_name),
    state: String(row.state) as StoreProductState,
    rawState: text(row.raw_state),
    group: text(row.group_name),
    period: text(row.period),
    name: preferred?.name ?? null,
    locales: localizations.map((l) => l.locale),
    price: headlinePrice(prices, text(row.base_territory)),
    territoryCount: new Set(prices.map((p) => p.territory)).size,
    syncedAt: Number(row.synced_at),
  };
}

export async function listStoredProducts(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<ProductSummary[]> {
  const products = await sql.query(
    'SELECT * FROM store_products WHERE app_id = ? AND workspace_id = ? ORDER BY reference_name, product_id',
    [appId, workspaceId],
  );
  if (products.length === 0) return [];
  const locales = await sql.query(
    'SELECT product_id, locale, name FROM store_product_localizations WHERE app_id = ? AND workspace_id = ? ORDER BY locale',
    [appId, workspaceId],
  );
  const prices = await sql.query(
    'SELECT product_id, plan_id, territory, currency, amount FROM store_product_prices WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  const localesBy = new Map<string, { locale: string; name: string }[]>();
  for (const l of locales) {
    const list = localesBy.get(String(l.product_id)) ?? [];
    list.push({ locale: String(l.locale), name: String(l.name) });
    localesBy.set(String(l.product_id), list);
  }
  const pricesBy = new Map<string, ProductPriceView[]>();
  for (const p of prices) {
    const list = pricesBy.get(String(p.product_id)) ?? [];
    list.push(priceView(p));
    pricesBy.set(String(p.product_id), list);
  }
  return products.map((row) => {
    const id = String(row.product_id);
    return summaryOf(row, localesBy.get(id) ?? [], pricesBy.get(id) ?? []);
  });
}

/** The stored row of one product, with what the write needs to name it to the store. */
export async function readStoredProductRef(
  sql: Sql,
  workspaceId: string,
  appId: string,
  productId: string,
): Promise<
  | {
      productId: string;
      kind: StoreProductKind;
      storeRef: string | null;
      referenceName: string;
      locales: { locale: string; name: string; description: string }[];
    }
  | undefined
> {
  const [row] = await sql.query(
    'SELECT product_id, kind, store_ref, reference_name FROM store_products WHERE app_id = ? AND workspace_id = ? AND product_id = ?',
    [appId, workspaceId, productId],
  );
  if (!row) return undefined;
  const locales = await sql.query(
    'SELECT locale, name, description FROM store_product_localizations WHERE app_id = ? AND workspace_id = ? AND product_id = ? ORDER BY locale',
    [appId, workspaceId, productId],
  );
  return {
    productId: String(row.product_id),
    kind: String(row.kind) as StoreProductKind,
    storeRef: text(row.store_ref),
    referenceName: String(row.reference_name),
    locales: locales.map((l) => ({
      locale: String(l.locale),
      name: String(l.name),
      description: String(l.description),
    })),
  };
}

export async function getStoredProduct(
  sql: Sql,
  workspaceId: string,
  appId: string,
  productId: string,
): Promise<ProductDetail | undefined> {
  const [row] = await sql.query(
    'SELECT * FROM store_products WHERE app_id = ? AND workspace_id = ? AND product_id = ?',
    [appId, workspaceId, productId],
  );
  if (!row) return undefined;
  const localizations = (
    await sql.query(
      'SELECT locale, name, description FROM store_product_localizations WHERE app_id = ? AND workspace_id = ? AND product_id = ? ORDER BY locale',
      [appId, workspaceId, productId],
    )
  ).map((l) => ({
    locale: String(l.locale),
    name: String(l.name),
    description: String(l.description),
  }));
  const prices = (
    await sql.query(
      'SELECT plan_id, territory, currency, amount FROM store_product_prices WHERE app_id = ? AND workspace_id = ? AND product_id = ? ORDER BY plan_id, territory',
      [appId, workspaceId, productId],
    )
  ).map(priceView);
  const detail = parseJson<{
    plans?: ProductDetail['plans'];
    offers?: ProductDetail['offers'];
  }>(row.detail_json, {});
  return {
    ...summaryOf(row, localizations, prices),
    baseTerritory: text(row.base_territory),
    localizations,
    prices,
    availability: parseJson<ProductDetail['availability']>(row.availability_json, null),
    plans: detail.plans ?? [],
    offers: detail.offers ?? [],
  };
}
