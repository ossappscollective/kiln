/**
 * Alerts in the web (docs/alerts.md, docs/api/alerts.md): the shapes of the API and the pure logic of the screens. Written for the
 * ES2017 web build. Everything shown comes from fixed codes or from text the server rendered out of ids and names; the delivery log
 * is explained with sentences chosen here, never with text a provider said.
 */

export type AlertChannel = 'in_app' | 'email' | 'desktop' | 'webhook';
export type PersonalChannel = 'in_app' | 'email' | 'desktop';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export const personalChannels: PersonalChannel[] = ['in_app', 'email', 'desktop'];
export const allChannels: AlertChannel[] = ['in_app', 'email', 'desktop', 'webhook'];

export const channelLabels: Record<AlertChannel, string> = {
  in_app: 'In the app',
  email: 'Email',
  desktop: 'Desktop notification',
  webhook: 'Webhook',
};

export const severityLabels: Record<AlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};
export const severityTone: Record<AlertSeverity, 'info' | 'warn' | 'bad'> = {
  info: 'info',
  warning: 'warn',
  critical: 'bad',
};

export type CatalogParam = {
  key: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
};

export type RuleView = {
  alertType: string;
  enabled: boolean;
  channels: AlertChannel[];
  maxPerHour: number;
  params: Record<string, number>;
  custom: boolean;
};

export type CatalogEntry = {
  id: string;
  group: string;
  groupLabel: string;
  label: string;
  description: string;
  severity: AlertSeverity;
  scope: 'workspace' | 'app';
  defaultChannels: AlertChannel[];
  allowedChannels: AlertChannel[];
  audience: string;
  source: 'event' | 'state';
  events: string[];
  dedupe: string;
  dedupeWindowHours: number;
  params: CatalogParam[];
  visible: boolean;
  rule: RuleView;
};

export type InboxAlert = {
  id: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  appId: string | null;
  count: number;
  firstAt: number;
  lastAt: number;
  resolvedAt: number | null;
  read: boolean;
  desktop: boolean;
};

export type AlertInboxPage = {
  alerts: InboxAlert[];
  unreadCount: number;
  hasMore: boolean;
  now: number;
};

export type UserSettings = {
  minSeverity: AlertSeverity;
  quietStart: number | null;
  quietEnd: number | null;
  timezone: string | null;
  digest: 'off' | 'daily' | 'weekly';
  digestHour: number;
  lastDigestAt: number | null;
};
export type Preference = { alertType: string; appId: string | null; channels: AlertChannel[] };
export type Mute = {
  id: string;
  appId: string | null;
  alertType: string | null;
  until: number | null;
  createdAt: number;
};
export type SettingsPage = { settings: UserSettings; preferences: Preference[]; mutes: Mute[] };

export type Delivery = {
  id: string;
  alertId: string | null;
  alertType: string | null;
  title: string | null;
  userId: string | null;
  channel: AlertChannel;
  kind: 'alert' | 'digest' | 'test';
  status: string;
  outcome: string;
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
};
export type AlertTestResult = { alertId: string; deliveries: Delivery[] };

// ----- the delivery log, in words --------------------------------------------------------------------------

/** One sentence per outcome code of the server's fixed vocabulary (a test keeps the two lists equal). */
export const outcomeLabels: Record<string, string> = {
  ok: 'Delivered.',
  queued_for_client: 'Waiting for the app to show it as a desktop notification.',
  queued_for_endpoints:
    'Sent to your webhook endpoints; each has its own delivery log under Webhooks.',
  in_digest: 'Held for your digest.',
  digest_sent: 'Sent in a digest.',
  quiet_hours: 'Held back by quiet hours.',
  muted: 'Muted by you.',
  below_minimum_severity: 'Below the lowest severity you asked for.',
  user_rate_limited: 'Too many emails this hour; not sent.',
  no_address: 'There is no email address for this person.',
  recipient_gone: 'The person left the workspace.',
  no_endpoint: 'No webhook endpoint listens for alerts. Add one under Webhooks.',
  smtp_not_configured: 'No mail server is set up. An admin can add one in Settings.',
  smtp_connection_failed: 'The mail server could not be reached.',
  smtp_auth_failed: 'The mail server refused the login. Check the mail settings.',
  smtp_tls_failed: 'A secure connection to the mail server could not be made.',
  smtp_rejected: 'The mail server did not accept the message.',
  smtp_timeout: 'The mail server did not answer in time.',
};

export const describeOutcome = (outcome: string): string =>
  outcomeLabels[outcome] || 'Unknown result.';

export const statusLabels: Record<string, string> = {
  queued: 'Queued',
  retrying: 'Will retry',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  deferred: 'Held',
};
export const statusTone = (status: string): 'ok' | 'bad' | 'warn' | 'neutral' =>
  status === 'sent'
    ? 'ok'
    : status === 'failed'
      ? 'bad'
      : status === 'retrying'
        ? 'warn'
        : 'neutral';

// ----- the matrix ----------------------------------------------------------------------------------------------

/** What one person gets for a type: their own choice for the app, else for all apps, else the workspace rule. Mirrors the server. */
export function effectiveChannels(
  entry: Pick<CatalogEntry, 'allowedChannels' | 'rule'>,
  prefs: Preference[],
  alertType: string,
  appId: string | null,
): PersonalChannel[] {
  const mine = prefs.filter((p) => p.alertType === alertType);
  const own =
    (appId !== null ? mine.filter((p) => p.appId === appId)[0] : undefined) ||
    mine.filter((p) => p.appId === null)[0];
  const base = (own ? own.channels : entry.rule.channels).filter(
    (c): c is PersonalChannel => c !== 'webhook' && entry.allowedChannels.indexOf(c) >= 0,
  );
  return base.indexOf('desktop') >= 0 && base.indexOf('in_app') < 0
    ? (['in_app'].concat(base) as PersonalChannel[])
    : base;
}

/** The channels after turning one on or off. The desktop notification is shown from the inbox, so it needs the inbox. */
export function toggleChannel(
  current: PersonalChannel[],
  channel: PersonalChannel,
  on: boolean,
): PersonalChannel[] {
  let next = current.filter((c) => c !== channel);
  if (on) next = next.concat([channel]);
  if (channel === 'in_app' && !on) next = next.filter((c) => c !== 'desktop');
  if (channel === 'desktop' && on && next.indexOf('in_app') < 0) next = next.concat(['in_app']);
  return personalChannels.filter((c) => next.indexOf(c) >= 0);
}

export type MatrixGroup = { id: string; label: string; entries: CatalogEntry[] };

/** The catalog grouped for the matrix, in catalog order, leaving out what the person's role can never receive. */
export function matrixGroups(catalog: CatalogEntry[]): MatrixGroup[] {
  const groups: MatrixGroup[] = [];
  for (const entry of catalog) {
    if (!entry.visible) continue;
    let g = groups.filter((x) => x.id === entry.group)[0];
    if (!g) {
      g = { id: entry.group, label: entry.groupLabel, entries: [] };
      groups.push(g);
    }
    g.entries.push(entry);
  }
  return groups;
}

// ----- the inbox -------------------------------------------------------------------------------------------------

export type InboxGroup = {
  id: 'attention' | 'info' | 'resolved';
  title: string;
  alerts: InboxAlert[];
};

/** Open critical and warning alerts first, then information, then what ended by itself. Empty groups are left out. */
export function groupInbox(alerts: InboxAlert[]): InboxGroup[] {
  const attention = alerts.filter((a) => a.resolvedAt === null && a.severity !== 'info');
  const info = alerts.filter((a) => a.resolvedAt === null && a.severity === 'info');
  const resolved = alerts.filter((a) => a.resolvedAt !== null);
  const out: InboxGroup[] = [
    { id: 'attention', title: 'Needs attention', alerts: attention },
    { id: 'info', title: 'For your information', alerts: info },
    { id: 'resolved', title: 'Resolved', alerts: resolved },
  ];
  return out.filter((g) => g.alerts.length > 0);
}

export const badgeCount = (n: number): string => (n <= 0 ? '' : n > 99 ? '99+' : String(n));

// ----- quiet hours and the digest, as a person types them ---------------------------------------------------------

export function minutesToTime(minutes: number | null): string {
  if (minutes === null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}

/** `22:30` to minutes after midnight; null for anything else (an empty box means no quiet hours). */
export function timeToMinutes(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function quietSummary(
  s: Pick<UserSettings, 'quietStart' | 'quietEnd' | 'timezone'>,
): string {
  if (s.quietStart === null || s.quietEnd === null) return 'No quiet hours';
  return `Quiet from ${minutesToTime(s.quietStart)} to ${minutesToTime(s.quietEnd)} (${s.timezone || 'UTC'}); critical alerts still come through`;
}

export const snoozeChoices: { hours: number | null; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '1 week' },
  { hours: null, label: 'Until I turn it back on' },
];

export function muteLabel(
  m: Mute,
  appName: (id: string) => string,
  typeLabel: (id: string) => string,
): string {
  const what = m.alertType ? typeLabel(m.alertType) : 'All alerts';
  const where = m.appId ? ` for ${appName(m.appId)}` : '';
  return `${what}${where}`;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** What an admin changes for a type, as the body of `PUT /alerts/rules/:type`, from the form's values. */
export function ruleBody(form: {
  enabled: boolean;
  channels: AlertChannel[];
  maxPerHour: number;
  params: Record<string, number>;
}) {
  return {
    enabled: form.enabled,
    channels: form.channels,
    maxPerHour: form.maxPerHour,
    params: form.params,
  };
}
