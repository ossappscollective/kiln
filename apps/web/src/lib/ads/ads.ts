import { ApiError } from '../api.ts';
import { currencyDigits, formatCurrency, formatNumber, formatPercent } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import type { CredentialSummary } from '../types.ts';

/**
 * Apple Ads in the web, READ ONLY (docs/adr/0058-apple-ads.md, docs/api/apple-ads.md). The numbers come from the server (our own database,
 * filled by the Apple Ads sync); nothing here recomputes a total. Money arrives as integer micro-units of the ONE currency of the linked
 * ad account and is shown in that currency only: no sum, no ratio and no chart ever mixes two currencies.
 */

export type AdsAccount = { id: string; name: string; orgId: string | null; roles: string[] };

export type AdsLinkView = {
  appId: string;
  credentialId: string;
  credentialLabel: string | null;
  credentialAvailable: boolean;
  adAccountId: string;
  adAccountName: string;
  orgId: string | null;
  currency: string | null;
  timezone: string | null;
  adamId: string;
  verifiedAt: number;
  linkedBy: string;
  createdAt: number;
  updatedAt: number;
};

export type AdsSyncView = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  failureStreak: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  campaigns: number;
  complete: boolean;
  skipped: number;
  warnings: string[];
};

export type AdsState = { supported: boolean; link: AdsLinkView | null; sync: AdsSyncView | null };
export type SetAdsLinkBody = { credentialId: string; adAccountId: string; adamId?: string };

export type AdsWindow = { from: string; to: string };
export type AdsTotals = {
  impressions: number;
  taps: number;
  installs: number;
  tapInstalls: number;
  spendMicros: number;
  cptMicros: number | null;
  cpiMicros: number | null;
  ttr: number | null;
  conversion: number | null;
};
export type AdsDailyPoint = { day: string; impressions: number; taps: number; installs: number; spendMicros: number };
export type AdsOverview = {
  currency: string | null;
  window: AdsWindow;
  previousWindow: AdsWindow;
  totals: AdsTotals;
  previous: AdsTotals;
  daily: AdsDailyPoint[];
  daysWithData: number;
  campaigns: number;
};
export type AdsOverviewResponse = { sync: AdsSyncView | null; overview: AdsOverview };
export type AdsCampaignRow = AdsTotals & { campaignId: string; name: string; status: string | null; daysWithData: number };
export type AdsCampaignsResponse = { currency: string | null; window: AdsWindow; sync: AdsSyncView | null; campaigns: AdsCampaignRow[] };
export type AdsTermRow = AdsTotals & {
  kind: 'term' | 'keyword';
  term: string;
  termKey: string;
  country: string;
  matchType: string | null;
  keywordText: string | null;
  tracked: boolean;
};
export type AdsTermsResponse = {
  currency: string | null;
  window: AdsWindow;
  sync: AdsSyncView | null;
  kind: 'term' | 'keyword';
  limit: number;
  offset: number;
  total: number;
  totals: AdsTotals;
  rows: AdsTermRow[];
};

export const ADS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------------------------
// Which records, which credentials

/** Only App Store records have Apple Ads (the server refuses the others with `ads.notSupported`). */
export const adsApps = <T extends { platform: string }>(apps: readonly T[]): T[] => apps.filter((a) => a.platform === 'ios' || a.platform === 'macos');

export const adsCredentials = (list: readonly CredentialSummary[] | null): CredentialSummary[] => (list ?? []).filter((c) => c.kind === 'apple_ads');

export const adsLinks = { credentials: '#/credentials' };

/** "123456789" is an Apple id of 5 to 15 digits (the number after `id` in the App Store address). */
export const validAdamId = (v: string): boolean => /^[0-9]{5,15}$/.test(v.trim());

// ---------------------------------------------------------------------------------------------
// Sections of the rail

export type AdsSection = 'overview' | 'campaigns' | 'terms' | 'keywords' | 'account';
export const ADS_SECTIONS: readonly AdsSection[] = ['overview', 'campaigns', 'terms', 'keywords', 'account'];
export const adsSectionKeys: Record<AdsSection, string> = {
  overview: k('ads:rail.overview'),
  campaigns: k('ads:rail.campaigns'),
  terms: k('ads:rail.terms'),
  keywords: k('ads:rail.keywords'),
  account: k('ads:rail.account'),
};

/** The same address on another section of the Ads tab; Overview is the default and is not written. */
export function withAdsSection(hash: string, id: string): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.set('view', 'ads');
  if (id === 'overview') params.delete('section');
  else params.set('section', id);
  return `${path}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Numbers

/** Micro-units to text in the account's currency; "no value" is a dash, never 0. */
export function formatMicros(micros: number | null, currency: string | null): string {
  if (micros === null || !Number.isFinite(micros)) return t('ads:none');
  const digits = currency && /^[A-Za-z]{3}$/.test(currency) ? currencyDigits(currency.toUpperCase()) : 2;
  // Per-tap and per-install figures are small: keep at least two decimals even for a currency without any.
  return formatCurrency(micros / 1_000_000, currency, { digits: Math.max(digits, micros !== 0 && Math.abs(micros) < 1_000_000 ? 2 : digits) });
}

export const formatCount = (n: number | null): string => (n === null ? t('ads:none') : formatNumber(n));
export const formatRatio = (v: number | null): string => (v === null ? t('ads:none') : formatPercent(v, { maximumFractionDigits: 1 }));

/** The change against the period before as a fraction; null when there is nothing to compare with (never a division by zero). */
export function changeOf(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

export type DeltaTone = 'up' | 'down' | 'flat';
/** "+12%" with its tone: a rise is `up` and a fall is `down` whatever it means (cost per install rising is bad; the screen does not judge). */
export function deltaText(change: number | null): { text: string; tone: DeltaTone } | null {
  if (change === null) return null;
  const rounded = Math.round(change * 1000) / 10;
  if (rounded === 0) return { text: formatPercent(0, { maximumFractionDigits: 0 }), tone: 'flat' };
  return { text: `${rounded > 0 ? '+' : ''}${formatPercent(rounded / 100, { maximumFractionDigits: 1 })}`, tone: rounded > 0 ? 'up' : 'down' };
}

/** The bar height of each day, 0 to 1 of the largest day; a series that is all zero has no bars rather than a wrong scale. */
export function dailyBars(daily: readonly AdsDailyPoint[], field: 'impressions' | 'taps' | 'installs' | 'spendMicros'): number[] {
  const max = daily.reduce((m, d) => Math.max(m, d[field]), 0);
  return daily.map((d) => (max > 0 ? d[field] / max : 0));
}

// ---------------------------------------------------------------------------------------------
// The terms table

export type TermSort = 'impressions' | 'taps' | 'installs' | 'spend' | 'cpt' | 'cpi' | 'ttr' | 'term';
export type TermColumn = { sort: TermSort; labelKey: string };
export const termColumns: readonly TermColumn[] = [
  { sort: 'impressions', labelKey: k('ads:col.impressions') },
  { sort: 'taps', labelKey: k('ads:col.taps') },
  { sort: 'installs', labelKey: k('ads:col.installs') },
  { sort: 'spend', labelKey: k('ads:col.spend') },
  { sort: 'cpt', labelKey: k('ads:col.cpt') },
  { sort: 'cpi', labelKey: k('ads:col.cpi') },
  { sort: 'ttr', labelKey: k('ads:col.ttr') },
];
export const isTermSort = (v: string | null): v is TermSort => v === 'term' || termColumns.some((c) => c.sort === v);

export type SortState = { sort: TermSort; dir: 'asc' | 'desc' };
export const DEFAULT_SORT: SortState = { sort: 'impressions', dir: 'desc' };

/** Clicking a heading: the same one flips the direction; another starts with the largest first (A to Z for the term). */
export function nextSort(current: SortState, clicked: TermSort): SortState {
  if (current.sort === clicked) return { sort: clicked, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { sort: clicked, dir: clicked === 'term' ? 'asc' : 'desc' };
}
export const ariaSort = (state: SortState, column: TermSort): 'ascending' | 'descending' | 'none' =>
  state.sort !== column ? 'none' : state.dir === 'asc' ? 'ascending' : 'descending';

export const termsQueryOf = (o: { kind: 'term' | 'keyword'; window: AdsWindow; sort: SortState; q: string; offset: number }): string => {
  const p = new URLSearchParams({ kind: o.kind, from: o.window.from, to: o.window.to, sort: o.sort.sort, dir: o.sort.dir, limit: String(ADS_PAGE_SIZE), offset: String(o.offset) });
  if (o.q.trim() !== '') p.set('q', o.q.trim());
  return p.toString();
};

/** Upper case the storefront for display ("us" is "US"); an empty one is a dash. */
export const countryText = (c: string): string => (c === '' ? t('ads:none') : c.toUpperCase());

/** The body to track a search term as a keyword. The server picks the storefront; the locale follows the storefront's default. */
export const trackBody = (row: Pick<AdsTermRow, 'term' | 'country'>): { term: string; country: string } => ({ term: row.term, country: row.country === '' ? 'us' : row.country });

// ---------------------------------------------------------------------------------------------
// What the last read says

export const warningKeys: Record<string, string> = {
  cap_campaigns: k('ads:warn.capCampaigns'),
  read_cut: k('ads:warn.readCut'),
  currency_mismatch: k('ads:warn.currencyMismatch'),
  popularity_failed: k('ads:warn.popularityFailed'),
  popularity_partial: k('ads:warn.popularityPartial'),
  no_campaign: k('ads:warn.noCampaign'),
};
export const warningText = (code: string): string => (warningKeys[code] ? t(warningKeys[code]) : t('ads:warn.unknown'));

/** The sentence of a failed request. Server texts are in the locale of the request (docs/i18n-server.md); the ones that cannot be shown are generic. */
export function adsErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  switch (error.code) {
    case 'forbidden':
      return t('ads:err.forbidden');
    case 'not_found':
      return t('ads:err.notFound');
    case 'credential_not_found':
      return t('ads:err.credentialNotFound');
    case 'credential_kind':
      return t('ads:err.credentialKind');
    case 'ads_not_supported':
      return t('ads:err.notSupported');
    case 'ads_not_linked':
      return t('ads:err.notLinked');
    case 'rate_limited':
      return t('ads:err.rateLimited');
    default:
      return typeof error.body.message === 'string' && error.body.message !== '' ? error.body.message : t('common:error.genericRetry');
  }
}
