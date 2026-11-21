import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { ServerModule } from '../module.ts';
import { analyticsRoutes } from './routes.ts';
import {
  type AnalyticsConnectorFactory,
  DEFAULT_ANALYTICS_TIMEOUT_MS,
  defaultAnalyticsConnectors,
} from './sync.ts';

/**
 * Analytics (docs/api/analytics.md): daily metrics read from the stores into a normalised store. `connectors` builds the Apple
 * Analytics Reports / Sales and Trends and Google Play vitals / reports readers from a stored credential (fakes in tests),
 * `timeoutMs` is the longest one source may take (default 120 seconds), `limiter` the per workspace budget of syncs, previews and
 * imports a minute (default 10), `intervalMinutes` is KILN_ANALYTICS_INTERVAL_MINUTES, shown by the status.
 */
export type AnalyticsDeps = {
  connectors?: AnalyticsConnectorFactory;
  timeoutMs?: number;
  limiter?: TestLimiter;
  intervalMinutes?: number;
};

// Reading what is stored is open to every role; syncing, importing and enabling Apple analytics need analytics.manage.
// A workspace must turn on analytics.enabled before anything is requested from a store.
export const analyticsModule: ServerModule<AnalyticsDeps> = {
  id: 'analytics',
  mount(app, services, deps) {
    app.route(
      '/api/workspaces',
      analyticsRoutes({
        db: services.db,
        masterKey: services.masterKey,
        now: services.now,
        connectors: deps?.connectors ?? defaultAnalyticsConnectors,
        timeoutMs: deps?.timeoutMs ?? DEFAULT_ANALYTICS_TIMEOUT_MS,
        limiter: deps?.limiter ?? createTestLimiter({ now: services.now }),
        intervalMinutes: deps?.intervalMinutes ?? 0,
      }),
    );
  },
};
