import type { Sql } from '@mrm/db';
import { type ReviewStatus, reviewStatuses } from './reviews.ts';

/**
 * Numbers about the reviews of one app, always with their basis: `stored` is computed from the
 * reviews this server holds (so it describes only those, and for Google Play only the reviews
 * seen since the first sync, which are the ones Google still showed), `storeWide` is the rating the
 * store publishes for the whole app, when there is a source for it (the public iTunes lookup for
 * App Store apps; Google Play's Developer API has none). The two are never mixed in one number.
 */

/** Most rows read for the numbers; a larger inbox says so (`truncated`). */
export const MAX_SUMMARY_ROWS = 20_000;
export const DEFAULT_TREND_WEEKS = 12;
export const MAX_TREND_WEEKS = 52;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** 1970-01-01 was a Thursday: the first Monday 00:00 UTC is 4 days later. */
const FIRST_MONDAY = 4 * 24 * 60 * 60 * 1000;

/** Monday 00:00 UTC of the week of `at`. */
export const weekStart = (at: number): number => Math.floor((at - FIRST_MONDAY) / WEEK_MS) * WEEK_MS + FIRST_MONDAY;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type StoredSummary = {
  basis: 'stored_reviews';
  /** For a person: where the numbers come from. */
  label: string;
  count: number;
  /** Mean of the stored ratings, two decimals; null with no review. */
  average: number | null;
  /** Index 0 is one star. Always five entries. */
  histogram: [number, number, number, number, number];
  oldestAt: number | null;
  newestAt: number | null;
  /** True when more than MAX_SUMMARY_ROWS reviews exist: the newest ones are counted. */
  truncated: boolean;
  byVersion: { version: string; count: number; average: number }[];
  /** Oldest first, one entry per week including weeks without reviews (count 0, average null). */
  weeks: { weekStart: number; count: number; average: number | null }[];
  territories: { value: string; count: number }[];
  languages: { value: string; count: number }[];
};

export type StoreWideRating = {
  basis: 'store_wide';
  label: string;
  /** Where the number comes from. */
  source: 'itunes_lookup';
  territory: string;
  average: number | null;
  ratingCount: number | null;
  currentVersionAverage: number | null;
  currentVersionCount: number | null;
  observedAt: number;
};

export type ReviewsSummary = {
  stored: StoredSummary;
  storeWide: StoreWideRating[];
  /** Reviews by triage status, over everything stored. */
  byStatus: Record<ReviewStatus, number>;
};

export function emptyStatusCounts(): Record<ReviewStatus, number> {
  return Object.fromEntries(reviewStatuses.map((s) => [s, 0])) as Record<ReviewStatus, number>;
}

type Slim = { rating: number; created_at: number; app_version: string | null; territory: string | null; language: string | null };

/** Pure: the stored part of the summary from rows. `now` fixes the end of the trend. */
export function summarizeRows(rows: Slim[], now: number, options: { weeks?: number; truncated?: boolean } = {}): StoredSummary {
  const weeksWanted = Math.min(Math.max(Math.trunc(options.weeks ?? DEFAULT_TREND_WEEKS), 1), MAX_TREND_WEEKS);
  const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const versions = new Map<string, { count: number; sum: number }>();
  const territories = new Map<string, number>();
  const languages = new Map<string, number>();
  const weeks = new Map<number, { count: number; sum: number }>();
  for (const row of rows) {
    const rating = Number(row.rating);
    if (!(rating >= 1 && rating <= 5)) continue;
    histogram[rating - 1] = (histogram[rating - 1] ?? 0) + 1;
    sum += rating;
    const at = Number(row.created_at);
    oldest = oldest === null || at < oldest ? at : oldest;
    newest = newest === null || at > newest ? at : newest;
    if (row.app_version) {
      const v = versions.get(row.app_version) ?? { count: 0, sum: 0 };
      v.count++;
      v.sum += rating;
      versions.set(row.app_version, v);
    }
    if (row.territory) territories.set(row.territory, (territories.get(row.territory) ?? 0) + 1);
    if (row.language) languages.set(row.language, (languages.get(row.language) ?? 0) + 1);
    const w = weeks.get(weekStart(at)) ?? { count: 0, sum: 0 };
    w.count++;
    w.sum += rating;
    weeks.set(weekStart(at), w);
  }
  const count = histogram.reduce((a, b) => a + b, 0);
  const last = weekStart(now);
  const trend: StoredSummary['weeks'] = [];
  for (let i = weeksWanted - 1; i >= 0; i--) {
    const start = last - i * WEEK_MS;
    const w = weeks.get(start);
    trend.push({ weekStart: start, count: w?.count ?? 0, average: w ? round2(w.sum / w.count) : null });
  }
  const top = <T extends { count: number }>(list: T[], key: (t: T) => string) =>
    list.sort((a, b) => b.count - a.count || key(a).localeCompare(key(b))).slice(0, 50);
  return {
    basis: 'stored_reviews',
    label:
      count === 0
        ? 'From 0 stored reviews'
        : `From ${count} stored review${count === 1 ? '' : 's'}${options.truncated ? ' (the newest ones)' : ''}, not store-wide`,
    count,
    average: count === 0 ? null : round2(sum / count),
    histogram,
    oldestAt: oldest,
    newestAt: newest,
    truncated: options.truncated ?? false,
    byVersion: top(
      [...versions].map(([version, v]) => ({ version, count: v.count, average: round2(v.sum / v.count) })),
      (v) => v.version,
    ),
    weeks: trend,
    territories: top([...territories].map(([value, count]) => ({ value, count })), (t) => t.value),
    languages: top([...languages].map(([value, count]) => ({ value, count })), (t) => t.value),
  };
}

/** The latest stored store-wide rating per territory (one row per territory, newest observation). */
export async function latestStoreWide(sql: Sql, workspaceId: string, appId: string): Promise<StoreWideRating[]> {
  const rows = await sql.query(
    `SELECT s.territory, s.average_milli, s.rating_count, s.current_average_milli, s.current_count, s.observed_at
       FROM app_rating_summaries s
      WHERE s.app_id = ? AND s.workspace_id = ?
        AND s.observed_at = (SELECT MAX(o.observed_at) FROM app_rating_summaries o
                              WHERE o.app_id = s.app_id AND o.store = s.store AND o.territory = s.territory)
      ORDER BY s.territory`,
    [appId, workspaceId],
  );
  return rows.map((r) => {
    const milli = (v: unknown) => (v === null || v === undefined ? null : Number(v) / 1000);
    const average = milli(r.average_milli);
    const count = r.rating_count === null || r.rating_count === undefined ? null : Number(r.rating_count);
    const territory = String(r.territory);
    return {
      basis: 'store_wide' as const,
      label: `Store-wide, ${territory} storefront (public iTunes lookup)${count !== null ? `, ${count} ratings` : ''}`,
      source: 'itunes_lookup' as const,
      territory,
      average,
      ratingCount: count,
      currentVersionAverage: milli(r.current_average_milli),
      currentVersionCount:
        r.current_count === null || r.current_count === undefined ? null : Number(r.current_count),
      observedAt: Number(r.observed_at),
    };
  });
}

export async function reviewsSummary(
  sql: Sql,
  workspaceId: string,
  appId: string,
  now: number,
  options: { weeks?: number } = {},
): Promise<ReviewsSummary> {
  const rows = (await sql.query(
    `SELECT rating, created_at, app_version, territory, language FROM app_reviews
      WHERE workspace_id = ? AND app_id = ? ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, appId, MAX_SUMMARY_ROWS + 1],
  )) as Slim[];
  const truncated = rows.length > MAX_SUMMARY_ROWS;
  const stored = summarizeRows(truncated ? rows.slice(0, MAX_SUMMARY_ROWS) : rows, now, {
    ...(options.weeks !== undefined ? { weeks: options.weeks } : {}),
    truncated,
  });
  const byStatus = emptyStatusCounts();
  const counted = await sql.query(
    'SELECT status, COUNT(*) AS n FROM app_reviews WHERE workspace_id = ? AND app_id = ? GROUP BY status',
    [workspaceId, appId],
  );
  for (const row of counted) {
    const status = String(row.status) as ReviewStatus;
    if (status in byStatus) byStatus[status] = Number(row.n);
  }
  return { stored, storeWide: await latestStoreWide(sql, workspaceId, appId), byStatus };
}
