import {
  type AnalyticsMetric,
  addDays,
  buildRankVsDownloads,
  type DownloadsIn,
  dateToDay,
  daysBetween,
  dayToMs,
  isIsoDate,
  metricInfo,
  normalizeCountry,
  type RankDownloadsView,
  type RankKeywordIn,
  rankDownloadsLimits,
} from '@mrm/core';
import type { Sql } from '@mrm/db';
import { readDaily } from '../../services/analytics-store.ts';
import type { ManagedApp } from '../../services/apps.ts';
import { type AsoKeyword, listKeywords } from './service.ts';
import { getSettings } from '../../services/workspace-settings.ts';

/**
 * Rank versus downloads (docs/api/aso.md): the rank history of chosen tracked keywords of one storefront laid on the same days as the
 * app's downloads, with rank moves marked and the downloads 7 days before and after each big move (core `buildRankVsDownloads`). It reads
 * this server's database only (rank checks and stored analytics); no store is contacted, so it works with whatever analytics source is on.
 * Always a correlation: the answer carries the notes that say so.
 *
 * Downloads: iOS and macOS use first-time downloads of the Analytics Reports, else the units of Sales and Trends (a different measure, and
 * labelled as such); Android uses user installs of the Play reports, else device installs. The first metric with a day in the range wins.
 */

const DAY_MS = 86_400_000;
export const DEFAULT_RANGE_DAYS = 90;
const DEFAULT_KEYWORDS = 3;
/** Checks before the range that are read so the first move of the range has a check to compare with. */
const LOOKBACK_DAYS = 14;

type Candidate = { metric: AnalyticsMetric; label: string; source: 'apple' | 'play' };

const candidates = (platform: ManagedApp['platform']): Candidate[] =>
  platform === 'android'
    ? [
        { metric: 'installs_user', label: metricInfo.installs_user.label, source: 'play' },
        { metric: 'installs_device', label: metricInfo.installs_device.label, source: 'play' },
      ]
    : [
        {
          metric: 'downloads_first_time',
          label: metricInfo.downloads_first_time.label,
          source: 'apple',
        },
        {
          metric: 'sales_units',
          label: 'Units (Sales and Trends, not first-time downloads)',
          source: 'apple',
        },
      ];

export type RankDownloadsQuery = {
  platform?: string;
  country?: string;
  keywords?: string;
  from?: string;
  to?: string;
};
type Issue = { path: string; message: string };

export type CheckedRankQuery =
  | { ok: true; country: string | undefined; keywordIds: string[]; from: string; to: string }
  | { ok: false; issues: Issue[] };

export function checkRankDownloadsQuery(
  app: Pick<ManagedApp, 'platform'>,
  query: RankDownloadsQuery,
  now: number,
): CheckedRankQuery {
  const issues: Issue[] = [];
  if (query.platform !== undefined && query.platform !== '' && query.platform !== app.platform) {
    issues.push({
      path: 'platform',
      message: `This app is ${app.platform}. Leave platform out or use ${app.platform}.`,
    });
  }
  let country: string | undefined;
  if (query.country !== undefined && query.country !== '') {
    country = normalizeCountry(query.country);
    if (!country)
      issues.push({ path: 'country', message: 'A storefront of two letters, such as us.' });
  }
  let keywordIds: string[] = [];
  if (query.keywords !== undefined && query.keywords !== '') {
    keywordIds = Array.from(
      new Set(
        query.keywords
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k !== ''),
      ),
    );
    if (keywordIds.length > rankDownloadsLimits.maxKeywords)
      issues.push({
        path: 'keywords',
        message: `At most ${rankDownloadsLimits.maxKeywords} keywords.`,
      });
  }
  const yesterday = addDays(dateToDay(now), -1);
  const to = query.to !== undefined && query.to !== '' ? query.to : yesterday;
  const from =
    query.from !== undefined && query.from !== ''
      ? query.from
      : addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (!isIsoDate(to)) issues.push({ path: 'to', message: 'A day, YYYY-MM-DD.' });
  if (!isIsoDate(from)) issues.push({ path: 'from', message: 'A day, YYYY-MM-DD.' });
  if (isIsoDate(from) && isIsoDate(to)) {
    if (from > to) issues.push({ path: 'from', message: 'from is after to.' });
    else if (daysBetween(from, to) + 1 > rankDownloadsLimits.maxDays)
      issues.push({ path: 'to', message: `At most ${rankDownloadsLimits.maxDays} days.` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, country, keywordIds, from, to };
}

export type RankDownloadsKeyword = {
  id: string;
  term: string;
  locale: string;
  priority: number;
  checks: number;
  lastCheckedAt: number | null;
};

export type RankDownloadsAnswer = RankDownloadsView & {
  appId: string;
  platform: ManagedApp['platform'];
  country: string | null;
  /** The storefronts that have tracked keywords (the ones the view can be switched to). */
  countries: string[];
  /** The tracked keywords of the storefront that can be chosen, with the checks each has in the range. */
  available: RankDownloadsKeyword[];
  /** The keyword ids drawn. */
  selected: string[];
};

export type RankDownloadsOutcome =
  | { ok: true; answer: RankDownloadsAnswer }
  | { ok: false; status: 400; issues: Issue[] };

/** The storefront with the most tracked keywords (ties: the first by code). */
const busiestCountry = (keywords: readonly AsoKeyword[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const k of keywords) counts.set(k.country, (counts.get(k.country) ?? 0) + 1);
  let best: string | undefined;
  for (const [c, n] of Array.from(counts.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (best === undefined || n > (counts.get(best) ?? 0)) best = c;
  return best;
};

export async function rankVsDownloadsFor(
  sql: Sql,
  workspaceId: string,
  app: ManagedApp,
  query: Extract<CheckedRankQuery, { ok: true }>,
  now: number,
): Promise<RankDownloadsOutcome> {
  const all = await listKeywords(sql, workspaceId, app.id);
  const country = query.country ?? busiestCountry(all);
  const inCountry = country === undefined ? [] : all.filter((k) => k.country === country);

  const lower = dayToMs(addDays(query.from, -LOOKBACK_DAYS));
  const upper = dayToMs(query.to) + DAY_MS;
  const checkRows =
    inCountry.length === 0
      ? []
      : await sql.query(
          `SELECT keyword_id, checked_at, rank_pos, total FROM aso_rank_checks
          WHERE workspace_id = ? AND app_id = ? AND checked_at >= ? AND checked_at < ?
          ORDER BY checked_at, id`,
          [workspaceId, app.id, lower, upper],
        );
  const byKeyword = new Map<string, { checkedAt: number; rank: number | null; total: number }[]>();
  const inRange = new Map<string, number>();
  const rangeFrom = dayToMs(query.from);
  const ids = new Set(inCountry.map((k) => k.id));
  for (const r of checkRows) {
    const id = String(r.keyword_id);
    if (!ids.has(id)) continue;
    const checkedAt = Number(r.checked_at);
    const list = byKeyword.get(id) ?? [];
    list.push({
      checkedAt,
      rank: r.rank_pos === null || r.rank_pos === undefined ? null : Number(r.rank_pos),
      total: Number(r.total),
    });
    byKeyword.set(id, list);
    if (checkedAt >= rangeFrom) inRange.set(id, (inRange.get(id) ?? 0) + 1);
  }

  const available: RankDownloadsKeyword[] = inCountry
    .map((k) => ({
      id: k.id,
      term: k.term,
      locale: k.locale,
      priority: k.priority,
      checks: inRange.get(k.id) ?? 0,
      lastCheckedAt: k.lastCheckedAt,
    }))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : a.locale < b.locale ? -1 : 1));

  let selected: string[];
  if (query.keywordIds.length > 0) {
    const unknown = query.keywordIds.filter((id) => !ids.has(id));
    if (unknown.length > 0)
      return {
        ok: false,
        status: 400,
        issues: [
          {
            path: 'keywords',
            message: 'A keyword is not tracked for this app in this storefront.',
          },
        ],
      };
    selected = query.keywordIds;
  } else {
    selected = available
      .filter((k) => k.checks > 0)
      .sort((a, b) => b.checks - a.checks || b.priority - a.priority || (a.term < b.term ? -1 : 1))
      .slice(0, DEFAULT_KEYWORDS)
      .map((k) => k.id);
  }
  const keywords: RankKeywordIn[] = selected.map((id) => {
    const k = inCountry.find((x) => x.id === id) as AsoKeyword;
    return { id, term: k.term, checks: byKeyword.get(id) ?? [] };
  });

  // Downloads, from the stored analytics of the app. The windows of moves near the range reach past it, so a week more is read each side.
  const from = addDays(query.from, -(rankDownloadsLimits.windowDays + 1));
  const to = addDays(query.to, rankDownloadsLimits.windowDays + 1);
  let downloads: DownloadsIn | null = null;
  for (const c of candidates(app.platform)) {
    const rows = (
      await readDaily(sql, { workspaceId, appId: app.id, platform: app.platform, from, to })
    ).filter((r) => r.metric === c.metric && r.dimType === '');
    if (!rows.some((r) => r.day >= query.from && r.day <= query.to)) continue;
    downloads = {
      metric: c.metric,
      label: c.label,
      source: c.source,
      delayDays: metricInfo[c.metric].delayDays,
      points: rows.map((r) => ({ day: r.day, value: r.value })),
    };
    break;
  }

  const settings = (await getSettings(sql, workspaceId)).values;
  const view = buildRankVsDownloads({
    from: query.from,
    to: query.to,
    today: dateToDay(now),
    keywords,
    downloads,
    threshold: settings['aso.rankMoveThreshold'] as number,
    analyticsEnabled: settings['analytics.enabled'] === true,
  });
  return {
    ok: true,
    answer: {
      ...view,
      appId: app.id,
      platform: app.platform,
      country: country ?? null,
      countries: Array.from(new Set(all.map((k) => k.country))).sort(),
      available,
      selected,
    },
  };
}
