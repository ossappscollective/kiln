import type { CatalogEntry } from '../alerts/alerts.ts';
import { k, t } from '../i18n/t.ts';
import type { AppSummary } from '../types.ts';

/**
 * Chat integrations, the pure part of the screen (Settings, Chat): the shapes of the API, the form of a destination and of a routing
 * rule, what to send, and the words for statuses and outcomes. No DOM, no network. The webhook URL is typed once: after saving, the
 * server returns only its last four characters, so a form for an existing destination starts with an empty address field.
 */

export type ChatProvider = 'slack' | 'teams';
export type ChatSeverity = 'info' | 'warning' | 'critical';

export type ChatRoute = {
  id: string;
  alertTypes: string[];
  minSeverity: ChatSeverity;
  appIds: string[] | null;
  platforms: string[] | null;
  enabled: boolean;
};

export type ChatDestination = {
  id: string;
  provider: ChatProvider;
  name: string;
  /** The last four characters of the address. The address itself is never sent to the browser. */
  urlHint: string;
  locale: string;
  enabled: boolean;
  allowAnyHost: boolean;
  digest: 'off' | 'daily';
  digestHour: number;
  timezone: string;
  createdAt: number;
  updatedAt: number;
  routes: ChatRoute[];
  lastDelivery: { status: string; outcome: string; at: number } | null;
};

export type ChatDelivery = {
  id: string;
  destinationId: string;
  alertId: string | null;
  kind: 'alert' | 'digest' | 'test';
  status: 'queued' | 'retrying' | 'sent' | 'failed' | 'skipped' | 'deferred';
  outcome: string;
  httpStatus: number | null;
  attempts: number;
  title: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

export const providerChoices: { id: ChatProvider; labelKey: string }[] = [
  { id: 'slack', labelKey: k('chat:provider.slack') },
  { id: 'teams', labelKey: k('chat:provider.teams') },
];

export const providerName = (provider: ChatProvider): string =>
  provider === 'slack' ? t('chat:provider.slack') : t('chat:provider.teams');

/** The steps to get the address, by provider: catalog keys, in order. */
export const helpSteps: Record<ChatProvider, string[]> = {
  slack: [
    k('chat:help.slack.step1'),
    k('chat:help.slack.step2'),
    k('chat:help.slack.step3'),
    k('chat:help.slack.step4'),
  ],
  teams: [
    k('chat:help.teams.step1'),
    k('chat:help.teams.step2'),
    k('chat:help.teams.step3'),
    k('chat:help.teams.step4'),
  ],
};

export const urlPlaceholder: Record<ChatProvider, string> = {
  slack: 'https://hooks.slack.com/services/…',
  teams: 'https://….environment.api.powerplatform.com/…',
};

export const severityChoices: { id: ChatSeverity; labelKey: string; fromKey: string }[] = [
  { id: 'info', labelKey: k('chat:severity.info'), fromKey: k('chat:routes.from.info') },
  { id: 'warning', labelKey: k('chat:severity.warning'), fromKey: k('chat:routes.from.warning') },
  {
    id: 'critical',
    labelKey: k('chat:severity.critical'),
    fromKey: k('chat:routes.from.critical'),
  },
];

export const platformChoices = [
  { id: 'ios', label: 'iOS' },
  { id: 'macos', label: 'macOS' },
  { id: 'android', label: 'Android' },
];

// ----- the destination form ----------------------------------------------------------------------------------

export type DestinationForm = {
  provider: ChatProvider;
  name: string;
  /** Empty when editing means "keep the saved address". */
  url: string;
  locale: string;
  enabled: boolean;
  allowAnyHost: boolean;
  digest: 'off' | 'daily';
  digestHour: number;
  timezone: string;
};

export const emptyDestinationForm = (locale = 'en', timezone = 'UTC'): DestinationForm => ({
  provider: 'slack',
  name: '',
  url: '',
  locale,
  enabled: true,
  allowAnyHost: false,
  digest: 'off',
  digestHour: 8,
  timezone,
});

export const formFromDestination = (d: ChatDestination): DestinationForm => ({
  provider: d.provider,
  name: d.name,
  url: '',
  locale: d.locale,
  enabled: d.enabled,
  allowAnyHost: d.allowAnyHost,
  digest: d.digest,
  digestHour: d.digestHour,
  timezone: d.timezone,
});

export type DestinationProblems = { name?: string; url?: string; timezone?: string };

const looksLikeHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** What is wrong with the form, in words. `editing` lets the address stay empty (the saved one is kept). */
export function validateDestinationForm(
  form: DestinationForm,
  editing: boolean,
): DestinationProblems {
  const problems: DestinationProblems = {};
  if (form.name.trim() === '') problems.name = t('chat:form.errors.name');
  else if (form.name.trim().length > 80) problems.name = t('chat:form.errors.nameLong');
  const url = form.url.trim();
  if (url === '' ? !editing : !looksLikeHttps(url)) problems.url = t('chat:form.errors.url');
  if (form.digest === 'daily' && form.timezone.trim() === '')
    problems.timezone = t('chat:form.errors.timezone');
  return problems;
}

export const hasProblems = (p: DestinationProblems): boolean => Object.keys(p).length > 0;

export function createInput(form: DestinationForm): Record<string, unknown> {
  return {
    provider: form.provider,
    name: form.name.trim(),
    url: form.url.trim(),
    locale: form.locale,
    enabled: form.enabled,
    allowAnyHost: form.allowAnyHost,
    digest: form.digest,
    digestHour: form.digestHour,
    ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
  };
}

/** Only what changed; the address only when one was typed. */
export function patchFor(d: ChatDestination, form: DestinationForm): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (form.name.trim() !== d.name) patch.name = form.name.trim();
  if (form.url.trim() !== '') patch.url = form.url.trim();
  if (form.locale !== d.locale) patch.locale = form.locale;
  if (form.enabled !== d.enabled) patch.enabled = form.enabled;
  if (form.allowAnyHost !== d.allowAnyHost) patch.allowAnyHost = form.allowAnyHost;
  if (form.digest !== d.digest) patch.digest = form.digest;
  if (form.digestHour !== d.digestHour) patch.digestHour = form.digestHour;
  if (form.timezone.trim() !== d.timezone && form.timezone.trim() !== '')
    patch.timezone = form.timezone.trim();
  return patch;
}

/** How a saved address is shown: its end only. */
export const hintText = (d: Pick<ChatDestination, 'urlHint'>): string => `…${d.urlHint}`;

// ----- routing rules ---------------------------------------------------------------------------------------------

export type RouteForm = {
  allTypes: boolean;
  types: string[];
  minSeverity: ChatSeverity;
  allApps: boolean;
  appIds: string[];
  allPlatforms: boolean;
  platforms: string[];
  enabled: boolean;
};

export const emptyRouteForm = (): RouteForm => ({
  allTypes: true,
  types: [],
  minSeverity: 'critical',
  allApps: true,
  appIds: [],
  allPlatforms: true,
  platforms: [],
  enabled: true,
});

/** The rules a new destination gets from the server: every critical alert, and every release event whatever its severity. */
export function defaultRouteForms(catalog: readonly CatalogEntry[]): RouteForm[] {
  return [
    emptyRouteForm(),
    {
      ...emptyRouteForm(),
      allTypes: false,
      types: catalog.filter((c) => c.group === 'releases').map((c) => c.id),
      minSeverity: 'info',
    },
  ];
}

export const routeFormFrom = (r: ChatRoute): RouteForm => ({
  allTypes: r.alertTypes.includes('*'),
  types: r.alertTypes.filter((x) => x !== '*'),
  minSeverity: r.minSeverity,
  allApps: r.appIds === null || r.appIds.length === 0,
  appIds: r.appIds ?? [],
  allPlatforms: r.platforms === null || r.platforms.length === 0,
  platforms: r.platforms ?? [],
  enabled: r.enabled,
});

export const routeInputFrom = (f: RouteForm) => ({
  alertTypes: f.allTypes ? ['*'] : f.types,
  minSeverity: f.minSeverity,
  appIds: f.allApps || f.appIds.length === 0 ? null : f.appIds,
  platforms: f.allPlatforms || f.platforms.length === 0 ? null : f.platforms,
  enabled: f.enabled,
});

/** A rule that picks types but none, would match nothing. */
export const routeProblem = (f: RouteForm): string | undefined =>
  !f.allTypes && f.types.length === 0 ? t('chat:routes.errors.noTypes') : undefined;

export type TypeGroup = { id: string; label: string; types: { id: string; label: string }[] };

/** The alert types by group, in catalog order, for the checkboxes of a rule. Internal and state types alike: any type can be routed. */
export function typeGroups(catalog: readonly CatalogEntry[]): TypeGroup[] {
  const groups: TypeGroup[] = [];
  for (const entry of catalog) {
    let g = groups.find((x) => x.id === entry.group);
    if (!g) {
      g = { id: entry.group, label: entry.groupLabel, types: [] };
      groups.push(g);
    }
    g.types.push({ id: entry.id, label: entry.label });
  }
  return groups;
}

/** Turns a whole group on or off in a list of selected types. */
export function toggleGroup(selected: readonly string[], group: TypeGroup, on: boolean): string[] {
  const ids = group.types.map((x) => x.id);
  return on ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.includes(x));
}

export const groupState = (
  selected: readonly string[],
  group: TypeGroup,
): 'all' | 'some' | 'none' => {
  const n = group.types.filter((x) => selected.includes(x.id)).length;
  return n === 0 ? 'none' : n === group.types.length ? 'all' : 'some';
};

/** The cells of one rule in the table: what it takes, how severe, which apps, which platforms. No sentence is built from parts. */
export function describeRoute(
  r: ChatRoute,
  apps: readonly Pick<AppSummary, 'id' | 'name'>[],
): { types: string; severity: string; apps: string; platforms: string } {
  const allTypes = r.alertTypes.includes('*');
  const named = (r.appIds ?? []).map((id) => apps.find((a) => a.id === id)?.name ?? id);
  return {
    types: allTypes
      ? t('chat:routes.allTypes')
      : t('chat:routes.someTypes', { count: r.alertTypes.length }),
    severity: severityLabel(r.minSeverity),
    apps: named.length === 0 ? t('chat:routes.allApps') : named.join(', '),
    platforms:
      !r.platforms || r.platforms.length === 0
        ? t('chat:routes.allPlatforms')
        : r.platforms.map((p) => platformChoices.find((c) => c.id === p)?.label ?? p).join(', '),
  };
}

export const severityLabel = (s: string): string => {
  const choice = severityChoices.find((c) => c.id === s);
  return choice ? t(choice.labelKey) : s;
};

// ----- the log -------------------------------------------------------------------------------------------------

type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'neutral';
const statusViews: Record<string, { labelKey: string; tone: Tone }> = {
  sent: { labelKey: k('chat:status.sent'), tone: 'ok' },
  failed: { labelKey: k('chat:status.failed'), tone: 'bad' },
  retrying: { labelKey: k('chat:status.retrying'), tone: 'warn' },
  queued: { labelKey: k('chat:status.queued'), tone: 'info' },
  deferred: { labelKey: k('chat:status.deferred'), tone: 'neutral' },
  skipped: { labelKey: k('chat:status.skipped'), tone: 'neutral' },
};

export function statusView(status: string): { label: string; tone: Tone } {
  const v = statusViews[status];
  return v ? { label: t(v.labelKey), tone: v.tone } : { label: status, tone: 'info' };
}

/** Every outcome code the server writes (modules/chat/model.ts `chatOutcomes`) and the sentence that explains it. */
export const outcomeKeys: Record<string, string> = {
  queued: k('chat:outcome.queued'),
  ok: k('chat:outcome.ok'),
  in_digest: k('chat:outcome.inDigest'),
  digest_sent: k('chat:outcome.digestSent'),
  rate_limited: k('chat:outcome.rateLimited'),
  server_error: k('chat:outcome.serverError'),
  timeout: k('chat:outcome.timeout'),
  dns_failed: k('chat:outcome.dnsFailed'),
  network_error: k('chat:outcome.networkError'),
  blocked_address: k('chat:outcome.blockedAddress'),
  host_not_allowed: k('chat:outcome.hostNotAllowed'),
  webhook_gone: k('chat:outcome.webhookGone'),
  webhook_rejected: k('chat:outcome.webhookRejected'),
  payload_rejected: k('chat:outcome.payloadRejected'),
  rejected: k('chat:outcome.rejected'),
  redirected: k('chat:outcome.redirected'),
  disabled: k('chat:outcome.disabled'),
  secret_unreadable: k('chat:outcome.secretUnreadable'),
};

export const describeOutcome = (outcome: string): string => {
  const key = outcomeKeys[outcome];
  return key ? t(key) : t('chat:outcome.unknown');
};

export const kindLabel = (kind: string): string =>
  kind === 'digest'
    ? t('chat:kind.digest')
    : kind === 'test'
      ? t('chat:kind.test')
      : t('chat:kind.alert');

/** A delivery still on its way: the log looks again while any is. */
export const inFlight = (deliveries: readonly Pick<ChatDelivery, 'status'>[]): boolean =>
  deliveries.some((d) => d.status === 'queued' || d.status === 'retrying');

/** The result of the latest test, for the line under the button: sent, failed with the reason, or still on its way. */
export function testResult(
  d: Pick<ChatDelivery, 'status' | 'outcome'> | undefined,
): { tone: Tone; text: string } | undefined {
  if (!d) return undefined;
  if (d.status === 'sent') return { tone: 'ok', text: t('chat:test.sent') };
  if (d.status === 'failed')
    return { tone: 'bad', text: t('chat:test.failed', { reason: describeOutcome(d.outcome) }) };
  return { tone: 'info', text: t('chat:test.waiting') };
}

/** The hour choices of the summary: 0 to 23. */
export const hours: number[] = Array.from({ length: 24 }, (_, i) => i);
export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;
