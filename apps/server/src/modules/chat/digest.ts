import type { Database } from '@kiln/db';
import { type AlertData, isSeverity } from '../alerts/catalog.ts';
import { digestDue } from '../alerts/time.ts';
import { queueChatDelivery } from './destinations.ts';
import { buildDigest } from './message.ts';
import type { ChatProvider } from './model.ts';
import { renderDigest } from './render.ts';

/**
 * The daily summary of a chat destination (docs/chat-integrations.md): the alerts a destination collected while its summary was on
 * (rows `deferred` / `in_digest`; critical alerts are never held back) become one message at its hour, in its time zone. The summary
 * is one more row in the log (kind `digest`) and goes through the same job as every message. Run by the alert runner every 5 minutes.
 */

export type ChatDigestSummary = { due: number; sent: number };
const MAX_PENDING = 500;
const KEEP_DAYS = 30;

export async function sendDueChatDigests(db: Database, at: number): Promise<ChatDigestSummary> {
  const summary: ChatDigestSummary = { due: 0, sent: 0 };
  const destinations = await db.query(
    "SELECT id, workspace_id, provider, locale, digest_hour, timezone, last_digest_at FROM chat_destinations WHERE enabled = 1 AND digest = 'daily'",
  );
  for (const g of destinations) {
    const last =
      g.last_digest_at === null || g.last_digest_at === undefined ? null : Number(g.last_digest_at);
    if (
      !digestDue(
        { mode: 'daily', hour: Number(g.digest_hour), timezone: String(g.timezone), lastAt: last },
        at,
      )
    )
      continue;
    summary.due++;
    const workspaceId = String(g.workspace_id);
    const destinationId = String(g.id);
    await db.transaction(async (tx) => {
      const pending = await tx.query(
        `SELECT d.id, a.type, a.title, a.severity, a.count, a.data
           FROM chat_deliveries d JOIN alerts a ON a.id = d.alert_id
          WHERE d.destination_id = ? AND d.status = 'deferred' AND d.outcome = 'in_digest'
          ORDER BY a.first_at, a.id LIMIT ?`,
        [destinationId, MAX_PENDING],
      );
      if (pending.length > 0) {
        const items = pending.map((p) => {
          let data: AlertData = {};
          try {
            data = JSON.parse(String(p.data ?? '{}')) as AlertData;
          } catch {
            // A broken row only loses its link.
          }
          const severity = String(p.severity);
          return {
            type: String(p.type),
            severity: isSeverity(severity) ? severity : ('info' as const),
            title: String(p.title),
            data,
            count: Number(p.count),
          };
        });
        const digest = buildDigest({ items, total: items.length, locale: String(g.locale) });
        await queueChatDelivery(tx, {
          workspaceId,
          destinationId,
          alertId: null,
          kind: 'digest',
          payload: renderDigest(String(g.provider) as ChatProvider, digest),
          at,
        });
        const marks = pending.map(() => '?').join(', ');
        await tx.execute(
          `UPDATE chat_deliveries SET status = 'sent', outcome = 'digest_sent', updated_at = ?, delivered_at = ? WHERE id IN (${marks})`,
          [at, at, ...pending.map((p) => String(p.id))],
        );
        summary.sent++;
      }
      await tx.execute('UPDATE chat_destinations SET last_digest_at = ? WHERE id = ?', [
        at,
        destinationId,
      ]);
    });
  }
  // The log keeps 30 days of finished messages.
  await db.execute(
    "DELETE FROM chat_deliveries WHERE created_at < ? AND status IN ('sent', 'failed', 'skipped')",
    [at - KEEP_DAYS * 86_400_000],
  );
  return summary;
}
