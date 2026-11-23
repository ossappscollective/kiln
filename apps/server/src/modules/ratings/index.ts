import type { ServerModule } from '../module.ts';
import { ratingsRoutes } from './routes.ts';

/**
 * The ratings history and app health (docs/adr/0052-ratings-and-health.md): Kiln's own daily record of an app's rating per country, new ratings
 * worked out from it, and crashes and freezes by version from the stored analytics. The record is written by the review sync (modules/reviews/
 * sync.ts calls `recordAppleRatings` and `evaluateHealth`); the routes only read stored data.
 */
export const ratingsModule: ServerModule<undefined> = {
  id: 'ratings',
  mount(app, services) {
    app.route('/api/workspaces', ratingsRoutes({ db: services.db, now: services.now }));
  },
};
