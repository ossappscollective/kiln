import { ApiError, waitPhrase } from '../api.ts';
import { timeAgo } from '../format.ts';
import { formatList } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';
import type { CredentialSummary } from '../types.ts';

/**
 * Pure helpers of the RevenueCat parts of the app (docs/adr/0039-revenuecat.md, docs/api/revenuecat.md): the types of what the API
 * answers, the words for each state, what the Products table and the Settings card show, and the sentence for each error code.
 * Configuration facts only: no money amounts and no customer data exist here. Written for the ES2017 web build.
 */

export type RevenueCatState = 'active' | 'archived' | 'unknown';
export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info';

/** `GET /apps/{appId}/revenuecat`: the link of an app record to its RevenueCat project and app. */
export type RevenueCatLinkView = {
  appId: string;
  credentialId: string;
  /** Null when the credential was deleted. */
  credentialLabel: string | null;
  /** False when the credential was deleted or is not a RevenueCat credential: another must be chosen. */
  credentialAvailable: boolean;
  projectId: string;
  projectName: string;
  revenueCatAppId: string;
  revenueCatAppName: string;
  /** `app_store`, `mac_app_store` or `play_store`. */
  revenueCatAppType: string;
  revenueCatIdentifier: string | null;
  /** Whether RevenueCat's bundle id or package name is this app's own; null when RevenueCat did not say. */
  identifierMatches: boolean | null;
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

export type RevenueCatSyncStatus = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  /** A fixed sentence about the last failure, or null after a good sync. */
  lastError: string | null;
  failures: number;
  productCount: number;
  otherAppProductCount: number;
  /** False when the last read stopped at a cap: a list may be missing items. */
  complete: boolean;
  warnings: string[];
};

export type RevenueCatMatchedProduct = {
  rcProductId: string;
  storeIdentifier: string;
  /** The Google Play base plan the RevenueCat product is for; null for an exact or legacy bare id, and for Apple. */
  planId: string | null;
  planInStore: boolean | null;
  type: string;
  state: RevenueCatState;
  displayName: string | null;
  /** ISO 8601 durations, or null. */
  duration: string | null;
  gracePeriod: string | null;
  trialDuration: string | null;
};

export type RevenueCatStatus = 'in_revenuecat' | 'archived' | 'not_in_revenuecat' | 'id_not_matched';

export type RevenueCatProductEntry = {
  status: RevenueCatStatus;
  products: RevenueCatMatchedProduct[];
  entitlements: { id: string; lookupKey: string; displayName: string | null; state: RevenueCatState }[];
  offerings: {
    id: string;
    lookupKey: string;
    isCurrent: boolean;
    state: RevenueCatState;
    packages: { id: string; lookupKey: string; rcProductId: string; eligibility: string }[];
  }[];
};

export type RevenueCatWarning = {
  code: string;
  severity: 'info' | 'warn' | 'bad';
  /** One sentence with the fix. */
  message: string;
  storeProductId: string | null;
  rcProductId: string | null;
  entitlementId: string | null;
};

/** `GET /apps/{appId}/revenuecat/products`: the stored store products joined to the stored RevenueCat configuration. */
export type RevenueCatProductsView = {
  supported: boolean;
  /** Null when the app has no link. */
  link: RevenueCatLinkView | null;
  /** Null before the first RevenueCat sync. */
  sync: RevenueCatSyncStatus | null;
  /** By store product id; empty before the first RevenueCat sync. */
  products: Record<string, RevenueCatProductEntry>;
  unmatched: RevenueCatMatchedProduct[];
  warnings: RevenueCatWarning[];
};

/** `GET /apps/{appId}/revenuecat`. */
export type RevenueCatLinkRead = { supported: boolean; link: RevenueCatLinkView | null; sync: RevenueCatSyncStatus | null };

export type RevenueCatAppChoice = {
  id: string;
  name: string;
  /** RevenueCat's own app type, verbatim. */
  type: string;
  mapped: boolean;
  linkable: boolean;
  identifier: string | null;
  matches: boolean;
  suggested: boolean;
  note: string | null;
};

/** `GET /apps/{appId}/revenuecat/detect`: what the credential sees. */
export type RevenueCatOptions = {
  projects: { id: string; name: string }[];
  projectId: string | null;
  apps: RevenueCatAppChoice[] | null;
  complete: boolean;
};

export type SetRevenueCatLinkBody = { credentialId: string; projectId: string; revenueCatAppId: string };

/** The RevenueCat step of `POST .../products/sync`: what it read, or a code and a fixed sentence. */
export type RevenueCatStep =
  | {
      ok: true;
      products: number;
      entitlements: number;
      offerings: number;
      otherAppProducts: number;
      complete: boolean;
      warnings: string[];
      syncedAt: number;
      /** The metrics overview read after the configuration, with its own result (docs/adr/0043-revenuecat-metrics.md). */
      metrics?: MetricsStep | undefined;
    }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number | undefined };

export type MetricsStep =
  | { ok: true; metrics: number; fetchedAt: number }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number | undefined };

// ---------------------------------------------------------------------------------------------
// Words

/** The credentials of the workspace that are RevenueCat secret keys, in the order given. */
export const revenueCatCredentials = (list: readonly CredentialSummary[] | null): CredentialSummary[] =>
  (list || []).filter((c) => c.kind === 'revenuecat');

/** RevenueCat's own app type, in words. An unknown type is shown as it is. */
export function appTypeLabel(type: string): string {
  switch (type) {
    case 'app_store':
      return 'App Store';
    case 'mac_app_store':
      return 'Mac App Store';
    case 'play_store':
      return 'Google Play';
    case 'amazon':
      return 'Amazon Appstore';
    case 'stripe':
      return 'Stripe';
    case 'rc_billing':
      return 'RevenueCat Web Billing';
    case 'paddle':
      return 'Paddle';
    case 'roku':
      return 'Roku';
    default:
      return type.replace(/_/g, ' ');
  }
}

/** The Products table badge: where the product stands in RevenueCat. */
export function statusBadge(status: RevenueCatStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'in_revenuecat':
      return { label: t('products:rc.status.inRevenueCat'), tone: 'ok' };
    case 'archived':
      return { label: t('products:rc.status.archived'), tone: 'neutral' };
    case 'id_not_matched':
      return { label: t('products:rc.status.idDiffers'), tone: 'warn' };
    default:
      return { label: t('products:rc.status.notInRevenueCat'), tone: 'warn' };
  }
}

/** The word beside a warning of the set-up: how serious it is. */
export const severityLabel = (severity: RevenueCatWarning['severity']): string =>
  severity === 'bad' ? t('products:rc.severity.bad') : severity === 'warn' ? t('products:rc.severity.warn') : t('products:rc.severity.info');

/** The names of the entitlements, the first `max` of them and "+n" for the rest. Archived ones are left out. */
export function entitlementNames(entry: RevenueCatProductEntry, max = 2): { shown: string[]; more: number } {
  const names = entry.entitlements.filter((e) => e.state !== 'archived').map((e) => e.displayName || e.lookupKey);
  return { shown: names.slice(0, max), more: Math.max(0, names.length - max) };
}

/** Whether the Products table draws the RevenueCat column: the store has RevenueCat support and the app is linked. */
export const showRevenueCatColumn = (view: RevenueCatProductsView | null): boolean =>
  view !== null && view.supported && view.link !== null;

/** Whether anything was read from RevenueCat yet. */
export const revenueCatRead = (view: RevenueCatProductsView | null): boolean =>
  view !== null && view.sync !== null && view.sync.lastSyncedAt !== null;

/** What one cell of the column says. Before the first read nothing is claimed. */
export function revenueCatCell(
  view: RevenueCatProductsView | null,
  productId: string,
): { label: string; tone: Tone; entry: RevenueCatProductEntry | null } {
  const entry = view !== null && revenueCatRead(view) ? view.products[productId] || null : null;
  if (entry === null) return { label: t('products:rc.status.notRead'), tone: 'neutral', entry: null };
  return { ...statusBadge(entry.status), entry };
}

/** "3 base plans" for a Google Play subscription that RevenueCat holds as several products, else ''. */
export function basePlanCount(entry: RevenueCatProductEntry): string {
  const plans = entry.products.filter((p) => p.planId !== null).length;
  return plans > 1 ? t('products:rc.basePlans', { count: plans }) : '';
}

/** What to say about RevenueCat where there is no link (or none can be). Empty when the store has no RevenueCat support. */
export function connectHint(view: RevenueCatProductsView | null, mayLink: boolean): string {
  if (view === null || !view.supported || view.link !== null) return '';
  return mayLink ? t('products:rc.connect.mayLink') : t('products:rc.connect.askAdmin');
}

/** An ISO 8601 duration in words (`P1M` is "1 month", `P1W` "1 week", `P3D` "3 days"). Anything else is shown as it is. */
export function durationText(value: string | null): string {
  if (value === null) return '';
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(value);
  if (!m || value === 'P') return value;
  const parts: string[] = [];
  if (m[1]) parts.push(t('products:rc.duration.years', { count: Number(m[1]) }));
  if (m[2]) parts.push(t('products:rc.duration.months', { count: Number(m[2]) }));
  if (m[3]) parts.push(t('products:rc.duration.weeks', { count: Number(m[3]) }));
  if (m[4]) parts.push(t('products:rc.duration.days', { count: Number(m[4]) }));
  return formatList(parts, { type: 'unit', style: 'narrow' });
}

/** The one line of a matched RevenueCat product: its type and what RevenueCat holds of its durations. */
export function matchedLine(p: RevenueCatMatchedProduct): string {
  const bits: string[] = [p.type.replace(/_/g, ' ')];
  if (p.duration !== null) bits.push(durationText(p.duration));
  if (p.trialDuration !== null) bits.push(t('products:rc.matched.trial', { duration: durationText(p.trialDuration) }));
  if (p.gracePeriod !== null) bits.push(t('products:rc.matched.grace', { duration: durationText(p.gracePeriod) }));
  return formatList(bits, { type: 'unit' });
}

/** What a package's eligibility value says; RevenueCat's own words, with the underscores taken out. */
export const eligibilityText = (value: string): string => (value === '' ? t('products:rc.eligibility.notGiven') : value.replace(/_/g, ' '));

/** The store id of a Google Play base plan product, shown as `subscription:base plan`. Apple and bare ids are shown as they are. */
export const matchedTitle = (p: RevenueCatMatchedProduct): string =>
  p.planId === null ? p.rcProductId : `${p.storeIdentifier.split(':')[0]} / ${p.planId}`;

/** Warnings in the order worst first, then in the order the server gave. */
export function sortedWarnings(list: readonly RevenueCatWarning[]): RevenueCatWarning[] {
  const rank = (w: RevenueCatWarning): number => (w.severity === 'bad' ? 0 : w.severity === 'warn' ? 1 : 2);
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map((x) => x.w);
}

/** The head of the warnings list: how many, and how bad the worst is. */
export function warningsSummary(list: readonly RevenueCatWarning[]): { text: string; tone: Tone } | null {
  if (list.length === 0) return null;
  const worst = sortedWarnings(list)[0];
  const tone: Tone = worst && worst.severity === 'bad' ? 'bad' : worst && worst.severity === 'warn' ? 'warn' : 'info';
  return { text: t('products:rc.warnings.summary', { count: list.length }), tone };
}

/** The warnings of one store product (they are also in the page list). */
export const warningsOf = (list: readonly RevenueCatWarning[], productId: string): RevenueCatWarning[] =>
  sortedWarnings(list.filter((w) => w.storeProductId === productId));

/** How the last RevenueCat read went, in one line, and how it should look. */
export function syncLine(sync: RevenueCatSyncStatus | null, now: number): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: t('products:rc.sync.never'), tone: 'neutral' };
  if (sync.lastError !== null) {
    const error = sync.lastError;
    const many = sync.failures > 1;
    if (sync.lastSyncedAt === null)
      return {
        text: many
          ? t('products:rc.sync.failedManyNothing', { count: sync.failures, error })
          : t('products:rc.sync.failedNothing', { error }),
        tone: 'bad',
      };
    const ago = timeAgo(sync.lastSyncedAt, now);
    return {
      text: many
        ? t('products:rc.sync.failedManyKept', { count: sync.failures, ago, error })
        : t('products:rc.sync.failedKept', { ago, error }),
      tone: 'bad',
    };
  }
  // Past the checks above a sync with no error has been read at least once.
  const ago = timeAgo(sync.lastSyncedAt ?? now, now);
  if (!sync.complete) return { text: t('products:rc.sync.partial', { count: sync.productCount, ago }), tone: 'warn' };
  const read = t('products:rc.sync.read', { count: sync.productCount, ago });
  const others =
    sync.otherAppProductCount > 0 ? ` ${t('products:rc.sync.others', { count: sync.otherAppProductCount })}` : '';
  return { text: `${read}${others}`, tone: 'neutral' };
}

/** What the RevenueCat step of "Sync products" says, next to the result of the store step. A failure here never says the store failed. */
export function stepResult(step: RevenueCatStep): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!step.ok) {
    return { text: t('products:rc.step.failed', { message: step.message }), tone: 'bad' };
  }
  const what = formatList([
    t('products:rc.step.products', { count: step.products }),
    t('products:rc.step.entitlements', { count: step.entitlements }),
    t('products:rc.step.offerings', { count: step.offerings }),
  ]);
  // The figures strip has its own result: a failure there is said, and never turns the configuration read into a failure.
  const figures = step.metrics && !step.metrics.ok ? ` ${t('products:rc.step.figuresFailed', { message: step.metrics.message })}` : '';
  return step.complete
    ? { text: `${t('products:rc.step.read', { what })}${figures}`, tone: figures === '' ? 'ok' : 'warn' }
    : { text: `${t('products:rc.step.readPartial', { what })}${figures}`, tone: 'warn' };
}

/** The RevenueCat step in the body of a failed store sync, or null. */
export function stepFromBody(body: Record<string, unknown>): RevenueCatStep | null {
  const step = body.revenuecat;
  if (typeof step !== 'object' || step === null) return null;
  const s = step as Record<string, unknown>;
  if (s.ok === true) return step as RevenueCatStep;
  if (s.ok === false && typeof s.message === 'string') return step as RevenueCatStep;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The link card of the app settings

/** The one line of the collapsed card. */
export function revenueCatSummary(links: readonly (RevenueCatLinkView | null)[]): string {
  const linked = links.filter((l): l is RevenueCatLinkView => l !== null);
  if (linked.length === 0) return t('products:rc.summary.notLinked');
  const names = linked.map((l) => l.projectName).filter((n, i, all) => all.indexOf(n) === i);
  return names.length === 1 ? names[0] || '' : t('products:rc.summary.projects', { count: names.length });
}

/** "Confirmed with RevenueCat 3 minutes ago.", or what is wrong with the credential. */
export function linkStatus(link: RevenueCatLinkView, now: number): { tone: 'ok' | 'warn'; text: string } {
  if (!link.credentialAvailable) {
    return { tone: 'warn', text: t('products:rc.link.credentialDeleted') };
  }
  return { tone: 'ok', text: t('products:rc.link.confirmed', { ago: timeAgo(link.verifiedAt, now) }) };
}

/** A sentence when the RevenueCat app's identifier is not this app's own; '' when it is, or RevenueCat gave none. */
export function identifierNote(link: RevenueCatLinkView): string {
  if (link.identifierMatches !== false || link.revenueCatIdentifier === null) return '';
  return t('products:rc.link.identifierDiffers', { identifier: link.revenueCatIdentifier });
}

/** The one choice to start from: the suggested app, else the only linkable one, else nothing. */
export function startingChoice(apps: readonly RevenueCatAppChoice[] | null): string {
  if (apps === null) return '';
  const suggested = apps.filter((a) => a.suggested)[0];
  if (suggested) return suggested.id;
  const linkable = apps.filter((a) => a.linkable);
  return linkable.length === 1 && linkable[0] ? linkable[0].id : '';
}

/** What to say under the list of apps: how many are listed, and that the others are ignored. */
export function appsNote(apps: readonly RevenueCatAppChoice[]): string {
  const ignored = apps.filter((a) => !a.mapped).length;
  if (apps.length === 0) return t('products:rc.apps.none');
  if (ignored === 0) return '';
  return t('products:rc.apps.ignored', { count: ignored });
}

/** The text of one option of the app list. */
export function appChoiceLabel(a: RevenueCatAppChoice): string {
  const details = a.identifier === null ? appTypeLabel(a.type) : `${appTypeLabel(a.type)}, ${a.identifier}`;
  const params = { name: a.name, details };
  if (a.suggested) return t('products:rc.choice.suggested', params);
  if (!a.mapped) return t('products:rc.choice.notMapped', params);
  if (!a.linkable) return t('products:rc.choice.otherStore', params);
  return t('products:rc.choice.plain', params);
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what the API said. The generic messages of the API client are written for GitHub, so these codes are said here. */
export function revenueCatErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return t('products:rc.error.forbidden');
    case 'not_found':
      return t('products:rc.error.notFound');
    case 'credential_not_found':
      return t('products:rc.error.credentialNotFound');
    case 'credential_kind':
      return t('products:rc.error.credentialKind');
    case 'credential_unreadable':
      return t('products:rc.error.credentialUnreadable');
    case 'invalid_request':
    case 'invalid_reference':
      return own || t('products:rc.error.invalidRequest');
    case 'revenuecat_not_supported':
    case 'revenuecat_app_not_mapped':
    case 'revenuecat_app_missing':
    case 'revenuecat_auth':
    case 'revenuecat_forbidden':
    case 'revenuecat_not_found':
    case 'revenuecat_unavailable':
      return own || t('products:rc.error.unavailable');
    case 'rate_limited':
      return t('products:rc.error.rateLimited', { wait: waitPhrase(error.retryAfter || 60) });
    case 'timeout':
      return t('products:rc.error.timeout');
    default:
      return error.status >= 500 ? t('products:rc.error.server') : error.message;
  }
}

export const revenueCatLinks = {
  credentials: '#/credentials',
};
