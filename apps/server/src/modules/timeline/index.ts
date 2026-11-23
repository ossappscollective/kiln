import type { ServerModule } from '../module.ts';
import { timelineRoutes } from './routes.ts';

/**
 * Timeline and reports (docs/adr/0053-timeline-and-reports.md): events from Kiln and from people on one chart, "what happened around it",
 * and weekly, monthly and yearly reports. Read from what is stored; a person's own events are Kiln's own data. No seams: nothing here
 * reaches a store or a provider.
 */
export const timelineModule: ServerModule<undefined> = {
  id: 'timeline',
  mount(app, services) {
    app.route('/api/workspaces', timelineRoutes({ db: services.db, now: services.now }));
  },
};
