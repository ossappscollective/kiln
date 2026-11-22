import type { Role } from '@kiln/core';
import { can } from '@kiln/core';
import type { Database, Row, Sql } from '@kiln/db';
import { recordAudit } from '../../services/audit.ts';
import {
  type AlertChannel,
  type AlertData,
  type AlertSeverity,
  type AlertTypeId,
  alertDef,
  alertGroupLabels,
  configurableAlertTypes,
} from './catalog.ts';
import { raiseAlert } from './service.ts';
import { alertText } from './text.ts';

import { coded, type ErrorParams } from '../../i18n/problem.ts';
import { SOURCE_LOCALE } from '../../i18n/runtime.ts';
/** Reading side of alerts (docs/api/alerts.md): the inbox of a person, the delivery log, "send a test", and the catalog as the API shows it. */

export type InboxAlert = {
  id: string;
  type: AlertTypeId;
  severity: AlertSeverity;
  title: string;
  body: string;
  appId: string | null;
  /** How many times it happened (repeats collapse into one alert). */
  count: number;
  firstAt: number;
  lastAt: number;
  /** Set when the condition behind a state alert ended. */
  resolvedAt: number | null;
  read: boolean;
  /** The person's choices allow a desktop notification for it: the client shows it once. */
  desktop: boolean;
};

export const MAX_INBOX_LIMIT = 100;
export const DEFAULT_INBOX_LIMIT = 30;

/** The stored title and body (English), or, for a person who chose another language, the sentences rebuilt from the type and its data. */
function inboxText(r: Row, locale: string | undefined): { title: string; body: string } {
  const stored = { title: String(r.title), body: String(r.body) };
  if (!locale || locale === SOURCE_LOCALE) return stored;
  try {
    const data = JSON.parse(String(r.data ?? '{}')) as AlertData;
    return alertText(String(r.type), data, locale) ?? stored;
  } catch {
    return stored;
  }
}

const toInbox = (r: Row, locale?: string): InboxAlert => ({
  id: String(r.id),
  type: String(r.type) as AlertTypeId,
  severity: String(r.severity) as AlertSeverity,
  ...inboxText(r, locale),
  appId: r.app_id === null || r.app_id === undefined ? null : String(r.app_id),
  count: Number(r.count),
  firstAt: Number(r.first_at),
  lastAt: Number(r.last_at),
  resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  read: r.read_at !== null && r.read_at !== undefined,
  desktop: Number(r.desktop) === 1,
});

export async function unreadCount(sql: Sql, workspaceId: string, userId: string): Promise<number> {
  const [row] = await sql.query(
    'SELECT COUNT(*) AS n FROM alert_inbox WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL',
    [workspaceId, userId],
  );
  return Number(row?.n ?? 0);
}

export async function listInbox(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    unreadOnly?: boolean;
    limit?: number;
    before?: number;
    /** The person's language (`users.locale`): title and body come in it. Absent or `en`: the stored English text. */
    locale?: string | undefined;
  },
): Promise<{ alerts: InboxAlert[]; unreadCount: number; hasMore: boolean }> {
  const limit = Math.trunc(
    Math.min(Math.max(input.limit ?? DEFAULT_INBOX_LIMIT, 1), MAX_INBOX_LIMIT),
  );
  const where = ['i.workspace_id = ?', 'i.user_id = ?'];
  const params: (string | number)[] = [input.workspaceId, input.userId];
  if (input.unreadOnly) where.push('i.read_at IS NULL');
  if (input.before !== undefined) {
    where.push('a.last_at < ?');
    params.push(input.before);
  }
  const rows = await sql.query(
    `SELECT a.id, a.type, a.severity, a.app_id, a.title, a.body, a.data, a.count, a.first_at, a.last_at, a.resolved_at, i.read_at, i.desktop
       FROM alert_inbox i JOIN alerts a ON a.id = i.alert_id
      WHERE ${where.join(' AND ')} ORDER BY a.last_at DESC, a.id LIMIT ?`,
    [...params, limit + 1],
  );
  return {
    alerts: rows.slice(0, limit).map((r) => toInbox(r, input.locale)),
    unreadCount: await unreadCount(sql, input.workspaceId, input.userId),
    hasMore: rows.length > limit,
  };
}

/** Marks alerts read for one person: the given ids, or all of them. Returns how many changed. */
export async function markRead(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    ids?: readonly string[] | undefined;
    all?: boolean | undefined;
    at: number;
  },
): Promise<number> {
  const where = ['workspace_id = ?', 'user_id = ?', 'read_at IS NULL'];
  const params: (string | number)[] = [input.at, input.workspaceId, input.userId];
  if (!input.all) {
    if (!input.ids || input.ids.length === 0) return 0;
    where.push(`alert_id IN (${input.ids.map(() => '?').join(', ')})`);
    params.push(...input.ids);
  }
  return sql.execute(`UPDATE alert_inbox SET read_at = ? WHERE ${where.join(' AND ')}`, params);
}

// ----- the delivery log --------------------------------------------------------------------------------

export type DeliveryView = {
  id: string;
  alertId: string | null;
  alertType: string | null;
  title: string | null;
  userId: string | null;
  channel: AlertChannel;
  kind: 'alert' | 'digest' | 'test';
  status: string;
  /** A code from a fixed vocabulary (see `deliveryOutcomes`). */
  outcome: string;
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
};

export const MAX_DELIVERIES_LIMIT = 100;

const toDelivery = (r: Row): DeliveryView => ({
  id: String(r.id),
  alertId: r.alert_id === null || r.alert_id === undefined ? null : String(r.alert_id),
  alertType: r.type === null || r.type === undefined ? null : String(r.type),
  title: r.title === null || r.title === undefined ? null : String(r.title),
  userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
  channel: String(r.channel) as AlertChannel,
  kind: String(r.kind) as DeliveryView['kind'],
  status: String(r.status),
  outcome: String(r.outcome),
  attempts: Number(r.attempts),
  createdAt: Number(r.created_at),
  deliveredAt:
    r.delivered_at === null || r.delivered_at === undefined ? null : Number(r.delivered_at),
});

/** The log. `userId` limits it to one person's rows (what a member sees); without it: the whole workspace, webhook rows included. */
export async function listDeliveries(
  sql: Sql,
  input: { workspaceId: string; userId?: string; alertId?: string; limit?: number },
): Promise<DeliveryView[]> {
  const limit = Math.trunc(Math.min(Math.max(input.limit ?? 30, 1), MAX_DELIVERIES_LIMIT));
  const where = ['d.workspace_id = ?'];
  const params: (string | number)[] = [input.workspaceId];
  if (input.userId) {
    where.push('d.user_id = ?');
    params.push(input.userId);
  }
  if (input.alertId) {
    where.push('d.alert_id = ?');
    params.push(input.alertId);
  }
  const rows = await sql.query(
    `SELECT d.id, d.alert_id, d.user_id, d.channel, d.kind, d.status, d.outcome, d.attempts, d.created_at, d.delivered_at, a.type, a.title
       FROM alert_deliveries d LEFT JOIN alerts a ON a.id = d.alert_id
      WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id LIMIT ?`,
    [...params, limit],
  );
  return rows.map(toDelivery);
}

// ----- "send a test" -----------------------------------------------------------------------------------

export type TestAlertResult =
  | { ok: true; alertId: string; deliveries: DeliveryView[] }
  | {
      ok: false;
      status: 403 | 400;
      error: string;
      message?: string;
      code?: string;
      params?: ErrorParams;
    };

/**
 * Sends a test alert on one channel to the person who asked (the webhook channel goes to the workspace's endpoints and needs an
 * admin). It travels the real channel code, but never through the person's filters, and never counts against a limit. Email is
 * queued like every email: read its outcome in the log once the job ran.
 */
export async function sendTestAlert(
  ctx: { db: Database; now: () => number },
  input: { workspaceId: string; userId: string; role: Role; channel: AlertChannel },
): Promise<TestAlertResult> {
  if (input.channel === 'webhook' && !can(input.role, 'alerts.manage')) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: 'Only an admin can send a test to the workspace webhooks.',
      ...coded('alerts.testAdminOnly'),
    };
  }
  const def = alertDef('test.alert');
  if (!def) return { ok: false, status: 400, error: 'invalid_request' };
  const at = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const result = await raiseAlert(tx, {
      workspaceId: input.workspaceId,
      type: 'test.alert',
      data: { channel: input.channel },
      at,
      test: { userId: input.userId, channel: input.channel },
    });
    if (result.status !== 'raised')
      return { ok: false as const, status: 400 as const, error: 'invalid_request' };
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'alert.test',
      target: { type: 'alert', id: result.alertId },
      detail: { channel: input.channel },
      at,
    });
    return {
      ok: true as const,
      alertId: result.alertId,
      deliveries: await listDeliveries(tx, {
        workspaceId: input.workspaceId,
        alertId: result.alertId,
      }),
    };
  });
}

// ----- the catalog as the API shows it -----------------------------------------------------------------------

export type CatalogEntry = {
  id: AlertTypeId;
  group: string;
  groupLabel: string;
  label: string;
  description: string;
  severity: AlertSeverity;
  scope: 'workspace' | 'app';
  defaultChannels: AlertChannel[];
  allowedChannels: AlertChannel[];
  /** The action that decides who is told (people whose role has it). */
  audience: string;
  source: 'event' | 'state';
  events: string[];
  dedupe: string;
  dedupeWindowHours: number;
  params: { key: string; label: string; unit: string; default: number; min: number; max: number }[];
};

export const catalogEntries = (): CatalogEntry[] =>
  configurableAlertTypes.map((d) => ({
    id: d.id,
    group: d.group,
    groupLabel: alertGroupLabels[d.group],
    label: d.label,
    description: d.description,
    severity: d.severity,
    scope: d.scope,
    defaultChannels: [...d.defaultChannels],
    allowedChannels: [...d.allowedChannels],
    audience: d.audience,
    source: d.source.kind === 'event' ? 'event' : 'state',
    events: d.source.kind === 'event' ? [...d.source.events] : [],
    dedupe: d.dedupe,
    dedupeWindowHours: Math.round(d.dedupeWindowMs / 3_600_000),
    params: Object.entries(d.params).map(([key, p]) => ({ key, ...p })),
  }));

// ----- upkeep ------------------------------------------------------------------------------------------------

/** Deletes alerts, inbox rows and log rows older than `keepMs` (default 90 days), and conditions that ended. */
export async function pruneAlerts(
  sql: Sql,
  now: number,
  keepMs = 90 * 24 * 3_600_000,
): Promise<{ alerts: number; deliveries: number }> {
  const cutoff = now - keepMs;
  await sql.execute(
    'DELETE FROM alert_inbox WHERE alert_id IN (SELECT id FROM alerts WHERE last_at < ?)',
    [cutoff],
  );
  const deliveries = await sql.execute('DELETE FROM alert_deliveries WHERE created_at < ?', [
    cutoff,
  ]);
  await sql.execute('DELETE FROM alert_conditions WHERE active = 0 AND last_seen_at < ?', [cutoff]);
  const alerts = await sql.execute('DELETE FROM alerts WHERE last_at < ?', [cutoff]);
  return { alerts, deliveries };
}
