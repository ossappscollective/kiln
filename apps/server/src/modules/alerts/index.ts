import type { ServerModule } from '../module.ts';
import { alertRoutes } from './routes.ts';

/**
 * Alerts (docs/api/alerts.md): the inbox, a person's choices, the workspace rules and the delivery log. The module has no seams
 * to replace; other features raise alerts through `./service.ts` (`raiseAlert`, `observeEventForAlerts`), and the worker sends
 * the email.
 */
export const alertsModule: ServerModule<undefined> = {
  id: 'alerts',
  mount(app, services) {
    app.route('/api/workspaces', alertRoutes({ db: services.db, now: services.now }));
  },
};
