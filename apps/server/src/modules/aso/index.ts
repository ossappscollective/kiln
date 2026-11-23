import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { StoreImageNet } from '../listing/store-image-net.ts';
import type { ServerModule } from '../module.ts';
import { type AsoSources, createAsoSources } from './net.ts';
import { asoRoutes } from './routes.ts';
import { type AsoLimits, DEFAULT_ASO_LIMITS } from './service.ts';

/**
 * ASO, keyword ranks and competitors from public store data (docs/api/aso.md). `sources` reads the stores (a fake in
 * tests; index.ts builds one and shares it with the worker, so the cache and the rate limits are shared);
 * `limits` are the KILN_ASO_* values; `limiter` is the per workspace budget of refreshes and lookups (default 10 a minute).
 */
export type AsoDeps = {
  sources?: AsoSources;
  limits?: Partial<AsoLimits>;
  limiter?: TestLimiter;
  /** Address checks and the exchange of the competitor image proxy (tests). */
  net?: StoreImageNet;
  imageLimiter?: TestLimiter;
  maxRunMs?: number;
};

/** The limits in force (also needed by the AI assistant, which budgets ASO suggestions the same way). */
export const asoLimitsFor = (deps: AsoDeps | undefined): AsoLimits => ({
  ...DEFAULT_ASO_LIMITS,
  ...(deps?.limits ?? {}),
});

// ASO: keyword ranks and competitors from public store data. Google Play only when KILN_ASO_PLAY_UNOFFICIAL_ENABLED.
export const asoModule: ServerModule<AsoDeps> = {
  id: 'aso',
  mount(app, services, deps) {
    app.route(
      '/api/workspaces',
      asoRoutes({
        db: services.db,
        now: services.now,
        sources:
          deps?.sources ??
          createAsoSources({
            playEnabled: false,
            now: services.now,
            cacheMs: 60 * 60_000,
            appleCallsPerMinute: 10,
            playCallsPerMinute: 4,
          }),
        limits: asoLimitsFor(deps),
        ...(deps?.maxRunMs !== undefined ? { maxRunMs: deps.maxRunMs } : {}),
        limiter: deps?.limiter ?? createTestLimiter({ now: services.now }),
        ...(deps?.net ? { net: deps.net } : {}),
        ...(deps?.imageLimiter ? { imageLimiter: deps.imageLimiter } : {}),
      }),
    );
  },
};
