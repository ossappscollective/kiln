import type { ServerModule } from '../module.ts';
import { setAlertLinkOrigin } from './email.ts';
import { alertRoutes } from './routes.ts';

/**
 * Alerts (docs/api/alerts.md): the inbox, a person's choices, the workspace rules and the delivery log. The module has no seams
 * to replace; other features raise alerts through `./service.ts` (`raiseAlert`, `observeEventForAlerts`), and the worker sends
 * the email.
 */
export type AlertsDeps = {
  /** MRM_PUBLIC_ORIGIN: the address the links in alert emails open. Without it the emails say where to go but have no links. */
  publicOrigin?: string | undefined;
};

export const alertsModule: ServerModule<AlertsDeps> = {
  id: 'alerts',
  mount(app, services, deps) {
    setAlertLinkOrigin(deps?.publicOrigin);
    app.route('/api/workspaces', alertRoutes({ db: services.db, now: services.now }));
  },
};
