import { randomUUID } from 'node:crypto';
import { type ActorType, PLATFORMS } from '@kiln/core';
import type { Database, Row, Sql } from '@kiln/db';
import { decryptSecret, encryptSecret } from '@kiln/vault';
import { z } from 'zod';
import { coded, type ErrorParams } from '../../i18n/problem.ts';
import { enqueue } from '../../jobs.ts';
import { recordAudit } from '../../services/audit.ts';
import {
  checkWebhookUrl,
  type Resolver,
  type sendPinned,
} from '../../services/webhook-transport.ts';
import { alertCatalog, alertSeverities, isAlertType } from '../alerts/catalog.ts';
import { isValidTimeZone } from '../alerts/time.ts';
import { buildTestMessage } from './message.ts';
import {
  type ChatDigestMode,
  type ChatProvider,
  chatDigestModes,
  chatLocales,
  chatProviders,
  hostAllowed,
  providerHosts,
  urlHint,
} from './model.ts';
import { renderMessage } from './render.ts';

/**
 * Chat destinations and their routing rules (docs/chat-integrations.md). The webhook URL is the secret: it is encrypted with the
 * vault key bound to the workspace and the destination, shown by nobody after it was saved (only its last four characters), and
 * never written to the audit log, the delivery log or an error. Owners and admins only (`chat.manage`), with a session.
 */

export const CHAT_QUEUE = 'chat.deliver';
export const MAX_DESTINATIONS = 20;
export const MAX_ROUTES = 20;

type Actor = { type: ActorType; id: string };

export type ChatContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  /** KILN_WEBHOOKS_ALLOW_PRIVATE=1, as for webhooks: private addresses (and http to localhost) allowed. */
  allowPrivate?: boolean | undefined;
  resolve?: Resolver | undefined;
  send?: typeof sendPinned | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
};

export const chatAad = (workspaceId: string, id: string) => `chat:${workspaceId}:${id}`;

// ----- input -------------------------------------------------------------------------------------------------

const alertTypeName = z
  .string()
  .max(60)
  .refine((v) => v === '*' || isAlertType(v), 'Use "*" or the id of an alert type.');

export const routeInput = z
  .object({
    alertTypes: z.array(alertTypeName).min(1).max(60),
    minSeverity: z.enum(alertSeverities).default('info'),
    appIds: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
    platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type RouteInput = z.infer<typeof routeInput>;

const timezone = z
  .string()
  .max(64)
  .refine(isValidTimeZone, 'Use an IANA time zone such as Europe/Paris.');
const name = z.string().trim().min(1).max(80);
const url = z.string().trim().min(1).max(2048);

export const createDestinationBody = z
  .object({
    provider: z.enum(chatProviders),
    name,
    url,
    locale: z.enum(chatLocales as unknown as [string, ...string[]]).optional(),
    enabled: z.boolean().optional(),
    allowAnyHost: z.boolean().optional(),
    digest: z.enum(chatDigestModes).optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
    timezone: timezone.optional(),
    routes: z.array(routeInput).max(MAX_ROUTES).optional(),
  })
  .strict();
export const updateDestinationBody = z
  .object({
    name: name.optional(),
    url: url.optional(),
    locale: z.enum(chatLocales as unknown as [string, ...string[]]).optional(),
    enabled: z.boolean().optional(),
    allowAnyHost: z.boolean().optional(),
    digest: z.enum(chatDigestModes).optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
    timezone: timezone.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export const routesBody = z.object({ routes: z.array(routeInput).max(MAX_ROUTES) }).strict();

export type CreateDestinationInput = z.infer<typeof createDestinationBody>;
export type UpdateDestinationInput = z.infer<typeof updateDestinationBody>;

// ----- views -------------------------------------------------------------------------------------------------

export type RouteView = {
  id: string;
  alertTypes: string[];
  minSeverity: (typeof alertSeverities)[number];
  appIds: string[] | null;
  platforms: string[] | null;
  enabled: boolean;
};

export type DestinationView = {
  id: string;
  provider: ChatProvider;
  name: string;
  /** The last four characters of the webhook URL. The URL itself is never returned. */
  urlHint: string;
  locale: string;
  enabled: boolean;
  allowAnyHost: boolean;
  digest: ChatDigestMode;
  digestHour: number;
  timezone: string;
  createdAt: number;
  updatedAt: number;
  routes: RouteView[];
  lastDelivery: { status: string; outcome: string; at: number } | null;
};

export type DeliveryView = {
  id: string;
  destinationId: string;
  alertId: string | null;
  kind: string;
  status: string;
  outcome: string;
  httpStatus: number | null;
  attempts: number;
  /** The alert's English title, for the log. */
  title: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

export type ChatFailure = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  message: string;
  code?: string;
  params?: ErrorParams;
};

export const parseList = (value: unknown): string[] | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    return null;
  }
};

const toRoute = (r: Row): RouteView => ({
  id: String(r.id),
  alertTypes: parseList(r.alert_types) ?? [],
  minSeverity: (alertSeverities as readonly string[]).includes(String(r.min_severity))
    ? (String(r.min_severity) as RouteView['minSeverity'])
    : 'info',
  appIds: parseList(r.app_ids),
  platforms: parseList(r.platforms),
  enabled: Number(r.enabled) === 1,
});

const toDestination = (r: Row, routes: RouteView[]): DestinationView => ({
  id: String(r.id),
  provider: String(r.provider) as ChatProvider,
  name: String(r.name),
  urlHint: String(r.url_hint),
  locale: String(r.locale),
  enabled: Number(r.enabled) === 1,
  allowAnyHost: Number(r.allow_any_host) === 1,
  digest: String(r.digest) === 'daily' ? 'daily' : 'off',
  digestHour: Number(r.digest_hour),
  timezone: String(r.timezone),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  routes,
  lastDelivery:
    r.last_status === null || r.last_status === undefined
      ? null
      : { status: String(r.last_status), outcome: String(r.last_outcome), at: Number(r.last_at) },
});

const SELECT = `SELECT g.id, g.provider, g.name, g.url_hint, g.locale, g.enabled, g.allow_any_host, g.digest, g.digest_hour, g.timezone,
       g.created_at, g.updated_at,
       d.status AS last_status, d.outcome AS last_outcome, d.created_at AS last_at
  FROM chat_destinations g
  LEFT JOIN chat_deliveries d ON d.id = (
    SELECT d2.id FROM chat_deliveries d2 WHERE d2.destination_id = g.id ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1)`;

/** The rules a new destination gets: every critical alert, and every release event whatever its severity. */
export function defaultRoutes(): RouteInput[] {
  const releases = alertCatalog.filter((d) => d.group === 'releases').map((d) => d.id);
  return [
    { alertTypes: ['*'], minSeverity: 'critical' },
    { alertTypes: releases, minSeverity: 'info' },
  ];
}

export async function listDestinations(sql: Sql, workspaceId: string): Promise<DestinationView[]> {
  const rows = await sql.query(`${SELECT} WHERE g.workspace_id = ? ORDER BY g.created_at, g.id`, [
    workspaceId,
  ]);
  const routes = await sql.query(
    'SELECT id, destination_id, alert_types, min_severity, app_ids, platforms, enabled FROM chat_routes WHERE workspace_id = ? ORDER BY position, id',
    [workspaceId],
  );
  return rows.map((r) =>
    toDestination(r, routes.filter((x) => String(x.destination_id) === String(r.id)).map(toRoute)),
  );
}

export async function getDestination(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<DestinationView | undefined> {
  return (await listDestinations(sql, workspaceId)).find((d) => d.id === id);
}

// ----- the address -------------------------------------------------------------------------------------------

/** Checks a webhook URL for a provider: https to a public host, and a host the provider uses unless the admin allowed any. */
export function checkChatUrl(
  provider: ChatProvider,
  raw: string,
  options: { allowAnyHost: boolean; allowPrivate?: boolean | undefined },
): ChatFailure | undefined {
  const checked = checkWebhookUrl(raw, { allowPrivate: options.allowPrivate });
  if (!checked.ok) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_url',
      message: checked.message,
      ...coded('chat.urlInvalid'),
    };
  }
  if (!options.allowAnyHost && !hostAllowed(provider, checked.hostname)) {
    return {
      ok: false,
      status: 400,
      error: 'host_not_allowed',
      message: `A ${provider === 'slack' ? 'Slack' : 'Teams'} webhook address comes from ${providerHosts[provider].join(', ')}. Allow other hosts on the destination to use another address.`,
      ...coded('chat.hostNotAllowed', {
        provider: provider === 'slack' ? 'Slack' : 'Microsoft Teams',
        hosts: providerHosts[provider].join(', '),
      }),
    };
  }
  return undefined;
}

// ----- writes ------------------------------------------------------------------------------------------------

async function writeRoutes(
  tx: Sql,
  workspaceId: string,
  destinationId: string,
  routes: readonly RouteInput[],
  at: number,
) {
  await tx.execute('DELETE FROM chat_routes WHERE destination_id = ? AND workspace_id = ?', [
    destinationId,
    workspaceId,
  ]);
  let position = 0;
  for (const r of routes) {
    await tx.execute(
      `INSERT INTO chat_routes (id, workspace_id, destination_id, alert_types, min_severity, app_ids, platforms, enabled, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        workspaceId,
        destinationId,
        JSON.stringify(r.alertTypes.includes('*') ? ['*'] : [...new Set(r.alertTypes)]),
        r.minSeverity,
        r.appIds && r.appIds.length > 0 ? JSON.stringify([...new Set(r.appIds)]) : null,
        r.platforms && r.platforms.length > 0 ? JSON.stringify([...new Set(r.platforms)]) : null,
        r.enabled === false ? 0 : 1,
        position++,
        at,
        at,
      ],
    );
  }
}

export async function createDestination(
  ctx: ChatContext,
  input: CreateDestinationInput & { workspaceId: string },
  actor: Actor,
): Promise<{ ok: true; destination: DestinationView } | ChatFailure> {
  const allowAnyHost = input.allowAnyHost === true;
  const bad = checkChatUrl(input.provider, input.url, {
    allowAnyHost,
    allowPrivate: ctx.allowPrivate,
  });
  if (bad) return bad;
  const id = randomUUID();
  const at = ctx.now();
  const outcome = await ctx.db.transaction(async (tx) => {
    const [count] = await tx.query(
      'SELECT COUNT(*) AS n FROM chat_destinations WHERE workspace_id = ?',
      [input.workspaceId],
    );
    if (Number(count?.n ?? 0) >= MAX_DESTINATIONS) return 'too_many' as const;
    await tx.execute(
      `INSERT INTO chat_destinations
         (id, workspace_id, provider, name, ciphertext, url_hint, locale, enabled, allow_any_host, digest, digest_hour, timezone, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.provider,
        input.name,
        encryptSecret(input.url, ctx.masterKey, chatAad(input.workspaceId, id)),
        urlHint(input.url),
        input.locale ?? 'en',
        input.enabled === false ? 0 : 1,
        allowAnyHost ? 1 : 0,
        input.digest ?? 'off',
        input.digestHour ?? 8,
        input.timezone ?? 'UTC',
        actor.id,
        at,
        at,
      ],
    );
    await writeRoutes(tx, input.workspaceId, id, input.routes ?? defaultRoutes(), at);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'chat.destination.create',
      target: { type: 'chat_destination', id },
      detail: { provider: input.provider, name: input.name, urlHint: urlHint(input.url) },
      at,
    });
    return 'ok' as const;
  });
  if (outcome === 'too_many') {
    return {
      ok: false,
      status: 409,
      error: 'too_many_destinations',
      message: `A workspace can have at most ${MAX_DESTINATIONS} chat destinations.`,
      ...coded('chat.tooManyDestinations', { count: MAX_DESTINATIONS }),
    };
  }
  return {
    ok: true,
    destination: (await getDestination(ctx.db, input.workspaceId, id)) as DestinationView,
  };
}

export async function updateDestination(
  ctx: ChatContext,
  input: UpdateDestinationInput & { workspaceId: string; id: string },
  actor: Actor,
): Promise<{ ok: true; destination: DestinationView } | ChatFailure> {
  const [row] = await ctx.db.query(
    'SELECT provider, allow_any_host FROM chat_destinations WHERE id = ? AND workspace_id = ?',
    [input.id, input.workspaceId],
  );
  if (!row) return { ok: false, status: 404, error: 'not_found', message: 'Not found.' };
  const provider = String(row.provider) as ChatProvider;
  const allowAnyHost = input.allowAnyHost ?? Number(row.allow_any_host) === 1;
  if (input.url !== undefined) {
    const bad = checkChatUrl(provider, input.url, { allowAnyHost, allowPrivate: ctx.allowPrivate });
    if (bad) return bad;
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const changed: string[] = [];
  const set = (column: string, value: string | number, field: string) => {
    sets.push(`${column} = ?`);
    params.push(value);
    changed.push(field);
  };
  if (input.name !== undefined) set('name', input.name, 'name');
  if (input.url !== undefined) {
    set(
      'ciphertext',
      encryptSecret(input.url, ctx.masterKey, chatAad(input.workspaceId, input.id)),
      'url',
    );
    set('url_hint', urlHint(input.url), 'urlHint');
  }
  if (input.locale !== undefined) set('locale', input.locale, 'locale');
  if (input.enabled !== undefined) set('enabled', input.enabled ? 1 : 0, 'enabled');
  if (input.allowAnyHost !== undefined)
    set('allow_any_host', input.allowAnyHost ? 1 : 0, 'allowAnyHost');
  if (input.digest !== undefined) set('digest', input.digest, 'digest');
  if (input.digestHour !== undefined) set('digest_hour', input.digestHour, 'digestHour');
  if (input.timezone !== undefined) set('timezone', input.timezone, 'timezone');
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE chat_destinations SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [...params, at, input.id, input.workspaceId],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'chat.destination.update',
      target: { type: 'chat_destination', id: input.id },
      detail: { changed },
      at,
    });
  });
  return {
    ok: true,
    destination: (await getDestination(ctx.db, input.workspaceId, input.id)) as DestinationView,
  };
}

export async function replaceRoutes(
  ctx: ChatContext,
  input: { workspaceId: string; id: string; routes: RouteInput[] },
  actor: Actor,
): Promise<{ ok: true; destination: DestinationView } | ChatFailure> {
  const exists = await ctx.db.query(
    'SELECT 1 AS x FROM chat_destinations WHERE id = ? AND workspace_id = ?',
    [input.id, input.workspaceId],
  );
  if (exists.length === 0)
    return { ok: false, status: 404, error: 'not_found', message: 'Not found.' };
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await writeRoutes(tx, input.workspaceId, input.id, input.routes, at);
    await tx.execute('UPDATE chat_destinations SET updated_at = ? WHERE id = ?', [at, input.id]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'chat.routes.update',
      target: { type: 'chat_destination', id: input.id },
      detail: { routes: input.routes.length },
      at,
    });
  });
  return {
    ok: true,
    destination: (await getDestination(ctx.db, input.workspaceId, input.id)) as DestinationView,
  };
}

export async function deleteDestination(
  ctx: Pick<ChatContext, 'db' | 'now'>,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<boolean> {
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT provider, name, url_hint FROM chat_destinations WHERE id = ? AND workspace_id = ?',
      [input.id, input.workspaceId],
    );
    if (!row) return false;
    await tx.execute('DELETE FROM chat_deliveries WHERE destination_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM chat_routes WHERE destination_id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await tx.execute('DELETE FROM chat_destinations WHERE id = ? AND workspace_id = ?', [
      input.id,
      input.workspaceId,
    ]);
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'chat.destination.delete',
      target: { type: 'chat_destination', id: input.id },
      detail: {
        provider: String(row.provider),
        name: String(row.name),
        urlHint: String(row.url_hint),
      },
      at,
    });
    return true;
  });
}

// ----- the log and the test ------------------------------------------------------------------------------------

export const MAX_DELIVERIES_LIMIT = 100;

export async function listDeliveries(
  sql: Sql,
  workspaceId: string,
  destinationId: string,
  limit: number,
): Promise<DeliveryView[]> {
  const rows = await sql.query(
    `SELECT d.id, d.destination_id, d.alert_id, d.kind, d.status, d.outcome, d.http_status, d.attempts, d.created_at, d.delivered_at, a.title
       FROM chat_deliveries d LEFT JOIN alerts a ON a.id = d.alert_id
      WHERE d.workspace_id = ? AND d.destination_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    [workspaceId, destinationId, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    destinationId: String(r.destination_id),
    alertId: r.alert_id === null || r.alert_id === undefined ? null : String(r.alert_id),
    kind: String(r.kind),
    status: String(r.status),
    outcome: String(r.outcome),
    httpStatus:
      r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    attempts: Number(r.attempts),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    createdAt: Number(r.created_at),
    deliveredAt:
      r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
  }));
}

/** Inserts a delivery row and queues the job that sends it. */
export async function queueChatDelivery(
  sql: Sql,
  input: {
    workspaceId: string;
    destinationId: string;
    alertId: string | null;
    kind: 'alert' | 'digest' | 'test';
    payload: object;
    at: number;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO chat_deliveries (id, workspace_id, destination_id, alert_id, kind, status, outcome, attempts, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.destinationId,
      input.alertId,
      input.kind,
      JSON.stringify(input.payload),
      input.at,
      input.at,
    ],
  );
  await enqueue(sql, CHAT_QUEUE, { deliveryId: id }, { now: input.at });
  return id;
}

export async function sendTestMessage(
  ctx: ChatContext,
  input: { workspaceId: string; id: string },
  actor: Actor,
): Promise<{ ok: true; deliveryId: string } | ChatFailure> {
  const [row] = await ctx.db.query(
    'SELECT provider, name, locale FROM chat_destinations WHERE id = ? AND workspace_id = ?',
    [input.id, input.workspaceId],
  );
  if (!row) return { ok: false, status: 404, error: 'not_found', message: 'Not found.' };
  const at = ctx.now();
  const payload = renderMessage(
    String(row.provider) as ChatProvider,
    buildTestMessage({ name: String(row.name), locale: String(row.locale) }),
  );
  return ctx.db.transaction(async (tx) => {
    const deliveryId = await queueChatDelivery(tx, {
      workspaceId: input.workspaceId,
      destinationId: input.id,
      alertId: null,
      kind: 'test',
      payload,
      at,
    });
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'chat.destination.test',
      target: { type: 'chat_destination', id: input.id },
      detail: { deliveryId },
      at,
    });
    return { ok: true as const, deliveryId };
  });
}

/** The address of a destination, decrypted: for the delivery job only. */
export function readDestinationUrl(
  ctx: Pick<ChatContext, 'masterKey'>,
  workspaceId: string,
  id: string,
  ciphertext: string,
): string {
  return decryptSecret(ciphertext, ctx.masterKey, chatAad(workspaceId, id));
}
