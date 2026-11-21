import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ActorType } from '@mrm/core';
import type { Database, Row, Sql } from '@mrm/db';
import { decryptSecret, encryptSecret } from '@mrm/vault';
import { z } from 'zod';
import { DEFAULT_MAX_ATTEMPTS, enqueue, type JobHandler } from '../jobs.ts';
import { recordAudit } from './audit.ts';
import { eventTypes } from './event-types.ts';
import type { EventRecord } from './events.ts';
import {
  checkWebhookUrl,
  cleanResponseBody,
  type Resolver,
  resolveAllowed,
  type SendResult,
  sendPinned,
} from './webhook-transport.ts';

/**
 * Outbound webhooks: a workspace lists URLs and the event types it wants; every event written by
 * `emitEvent` becomes one delivery row per matching endpoint and one job in the queue. The job
 * signs the body, sends it through the SSRF guard in webhook-transport.ts, and records what
 * happened. A failure is retried by the queue with its backoff; the delivery log keeps the last
 * answer. See docs/api/webhooks.md for the receiver side.
 */

export const WEBHOOK_QUEUE = 'webhook.deliver';
export const MAX_WEBHOOKS_PER_WORKSPACE = 20;
export const SECRET_PREFIX = 'whsec_';

type Actor = { type: ActorType; id: string };

export const webhookEventTypes = ['*', ...eventTypes] as const;

export const webhookUrlSchema = z.string().trim().min(1).max(2048);
export const createWebhookBody = z.object({
  url: webhookUrlSchema,
  description: z.string().trim().max(200).optional(),
  eventTypes: z.array(z.enum(webhookEventTypes)).min(1).max(20),
  enabled: z.boolean().optional(),
});
export const updateWebhookBody = z
  .object({
    url: webhookUrlSchema.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    eventTypes: z.array(z.enum(webhookEventTypes)).min(1).max(20).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.');

export type CreateWebhookInput = z.infer<typeof createWebhookBody>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookBody>;

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** The newest delivery, or null when none was made yet. */
  lastDelivery: { status: string; at: number; responseCode: number | null } | null;
};

export type WebhookDelivery = {
  id: string;
  endpointId: string;
  eventId: number | null;
  eventType: string;
  status: 'pending' | 'retrying' | 'success' | 'failed';
  attempts: number;
  responseCode: number | null;
  /** Truncated, printable, with the signing secret removed. */
  responseBody: string | null;
  error: string | null;
  redeliveryOf: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

export type WebhookFailure = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  message?: string;
};

export type WebhookContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** MRM_WEBHOOKS_ALLOW_PRIVATE=1: loopback and private addresses (and http to localhost) allowed. */
  allowPrivate?: boolean | undefined;
  /** Overridable for tests. */
  resolve?: Resolver | undefined;
  send?: typeof sendPinned | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
};

export const webhookAad = (workspaceId: string, id: string) => `webhook:${workspaceId}:${id}`;

const newSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;

const parseTypes = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};

const toEndpoint = (r: Row): WebhookEndpoint => ({
  id: String(r.id),
  url: String(r.url),
  description: r.description === null || r.description === undefined ? null : String(r.description),
  eventTypes: parseTypes(r.event_types),
  enabled: Number(r.enabled) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  lastDelivery:
    r.last_status === null || r.last_status === undefined
      ? null
      : {
          status: String(r.last_status),
          at: Number(r.last_at),
          responseCode:
            r.last_code === null || r.last_code === undefined ? null : Number(r.last_code),
        },
});

const toDelivery = (r: Row): WebhookDelivery => ({
  id: String(r.id),
  endpointId: String(r.endpoint_id),
  eventId: r.event_id === null || r.event_id === undefined ? null : Number(r.event_id),
  eventType: String(r.event_type),
  status: String(r.status) as WebhookDelivery['status'],
  attempts: Number(r.attempts),
  responseCode:
    r.response_code === null || r.response_code === undefined ? null : Number(r.response_code),
  responseBody:
    r.response_body === null || r.response_body === undefined ? null : String(r.response_body),
  error: r.error === null || r.error === undefined ? null : String(r.error),
  redeliveryOf:
    r.redelivery_of === null || r.redelivery_of === undefined ? null : String(r.redelivery_of),
  createdAt: Number(r.created_at),
  deliveredAt:
    r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
});

const ENDPOINT_SELECT = `SELECT e.id, e.url, e.description, e.event_types, e.enabled, e.created_at, e.updated_at,
       d.status AS last_status, d.created_at AS last_at, d.response_code AS last_code
  FROM webhook_endpoints e
  LEFT JOIN webhook_deliveries d ON d.id = (
    SELECT d2.id FROM webhook_deliveries d2 WHERE d2.endpoint_id = e.id
     ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1)`;

export async function listWebhooks(sql: Sql, workspaceId: string): Promise<WebhookEndpoint[]> {
  const rows = await sql.query(
    `${ENDPOINT_SELECT} WHERE e.workspace_id = ? ORDER BY e.created_at, e.id`,
    [workspaceId],
  );
  return rows.map(toEndpoint);
}

export async function getWebhook(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<WebhookEndpoint | undefined> {
  const [row] = await sql.query(`${ENDPOINT_SELECT} WHERE e.workspace_id = ? AND e.id = ?`, [
    workspaceId,
    id,
  ]);
  return row ? toEndpoint(row) : undefined;
}

/** The URL rules, plus a look at what the name resolves to now (a name that cannot be resolved yet is accepted). */
async function checkUrl(ctx: WebhookContext, url: string): Promise<WebhookFailure | undefined> {
  const checked = checkWebhookUrl(url, { allowPrivate: ctx.allowPrivate });
  if (!checked.ok)
    return { ok: false, status: 400, error: 'invalid_url', message: checked.message };
  const resolved = await resolveAllowed(checked, {
    allowPrivate: ctx.allowPrivate,
    resolve: ctx.resolve,
  });
  if (!resolved.ok && !resolved.transient) {
    return { ok: false, status: 400, error: 'invalid_url', message: resolved.message };
  }
  return undefined;
}

const uniqueTypes = (types: string[]) => [...new Set(types)];

export async function createWebhook(
  ctx: WebhookContext,
  input: CreateWebhookInput & { workspaceId: string },
  actor: Actor,
): Promise<{ ok: true; endpoint: WebhookEndpoint; secret: string } | WebhookFailure> {
  const bad = await checkUrl(ctx, input.url);
  if (bad) return bad;
  const id = randomUUID();
  const secret = newSecret();
  const at = ctx.now();
  const types = uniqueTypes(input.eventTypes);
  const outcome = await ctx.db.transaction(async (tx) => {
    const [count] = await tx.query(
      'SELECT COUNT(*) AS n FROM webhook_endpoints WHERE workspace_id = ?',
      [input.workspaceId],
    );
    if (Number(count?.n ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE) return 'too_many' as const;
    await tx.execute(
      `INSERT INTO webhook_endpoints
         (id, workspace_id, url, description, ciphertext, event_types, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.url,
        input.description || null,
        encryptSecret(secret, ctx.masterKey, webhookAad(input.workspaceId, id)),
        JSON.stringify(types),
        input.enabled === false ? 0 : 1,
        actor.id,
        at,
        at,
      ],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.create',
      target: { type: 'webhook', id },
      detail: { url: input.url, eventTypes: types },
      at,
    });
    return 'ok' as const;
  });
  if (outcome === 'too_many') {
    return {
      ok: false,
      status: 409,
      error: 'too_many_webhooks',
      message: `A workspace can have at most ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks.`,
    };
  }
  const endpoint = (await getWebhook(ctx.db, input.workspaceId, id)) as WebhookEndpoint;
  return { ok: true, endpoint, secret };
}

export async function updateWebhook(
  ctx: WebhookContext,
  input: UpdateWebhookInput & { workspaceId: string; id: string },
  actor: Actor,
): Promise<{ ok: true; endpoint: WebhookEndpoint } | WebhookFailure> {
  const existing = await getWebhook(ctx.db, input.workspaceId, input.id);
  if (!existing) return { ok: false, status: 404, error: 'not_found' };
  if (input.url !== undefined && input.url !== existing.url) {
    const bad = await checkUrl(ctx, input.url);
    if (bad) return bad;
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const changed: string[] = [];
  if (input.url !== undefined) {
    sets.push('url = ?');
    params.push(input.url);
    changed.push('url');
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(input.description || null);
    changed.push('description');
  }
  if (input.eventTypes !== undefined) {
    sets.push('event_types = ?');
    params.push(JSON.stringify(uniqueTypes(input.eventTypes)));
    changed.push('eventTypes');
  }
  if (input.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(input.enabled ? 1 : 0);
    changed.push('enabled');
  }
  const at = ctx.now();
  const done = await ctx.db.transaction(async (tx) => {
    const n = await tx.execute(
      `UPDATE webhook_endpoints SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [...params, at, input.id, input.workspaceId],
    );
    if (n === 0) return false;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.update',
      target: { type: 'webhook', id: input.id },
      detail: { changed },
      at,
    });
    return true;
  });
  if (!done) return { ok: false, status: 404, error: 'not_found' };
  return {
    ok: true,
    endpoint: (await getWebhook(ctx.db, input.workspaceId, input.id)) as WebhookEndpoint,
  };
}

export async function deleteWebhook(
  ctx: Pick<WebhookContext, 'db' | 'now'>,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<boolean> {
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT url FROM webhook_endpoints WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return false;
    await tx.execute('DELETE FROM webhook_deliveries WHERE endpoint_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM webhook_endpoints WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.delete',
      target: { type: 'webhook', id: input.id },
      detail: { url: String(row.url) },
      at,
    });
    return true;
  });
}

/** Makes a new signing secret and returns it once. The old one stops working at once. */
export async function rotateWebhookSecret(
  ctx: Pick<WebhookContext, 'db' | 'now' | 'masterKey'>,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<{ ok: true; secret: string } | WebhookFailure> {
  const secret = newSecret();
  const at = ctx.now();
  const done = await ctx.db.transaction(async (tx) => {
    const n = await tx.execute(
      'UPDATE webhook_endpoints SET ciphertext = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      [
        encryptSecret(secret, ctx.masterKey, webhookAad(input.workspaceId, input.id)),
        at,
        input.id,
        input.workspaceId,
      ],
    );
    if (n === 0) return false;
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.rotate_secret',
      target: { type: 'webhook', id: input.id },
      at,
    });
    return true;
  });
  return done ? { ok: true, secret } : { ok: false, status: 404, error: 'not_found' };
}

export const MAX_DELIVERIES_LIMIT = 100;

export async function listDeliveries(
  sql: Sql,
  workspaceId: string,
  endpointId: string,
  limit = 20,
): Promise<WebhookDelivery[]> {
  const rows = await sql.query(
    `SELECT id, endpoint_id, event_id, event_type, status, attempts, response_code, response_body,
            error, redelivery_of, created_at, delivered_at
       FROM webhook_deliveries WHERE workspace_id = ? AND endpoint_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [workspaceId, endpointId, Math.trunc(Math.min(Math.max(limit, 1), MAX_DELIVERIES_LIMIT))],
  );
  return rows.map(toDelivery);
}

export async function deliveryExists(
  sql: Sql,
  input: { workspaceId: string; endpointId: string; deliveryId: string },
): Promise<boolean> {
  const rows = await sql.query(
    'SELECT 1 AS ok FROM webhook_deliveries WHERE id = ? AND endpoint_id = ? AND workspace_id = ?',
    [input.deliveryId, input.endpointId, input.workspaceId],
  );
  return rows.length > 0;
}

/** Drops delivery records older than `keepMs`. Called at start-up. */
export async function pruneDeliveries(
  sql: Sql,
  now: number,
  keepMs = 30 * 24 * 60 * 60 * 1000,
): Promise<number> {
  return sql.execute('DELETE FROM webhook_deliveries WHERE created_at < ?', [now - keepMs]);
}

// ---------------------------------------------------------------------------------------------
// Queueing

/** The JSON a receiver gets. `id` is the event's id, null for a test. */
export function envelope(
  event:
    | Pick<EventRecord, 'id' | 'type' | 'workspaceId' | 'subject' | 'payload' | 'createdAt'>
    | {
        id: null;
        type: string;
        workspaceId: string;
        subject: Record<string, never>;
        payload: Record<string, unknown>;
        createdAt: number;
      },
): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    workspaceId: event.workspaceId,
    createdAt: event.createdAt,
    subject: event.subject,
    data: event.payload,
  });
}

async function queueDelivery(
  sql: Sql,
  input: {
    workspaceId: string;
    endpointId: string;
    eventId: number | null;
    eventType: string;
    body: string;
    redeliveryOf?: string;
    at: number;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO webhook_deliveries
       (id, workspace_id, endpoint_id, event_id, event_type, body, status, attempts, redelivery_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.endpointId,
      input.eventId,
      input.eventType,
      input.body,
      input.redeliveryOf ?? null,
      input.at,
    ],
  );
  await enqueue(sql, WEBHOOK_QUEUE, { deliveryId: id }, { now: input.at });
  return id;
}

/** Called by `emitEvent`: one delivery and one job per enabled endpoint that wants this event. */
export async function queueWebhookDeliveries(sql: Sql, event: EventRecord): Promise<void> {
  const rows = await sql.query(
    'SELECT id, event_types FROM webhook_endpoints WHERE workspace_id = ? AND enabled = 1',
    [event.workspaceId],
  );
  if (rows.length === 0) return;
  const body = envelope(event);
  for (const row of rows) {
    const wanted = parseTypes(row.event_types);
    if (!wanted.includes('*') && !wanted.includes(event.type)) continue;
    await queueDelivery(sql, {
      workspaceId: event.workspaceId,
      endpointId: String(row.id),
      eventId: event.id,
      eventType: event.type,
      body,
      at: event.createdAt,
    });
  }
}

/** A `webhook.test` delivery, sent through the same path as a real one. */
export async function sendTestEvent(
  ctx: Pick<WebhookContext, 'db' | 'now'>,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<{ ok: true; deliveryId: string } | WebhookFailure> {
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT id FROM webhook_endpoints WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return { ok: false as const, status: 404 as const, error: 'not_found' };
    const body = envelope({
      id: null,
      type: 'webhook.test',
      workspaceId: input.workspaceId,
      subject: {},
      payload: { message: 'This is a test event from Kiln.' },
      createdAt: at,
    });
    const deliveryId = await queueDelivery(tx, {
      workspaceId: input.workspaceId,
      endpointId: input.id,
      eventId: null,
      eventType: 'webhook.test',
      body,
      at,
    });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.test',
      target: { type: 'webhook', id: input.id },
      detail: { deliveryId },
      at,
    });
    return { ok: true as const, deliveryId };
  });
}

/** Sends a delivery again, as a new delivery that points at the first. The same body is sent. */
export async function redeliver(
  ctx: Pick<WebhookContext, 'db' | 'now'>,
  input: { workspaceId: string; endpointId: string; deliveryId: string },
  actor: Actor,
): Promise<{ ok: true; deliveryId: string } | WebhookFailure> {
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      `SELECT d.id, d.event_id, d.event_type, d.body, d.redelivery_of
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.id = ? AND d.endpoint_id = ? AND d.workspace_id = ? AND e.workspace_id = ?`,
      [input.deliveryId, input.endpointId, input.workspaceId, input.workspaceId],
    );
    if (!row) return { ok: false as const, status: 404 as const, error: 'not_found' };
    const deliveryId = await queueDelivery(tx, {
      workspaceId: input.workspaceId,
      endpointId: input.endpointId,
      eventId: row.event_id === null || row.event_id === undefined ? null : Number(row.event_id),
      eventType: String(row.event_type),
      body: String(row.body),
      redeliveryOf: String(row.redelivery_of ?? row.id),
      at,
    });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'webhook.redeliver',
      target: { type: 'webhook', id: input.endpointId },
      detail: { of: String(row.id), deliveryId },
      at,
    });
    return { ok: true as const, deliveryId };
  });
}

// ---------------------------------------------------------------------------------------------
// Signing and sending

/** The signature: hex HMAC-SHA256 of `<timestamp>.<body>` with the endpoint's secret. */
export const signWebhook = (secret: string, timestamp: number | string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const MAX_ERROR_CHARS = 300;

export function createWebhookHandler(ctx: WebhookContext): JobHandler {
  const send = ctx.send ?? sendPinned;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return async (payload, job) => {
    const deliveryId = (payload as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof deliveryId !== 'string') return;
    const [row] = await ctx.db.query(
      `SELECT d.id, d.workspace_id, d.endpoint_id, d.event_type, d.body, d.status,
              e.url, e.ciphertext, e.enabled
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.id = ?`,
      [deliveryId],
    );
    // The endpoint (and with it the delivery) was deleted while the job waited.
    if (!row || String(row.status) === 'success') return;
    const workspaceId = String(row.workspace_id);

    const record = (
      status: string,
      fields: { code?: number | null; body?: string | null; error?: string | null },
    ) =>
      ctx.db.execute(
        `UPDATE webhook_deliveries
            SET status = ?, attempts = ?, response_code = ?, response_body = ?, error = ?, delivered_at = ?
          WHERE id = ?`,
        [
          status,
          job.attempts,
          fields.code ?? null,
          fields.body ?? null,
          fields.error ?? null,
          status === 'success' ? ctx.now() : null,
          deliveryId,
        ],
      );

    if (Number(row.enabled) !== 1) {
      await record('failed', { error: 'The webhook is disabled.' });
      return;
    }
    let secret: string;
    try {
      secret = decryptSecret(
        String(row.ciphertext),
        ctx.masterKey,
        webhookAad(workspaceId, String(row.endpoint_id)),
      );
    } catch {
      await record('failed', { error: 'The signing secret could not be read. Rotate it.' });
      return;
    }

    const body = String(row.body);
    const timestamp = Math.floor(ctx.now() / 1000);
    const result: SendResult = await send(
      String(row.url),
      body,
      {
        'content-type': 'application/json',
        'user-agent': 'Kiln-Webhooks/1',
        'x-mrm-event': String(row.event_type),
        'x-mrm-delivery': deliveryId,
        'x-mrm-timestamp': String(timestamp),
        'x-mrm-signature': `v1=${signWebhook(secret, timestamp, body)}`,
      },
      { allowPrivate: ctx.allowPrivate, resolve: ctx.resolve, timeoutMs: ctx.timeoutMs },
    );

    if (result.ok && result.status >= 200 && result.status < 300) {
      await record('success', {
        code: result.status,
        body: cleanResponseBody(result.body, [secret]),
      });
      return;
    }
    const code = result.ok ? result.status : null;
    const shown = result.ok ? cleanResponseBody(result.body, [secret]) : null;
    const message = (result.ok ? `The receiver answered ${result.status}.` : result.message).slice(
      0,
      MAX_ERROR_CHARS,
    );
    // A refused address will not get better by waiting; everything else is worth another try.
    const permanent = !result.ok && !result.transient;
    const last = permanent || job.attempts >= maxAttempts;
    await record(last ? 'failed' : 'retrying', { code, body: shown, error: message });
    if (!permanent) throw new Error(message);
  };
}
