import { createTestLimiter } from '../../services/credential-tests.ts';
import type { ServerModule } from '../module.ts';
import { revenueCatRoutes } from './routes.ts';

// The seam every RevenueCat feature uses to reach RevenueCat: a client for one credential, and the response for an error (client.ts).
export {
  type RevenueCatClientResult,
  type RevenueCatUse,
  revenueCatClientFor,
  revenueCatFailure,
} from './client.ts';
export {
  getRevenueCatMetrics,
  type RevenueCatMetricsAnswer,
  type RevenueCatMetricsView,
} from './metrics.ts';
export { type RevenueCatStep, type RevenueCatSyncContext, revenueCatStep } from './sync.ts';

/**
 * RevenueCat next to the store products (docs/adr/0039-revenuecat.md, docs/api/revenuecat.md): the link between an app and a RevenueCat
 * project and app, a cached copy of the project configuration, and the join to the stored store products. Read only toward RevenueCat.
 * The sync also runs as the second step of "Sync products" (modules/monetization). Nothing here calls RevenueCat unless a workspace has
 * a RevenueCat credential and an app linked to a project.
 */
export type RevenueCatDeps = {
  /** Replaces the network for every call to RevenueCat (tests use a fake). */
  fetch?: typeof fetch | undefined;
  /** Default https://api.revenuecat.com. Tests and self-hosted proxies set it. */
  apiOrigin?: string | undefined;
  /** Per request, in milliseconds (default 15000). */
  requestTimeoutMs?: number | undefined;
  /** The whole sync, in milliseconds (default 120000). */
  syncTimeoutMs?: number | undefined;
  /** How many requests one client may send (default 45, under RevenueCat's 60 a minute for the project configuration). */
  maxRequests?: number | undefined;
};

export const revenuecatModule: ServerModule<RevenueCatDeps> = {
  id: 'revenuecat',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    app.route(
      '/api/workspaces',
      revenueCatRoutes({
        db,
        masterKey,
        now,
        deps,
        // A standalone sync is the same kind of request as a product sync: the budget of the app sync.
        syncLimiter: shared.appSyncLimiter,
        linkLimiter: createTestLimiter({ limit: 20, now }),
      }),
    );
  },
};
