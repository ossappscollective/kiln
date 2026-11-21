import { StoreRateLimitError } from '@kiln/connectors';
import { supports } from '@kiln/core';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { storeFor } from '../reviews/sync.ts';
import {
  type Actor,
  type Connection,
  connect,
  type MonetizationContext,
  mapStoreError,
  notSupportedFailure,
  PRODUCT_SYNC_PURPOSE,
  StoreTimeout,
  timeoutFailure,
  withConnector,
} from './shared.ts';
import {
  getStoredProduct,
  listStoredProducts,
  type ProductDetail,
  type ProductSummary,
  type ProductSyncStatus,
  readSyncStatus,
  recordSyncFailure,
  replaceSnapshot,
} from './snapshot.ts';

/**
 * Reading the in-app purchases and subscriptions of an app from its store, keeping a copy, and showing it (docs/api/products.md,
 * docs/adr/0034-in-app-products.md). READ ONLY: a sync asks the store for lists and details and changes nothing there. A sync is a
 * request of a person (`apps.sync`), counted against the same per workspace budget as the app sync. A failed sync keeps the last good copy and
 * says what went wrong; a half-read store never replaces a good copy (the connectors fail the whole read when a part of it fails).
 */

export type ProductsView = {
  app: { id: string; name: string; platform: ManagedApp['platform']; store: string };
  /** False for a platform whose store has no in-app purchases here: the list is empty and a sync is refused. */
  supported: boolean;
  products: ProductSummary[];
  /** Null before the first sync. */
  sync: ProductSyncStatus | null;
  write: { enabled: boolean; envName: string };
};

const appView = (app: ManagedApp) => ({
  id: app.id,
  name: app.name,
  platform: app.platform,
  store: storeFor(app.platform),
});

export async function listProducts(
  ctx: MonetizationContext,
  input: { workspaceId: string; appId: string },
): Promise<{ ok: true; view: ProductsView } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const supported = supports(app.platform, 'inAppPurchases');
  return {
    ok: true,
    view: {
      app: appView(app),
      supported,
      products: supported ? await listStoredProducts(ctx.db, input.workspaceId, app.id) : [],
      sync: supported ? await readSyncStatus(ctx.db, input.workspaceId, app.id) : null,
      write: { enabled: ctx.writeEnabled, envName: 'MRM_STORE_PRODUCT_WRITE_ENABLED' },
    },
  };
}

export async function getProduct(
  ctx: MonetizationContext,
  input: { workspaceId: string; appId: string; productId: string },
): Promise<
  | { ok: true; app: ProductsView['app']; product: ProductDetail; sync: ProductSyncStatus | null }
  | Failure
> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const product = await getStoredProduct(ctx.db, input.workspaceId, app.id, input.productId);
  if (!product) return failure(404, 'product_not_found', 'No such product. Sync the app first.');
  return {
    ok: true,
    app: appView(app),
    product,
    sync: await readSyncStatus(ctx.db, input.workspaceId, app.id),
  };
}

export type SyncResult = {
  app: ProductsView['app'];
  products: number;
  complete: boolean;
  warnings: string[];
  syncedAt: number;
};

/**
 * The sync of one app. The route has already checked the app exists and counted the request against the budget (`takeSyncSlot`).
 * Nothing is changed in the store.
 */
const readAll = (ctx: MonetizationContext, input: Connection['input']) =>
  withConnector(ctx.readFactory, input, ctx.readTimeoutMs, (connector) => connector.listProducts());

export async function syncProducts(
  ctx: MonetizationContext,
  input: { workspaceId: string; appId: string; actor: Actor },
): Promise<{ ok: true; result: SyncResult } | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  if (!supports(app.platform, 'inAppPurchases')) return notSupportedFailure();
  const at = ctx.now();
  /** A failure to reach the store's data (the credential, the read): kept on the app so the screen says what went wrong, and answered. */
  const failed = async (f: Failure, record: boolean): Promise<Failure> => {
    if (record) {
      await recordSyncFailure(ctx.db, {
        workspaceId: input.workspaceId,
        appId: app.id,
        message: String(f.body.message ?? f.body.error),
        at,
      });
    }
    return f;
  };

  const connected = await connect(ctx, input.workspaceId, app, PRODUCT_SYNC_PURPOSE, input.actor);
  if (!connected.ok) return failed(connected, true);
  const { connection } = connected;
  let result: Awaited<ReturnType<typeof readAll>>;
  try {
    result = await readAll(ctx, connection.input);
  } catch (error) {
    if (error instanceof StoreTimeout) {
      return failed(timeoutFailure(), true);
    }
    const mapped = mapStoreError(error, connection.secret);
    // A rate limit is the store asking to wait: the answer says so, and it counts as a failed sync only in the text, not in the streak.
    return failed(mapped.failure, !(error instanceof StoreRateLimitError));
  }

  await ctx.db.transaction(async (tx) => {
    await replaceSnapshot(tx, { workspaceId: input.workspaceId, appId: app.id, result, at });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'monetization.synced',
      target: { type: 'app', id: app.id },
      // Counts only: never a product text, a price or a store response.
      detail: {
        appId: app.id,
        store: storeFor(app.platform),
        products: result.products.length,
        complete: result.complete,
        warnings: result.warnings.length,
      },
      at,
    });
  });
  return {
    ok: true,
    result: {
      app: appView(app),
      products: result.products.length,
      complete: result.complete,
      warnings: result.warnings,
      syncedAt: at,
    },
  };
}
