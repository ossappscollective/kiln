import { randomUUID } from 'node:crypto';
import type { Sql } from '@kiln/db';
import { type AlertData, type AlertSeverity, severityRank } from '../alerts/catalog.ts';
import { parseList, queueChatDelivery } from './destinations.ts';
import { buildAlertMessage } from './message.ts';
import type { ChatProvider } from './model.ts';
import { renderMessage } from './render.ts';

/**
 * Which alerts go to which chat destination (docs/chat-integrations.md). `routeAlertToChat` is called by `raiseAlert` for every NEW
 * alert (a repeat that collapsed into an earlier alert, a capped one and a test never get here), so the alert system's own rules
 * come first: the workspace rule that switches a type off, deduplication and the hourly cap. This file adds the destination's rules.
 */

export type RouteRule = {
  alertTypes: readonly string[];
  minSeverity: AlertSeverity;
  appIds: readonly string[] | null;
  platforms: readonly string[] | null;
};

export type AlertFacts = { type: string; severity: AlertSeverity; appId: string | null; platform: string | null };

/** Whether one rule takes an alert. Pure. */
export function ruleMatches(rule: RouteRule, alert: AlertFacts): boolean {
  if (!(rule.alertTypes.includes('*') || rule.alertTypes.includes(alert.type))) return false;
  if (severityRank[alert.severity] < severityRank[rule.minSeverity]) return false;
  if (rule.appIds && rule.appIds.length > 0 && (alert.appId === null || !rule.appIds.includes(alert.appId))) return false;
  if (rule.platforms && rule.platforms.length > 0 && (alert.platform === null || !rule.platforms.includes(alert.platform)))
    return false;
  return true;
}

export type RoutedAlert = {
  workspaceId: string;
  alertId: string;
  type: string;
  severity: AlertSeverity;
  appId: string | null;
  title: string;
  body: string;
  data: AlertData;
  at: number;
};

/** Writes a delivery for each enabled destination with a matching rule. Returns how many destinations took it. */
export async function routeAlertToChat(sql: Sql, a: RoutedAlert): Promise<number> {
  const destinations = await sql.query(
    "SELECT id, provider, locale, digest FROM chat_destinations WHERE workspace_id = ? AND enabled = 1",
    [a.workspaceId],
  );
  if (destinations.length === 0) return 0;
  const routes = await sql.query(
    'SELECT destination_id, alert_types, min_severity, app_ids, platforms FROM chat_routes WHERE workspace_id = ? AND enabled = 1',
    [a.workspaceId],
  );
  const facts: AlertFacts = {
    type: a.type,
    severity: a.severity,
    appId: a.appId,
    platform: typeof a.data.platform === 'string' ? a.data.platform : null,
  };
  let taken = 0;
  for (const d of destinations) {
    const id = String(d.id);
    const matched = routes.some(
      (r) =>
        String(r.destination_id) === id &&
        ruleMatches(
          {
            alertTypes: parseList(r.alert_types) ?? [],
            minSeverity: (String(r.min_severity) as AlertSeverity) ?? 'info',
            appIds: parseList(r.app_ids),
            platforms: parseList(r.platforms),
          },
          facts,
        ),
    );
    if (!matched) continue;
    taken++;
    // Like the email digest: with a daily summary on, everything below critical waits for it.
    if (String(d.digest) === 'daily' && a.severity !== 'critical') {
      await sql.execute(
        `INSERT INTO chat_deliveries (id, workspace_id, destination_id, alert_id, kind, status, outcome, attempts, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'alert', 'deferred', 'in_digest', 0, NULL, ?, ?)`,
        [randomUUID(), a.workspaceId, id, a.alertId, a.at, a.at],
      );
      continue;
    }
    const message = buildAlertMessage({
      type: a.type,
      severity: a.severity,
      title: a.title,
      body: a.body,
      data: a.data,
      locale: String(d.locale),
    });
    await queueChatDelivery(sql, {
      workspaceId: a.workspaceId,
      destinationId: id,
      alertId: a.alertId,
      kind: 'alert',
      payload: renderMessage(String(d.provider) as ChatProvider, message),
      at: a.at,
    });
  }
  return taken;
}
