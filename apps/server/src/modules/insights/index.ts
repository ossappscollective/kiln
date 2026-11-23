import type { ServerModule } from '../module.ts';
import { insightsRoutes } from './routes.ts';

/**
 * Insights cards, store page checks and country language coverage of an app (docs/adr/0051-insights.md, docs/api/insights.md): computed on
 * read from what Kiln stores by the pure engine in `@kiln/core`; nothing reaches a store. Only the dismissal of a card is stored.
 */
export const insightsModule: ServerModule<undefined> = {
  id: 'insights',
  mount(app, services) {
    app.route('/api/workspaces', insightsRoutes({ db: services.db, now: services.now }));
  },
};
