import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { createAppIcons, type IconsContext } from '../../services/app-icons.ts';
import type { ServerModule } from '../module.ts';
import { assetRoutes } from './asset-routes.ts';
import { type AssetSyncRoutesContext, assetSyncRoutes } from './asset-sync-routes.ts';
import { listingRoutes } from './routes.ts';

/**
 * The store listing of an app and its media (docs/api/listing.md, docs/api/assets.md). Live listing, drift and history read the
 * tool's own database (only `repo-refresh` reads GitHub); the Assets tab reads media files from the repository and the icon of an
 * app; the two way sync of graphics compares the store's images with the repository and pulls them into a change set. Nothing here
 * writes to a store. Staging and pushing a draft are a different feature (the staged routes) that shares `shared.repo` and
 * `shared.assetsLimiter`.
 *
 * `listing.intervalMs` is MRM_LISTING_INTERVAL_MINUTES in milliseconds, shown so the Listing tab can say when the next read is due.
 * `assets.limiter` is the per workspace limit of index reads that miss the cache (default 30 a minute), `assets.icons` the icon
 * lookup's limiter and network seam. `assetSync` replaces the CDN exchange and the limiters of the graphics sync (tests).
 * `draft` is the store draft's connector, which the graphics sync reads.
 */
export type ListingDeps = {
  listing?: { intervalMs?: number | undefined } | undefined;
  assets?: { limiter?: TestLimiter | undefined; icons?: Pick<IconsContext, 'limiter' | 'net'> | undefined } | undefined;
  assetSync?: Pick<AssetSyncRoutesContext, 'net' | 'storeLimiter' | 'fetchLimiter' | 'uploadLimiter'> | undefined;
  draft?: AssetSyncRoutesContext['draft'] | undefined;
};

export const listingModule: ServerModule<ListingDeps> = {
  id: 'listing',
  mount(app, services, deps, shared) {
    app.route(
      '/api/workspaces',
      listingRoutes({
        db: services.db,
        now: services.now,
        repo: shared.repo,
        limiter: createTestLimiter({ now: services.now }),
        sync: { apps: shared.apps, limiter: shared.appSyncLimiter },
        ...(deps?.listing?.intervalMs ? { listingIntervalMs: deps.listing.intervalMs } : {}),
      }),
    );
    app.route(
      '/api/workspaces',
      assetRoutes({
        db: services.db,
        now: services.now,
        repo: shared.repo,
        limiter: shared.assetsLimiter,
        icons: createAppIcons({
          db: services.db,
          now: services.now,
          repo: shared.repo,
          ...(deps?.assets?.icons?.limiter ? { limiter: deps.assets.icons.limiter } : {}),
          ...(deps?.assets?.icons?.net ? { net: deps.assets.icons.net } : {}),
        }),
      }),
    );
    app.route(
      '/api/workspaces',
      assetSyncRoutes({
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        repo: shared.repo,
        limiter: shared.assetsLimiter,
        ...(deps?.draft ? { draft: deps.draft } : {}),
        ...(deps?.assetSync ?? {}),
      }),
    );
  },
};
