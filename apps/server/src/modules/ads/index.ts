import { createTestLimiter } from '../../services/credential-tests.ts';
import type { ServerModule } from '../module.ts';
import { adsRoutes } from './routes.ts';

export { type AdsClientResult, type AdsUse, adsClientFor, adsFailure } from './client.ts';
export { ADS_SYNC_QUEUE, type AdsSyncPayload, createAdsSyncHandler, runAdsSync } from './sync.ts';

/**
 * Apple Ads, read only (docs/adr/0058-apple-ads.md, docs/api/apple-ads.md): the link between an app and an Apple Ads ad account and
 * the app it promotes, a sync of the campaign, search term and keyword reports into the database (the `ads.sync` job), and the views
 * of Insights, Ads. Search term impressions also feed the keyword popularity estimate (modules/aso/estimates.ts). Nothing here calls
 * Apple unless a workspace has an Apple Ads credential and an app linked to an ad account, and nothing here can create or change a
 * campaign: the connector has no such method.
 */
export type AdsDeps = {
  /** Replaces the network for every call to Apple (tests use a fake). */
  fetch?: typeof fetch | undefined;
  /** Default https://api.ads.apple.com. Tests and a proxy set it. */
  apiOrigin?: string | undefined;
  /** Default https://appleid.apple.com. */
  tokenOrigin?: string | undefined;
  /** Replaces waiting (tests). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** The whole sync, in milliseconds (default 240000). */
  syncTimeoutMs?: number | undefined;
};

export const adsModule: ServerModule<AdsDeps> = {
  id: 'ads',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    app.route(
      '/api/workspaces',
      adsRoutes({ db, masterKey, now, deps, limiter: createTestLimiter({ limit: 20, now }), syncLimiter: shared.appSyncLimiter }),
    );
  },
};
