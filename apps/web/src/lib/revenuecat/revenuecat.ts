import { ApiError, waitPhrase } from '../api.ts';
import { timeAgo } from '../format.ts';
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
    }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number | undefined };

// ---------------------------------------------------------------------------------------------
// Words

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

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
      return { label: 'In RevenueCat', tone: 'ok' };
    case 'archived':
      return { label: 'Archived there', tone: 'neutral' };
    case 'id_not_matched':
      return { label: 'Id differs', tone: 'warn' };
    default:
      return { label: 'Not in RevenueCat', tone: 'warn' };
  }
}

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
  if (entry === null) return { label: 'Not read yet', tone: 'neutral', entry: null };
  return { ...statusBadge(entry.status), entry };
}

/** "3 base plans" for a Google Play subscription that RevenueCat holds as several products, else ''. */
export function basePlanCount(entry: RevenueCatProductEntry): string {
  const plans = entry.products.filter((p) => p.planId !== null).length;
  return plans > 1 ? plural(plans, 'base plan', 'base plans') : '';
}

/** What to say about RevenueCat where there is no link (or none can be). Empty when the store has no RevenueCat support. */
export function connectHint(view: RevenueCatProductsView | null, mayLink: boolean): string {
  if (view === null || !view.supported || view.link !== null) return '';
  const what = 'to see which of these products RevenueCat sells, and the entitlements and offerings that use them';
  return mayLink
    ? `Link this app to its RevenueCat project in the app settings (Settings, RevenueCat) ${what}. Nothing is changed in RevenueCat.`
    : `Ask an owner or an admin to link this app to its RevenueCat project ${what}.`;
}

/** An ISO 8601 duration in words (`P1M` is "1 month", `P1W` "1 week", `P3D` "3 days"). Anything else is shown as it is. */
export function durationText(value: string | null): string {
  if (value === null) return '';
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(value);
  if (!m || value === 'P') return value;
  const parts: string[] = [];
  const units: [string, string, string][] = [
    [m[1] || '', 'year', 'years'],
    [m[2] || '', 'month', 'months'],
    [m[3] || '', 'week', 'weeks'],
    [m[4] || '', 'day', 'days'],
  ];
  for (const [n, one, many] of units) if (n !== '') parts.push(plural(Number(n), one, many));
  return parts.join(' ');
}

/** The one line of a matched RevenueCat product: its type and what RevenueCat holds of its durations. */
export function matchedLine(p: RevenueCatMatchedProduct): string {
  const bits: string[] = [p.type.replace(/_/g, ' ')];
  if (p.duration !== null) bits.push(durationText(p.duration));
  if (p.trialDuration !== null) bits.push(`${durationText(p.trialDuration)} trial`);
  if (p.gracePeriod !== null) bits.push(`${durationText(p.gracePeriod)} grace period`);
  return bits.join(', ');
}

/** What a package's eligibility value says; RevenueCat's own words, with the underscores taken out. */
export const eligibilityText = (value: string): string => (value === '' ? 'not given' : value.replace(/_/g, ' '));

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
  return { text: `${plural(list.length, 'thing to check', 'things to check')} in the RevenueCat set-up`, tone };
}

/** The warnings of one store product (they are also in the page list). */
export const warningsOf = (list: readonly RevenueCatWarning[], productId: string): RevenueCatWarning[] =>
  sortedWarnings(list.filter((w) => w.storeProductId === productId));

/** How the last RevenueCat read went, in one line, and how it should look. */
export function syncLine(sync: RevenueCatSyncStatus | null, now: number): { text: string; tone: 'neutral' | 'warn' | 'bad' } {
  if (sync === null || (sync.lastSyncedAt === null && sync.lastError === null))
    return { text: 'Not read from RevenueCat yet. Use "Sync products" to read it.', tone: 'neutral' };
  if (sync.lastError !== null) {
    const kept = sync.lastSyncedAt === null ? 'Nothing was read yet.' : `Showing what was read ${timeAgo(sync.lastSyncedAt, now)}.`;
    const times = sync.failures > 1 ? ` (${sync.failures} reads in a row failed)` : '';
    return { text: `The last RevenueCat read failed${times}. ${kept} ${sync.lastError}`, tone: 'bad' };
  }
  const when = sync.lastSyncedAt === null ? '' : ` ${timeAgo(sync.lastSyncedAt, now)}`;
  const count = plural(sync.productCount, 'product', 'products');
  if (!sync.complete)
    return { text: `RevenueCat read${when}: ${count}, but RevenueCat has more than were read. The picture is not complete.`, tone: 'warn' };
  const others =
    sync.otherAppProductCount > 0
      ? ` ${plural(sync.otherAppProductCount, 'product', 'products')} of the other apps of the project ${sync.otherAppProductCount === 1 ? 'is' : 'are'} left out.`
      : '';
  return { text: `RevenueCat read${when}: ${count} of this app.${others}`, tone: 'neutral' };
}

/** What the RevenueCat step of "Sync products" says, next to the result of the store step. A failure here never says the store failed. */
export function stepResult(step: RevenueCatStep): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!step.ok) {
    return {
      text: `RevenueCat could not be read: ${step.message} The products read from the store are not affected.`,
      tone: 'bad',
    };
  }
  const what = `${plural(step.products, 'product', 'products')}, ${plural(step.entitlements, 'entitlement', 'entitlements')} and ${plural(step.offerings, 'offering', 'offerings')}`;
  return step.complete
    ? { text: `Read ${what} from RevenueCat.`, tone: 'ok' }
    : { text: `Read ${what} from RevenueCat, but it has more than were read. The picture is not complete.`, tone: 'warn' };
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
  if (linked.length === 0) return 'Not linked';
  const names = linked.map((l) => l.projectName).filter((n, i, all) => all.indexOf(n) === i);
  return names.length === 1 ? names[0] || '' : `${names.length} projects`;
}

/** "Confirmed with RevenueCat 3 minutes ago.", or what is wrong with the credential. */
export function linkStatus(link: RevenueCatLinkView, now: number): { tone: 'ok' | 'warn'; text: string } {
  if (!link.credentialAvailable) {
    return { tone: 'warn', text: 'The RevenueCat credential of this link was deleted. Choose another and save.' };
  }
  return { tone: 'ok', text: `Confirmed with RevenueCat ${timeAgo(link.verifiedAt, now)}.` };
}

/** A sentence when the RevenueCat app's identifier is not this app's own; '' when it is, or RevenueCat gave none. */
export function identifierNote(link: RevenueCatLinkView): string {
  if (link.identifierMatches !== false || link.revenueCatIdentifier === null) return '';
  return `RevenueCat holds ${link.revenueCatIdentifier} for this app, which differs from the identifier of this app. That is expected for a universal purchase shared with another app; otherwise check that the right RevenueCat app is linked.`;
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
  if (apps.length === 0) return 'This RevenueCat project has no apps.';
  if (ignored === 0) return '';
  return `${plural(ignored, 'app', 'apps')} of other stores (Amazon, Stripe, Paddle, Web Billing, Roku) ${ignored === 1 ? 'is' : 'are'} not mapped and cannot be linked.`;
}

/** The text of one option of the app list. */
export function appChoiceLabel(a: RevenueCatAppChoice): string {
  const id = a.identifier === null ? '' : `, ${a.identifier}`;
  const hint = a.suggested ? ' (suggested)' : !a.mapped ? ' (not mapped)' : !a.linkable ? ' (other store)' : '';
  return `${a.name} (${appTypeLabel(a.type)}${id})${hint}`;
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what the API said. The generic messages of the API client are written for GitHub, so these codes are said here. */
export function revenueCatErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return 'Only an owner or an admin can change the RevenueCat link of an app.';
    case 'not_found':
      return 'That app or link no longer exists. Reload the page.';
    case 'credential_not_found':
      return 'That credential no longer exists. Choose another one.';
    case 'credential_kind':
      return 'Choose a credential of the RevenueCat secret key kind.';
    case 'credential_unreadable':
      return 'The credential could not be decrypted. Enter its key again under Credentials.';
    case 'invalid_request':
    case 'invalid_reference':
      return own || 'Choose a credential, a project and an app.';
    case 'revenuecat_not_supported':
    case 'revenuecat_app_not_mapped':
    case 'revenuecat_app_missing':
    case 'revenuecat_auth':
    case 'revenuecat_forbidden':
    case 'revenuecat_not_found':
    case 'revenuecat_unavailable':
      return own || 'RevenueCat could not be asked. Try again in a moment.';
    case 'rate_limited':
      return `Too many requests. Try again in ${waitPhrase(error.retryAfter || 60)}.`;
    case 'timeout':
      return 'RevenueCat took too long to answer. Try again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : error.message;
  }
}

export const revenueCatLinks = {
  credentials: '#/credentials',
};
