import { randomUUID } from 'node:crypto';
import type { Database } from '@kiln/db';
import { isSeverity } from './catalog-core.ts';
import { alertGuide, renderDigestEmail } from './email.ts';
import { toUserSettings } from './prefs.ts';
import { queueEmailJob } from './service.ts';
import { digestDue } from './time.ts';

/**
 * The email digest (docs/alerts.md): a person who chose "daily" or "weekly" gets the alerts their email channel collected (rows the
 * delivery log marks `in_digest`) as one message at their digest hour, in their timezone. Critical alerts are never held back. The
 * digest is one more row in the delivery log (kind `digest`) and goes through the same job as every alert email, with the same retry.
 */

export type DigestSummary = { due: number; sent: number };
const MAX_ITEMS = 100;

export async function sendDueDigests(db: Database, at: number): Promise<DigestSummary> {
  const summary: DigestSummary = { due: 0, sent: 0 };
  const people = await db.query(
    `SELECT workspace_id, user_id, min_severity, quiet_start, quiet_end, timezone, digest, digest_hour, last_digest_at
       FROM alert_user_settings WHERE digest <> 'off'`,
  );
  for (const row of people) {
    const s = toUserSettings(row);
    if (
      !digestDue(
        { mode: s.digest, hour: s.digestHour, timezone: s.timezone, lastAt: s.lastDigestAt },
        at,
      )
    )
      continue;
    summary.due++;
    const workspaceId = String(row.workspace_id);
    const userId = String(row.user_id);
    await db.transaction(async (tx) => {
      const pending = await tx.query(
        `SELECT d.id, a.title, a.severity, a.count, a.type, a.data FROM alert_deliveries d JOIN alerts a ON a.id = d.alert_id
          WHERE d.workspace_id = ? AND d.user_id = ? AND d.channel = 'email' AND d.status = 'deferred' AND d.outcome = 'in_digest'
          ORDER BY a.first_at, a.id LIMIT ?`,
        [workspaceId, userId, MAX_ITEMS],
      );
      if (pending.length > 0) {
        const mail = renderDigestEmail(
          pending.map((p) => {
            let data: Record<string, string | number | boolean | null> = {};
            try {
              data = JSON.parse(String(p.data ?? '{}')) as typeof data;
            } catch {
              // A broken row only loses its link.
            }
            const severity = String(p.severity);
            return {
              title: String(p.title),
              severity: isSeverity(severity) ? severity : 'info',
              count: Number(p.count),
              action: alertGuide(String(p.type), data).primary,
            };
          }),
        );
        const id = randomUUID();
        await tx.execute(
          `INSERT INTO alert_deliveries
             (id, workspace_id, alert_id, user_id, channel, kind, status, outcome, attempts, subject, body, html, event_id, created_at, updated_at, delivered_at)
           VALUES (?, ?, NULL, ?, 'email', 'digest', 'queued', 'ok', 0, ?, ?, ?, NULL, ?, ?, NULL)`,
          [id, workspaceId, userId, mail.subject, mail.text, mail.html, at, at],
        );
        const marks = pending.map(() => '?').join(', ');
        await tx.execute(
          `UPDATE alert_deliveries SET status = 'sent', outcome = 'digest_sent', updated_at = ?, delivered_at = ? WHERE id IN (${marks})`,
          [at, at, ...pending.map((p) => String(p.id))],
        );
        await queueEmailJob(tx, id, at);
        summary.sent++;
      }
      await tx.execute(
        'UPDATE alert_user_settings SET last_digest_at = ? WHERE workspace_id = ? AND user_id = ?',
        [at, workspaceId, userId],
      );
    });
  }
  return summary;
}
