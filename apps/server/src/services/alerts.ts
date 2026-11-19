import { randomUUID } from 'node:crypto';
import { can, isRole, type Role } from '@mrm/core';
import type { Row, Sql } from '@mrm/db';
import { enqueue } from '../jobs.ts';
import {
  type AlertChannel,
  type AlertData,
  type AlertDef,
  type AlertSeverity,
  type AlertTypeId,
  alertDef,
  alertsFromEvent,
  isPersonalChannel,
  redactAlertData,
  resolveParams,
  severityRank,
} from './alert-catalog.ts';
import {
  defaultUserSettings,
  isMuted,
  loadRules,
  type MuteView,
  type RuleView,
  ruleView,
  toUserSettings,
  type UserSettings,
} from './alert-prefs.ts';
import { inQuietHours, quietEndsAt } from './alert-time.ts';
import { type EventRecord, emitEvent } from './events.ts';

/**
 * Alerts (docs/alerts.md, docs/adr/0022-alerts.md). An alert is a read-only side effect: it tells people about something and never
 * publishes or changes anything in a store.
 *
 * Two sources raise alerts. Every event written by `emitEvent` passes `observeEventForAlerts` (one call in events.ts, so no
 * emitter changes); conditions that exist only as state are found by the evaluator (alert-evaluator.ts). Both end in `raiseAlert`:
 * collapse repeats (dedupe key and window), keep one workspace from flooding (a cap per type and hour), write the alert, then for
 * each person who may read it decide each channel (workspace rule, their own choice, severity, mute, quiet hours, digest) and write
 * a row for the in-app inbox and a row in the delivery log. Email goes through a job so a failure is retried with backoff; the webhook
 * channel is the event `alert.raised`, delivered by the existing signed webhooks.
 */

export const ALERT_QUEUE = 'alert.deliver';
/** Alert emails one person gets per hour, whatever the types, before the rest are only logged. */
export const MAX_EMAILS_PER_USER_PER_HOUR = 20;
const HOUR = 3_600_000;

export const deliveryStatuses = [
  'queued',
  'retrying',
  'sent',
  'failed',
  'skipped',
  'deferred',
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/** The fixed vocabulary of the delivery log: a screen can explain each, and nothing a provider said is ever stored. */
export const deliveryOutcomes = [
  'ok',
  'queued_for_client',
  'queued_for_endpoints',
  'in_digest',
  'digest_sent',
  'quiet_hours',
  'muted',
  'below_minimum_severity',
  'user_rate_limited',
  'no_address',
  'recipient_gone',
  'no_endpoint',
  'smtp_not_configured',
  'smtp_connection_failed',
  'smtp_auth_failed',
  'smtp_tls_failed',
  'smtp_rejected',
  'smtp_timeout',
] as const;
export type DeliveryOutcome = (typeof deliveryOutcomes)[number];

export type RaiseInput = {
  workspaceId: string;
  type: AlertTypeId;
  appId?: string | null;
  data: Record<string, unknown>;
  /** Epoch milliseconds. */
  at: number;
  /** "Send a test": one person, one channel, no collapsing, no limits. */
  test?: { userId: string; channel: AlertChannel };
};

export type RaiseResult =
  | { status: 'raised'; alertId: string }
  | { status: 'collapsed' | 'throttled'; alertId: string }
  | { status: 'disabled' };

type Recipient = { userId: string; role: Role; email: string; settings: UserSettings };

const newId = () => randomUUID();

async function loadRecipients(sql: Sql, workspaceId: string, def: AlertDef): Promise<Recipient[]> {
  const rows = await sql.query(
    `SELECT m.user_id, m.role, u.email, s.min_severity, s.quiet_start, s.quiet_end, s.timezone, s.digest, s.digest_hour, s.last_digest_at
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN alert_user_settings s ON s.workspace_id = m.workspace_id AND s.user_id = m.user_id
      WHERE m.workspace_id = ? ORDER BY m.user_id`,
    [workspaceId],
  );
  const out: Recipient[] = [];
  for (const r of rows) {
    if (!isRole(r.role) || !can(r.role, def.audience) || !can(r.role, 'alerts.read')) continue;
    out.push({
      userId: String(r.user_id),
      role: r.role,
      email: String(r.email),
      settings:
        r.min_severity === null || r.min_severity === undefined
          ? defaultUserSettings()
          : toUserSettings(r),
    });
  }
  return out;
}

/** The channels one person gets: their own choice for this app, else for all apps, else the workspace rule. */
export function effectiveChannels(
  def: AlertDef,
  rule: Pick<RuleView, 'channels'>,
  prefs: readonly { appId: string | null; channels: readonly AlertChannel[] }[],
  appId: string | null,
): AlertChannel[] {
  const own =
    (appId !== null ? prefs.find((p) => p.appId === appId) : undefined) ??
    prefs.find((p) => p.appId === null);
  const base = (own ? own.channels : rule.channels).filter(
    (c) => isPersonalChannel(c) && def.allowedChannels.includes(c),
  );
  // The desktop notification is shown from the inbox.
  return base.includes('desktop') && !base.includes('in_app') ? ['in_app', ...base] : [...base];
}

export function renderEmail(
  def: AlertDef,
  title: string,
  body: string,
  severity: AlertSeverity,
  count: number,
): { subject: string; text: string } {
  const subject = `[${severity}] ${title}`.slice(0, 200);
  const text = [
    title,
    '',
    body,
    count > 1 ? `\nThis happened ${count} times.` : '',
    '',
    `Alert type: ${def.id}. Severity: ${severity}.`,
    'You get this email because of your alert settings in Mobile Release Manager. Change them in Alerts, Settings.',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
  return { subject, text };
}

async function logDelivery(
  sql: Sql,
  input: {
    workspaceId: string;
    alertId: string | null;
    userId: string | null;
    channel: AlertChannel;
    kind: 'alert' | 'digest' | 'test';
    status: DeliveryStatus;
    outcome: DeliveryOutcome;
    subject?: string;
    body?: string;
    eventId?: number | null;
    at: number;
  },
): Promise<string> {
  const id = newId();
  await sql.execute(
    `INSERT INTO alert_deliveries
       (id, workspace_id, alert_id, user_id, channel, kind, status, outcome, attempts, subject, body, event_id, created_at, updated_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.alertId,
      input.userId,
      input.channel,
      input.kind,
      input.status,
      input.outcome,
      input.subject ?? null,
      input.body ?? null,
      input.eventId ?? null,
      input.at,
      input.at,
      input.status === 'sent' ? input.at : null,
    ],
  );
  return id;
}

/** Queues the mail of a delivery row as a job; `runAt` later than `at` defers it (quiet hours). */
export async function queueEmailJob(
  sql: Sql,
  deliveryId: string,
  at: number,
  runAt = at,
): Promise<void> {
  await enqueue(sql, ALERT_QUEUE, { deliveryId }, { now: at, runAt });
}

const recentEmails = async (
  sql: Sql,
  workspaceId: string,
  userId: string,
  at: number,
): Promise<number> => {
  const [row] = await sql.query(
    `SELECT COUNT(*) AS n FROM alert_deliveries
      WHERE workspace_id = ? AND user_id = ? AND channel = 'email' AND created_at > ? AND status IN ('queued', 'retrying', 'sent', 'deferred')
        AND outcome <> 'in_digest'`,
    [workspaceId, userId, at - HOUR],
  );
  return Number(row?.n ?? 0);
};

/**
 * Raises one alert. Safe to call with a transaction (events do) or the database. Returns what happened; it never sends anything
 * itself except the `alert.raised` event (the webhook channel) and jobs for email.
 */
export async function raiseAlert(sql: Sql, input: RaiseInput): Promise<RaiseResult> {
  const def = alertDef(input.type);
  if (!def) return { status: 'disabled' };
  const { workspaceId, at } = input;
  const rules = await loadRules(sql, workspaceId);
  const stored = rules.get(def.id);
  const rule = ruleView(def, stored);
  const test = input.test;
  if (!test && !rule.enabled) return { status: 'disabled' };

  const appId = input.appId ?? (typeof input.data.appId === 'string' ? input.data.appId : null);
  const data = redactAlertData({ ...input.data, appId });
  if (appId && data.appName === undefined) {
    const [a] = await sql.query(
      'SELECT name, platform FROM apps WHERE id = ? AND workspace_id = ?',
      [appId, workspaceId],
    );
    if (a) {
      data.appName = String(a.name);
      data.platform = String(a.platform);
    }
  }
  if (test) data.nonce = newId();
  const key = def.dedupeKey(data);

  if (!test) {
    // Repeats collapse into the alert that is already there.
    if (def.dedupeWindowMs > 0) {
      const [same] = await sql.query(
        'SELECT id FROM alerts WHERE workspace_id = ? AND dedupe_key = ? AND last_at > ? AND is_test = 0 ORDER BY last_at DESC LIMIT 1',
        [workspaceId, key, at - def.dedupeWindowMs],
      );
      if (same) {
        await sql.execute(
          'UPDATE alerts SET count = count + 1, last_at = ?, resolved_at = NULL WHERE id = ?',
          [at, String(same.id)],
        );
        return { status: 'collapsed', alertId: String(same.id) };
      }
    }
    // One workspace cannot flood: past the cap, further alerts of the type are only counted on the newest one.
    const [recent] = await sql.query(
      'SELECT COUNT(*) AS n FROM alerts WHERE workspace_id = ? AND type = ? AND first_at > ? AND is_test = 0',
      [workspaceId, def.id, at - HOUR],
    );
    if (Number(recent?.n ?? 0) >= rule.maxPerHour) {
      const [last] = await sql.query(
        'SELECT id FROM alerts WHERE workspace_id = ? AND type = ? AND is_test = 0 ORDER BY first_at DESC LIMIT 1',
        [workspaceId, def.id],
      );
      if (last) {
        await sql.execute('UPDATE alerts SET count = count + 1, last_at = ? WHERE id = ?', [
          at,
          String(last.id),
        ]);
        return { status: 'throttled', alertId: String(last.id) };
      }
    }
  }

  const title = def.title(data).slice(0, 300);
  const body = def.body(data).slice(0, 2000);
  const alertId = newId();
  await sql.execute(
    `INSERT INTO alerts (id, workspace_id, type, severity, app_id, dedupe_key, title, body, data, count, first_at, last_at, resolved_at, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)`,
    [
      alertId,
      workspaceId,
      def.id,
      def.severity,
      appId,
      key,
      title,
      body,
      JSON.stringify(data),
      at,
      at,
      test ? 1 : 0,
    ],
  );

  // ----- the people --------------------------------------------------------------------------------------
  const recipients = (await loadRecipients(sql, workspaceId, def)).filter(
    (r) => !test || r.userId === test.userId,
  );
  if (recipients.length > 0) {
    const ids = recipients.map((r) => r.userId);
    const marks = ids.map(() => '?').join(', ');
    const prefRows = await sql.query(
      `SELECT user_id, app_id, channels FROM alert_preferences WHERE workspace_id = ? AND alert_type = ? AND user_id IN (${marks})`,
      [workspaceId, def.id, ...ids],
    );
    const muteRows = await sql.query(
      `SELECT user_id, id, app_id, alert_type, until, created_at FROM alert_mutes WHERE workspace_id = ? AND user_id IN (${marks}) AND (until IS NULL OR until > ?)`,
      [workspaceId, ...ids, at],
    );
    for (const r of recipients) {
      const prefs = prefRows
        .filter((p) => String(p.user_id) === r.userId)
        .map((p) => {
          let channels: AlertChannel[] = [];
          try {
            channels = (JSON.parse(String(p.channels)) as unknown[]).filter(
              (c): c is AlertChannel => isPersonalChannel(c),
            );
          } catch {
            // A broken row counts as no choice.
          }
          return { appId: String(p.app_id) === '' ? null : String(p.app_id), channels };
        });
      const mutes: MuteView[] = muteRows
        .filter((m: Row) => String(m.user_id) === r.userId)
        .map((m: Row) => ({
          id: String(m.id),
          appId: m.app_id === null || m.app_id === undefined ? null : String(m.app_id),
          alertType:
            m.alert_type === null || m.alert_type === undefined
              ? null
              : (String(m.alert_type) as AlertTypeId),
          until: m.until === null || m.until === undefined ? null : Number(m.until),
          createdAt: Number(m.created_at),
        }));
      await deliverToPerson(sql, {
        def,
        rule,
        alertId,
        workspaceId,
        appId,
        at,
        title,
        body,
        severity: def.severity,
        recipient: r,
        prefs,
        mutes,
        test,
      });
    }
  }

  // ----- the workspace webhook channel ------------------------------------------------------------------------
  if (
    (test ? test.channel === 'webhook' : rule.channels.includes('webhook')) &&
    def.allowedChannels.includes('webhook')
  ) {
    // The event is only written when a webhook listens for it, so a workspace without one keeps an event log free of alerts
    // (the inbox and the delivery log already show them).
    if (!(await webhookListens(sql, workspaceId))) {
      await logDelivery(sql, {
        workspaceId,
        alertId,
        userId: null,
        channel: 'webhook',
        kind: test ? 'test' : 'alert',
        status: 'skipped',
        outcome: 'no_endpoint',
        at,
      });
      return { status: 'raised', alertId };
    }
    const event = await emitEvent(sql, {
      workspaceId,
      type: 'alert.raised',
      subject: appId ? { appId } : {},
      payload: {
        alertId,
        alertType: def.id,
        severity: def.severity,
        title,
        appId,
        count: 1,
        test: Boolean(test),
      },
      at,
    });
    const [n] = await sql.query('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event_id = ?', [
      event.id,
    ]);
    const queued = Number(n?.n ?? 0) > 0;
    await logDelivery(sql, {
      workspaceId,
      alertId,
      userId: null,
      channel: 'webhook',
      kind: test ? 'test' : 'alert',
      status: queued ? 'queued' : 'skipped',
      outcome: queued ? 'queued_for_endpoints' : 'no_endpoint',
      eventId: event.id,
      at,
    });
  }
  return { status: 'raised', alertId };
}

/** Whether an enabled webhook of the workspace listens for `alert.raised` (by name or with `*`). */
async function webhookListens(sql: Sql, workspaceId: string): Promise<boolean> {
  const rows = await sql.query(
    'SELECT event_types FROM webhook_endpoints WHERE workspace_id = ? AND enabled = 1',
    [workspaceId],
  );
  return rows.some((r) => {
    try {
      const wanted: unknown = JSON.parse(String(r.event_types));
      return Array.isArray(wanted) && (wanted.includes('*') || wanted.includes('alert.raised'));
    } catch {
      return false;
    }
  });
}

/** What "send a test" uses per channel: the desktop notification is shown from the inbox; the webhook channel is not per person. */
const testChannels = (channel: AlertChannel): AlertChannel[] =>
  channel === 'desktop' ? ['in_app', 'desktop'] : channel === 'webhook' ? [] : [channel];

async function deliverToPerson(
  sql: Sql,
  c: {
    def: AlertDef;
    rule: RuleView;
    alertId: string;
    workspaceId: string;
    appId: string | null;
    at: number;
    title: string;
    body: string;
    severity: AlertSeverity;
    recipient: Recipient;
    prefs: readonly { appId: string | null; channels: readonly AlertChannel[] }[];
    mutes: readonly MuteView[];
    test: RaiseInput['test'];
  },
): Promise<void> {
  const { def, recipient: r, at } = c;
  const kind = c.test ? 'test' : 'alert';
  const wanted = c.test
    ? testChannels(c.test.channel)
    : effectiveChannels(def, c.rule, c.prefs, c.appId);
  if (wanted.length === 0) return;
  const log = (
    channel: AlertChannel,
    status: DeliveryStatus,
    outcome: DeliveryOutcome,
    extra: { subject?: string; body?: string } = {},
  ) =>
    logDelivery(sql, {
      workspaceId: c.workspaceId,
      alertId: c.alertId,
      userId: r.userId,
      channel,
      kind,
      status,
      outcome,
      at,
      ...extra,
    });

  // Tests go through the same channel code but not through the person's filters: pressing the button must show what the channel does.
  if (!c.test) {
    if (severityRank[c.severity] < severityRank[r.settings.minSeverity]) {
      for (const ch of wanted) await log(ch, 'skipped', 'below_minimum_severity');
      return;
    }
    if (isMuted(c.mutes, def.id, c.appId, at)) {
      for (const ch of wanted) await log(ch, 'skipped', 'muted');
      return;
    }
  }
  const quiet =
    !c.test &&
    c.severity !== 'critical' &&
    inQuietHours(
      { start: r.settings.quietStart, end: r.settings.quietEnd, timezone: r.settings.timezone },
      at,
    );

  if (wanted.includes('in_app')) {
    const desktop = wanted.includes('desktop') && !quiet;
    await sql.execute(
      'INSERT INTO alert_inbox (alert_id, user_id, workspace_id, desktop, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      [c.alertId, r.userId, c.workspaceId, desktop ? 1 : 0, at],
    );
    await log('in_app', 'sent', 'ok');
    if (wanted.includes('desktop')) {
      await (desktop
        ? log('desktop', 'queued', 'queued_for_client')
        : log('desktop', 'skipped', 'quiet_hours'));
    }
  }
  if (wanted.includes('email')) {
    const rendered = renderEmail(def, c.title, c.body, c.severity, 1);
    const mail = { subject: rendered.subject, body: rendered.text };
    if (!c.test && r.settings.digest !== 'off' && c.severity !== 'critical') {
      await log('email', 'deferred', 'in_digest', mail);
    } else if (quiet) {
      const id = await log('email', 'deferred', 'quiet_hours', mail);
      await queueEmailJob(
        sql,
        id,
        at,
        quietEndsAt(
          { start: r.settings.quietStart, end: r.settings.quietEnd, timezone: r.settings.timezone },
          at,
        ),
      );
    } else if (
      !c.test &&
      (await recentEmails(sql, c.workspaceId, r.userId, at)) >= MAX_EMAILS_PER_USER_PER_HOUR
    ) {
      await log('email', 'skipped', 'user_rate_limited');
    } else {
      const id = await log('email', 'queued', 'ok', mail);
      await queueEmailJob(sql, id, at);
    }
  }
}

/**
 * The hook `emitEvent` calls after it wrote an event: raises the alerts that event gives rise to. Alert events themselves are
 * skipped (no loops). A failure here is swallowed: an alert must never undo the thing it is about.
 */
export async function observeEventForAlerts(sql: Sql, event: EventRecord): Promise<void> {
  if (event.type.startsWith('alert.')) return;
  try {
    const rules = await loadRules(sql, event.workspaceId);
    const matches = alertsFromEvent(event, (d) => resolveParams(d, rules.get(d.id)?.params));
    for (const m of matches) {
      await raiseAlert(sql, {
        workspaceId: event.workspaceId,
        type: m.def.id,
        appId: event.subject.appId ?? null,
        data: m.data,
        at: event.createdAt,
      });
    }
  } catch {
    // Best effort by design (docs/adr/0022-alerts.md).
  }
}

export type { AlertData };
