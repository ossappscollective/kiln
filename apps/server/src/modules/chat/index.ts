import type { ServerModule } from '../module.ts';
import { type ChatRoutesContext, chatRoutes } from './routes.ts';

/**
 * Chat integrations (docs/chat-integrations.md, ADR 0047): Slack and Microsoft Teams destinations, their routing rules, the daily
 * summary and the delivery log. Alerts reach them through `raiseAlert` (modules/alerts/service.ts calls `routeAlertToChat`); the
 * worker sends them (`createChatDeliveryHandler`, queue `chat.deliver`).
 */
export type ChatDeps = Partial<Pick<ChatRoutesContext, 'allowPrivate' | 'resolve' | 'send' | 'timeoutMs' | 'limiter'>>;

export const chatModule: ServerModule<ChatDeps> = {
  id: 'chat',
  mount(app, services, deps) {
    app.route(
      '/api/workspaces',
      chatRoutes({ db: services.db, masterKey: services.masterKey, now: services.now, ...(deps ?? {}) }),
    );
  },
};
