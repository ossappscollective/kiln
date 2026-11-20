import type { ServerModule } from '../module.ts';
import { releasePipelineRoutes } from './pipeline-routes.ts';
import { planRoutes } from './routes.ts';

/**
 * Release planning (docs/api/plans.md): our own checklists, notes and deadlines per release, the reminders and the
 * stalled-release watch, and where a release is between CI and live (read-only, from stored data). No store is read or written.
 */
export const planningModule: ServerModule<undefined> = {
  id: 'planning',
  mount(app, { db, now }) {
    app.route('/api/workspaces', releasePipelineRoutes({ db, now }));
    app.route('/api/workspaces', planRoutes({ db, now }));
  },
};
