import type { Database } from '@kiln/db';
import { backoffMs, DEFAULT_MAX_ATTEMPTS, enqueue, type JobHandler } from '../../jobs.ts';
import { type SendResult, sendPinned } from '../../services/webhook-transport.ts';
import { CHAT_QUEUE, type ChatContext, checkChatUrl, readDestinationUrl } from './destinations.ts';
import type { ChatOutcome, ChatProvider } from './model.ts';

/**
 * The job that sends one chat message (docs/chat-integrations.md). Through the webhook module's SSRF-safe transport (https only, every
 * address checked, the connection pinned to the checked address, no redirects, a small response). Pacing: at most one message per
 * second per destination (Slack's documented limit for incoming webhooks; Teams allows more). Retries: a failure that waiting can fix
 * (a timeout, a network error, a 5xx, a 429) is tried again up to 5 times, after the server's `Retry-After` when it sent one (capped
 * at 5 minutes), else after the queue's exponential backoff. Nothing a provider answered is stored or shown: the HTTP status and a
 * code from a fixed list (`chatOutcomes`).
 */

export const MIN_GAP_MS = 1000;
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** `Retry-After` as milliseconds: whole seconds or an HTTP date; undefined when absent or unusable. Capped. */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const text = header.trim();
  let ms: number;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else {
    const date = Date.parse(text);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  return Math.min(Math.max(ms, MIN_GAP_MS), MAX_RETRY_AFTER_MS);
}

type Verdict =
  | { kind: 'sent' }
  | { kind: 'retry'; outcome: ChatOutcome; waitMs?: number | undefined }
  | { kind: 'fail'; outcome: ChatOutcome };

/** What an answer means. Pure. */
export function judge(result: SendResult, now: number): Verdict {
  if (!result.ok) {
    if (result.kind === 'blocked') return { kind: 'fail', outcome: 'blocked_address' };
    if (result.kind === 'dns') return { kind: 'retry', outcome: 'dns_failed' };
    if (result.kind === 'timeout') return { kind: 'retry', outcome: 'timeout' };
    return { kind: 'retry', outcome: 'network_error' };
  }
  const s = result.status;
  if (s >= 200 && s < 300) return { kind: 'sent' };
  if (s === 429) return { kind: 'retry', outcome: 'rate_limited', waitMs: retryAfterMs(result.retryAfter, now) };
  if (s === 408 || s >= 500) return { kind: 'retry', outcome: 'server_error' };
  if (s >= 300 && s < 400) return { kind: 'fail', outcome: 'redirected' };
  if (s === 404 || s === 410) return { kind: 'fail', outcome: 'webhook_gone' };
  if (s === 401 || s === 403) return { kind: 'fail', outcome: 'webhook_rejected' };
  if (s === 400 || s === 413 || s === 422) return { kind: 'fail', outcome: 'payload_rejected' };
  return { kind: 'fail', outcome: 'rejected' };
}

export function createChatDeliveryHandler(ctx: ChatContext): JobHandler {
  const send = ctx.send ?? sendPinned;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const db: Database = ctx.db;
  return async (payload) => {
    const deliveryId = (payload as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof deliveryId !== 'string') return;
    const [row] = await db.query(
      `SELECT d.id, d.workspace_id, d.destination_id, d.kind, d.status, d.attempts, d.payload,
              g.provider, g.ciphertext, g.enabled, g.allow_any_host, g.last_sent_at
         FROM chat_deliveries d JOIN chat_destinations g ON g.id = d.destination_id WHERE d.id = ?`,
      [deliveryId],
    );
    // The destination was deleted while the job waited, or the message is done.
    if (!row || ['sent', 'failed', 'skipped'].includes(String(row.status))) return;
    const workspaceId = String(row.workspace_id);
    const destinationId = String(row.destination_id);
    const now = ctx.now();
    const record = (status: string, outcome: ChatOutcome, fields: { http?: number | null; attempts?: number } = {}) =>
      db.execute(
        'UPDATE chat_deliveries SET status = ?, outcome = ?, http_status = ?, attempts = ?, updated_at = ?, delivered_at = ? WHERE id = ?',
        [
          status,
          outcome,
          fields.http ?? null,
          fields.attempts ?? Number(row.attempts),
          now,
          status === 'sent' ? now : null,
          deliveryId,
        ],
      );

    // A test goes out even from a disabled destination: it is how a person checks before switching it on.
    if (Number(row.enabled) !== 1 && String(row.kind) !== 'test') {
      await record('failed', 'disabled');
      return;
    }
    let url: string;
    try {
      url = readDestinationUrl(ctx, workspaceId, destinationId, String(row.ciphertext));
    } catch {
      await record('failed', 'secret_unreadable');
      return;
    }
    const provider = String(row.provider) as ChatProvider;
    const bad = checkChatUrl(provider, url, {
      allowAnyHost: Number(row.allow_any_host) === 1,
      allowPrivate: ctx.allowPrivate,
    });
    if (bad) {
      await record('failed', bad.error === 'host_not_allowed' ? 'host_not_allowed' : 'blocked_address');
      return;
    }

    // Pacing: one message per second per destination. Waiting costs no attempt.
    const last = row.last_sent_at === null || row.last_sent_at === undefined ? null : Number(row.last_sent_at);
    if (last !== null && now - last < MIN_GAP_MS) {
      await enqueue(db, CHAT_QUEUE, { deliveryId }, { now, runAt: last + MIN_GAP_MS });
      return;
    }
    await db.execute('UPDATE chat_destinations SET last_sent_at = ? WHERE id = ?', [now, destinationId]);

    const attempts = Number(row.attempts) + 1;
    const result = await send(
      url,
      String(row.payload ?? '{}'),
      { 'content-type': 'application/json', 'user-agent': 'Kiln-Chat/1' },
      { allowPrivate: ctx.allowPrivate, resolve: ctx.resolve, timeoutMs: ctx.timeoutMs },
    );
    const http = result.ok ? result.status : null;
    const verdict = judge(result, now);
    if (verdict.kind === 'sent') {
      await record('sent', 'ok', { http, attempts });
    } else if (verdict.kind === 'fail' || attempts >= maxAttempts) {
      await record('failed', verdict.outcome, { http, attempts });
    } else {
      await record('retrying', verdict.outcome, { http, attempts });
      // Our own schedule, so the server's Retry-After is honoured to the second.
      await enqueue(db, CHAT_QUEUE, { deliveryId }, { now, runAt: now + (verdict.waitMs ?? backoffMs(attempts)) });
    }
  };
}
