import type { ServerModule } from '../module.ts';
import { ciRoutes } from './routes.ts';

/**
 * CI (docs/api/ci.md): the workflows, dispatches and runs of a repository, the build conventions and the matching of runs to
 * builds. Its context (`shared.ci`, built from `AppDeps.ci`: limiter, build matchers, poll time) is also what the builds module
 * reads, so this module is a dependency of builds.
 */
export const ciModule: ServerModule<undefined> = {
  id: 'ci',
  mount(app, _services, _deps, shared) {
    app.route('/api/workspaces', ciRoutes(shared.ci));
  },
};
