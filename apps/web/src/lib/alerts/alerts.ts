/**
 * Alerts in the web (docs/alerts.md, docs/api/alerts.md): the shapes of the API and the pure logic of the screens. Written for the
 * ES2017 web build. Everything shown comes from fixed codes or from text the server rendered out of ids and names; the delivery log
 * is explained with sentences chosen here, never with text a provider said.
 */

import { currentLocale, k, t } from '../i18n/t.ts';

export type AlertChannel = 'in_app' | 'email' | 'desktop' | 'webhook';
export type PersonalChannel = 'in_app' | 'email' | 'desktop';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export const personalChannels: PersonalChannel[] = ['in_app', 'email', 'desktop'];
export const allChannels: AlertChannel[] = ['in_app', 'email', 'desktop', 'webhook'];

/** Message keys: `channelLabel(channel)` is the text. */
export const channelKeys: Record<AlertChannel, string> = {
  in_app: k('workspace:alerts.channel.inApp'),
  email: k('workspace:alerts.channel.email'),
  desktop: k('workspace:alerts.channel.desktop'),
  webhook: k('workspace:alerts.channel.webhook'),
};
export const channelLabel = (channel: AlertChannel): string => t(channelKeys[channel]);

export const severityKeys: Record<AlertSeverity, string> = {
  info: k('workspace:alerts.severity.info'),
  warning: k('workspace:alerts.severity.warning'),
  critical: k('workspace:alerts.severity.critical'),
};
/** Lower-case the first letter for the middle of a sentence; German keeps it (its nouns are capitalised). */
export const lowerFirst = (text: string): string =>
  currentLocale() === 'de' ? text : text.charAt(0).toLowerCase() + text.slice(1);

export const severityLabel = (severity: AlertSeverity): string => t(severityKeys[severity]);
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
export const outcomeKeys: Record<string, string> = {
  ok: k('workspace:alerts.outcome.ok'),
  queued_for_client: k('workspace:alerts.outcome.queuedForClient'),
  queued_for_endpoints: k('workspace:alerts.outcome.queuedForEndpoints'),
  in_digest: k('workspace:alerts.outcome.inDigest'),
  digest_sent: k('workspace:alerts.outcome.digestSent'),
  quiet_hours: k('workspace:alerts.outcome.quietHours'),
  muted: k('workspace:alerts.outcome.muted'),
  below_minimum_severity: k('workspace:alerts.outcome.belowMinimumSeverity'),
  user_rate_limited: k('workspace:alerts.outcome.userRateLimited'),
  no_address: k('workspace:alerts.outcome.noAddress'),
  recipient_gone: k('workspace:alerts.outcome.recipientGone'),
  no_endpoint: k('workspace:alerts.outcome.noEndpoint'),
  smtp_not_configured: k('workspace:alerts.outcome.smtpNotConfigured'),
  smtp_connection_failed: k('workspace:alerts.outcome.smtpConnectionFailed'),
  smtp_auth_failed: k('workspace:alerts.outcome.smtpAuthFailed'),
  smtp_tls_failed: k('workspace:alerts.outcome.smtpTlsFailed'),
  smtp_rejected: k('workspace:alerts.outcome.smtpRejected'),
  smtp_timeout: k('workspace:alerts.outcome.smtpTimeout'),
};

export const describeOutcome = (outcome: string): string => {
  const key = outcomeKeys[outcome];
  return key ? t(key) : t('workspace:alerts.outcome.unknown');
};

export const statusKeys: Record<string, string> = {
  queued: k('workspace:alerts.status.queued'),
  retrying: k('workspace:alerts.status.retrying'),
  sent: k('workspace:alerts.status.sent'),
  failed: k('workspace:alerts.status.failed'),
  skipped: k('workspace:alerts.status.skipped'),
  deferred: k('workspace:alerts.status.deferred'),
};
/** The words for a delivery status; a status this version does not know is shown as it is. */
export const statusLabel = (status: string): string => {
  const key = statusKeys[status];
  return key ? t(key) : status;
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
    { id: 'attention', title: t('workspace:alerts.group.attention'), alerts: attention },
    { id: 'info', title: t('workspace:alerts.group.info'), alerts: info },
    { id: 'resolved', title: t('workspace:alerts.group.resolved'), alerts: resolved },
  ];
  return out.filter((g) => g.alerts.length > 0);
}

/**
 * The one line at the top of the inbox: what needs the person first ("2 need attention, 3 unread"). Open warnings and criticals are
 * "need attention"; when there are none it says so, so an empty "Needs attention" group is never a mystery.
 */
export function inboxHeadline(groups: readonly InboxGroup[], unread: number): string {
  const need = groups.find((g) => g.id === 'attention')?.alerts.length ?? 0;
  if (need === 0)
    return unread > 0
      ? t('workspace:alerts.headline.nothingUnread', { unread })
      : t('workspace:alerts.headline.nothing');
  return unread > 0
    ? t('workspace:alerts.headline.attentionUnread', { count: need, unread })
    : t('workspace:alerts.headline.attention', { count: need });
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
  if (s.quietStart === null || s.quietEnd === null) return t('workspace:alerts.quiet.none');
  return t('workspace:alerts.quiet.summary', {
    from: minutesToTime(s.quietStart),
    to: minutesToTime(s.quietEnd),
    zone: s.timezone || 'UTC',
  });
}

export const snoozeChoices: { hours: number | null; labelKey: string }[] = [
  { hours: 1, labelKey: k('workspace:alerts.snooze.hour1') },
  { hours: 8, labelKey: k('workspace:alerts.snooze.hours8') },
  { hours: 24, labelKey: k('workspace:alerts.snooze.day1') },
  { hours: 24 * 7, labelKey: k('workspace:alerts.snooze.week1') },
  { hours: null, labelKey: k('workspace:alerts.snooze.untilOn') },
];

export function muteLabel(
  m: Mute,
  appName: (id: string) => string,
  typeLabel: (id: string) => string,
): string {
  const what = m.alertType ? typeLabel(m.alertType) : t('workspace:alerts.mute.all');
  return m.appId ? t('workspace:alerts.mute.forApp', { what, app: appName(m.appId) }) : what;
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
