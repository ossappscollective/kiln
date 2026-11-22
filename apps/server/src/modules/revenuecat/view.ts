import {
  joinRevenueCat,
  type JoinStoreProduct,
  type MatchedProduct,
  type ProductRevenueCat,
  type RevenueCatWarning,
} from '@kiln/connectors';
import type { Sql } from '@kiln/db';
import { type RevenueCatLinkView, getRevenueCatLink } from './link.ts';
import {
  readRevenueCatCache,
  readRevenueCatSyncStatus,
  type RevenueCatSyncStatus,
} from './snapshot.ts';

/**
 * What the Products page shows of RevenueCat: the stored store products joined to the stored RevenueCat configuration, and the
 * warnings that follow (docs/adr/0039-revenuecat.md). Computed on every read from the two copies, never stored, and it asks neither
 * the store nor RevenueCat. Configuration facts only: no money, no customers.
 */

export type RevenueCatProductsView = {
  /** Null when the app has no link: the page shows how to connect. */
  link: RevenueCatLinkView | null;
  /** Null before the first RevenueCat sync. */
  sync: RevenueCatSyncStatus | null;
  /** By store product id; empty before the first RevenueCat sync (nothing is claimed). */
  products: Record<string, ProductRevenueCat>;
  /** RevenueCat products of the linked app that match no store product. */
  unmatched: MatchedProduct[];
  warnings: RevenueCatWarning[];
};

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The stored store products, with what the join needs (state, kind, Google Play base plans), and whether that copy is complete. */
async function readStoreSide(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<{ products: JoinStoreProduct[]; synced: boolean; complete: boolean }> {
  const [sync] = await sql.query(
    'SELECT last_synced_at, complete FROM store_product_sync WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  const rows: Row[] = await sql.query(
    'SELECT product_id, kind, reference_name, state, detail_json FROM store_products WHERE app_id = ? AND workspace_id = ? ORDER BY product_id',
    [appId, workspaceId],
  );
  return {
    synced: sync !== undefined && sync.last_synced_at !== null && sync.last_synced_at !== undefined,
    complete: sync !== undefined && Number(sync.complete) === 1,
    products: rows.map((r) => ({
      productId: String(r.product_id),
      kind: String(r.kind),
      referenceName: String(r.reference_name),
      state: String(r.state),
      plans: parseJson<{ plans?: { id: string; state: string }[] }>(r.detail_json, {}).plans ?? [],
    })),
  };
}

export async function getRevenueCatProductsView(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<RevenueCatProductsView> {
  const link = await getRevenueCatLink(sql, workspaceId, appId);
  if (!link) return { link: null, sync: null, products: {}, unmatched: [], warnings: [] };
  const sync = await readRevenueCatSyncStatus(sql, workspaceId, appId);
  // Before the first good RevenueCat read there is no copy: nothing is joined and nothing is claimed.
  if (!sync || sync.lastSyncedAt === null)
    return { link, sync, products: {}, unmatched: [], warnings: [] };
  const [store, cache] = await Promise.all([
    readStoreSide(sql, workspaceId, appId),
    readRevenueCatCache(sql, workspaceId, appId),
  ]);
  const joined = joinRevenueCat({
    storeProducts: store.products,
    storeSynced: store.synced,
    storeComplete: store.complete,
    rcProducts: cache.products,
    entitlements: cache.entitlements,
    offerings: cache.offerings,
    rcComplete: sync.complete,
  });
  return {
    link,
    sync,
    products: Object.fromEntries(joined.byProduct),
    unmatched: joined.unmatched,
    warnings: joined.warnings,
  };
}
