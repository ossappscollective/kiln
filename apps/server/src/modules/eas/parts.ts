import type { Hono } from 'hono';
import type { AppEnv, Services } from '../../http.ts';
import type { ModuleShared } from '../module.ts';
import { easConfigPart } from './config-routes.ts';
import type { EasDeps } from './index.ts';
import { easLinkRoutes } from './link-routes.ts';

/** One piece of the EAS module: it mounts its routes. Each feature adds one entry to `easParts` and one array to `easOperations`. */
export type EasPart = (
  app: Hono<AppEnv>,
  services: Services,
  deps: EasDeps | undefined,
  shared: ModuleShared,
) => void;

/** The mounts of the EAS module, in order. Add yours with one import and one entry. */
export const easParts: EasPart[] = [
  // The link between an app and its EAS project (link.ts): GET, PUT, DELETE and detect of /apps/:appId/expo.
  (app, services, deps, shared) => {
    app.route('/api/workspaces', easLinkRoutes(services, deps, shared));
  },
  // The read of eas.json and the app config of an app (config.ts): GET /apps/:appId/eas-config.
  easConfigPart,
];
