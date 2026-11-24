import type { ServerModule } from '../module.ts';
import { type RevenueCatDeps, revenueCatStep } from '../revenuecat/index.ts';
import { buildPriceContext, type PriceDeps } from './price-shared.ts';
import { monetizationRoutes } from './routes.ts';
import {
  DEFAULT_PRODUCT_CLAIM_TTL_MS,
  DEFAULT_PRODUCT_SYNC_TIMEOUT_MS,
  DEFAULT_PRODUCT_WRITE_TIMEOUT_MS,
  defaultProductsConnectorFactory,
  defaultProductWriteConnectorFactory,
  type ProductsConnectorFactory,
  type ProductWriteConnectorFactory,
} from './shared.ts';

export {
  PRODUCT_WRITE_ENV,
  type ProductsConnectorFactory,
  type ProductWriteConnectorFactory,
} from './shared.ts';

/**
 * In-app purchases and subscriptions (docs/adr/0034-in-app-products.md, docs/api/products.md): read from App Store Connect and Google Play into
 * a stored copy (a sync, read-only toward the stores), shown per app, with ONE gated write, the localized display name and description of a
 * product. Prices and availability are read, never written. The seams below are what tests replace; production sets only the write switch.
 */
export type MonetizationDeps = {
  /** Reading the products (the sync). `connectorFactory` builds the read-only connector (fakes in tests); `timeoutMs` is for tests. */
  read?:
    | {
        connectorFactory?: ProductsConnectorFactory | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
  /**
   * Changing a localization (KILN_STORE_PRODUCT_WRITE_ENABLED): OFF unless `enabled`. `connectorFactory` builds the connector that can read and
   * write one localization (fakes in tests); `timeoutMs` and `claimTtlMs` are for tests.
   */
  write?:
    | {
        enabled?: boolean | undefined;
        connectorFactory?: ProductWriteConnectorFactory | undefined;
        timeoutMs?: number | undefined;
        claimTtlMs?: number | undefined;
      }
    | undefined;
  /** Price changes (docs/adr/0062-price-writes.md): the stage, price point, convert and dry run routes. The same object the cart gets. */
  price?: PriceDeps | undefined;
  /** The seams of the RevenueCat read that follows the store read of a sync (the same as `AppDeps.revenuecat`). */
  revenueCat?: RevenueCatDeps | undefined;
};

export const monetizationModule: ServerModule<MonetizationDeps> = {
  id: 'monetization',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    app.route(
      '/api/workspaces',
      monetizationRoutes({
        price: buildPriceContext({ db, masterKey, now }, deps?.price),
        db,
        masterKey,
        now,
        // The budget of the app sync: a product sync is the same kind of request.
        limiter: shared.appSyncLimiter,
        readFactory: deps?.read?.connectorFactory ?? defaultProductsConnectorFactory,
        readTimeoutMs: deps?.read?.timeoutMs ?? DEFAULT_PRODUCT_SYNC_TIMEOUT_MS,
        writeEnabled: deps?.write?.enabled ?? false,
        writeFactory: deps?.write?.connectorFactory ?? defaultProductWriteConnectorFactory,
        writeTimeoutMs: deps?.write?.timeoutMs ?? DEFAULT_PRODUCT_WRITE_TIMEOUT_MS,
        claimTtlMs: deps?.write?.claimTtlMs ?? DEFAULT_PRODUCT_CLAIM_TTL_MS,
        revenueCatStep: (input) =>
          revenueCatStep({ db, masterKey, now, deps: deps?.revenueCat }, input),
      }),
    );
  },
};
