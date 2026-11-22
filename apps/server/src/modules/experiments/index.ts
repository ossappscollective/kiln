import type { ServerModule } from '../module.ts';
import { experimentsRoutes } from './routes.ts';
import {
  DEFAULT_EXPERIMENTS_SYNC_TIMEOUT_MS,
  defaultExperimentsConnectorFactory,
  type ExperimentsConnectorFactory,
} from './shared.ts';

export type { ExperimentsConnectorFactory } from './shared.ts';

/**
 * Store experiments and custom product pages (docs/adr/0048-store-experiments.md, docs/api/experiments.md): Apple's Product Page Optimization
 * experiments and custom product pages read from App Store Connect into a stored copy (a sync, read-only toward the store), shown per app, and a
 * manual tracker for what no API exposes (Google Play). No write to a store exists: the design for one is in the ADR. The seams below are what
 * tests replace.
 */
export type ExperimentsDeps = {
  read?:
    | {
        connectorFactory?: ExperimentsConnectorFactory | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
};

export const experimentsModule: ServerModule<ExperimentsDeps> = {
  id: 'experiments',
  mount(app, services, deps, shared) {
    const { db, masterKey, now } = services;
    app.route(
      '/api/workspaces',
      experimentsRoutes({
        db,
        masterKey,
        now,
        // The budget of the app sync: an experiments sync is the same kind of request.
        limiter: shared.appSyncLimiter,
        readFactory: deps?.read?.connectorFactory ?? defaultExperimentsConnectorFactory,
        readTimeoutMs: deps?.read?.timeoutMs ?? DEFAULT_EXPERIMENTS_SYNC_TIMEOUT_MS,
      }),
    );
  },
};
