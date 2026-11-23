import type { Sql } from '@kiln/db';
import { nullableString } from '@kiln/db';
import { listKeywords } from '../aso/service.ts';
import type { AdsLinkView } from './link.ts';

/**
 * The reads behind Insights, Ads (docs/adr/0058-apple-ads.md, docs/api/apple-ads.md). Database only: Apple is not contacted. Every
 * amount is in the currency of the link (the ad account's); rows in another currency are never read. Derived figures (cost per tap,
 * cost per install, tap-through rate, conversion) are worked out here from sums, never averaged from daily rates, and are null when
 * the denominator is 0.
 */
const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const ADS_MAX_QUERY_DAYS = 366;

export type AdsWindow = { from: string; to: string };

const parseDay = (v: string) => Date.parse(`${v}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A valid window of at most a year, or null. */
export function parseWindow(from: string | undefined, to: string | undefined, fallbackEnd: string, defaultDays = 30): AdsWindow | null {
  const end = to ?? fallbackEnd;
  const start = from ?? isoDay(parseDay(end) - (defaultDays - 1) * DAY_MS);
  if (!ISO.test(start) || !ISO.test(end)) return null;
  const a = parseDay(start);
  const b = parseDay(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || (b - a) / DAY_MS + 1 > ADS_MAX_QUERY_DAYS) return null;
  return { from: start, to: end };
}

/** The window of the same length that ends the day before `w` starts. */
export function previousWindow(w: AdsWindow): AdsWindow {
  const length = (parseDay(w.to) - parseDay(w.from)) / DAY_MS + 1;
  const to = parseDay(w.from) - DAY_MS;
  return { from: isoDay(to - (length - 1) * DAY_MS), to: isoDay(to) };
}

export type AdsTotals = {
  impressions: number;
  taps: number;
  installs: number;
  tapInstalls: number;
  spendMicros: number;
  /** Spend per tap, in micro-units; null without taps. */
  cptMicros: number | null;
  /** Spend per install, in micro-units; null without installs. */
  cpiMicros: number | null;
  /** Taps per impression, 0 to 1; null without impressions. */
  ttr: number | null;
  /** Installs per tap, 0 to 1; null without taps. */
  conversion: number | null;
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function totalsOf(r: Record<string, unknown> | undefined): AdsTotals {
  const impressions = num(r?.impressions);
  const taps = num(r?.taps);
  const installs = num(r?.installs);
  const spendMicros = num(r?.spend_micros);
  return {
    impressions,
    taps,
    installs,
    tapInstalls: num(r?.tap_installs),
    spendMicros,
    cptMicros: taps > 0 ? Math.round(spendMicros / taps) : null,
    cpiMicros: installs > 0 ? Math.round(spendMicros / installs) : null,
    ttr: impressions > 0 ? taps / impressions : null,
    conversion: taps > 0 ? installs / taps : null,
  };
}

const SUMS = 'SUM(impressions) AS impressions, SUM(taps) AS taps, SUM(installs) AS installs, SUM(tap_installs) AS tap_installs, SUM(spend_micros) AS spend_micros';

/** `AND (currency = ? OR currency IS NULL)` for a link with a currency. */
const currencyClause = (link: AdsLinkView): { sql: string; args: string[] } =>
  link.currency ? { sql: ' AND (currency = ? OR currency IS NULL)', args: [link.currency] } : { sql: '', args: [] };

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

const optionalNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function getAdsSync(sql: Sql, workspaceId: string, appId: string): Promise<AdsSyncView | null> {
  const [r] = await sql.query('SELECT * FROM ads_sync WHERE app_id = ? AND workspace_id = ?', [appId, workspaceId]);
  if (!r) return null;
  let warnings: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.warnings ?? '[]'));
    if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === 'string').slice(0, 20);
  } catch {
    warnings = [];
  }
  return {
    lastAttemptAt: optionalNumber(r.last_attempt_at),
    lastSuccessAt: optionalNumber(r.last_success_at),
    lastError: nullableString(r.last_error),
    lastErrorCode: nullableString(r.last_error_code),
    failureStreak: num(r.failure_streak),
    rangeStart: nullableString(r.range_start),
    rangeEnd: nullableString(r.range_end),
    campaigns: num(r.campaigns),
    complete: num(r.complete) !== 0,
    skipped: num(r.skipped),
    warnings,
  };
}

export type AdsDailyPoint = { day: string; impressions: number; taps: number; installs: number; spendMicros: number };

export type AdsOverview = {
  currency: string | null;
  window: AdsWindow;
  previousWindow: AdsWindow;
  totals: AdsTotals;
  previous: AdsTotals;
  daily: AdsDailyPoint[];
  /** Days with data in the window, so a screen can say "3 of 30 days". */
  daysWithData: number;
  campaigns: number;
};

export async function adsOverview(sql: Sql, workspaceId: string, appId: string, link: AdsLinkView, window: AdsWindow): Promise<AdsOverview> {
  const cur = currencyClause(link);
  const prev = previousWindow(window);
  const base = `FROM ads_campaign_daily WHERE workspace_id = ? AND app_id = ? AND day >= ? AND day <= ?${cur.sql}`;
  const sum = async (w: AdsWindow) => (await sql.query(`SELECT ${SUMS} ${base}`, [workspaceId, appId, w.from, w.to, ...cur.args]))[0];
  const daily = await sql.query(`SELECT day, ${SUMS} ${base} GROUP BY day ORDER BY day`, [workspaceId, appId, window.from, window.to, ...cur.args]);
  const [count] = await sql.query(`SELECT COUNT(DISTINCT campaign_id) AS campaigns ${base}`, [workspaceId, appId, window.from, window.to, ...cur.args]);
  return {
    currency: link.currency,
    window,
    previousWindow: prev,
    totals: totalsOf(await sum(window)),
    previous: totalsOf(await sum(prev)),
    daily: daily.map((d) => ({ day: String(d.day), impressions: num(d.impressions), taps: num(d.taps), installs: num(d.installs), spendMicros: num(d.spend_micros) })),
    daysWithData: daily.length,
    campaigns: num(count?.campaigns),
  };
}

export type AdsCampaignRow = AdsTotals & { campaignId: string; name: string; status: string | null; daysWithData: number };

export async function adsCampaigns(sql: Sql, workspaceId: string, appId: string, link: AdsLinkView, window: AdsWindow): Promise<AdsCampaignRow[]> {
  const cur = currencyClause(link);
  const rows = await sql.query(
    `SELECT campaign_id, MAX(name) AS name, MAX(status) AS status, COUNT(DISTINCT day) AS days, ${SUMS}
       FROM ads_campaign_daily WHERE workspace_id = ? AND app_id = ? AND day >= ? AND day <= ?${cur.sql}
      GROUP BY campaign_id ORDER BY SUM(spend_micros) DESC, campaign_id`,
    [workspaceId, appId, window.from, window.to, ...cur.args],
  );
  return rows.map((r) => ({ ...totalsOf(r), campaignId: String(r.campaign_id), name: String(r.name), status: nullableString(r.status), daysWithData: num(r.days) }));
}

export const TERM_SORTS = ['impressions', 'taps', 'installs', 'spend', 'cpt', 'cpi', 'ttr', 'term'] as const;
export type TermSort = (typeof TERM_SORTS)[number];

const SORT_SQL: Record<TermSort, string> = {
  impressions: 'SUM(impressions)',
  taps: 'SUM(taps)',
  installs: 'SUM(installs)',
  spend: 'SUM(spend_micros)',
  cpt: 'CASE WHEN SUM(taps) = 0 THEN -1 ELSE 1.0 * SUM(spend_micros) / SUM(taps) END',
  cpi: 'CASE WHEN SUM(installs) = 0 THEN -1 ELSE 1.0 * SUM(spend_micros) / SUM(installs) END',
  ttr: 'CASE WHEN SUM(impressions) = 0 THEN -1 ELSE 1.0 * SUM(taps) / SUM(impressions) END',
  term: 'MAX(term)',
};

export type AdsTermQuery = {
  kind: 'term' | 'keyword';
  window: AdsWindow;
  country?: string | undefined;
  campaignId?: string | undefined;
  q?: string | undefined;
  sort: TermSort;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
};

export type AdsTermRow = AdsTotals & {
  kind: 'term' | 'keyword';
  term: string;
  termKey: string;
  /** Lower-case storefront, or empty when Apple did not say. */
  country: string;
  matchType: string | null;
  /** For a search term, the keyword that matched it most. */
  keywordText: string | null;
  /** A tracked keyword of this app has this term in this storefront. */
  tracked: boolean;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function adsTerms(sql: Sql, workspaceId: string, appId: string, link: AdsLinkView, query: AdsTermQuery) {
  const cur = currencyClause(link);
  const where = [`workspace_id = ? AND app_id = ? AND kind = ? AND day >= ? AND day <= ?${cur.sql}`];
  const args: unknown[] = [workspaceId, appId, query.kind, query.window.from, query.window.to, ...cur.args];
  if (query.country !== undefined) {
    where.push('country = ?');
    args.push(query.country);
  }
  if (query.campaignId !== undefined) {
    where.push('campaign_id = ?');
    args.push(query.campaignId);
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    where.push("LOWER(term) LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(query.q.trim().toLowerCase())}%`);
  }
  const from = `FROM ads_term_daily WHERE ${where.join(' AND ')} GROUP BY term_key, country`;
  const [count] = await sql.query(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from}) x`, args as never[]);
  const order = `${SORT_SQL[query.sort]} ${query.dir === 'asc' ? 'ASC' : 'DESC'}, MAX(term) ASC, country ASC`;
  const rows = await sql.query(
    `SELECT term_key, country, MAX(term) AS term, MAX(match_type) AS match_type, MAX(keyword_text) AS keyword_text, ${SUMS} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...args, query.limit, query.offset] as never[],
  );
  const tracked = new Set<string>();
  const trackedKeys = new Set<string>();
  if (query.kind === 'term') {
    for (const k of await listKeywords(sql, workspaceId, appId)) {
      tracked.add(`${k.country}|${k.key}`);
      trackedKeys.add(k.key);
    }
  }
  const [totals] = await sql.query(`SELECT ${SUMS} FROM ads_term_daily WHERE ${where.join(' AND ')}`, args as never[]);
  return {
    total: num(count?.n),
    totals: totalsOf(totals),
    rows: rows.map(
      (r): AdsTermRow => ({
        ...totalsOf(r),
        kind: query.kind,
        term: String(r.term),
        termKey: String(r.term_key),
        country: String(r.country),
        matchType: nullableString(r.match_type),
        keywordText: nullableString(r.keyword_text),
        tracked: query.kind === 'term' && (tracked.has(`${String(r.country)}|${String(r.term_key)}`) || (String(r.country) === '' && trackedKeys.has(String(r.term_key)))),
      }),
    ),
  };
}

/** The own-campaign signal of the keyword estimate: the term's impressions, taps and installs in the stored rows; null when the term never appeared. */
export async function adsSignalFor(
  sql: Sql,
  workspaceId: string,
  appId: string,
  termKey: string,
  country: string,
): Promise<{ impressions: number; taps: number; installs: number; days: number } | null> {
  const [r] = await sql.query(
    `SELECT SUM(impressions) AS impressions, SUM(taps) AS taps, SUM(installs) AS installs, MIN(day) AS first, MAX(day) AS last, COUNT(*) AS n
       FROM ads_term_daily WHERE workspace_id = ? AND app_id = ? AND kind = 'term' AND term_key = ? AND (country = ? OR country = '')`,
    [workspaceId, appId, termKey, country],
  );
  if (!r || num(r.n) === 0) return null;
  const days = Math.max(1, Math.round((parseDay(String(r.last)) - parseDay(String(r.first))) / DAY_MS) + 1);
  return { impressions: num(r.impressions), taps: num(r.taps), installs: num(r.installs), days };
}

export type AdsPopularityView = { genre: string; period: string | null; popularity100: number | null; popularity5: number | null; rankInGenre: number | null; fetchedAt: number };

/** Apple's own popularity rows of a term in a storefront, highest score first. Never merged into an estimate. */
export async function adsPopularityFor(sql: Sql, workspaceId: string, termKey: string, country: string): Promise<AdsPopularityView[]> {
  const rows = await sql.query(
    'SELECT genre, period, popularity_100, popularity_5, rank_in_genre, fetched_at FROM ads_term_popularity WHERE workspace_id = ? AND country = ? AND term_key = ? ORDER BY popularity_100 DESC',
    [workspaceId, country, termKey],
  );
  return rows.map((r) => ({
    genre: String(r.genre),
    period: nullableString(r.period),
    popularity100: optionalNumber(r.popularity_100),
    popularity5: optionalNumber(r.popularity_5),
    rankInGenre: optionalNumber(r.rank_in_genre),
    fetchedAt: num(r.fetched_at),
  }));
}
