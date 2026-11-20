import type { ServerModule } from '../module.ts';
import { internalSharingRoutes } from './internal-sharing-routes.ts';
import { buildsRoutes, publicBuildsRoutes } from './routes.ts';
import { type BuildsSettings, createBuildsContext } from './service.ts';

/**
 * Builds to test (docs/api/builds.md): CI artifacts and store builds of an app. Listing always works; downloading them and the
 * links that hand one to a phone answer `409 builds_download_disabled` unless `downloadEnabled` (MRM_BUILDS_DOWNLOAD_ENABLED).
 * Uploading an Android build to Google Play internal app sharing (docs/api/internal-sharing.md) is off unless
 * `internalSharingEnabled` (MRM_PLAY_INTERNAL_SHARING_ENABLED). Needs the CI module (`shared.ci`).
 */
export type BuildsDeps = Partial<BuildsSettings>;

export const buildsModule: ServerModule<BuildsDeps> = {
  id: 'builds',
  mount(app, _services, deps, shared) {
    const context = createBuildsContext(shared.ci, deps);
    app.route('/api/workspaces', buildsRoutes(context));
    app.route('/api/workspaces', internalSharingRoutes(context));
    app.route('/api/builds', publicBuildsRoutes(context));
  },
};
