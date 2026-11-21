import type { Database } from '@kiln/db';
import { DEFAULT_MAX_ATTEMPTS, type JobHandler } from '../../jobs.ts';
import {
  isMailErrorCode,
  type MailInput,
  type MailResult,
  sendMail as realSendMail,
} from '../../services/mailer.ts';
import { ALERT_QUEUE, type DeliveryOutcome } from './service.ts';

/**
 * The job that sends one alert email (docs/alerts.md). The delivery row holds the rendered subject and text (ids and names only), so
 * a retry sends the same message. The result of the mailer is a code from a fixed vocabulary; it is mapped to the log's outcome and
 * nothing a server said is stored. Retries use the queue's backoff: a failure that waiting can fix throws, so the queue runs the job
 * again later; one that waiting cannot fix is recorded as failed at once.
 */

export type AlertDeliveryContext = {
  db: Database;
  now: () => number;
  /** The injected mailer; default: the server's `sendMail` (services/mailer.ts). Tests pass a fake. */
  sendMail?: (input: MailInput) => Promise<MailResult>;
  maxAttempts?: number;
};

/** Codes that a later attempt can fix (the network, a timeout). The others (no server set up, bad login, rejected) need a person. */
const transientCodes = new Set(['smtp_connection_failed', 'smtp_timeout']);

export function createAlertDeliveryHandler(ctx: AlertDeliveryContext): JobHandler {
  const send = ctx.sendMail ?? realSendMail;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return async (payload, job) => {
    const deliveryId = (payload as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof deliveryId !== 'string') return;
    const [row] = await ctx.db.query(
      `SELECT d.id, d.workspace_id, d.user_id, d.channel, d.status, d.subject, d.body, d.html
         FROM alert_deliveries d WHERE d.id = ?`,
      [deliveryId],
    );
    if (!row || String(row.channel) !== 'email') return;
    // Sent already (a repeated job), or given up on.
    if (
      String(row.status) === 'sent' ||
      String(row.status) === 'failed' ||
      String(row.status) === 'skipped'
    )
      return;
    const at = ctx.now();
    const record = (status: string, outcome: DeliveryOutcome) =>
      ctx.db.execute(
        'UPDATE alert_deliveries SET status = ?, outcome = ?, attempts = ?, updated_at = ?, delivered_at = ? WHERE id = ?',
        [status, outcome, job.attempts, at, status === 'sent' ? at : null, deliveryId],
      );

    const [person] = row.user_id
      ? await ctx.db.query(
          `SELECT u.email FROM users u JOIN workspace_members m ON m.user_id = u.id
            WHERE u.id = ? AND m.workspace_id = ?`,
          [String(row.user_id), String(row.workspace_id)],
        )
      : [];
    if (!person) {
      await record('skipped', 'recipient_gone');
      return;
    }
    const to = String(person.email ?? '');
    if (!to.includes('@')) {
      await record('skipped', 'no_address');
      return;
    }
    const result = await send({
      to,
      subject: String(row.subject ?? 'Alert'),
      text: String(row.body ?? ''),
      ...(typeof row.html === 'string' && row.html !== '' ? { html: row.html } : {}),
    });
    if (result.ok) {
      await record('sent', 'ok');
      return;
    }
    const outcome: DeliveryOutcome = isMailErrorCode(result.code)
      ? result.code
      : 'smtp_connection_failed';
    const transient = transientCodes.has(outcome);
    const last = !transient || job.attempts >= maxAttempts;
    await record(last ? 'failed' : 'retrying', outcome);
    // A generic message: the queue stores it, and it must not carry anything a mail server said.
    if (!last) throw new Error('The alert email could not be sent yet; it will be tried again.');
  };
}

export { ALERT_QUEUE };
