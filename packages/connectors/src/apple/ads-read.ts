import type { AppleAdsClient } from './ads-client.ts';
import { AppleAdsError } from './ads-errors.ts';

/**
 * Typed reads of the Apple Ads Platform API v1 (docs/adr/0058-apple-ads.md): the ad accounts the key may read, one ad account, the
 * campaign, search term and keyword reports of App Store campaigns, and Apple's search term popularity. Every function reads; the
 * client behind them cannot do anything else. Responses are validated strictly: a shape this code does not know is `unexpected`
 * (never guessed at), a row without the ids it needs is skipped and counted, a metric that is absent is 0, and a metric of the
 * wrong type makes the answer `unexpected`. Money is kept as integer micro-units, parsed from Apple's decimal strings without
 * floating point. Report requests ask for `DAILY` granularity in the account's reporting time zone (`ORTZ`, the only zone Apple
 * allows for search terms), at most 90 days.
 *
 * UNVERIFIED against a live account (see the ADR): the exact shape of rows with `groupBy`, the keyword report's metadata, the
 * campaign report's `promotedObjectId` being the app's Apple id, and which popularity rows come back without a `genre` filter.
 */
export type AdsRange = { start: string; end: string };

export type AdsMetrics = {
  impressions: number;
  taps: number;
  /** All installs (tap and view attributed), else the tap installs. */
  installs: number;
  tapInstalls: number;
  /** Spend in millionths of the currency. */
  spendMicros: number;
  currency: string | null;
};

export type AdsDay = AdsMetrics & { day: string; country: string };

export type AdsAccount = { id: string; name: string; orgId: string | null; roles: string[] };

export type AdsAccountDetail = {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  systemStatus: string | null;
  productFeatures: string[];
};

export type AdsCampaign = {
  campaignId: string;
  name: string;
  status: string | null;
  /** The promoted app's Apple id (`promotedObjectId`), when the campaign promotes an app. */
  adamId: string | null;
  days: AdsDay[];
};

export type AdsTerm = {
  /** The search term (`searchTermText`) or the keyword text. */
  term: string;
  /** For a keyword, Apple's keyword id. */
  keywordId: string | null;
  matchType: string | null;
  /** `TARGETED` or `AUTO` for a search term. */
  source: string | null;
  /** For a search term, the keyword it matched (the one with most impressions). */
  keywordText: string | null;
  days: AdsDay[];
};

export type AdsReadResult<T> = {
  rows: T[];
  /** False when a page or row cap ended the read before the last page. */
  complete: boolean;
  /** Rows Apple sent that lacked an id or a text and were left out. */
  skipped: number;
};

export type AdsPopularity = {
  term: string;
  country: string;
  genre: string | null;
  /** Apple's period label (`week` or `month`) as sent. */
  period: string | null;
  /** Apple's 1 to 100 score, and the 1 to 5 one shown as dots. */
  popularity100: number | null;
  popularity5: number | null;
  rankInGenre: number | null;
};

export const ADS_MAX_RANGE_DAYS = 90;
export const ADS_PAGE_SIZE = 1000;
export const ADS_MAX_PAGES = 10;
export const ADS_MAX_ROWS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unexpected = () => new AppleAdsError('unexpected');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Days between two YYYY-MM-DD dates, inclusive; NaN when either is not a date. */
export function adsRangeDays(range: AdsRange): number {
  if (!DATE.test(range.start) || !DATE.test(range.end)) return Number.NaN;
  const a = Date.parse(`${range.start}T00:00:00Z`);
  const b = Date.parse(`${range.end}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY_MS) + 1 : Number.NaN;
}

function checkRange(range: AdsRange): void {
  const days = adsRangeDays(range);
  if (!Number.isFinite(days) || days < 1 || days > ADS_MAX_RANGE_DAYS) {
    throw new AppleAdsError('invalid_input', { message: `The date range must be 1 to ${ADS_MAX_RANGE_DAYS} days.` });
  }
}

const idOf = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v)) return v;
  return null;
};

const textOf = (v: unknown, max = 300): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** "45.00" to 45_000_000. A number is refused: Apple sends amounts as strings, and a float would round. */
export function microsOf(amount: unknown): number {
  if (typeof amount !== 'string') throw unexpected();
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,9}))?$/.exec(amount.trim());
  if (!m) throw unexpected();
  const whole = Number(m[2]);
  const frac = Math.round(Number(`0.${m[3] ?? '0'}`) * 1_000_000);
  return (m[1] ? -1 : 1) * (whole * 1_000_000 + frac);
}

const count = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw unexpected();
  return Math.round(v);
};

const money = (v: unknown): { micros: number; currency: string | null } => {
  if (v === undefined || v === null) return { micros: 0, currency: null };
  if (!isRecord(v)) throw unexpected();
  const currency = typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? v.currency : null;
  return { micros: v.amount === undefined ? 0 : microsOf(v.amount), currency };
};

export function parseAdsMetrics(m: unknown): AdsMetrics {
  if (m === undefined || m === null) return { impressions: 0, taps: 0, installs: 0, tapInstalls: 0, spendMicros: 0, currency: null };
  if (!isRecord(m)) throw unexpected();
  const spend = money(m.localSpend);
  const tapInstalls = count(m.tapInstalls);
  const total = m.totalInstalls === undefined || m.totalInstalls === null ? undefined : count(m.totalInstalls);
  return {
    impressions: count(m.impressions),
    taps: count(m.taps),
    installs: total ?? tapInstalls,
    tapInstalls,
    spendMicros: spend.micros,
    currency: spend.currency,
  };
}

const add = (a: AdsMetrics, b: AdsMetrics): AdsMetrics => ({
  impressions: a.impressions + b.impressions,
  taps: a.taps + b.taps,
  installs: a.installs + b.installs,
  tapInstalls: a.tapInstalls + b.tapInstalls,
  spendMicros: a.spendMicros + b.spendMicros,
  currency: a.currency ?? b.currency,
});

/** The daily entries of a row, merged by day and country. With no granular entries (a one-day request) the totals are that day. */
function daysOf(row: Record<string, unknown>, range: AdsRange, meta: Record<string, unknown>): AdsDay[] {
  const out = new Map<string, AdsDay>();
  const put = (day: string, country: string, m: AdsMetrics) => {
    const key = `${day}|${country}`;
    const had = out.get(key);
    out.set(key, had ? { ...add(had, m), day, country } : { ...m, day, country });
  };
  const granular = row.granularMetrics;
  if (granular !== undefined && granular !== null) {
    if (!Array.isArray(granular)) throw unexpected();
    for (const g of granular) {
      if (!isRecord(g)) throw unexpected();
      if (typeof g.date !== 'string' || !DATE.test(g.date.slice(0, 10))) continue;
      const country = textOf(g.countryOrRegion, 8) ?? textOf(meta.countryOrRegion, 8) ?? '';
      put(g.date.slice(0, 10), country.toLowerCase(), parseAdsMetrics(g));
    }
  } else if (range.start === range.end && row.totalMetrics !== undefined) {
    const country = textOf(meta.countryOrRegion, 8) ?? '';
    put(range.start, country.toLowerCase(), parseAdsMetrics(row.totalMetrics));
  }
  return [...out.values()].sort((a, b) => (a.day + a.country < b.day + b.country ? -1 : 1));
}

function reportBody(range: AdsRange, page: { offset: number; pageSize: number }, extra: { campaignId?: string; groupByCountry?: boolean }) {
  const daily = range.start !== range.end;
  return {
    timeRange: { start: range.start, end: range.end, timeZone: 'ORTZ', ...(daily ? { granularity: 'DAILY' } : {}) },
    ...(extra.campaignId ? { filters: [{ field: 'campaignId', operator: 'EQUALS', value: extra.campaignId }] } : {}),
    ...(extra.groupByCountry ? { groupBy: ['countryOrRegion'] } : {}),
    pagination: { offset: page.offset, pageSize: page.pageSize },
  };
}

async function pagedRows(
  client: AppleAdsClient,
  path: string,
  adAccountId: string,
  makeBody: (page: { offset: number; pageSize: number }) => Record<string, unknown>,
  options: { signal?: AbortSignal | undefined; maxRows?: number | undefined; pageSize?: number | undefined },
): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
  const pageSize = options.pageSize ?? ADS_PAGE_SIZE;
  const maxRows = options.maxRows ?? ADS_MAX_ROWS;
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < ADS_MAX_PAGES; page += 1) {
    if (!client.canRequest()) return { rows, complete: false };
    const body = await client.query(path, makeBody({ offset, pageSize }), { adAccountId, signal: options.signal });
    const result = body.result;
    const list = isRecord(result) ? result.rows : undefined;
    if (!Array.isArray(list)) throw unexpected();
    for (const r of list) {
      if (!isRecord(r)) throw unexpected();
      rows.push(r);
    }
    const total = isRecord(body.pagination) && typeof body.pagination.totalCount === 'number' ? body.pagination.totalCount : undefined;
    offset += list.length;
    if (list.length < pageSize || (total !== undefined && offset >= total)) return { rows, complete: true };
    if (rows.length >= maxRows) return { rows, complete: false };
  }
  return { rows, complete: false };
}

const accountId = (v: string): string => {
  if (!/^[0-9]{1,20}$/.test(v)) throw new AppleAdsError('invalid_input', { message: 'That is not a valid Apple Ads ad account id.' });
  return v;
};

/** `GET /v1/acls`: the ad accounts the key may read and its roles on each. */
export async function listAppleAdsAccounts(client: AppleAdsClient, options: { signal?: AbortSignal | undefined } = {}): Promise<AdsAccount[]> {
  const body = await client.get('/acls', options);
  const result = body.result;
  const acls = isRecord(result) ? result.acls : undefined;
  if (!Array.isArray(acls)) throw unexpected();
  const out: AdsAccount[] = [];
  for (const entry of acls) {
    if (!isRecord(entry) || !isRecord(entry.adAccount)) throw unexpected();
    const id = idOf(entry.adAccount.id);
    if (id === null) continue;
    const roles = Array.isArray(entry.roles) ? entry.roles.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 80)) : [];
    out.push({ id, name: textOf(entry.adAccount.name, 200) ?? id, orgId: idOf(entry.adAccount.orgId), roles });
  }
  return out;
}

/** `GET /v1/ad-accounts/{id}`: the currency and the reporting time zone of the account. */
export async function getAppleAdsAccount(
  client: AppleAdsClient,
  adAccountId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<AdsAccountDetail> {
  const id = accountId(adAccountId);
  const body = await client.get(`/ad-accounts/${id}`, { adAccountId: id, signal: options.signal });
  const r = body.result;
  if (!isRecord(r)) throw unexpected();
  return {
    id,
    name: textOf(r.name, 200) ?? id,
    currency: typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : null,
    timezone: textOf(r.timezone, 60),
    systemStatus: textOf(r.systemStatus, 40),
    productFeatures: Array.isArray(r.productFeatures) ? r.productFeatures.filter((f): f is string => typeof f === 'string').slice(0, 10) : [],
  };
}

type ReadOptions = { signal?: AbortSignal | undefined; maxRows?: number | undefined; pageSize?: number | undefined };

/** `POST /v1/reports/apps/campaigns/query`: one row per App Store campaign with activity in the range, daily. */
export async function readAppleAdsCampaigns(
  client: AppleAdsClient,
  adAccountId: string,
  range: AdsRange,
  options: ReadOptions = {},
): Promise<AdsReadResult<AdsCampaign>> {
  checkRange(range);
  const id = accountId(adAccountId);
  const { rows, complete } = await pagedRows(client, '/reports/apps/campaigns/query', id, (page) => reportBody(range, page, {}), options);
  const byId = new Map<string, AdsCampaign>();
  let skipped = 0;
  for (const row of rows) {
    const meta = isRecord(row.metadata) ? row.metadata : undefined;
    const campaignId = meta ? idOf(meta.id) : null;
    if (!meta || campaignId === null) {
      skipped += 1;
      continue;
    }
    const days = daysOf(row, range, meta);
    const had = byId.get(campaignId);
    const campaign: AdsCampaign = had ?? {
      campaignId,
      name: textOf(meta.name, 200) ?? campaignId,
      status: textOf(meta.status, 40),
      adamId: meta.promotedObjectType === undefined || meta.promotedObjectType === 'APPSTORE_APP' ? idOf(meta.promotedObjectId) : null,
      days: [],
    };
    campaign.days = mergeDays(campaign.days, days);
    byId.set(campaignId, campaign);
  }
  return { rows: [...byId.values()], complete, skipped };
}

function mergeDays(a: AdsDay[], b: AdsDay[]): AdsDay[] {
  const out = new Map<string, AdsDay>();
  for (const d of [...a, ...b]) {
    const key = `${d.day}|${d.country}`;
    const had = out.get(key);
    out.set(key, had ? { ...add(had, d), day: d.day, country: d.country } : d);
  }
  return [...out.values()].sort((x, y) => (x.day + x.country < y.day + y.country ? -1 : 1));
}

type TermKind = 'searchterms' | 'keywords';

async function readTerms(
  client: AppleAdsClient,
  kind: TermKind,
  adAccountId: string,
  campaignId: string,
  range: AdsRange,
  options: ReadOptions,
): Promise<AdsReadResult<AdsTerm>> {
  checkRange(range);
  const id = accountId(adAccountId);
  const campaign = accountId(campaignId);
  const { rows, complete } = await pagedRows(
    client,
    `/reports/apps/${kind}/query`,
    id,
    (page) => reportBody(range, page, { campaignId: campaign, groupByCountry: true }),
    options,
  );
  const merged = new Map<string, AdsTerm & { best: number }>();
  let skipped = 0;
  for (const row of rows) {
    const meta = isRecord(row.metadata) ? row.metadata : undefined;
    if (!meta) {
      skipped += 1;
      continue;
    }
    const keyword = isRecord(meta.keyword) ? meta.keyword : kind === 'keywords' ? meta : undefined;
    const term = kind === 'searchterms' ? textOf(meta.searchTermText) : textOf(keyword?.text);
    if (term === null) {
      skipped += 1;
      continue;
    }
    const keywordId = idOf(keyword?.id);
    if (kind === 'keywords' && keywordId === null) {
      skipped += 1;
      continue;
    }
    const days = daysOf(row, range, meta);
    const weight = days.reduce((t, d) => t + d.impressions, 0);
    const key = kind === 'keywords' ? (keywordId ?? term) : term.toLowerCase();
    const had = merged.get(key);
    if (had) {
      had.days = mergeDays(had.days, days);
      if (weight > had.best) {
        had.best = weight;
        had.keywordText = kind === 'searchterms' ? textOf(keyword?.text) : had.keywordText;
        had.matchType = textOf(keyword?.matchType, 20) ?? had.matchType;
      }
    } else {
      merged.set(key, {
        term,
        keywordId,
        matchType: textOf(keyword?.matchType, 20),
        source: kind === 'searchterms' ? textOf(meta.searchTermSource, 20) : null,
        keywordText: kind === 'searchterms' ? textOf(keyword?.text) : null,
        days,
        best: weight,
      });
    }
  }
  return { rows: [...merged.values()].map(({ best: _best, ...t }) => t), complete, skipped };
}

/** `POST /v1/reports/apps/searchterms/query` for one campaign, daily and per country. Low-volume terms may be hidden by Apple. */
export const readAppleAdsSearchTerms = (client: AppleAdsClient, adAccountId: string, campaignId: string, range: AdsRange, options: ReadOptions = {}) =>
  readTerms(client, 'searchterms', adAccountId, campaignId, range, options);

/** `POST /v1/reports/apps/keywords/query` for one campaign, daily and per country. */
export const readAppleAdsKeywords = (client: AppleAdsClient, adAccountId: string, campaignId: string, range: AdsRange, options: ReadOptions = {}) =>
  readTerms(client, 'keywords', adAccountId, campaignId, range, options);

const POPULARITY_CHUNK = 20;

/**
 * `POST /v1/insights/apps/search-term-popularity/query`: Apple's own 1 to 100 popularity of the given terms in one storefront for
 * one week (a Sunday to Saturday range). Apple answers per genre; every row is returned as sent. Terms Apple does not list are
 * simply absent: that is not a score of 0.
 */
export async function readAppleAdsPopularity(
  client: AppleAdsClient,
  adAccountId: string,
  input: { country: string; terms: string[]; weekStart: string; weekEnd: string; genre?: string | undefined },
  options: { signal?: AbortSignal | undefined } = {},
): Promise<{ rows: AdsPopularity[]; complete: boolean }> {
  const id = accountId(adAccountId);
  if (!/^[A-Za-z]{2}$/.test(input.country) || !DATE.test(input.weekStart) || !DATE.test(input.weekEnd)) {
    throw new AppleAdsError('invalid_input');
  }
  const out: AdsPopularity[] = [];
  const terms = [...new Set(input.terms.map((t) => t.trim()).filter((t) => t !== ''))];
  let complete = true;
  for (let i = 0; i < terms.length; i += POPULARITY_CHUNK) {
    if (!client.canRequest()) {
      complete = false;
      break;
    }
    const chunk = terms.slice(i, i + POPULARITY_CHUNK);
    const body = await client.query(
      '/insights/apps/search-term-popularity/query',
      {
        filters: [
          { field: 'countryOrRegion', operator: 'EQUALS', value: input.country.toUpperCase() },
          { field: 'searchTerm', operator: 'IN', value: chunk },
          ...(input.genre ? [{ field: 'genre', operator: 'EQUALS', value: input.genre }] : []),
        ],
        timeRange: { start: input.weekStart, end: input.weekEnd, granularity: 'WEEKLY_SUN_SAT' },
        pagination: { offset: 0, pageSize: Math.min(500, chunk.length * 15) },
      },
      { adAccountId: id, signal: options.signal },
    );
    const result = body.result;
    const list = isRecord(result) ? result.rows : undefined;
    if (!Array.isArray(list)) throw unexpected();
    for (const r of list) {
      if (!isRecord(r)) throw unexpected();
      const term = textOf(r.searchTerm);
      if (term === null) continue;
      const score = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
      out.push({
        term,
        country: (textOf(r.countryOrRegion, 8) ?? input.country).toLowerCase(),
        genre: textOf(r.genre, 60),
        period: textOf(r.week, 20) ?? textOf(r.month, 20),
        popularity100: score(r.searchPopularity1to100),
        popularity5: score(r.searchPopularity1to5),
        rankInGenre: score(r.rankInGenre),
      });
    }
  }
  return { rows: out, complete };
}
