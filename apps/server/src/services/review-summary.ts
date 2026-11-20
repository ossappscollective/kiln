import { PLATFORMS, type Platform, type StoreId, storeOf } from '@mrm/core';
import { oneOf, type Sql } from '@mrm/db';
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
export const weekStart = (at: number): number =>
  Math.floor((at - FIRST_MONDAY) / WEEK_MS) * WEEK_MS + FIRST_MONDAY;

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

/** Reviews with no developer response (and not ignored), at or below a rating. */
export type UnansweredSummary = {
  count: number;
  /** When the oldest of them was written; null when there is none. */
  oldestAt: number | null;
  /** The highest rating counted (5: every rating). */
  maxRating: number;
};

export const DEFAULT_UNANSWERED_MAX_RATING = 5;

export type ReviewsSummary = {
  stored: StoredSummary;
  unanswered: UnansweredSummary;
  storeWide: StoreWideRating[];
  /** Reviews by triage status, over everything stored. */
  byStatus: Record<ReviewStatus, number>;
};

export function emptyStatusCounts(): Record<ReviewStatus, number> {
  return Object.fromEntries(reviewStatuses.map((s) => [s, 0])) as Record<ReviewStatus, number>;
}

type Slim = {
  rating: number;
  created_at: number;
  app_version: string | null;
  territory: string | null;
  language: string | null;
};

/** Pure: the stored part of the summary from rows. `now` fixes the end of the trend. */
export function summarizeRows(
  rows: Slim[],
  now: number,
  options: { weeks?: number; truncated?: boolean } = {},
): StoredSummary {
  const weeksWanted = Math.min(
    Math.max(Math.trunc(options.weeks ?? DEFAULT_TREND_WEEKS), 1),
    MAX_TREND_WEEKS,
  );
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
    trend.push({
      weekStart: start,
      count: w?.count ?? 0,
      average: w ? round2(w.sum / w.count) : null,
    });
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
      [...versions].map(([version, v]) => ({
        version,
        count: v.count,
        average: round2(v.sum / v.count),
      })),
      (v) => v.version,
    ),
    weeks: trend,
    territories: top(
      [...territories].map(([value, count]) => ({ value, count })),
      (t) => t.value,
    ),
    languages: top(
      [...languages].map(([value, count]) => ({ value, count })),
      (t) => t.value,
    ),
  };
}

/** The latest stored store-wide rating per territory (one row per territory, newest observation). */
export async function latestStoreWide(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<StoreWideRating[]> {
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
    const count =
      r.rating_count === null || r.rating_count === undefined ? null : Number(r.rating_count);
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

/**
 * The reviews nobody answered, per app: no developer response, not ignored, rating at or below `maxRating`, and written at or
 * before `olderThan` (epoch ms) when given. Counts and times only: never a review text. `appIds` limits the apps.
 */
export async function unansweredByApp(
  sql: Sql,
  workspaceId: string,
  options: { maxRating?: number; olderThan?: number; appIds?: readonly string[] } = {},
): Promise<Map<string, { count: number; oldestAt: number | null }>> {
  const maxRating = options.maxRating ?? DEFAULT_UNANSWERED_MAX_RATING;
  const params: (string | number)[] = [workspaceId, maxRating];
  let where =
    "workspace_id = ? AND developer_response IS NULL AND status <> 'ignored' AND rating <= ?";
  if (options.olderThan !== undefined) {
    where += ' AND created_at <= ?';
    params.push(options.olderThan);
  }
  if (options.appIds !== undefined) {
    if (options.appIds.length === 0) return new Map();
    where += ` AND app_id IN (${options.appIds.map(() => '?').join(', ')})`;
    params.push(...options.appIds);
  }
  const rows = await sql.query(
    `SELECT app_id, COUNT(*) AS n, MIN(created_at) AS oldest FROM app_reviews WHERE ${where} GROUP BY app_id`,
    params,
  );
  return new Map(
    rows.map((r) => [
      String(r.app_id),
      {
        count: Number(r.n),
        oldestAt: r.oldest === null || r.oldest === undefined ? null : Number(r.oldest),
      },
    ]),
  );
}

export async function reviewsSummary(
  sql: Sql,
  workspaceId: string,
  appId: string,
  now: number,
  options: { weeks?: number; maxRating?: number } = {},
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
  const maxRating = options.maxRating ?? DEFAULT_UNANSWERED_MAX_RATING;
  const open = (await unansweredByApp(sql, workspaceId, { maxRating, appIds: [appId] })).get(appId);
  return {
    stored,
    unanswered: { count: open?.count ?? 0, oldestAt: open?.oldestAt ?? null, maxRating },
    storeWide: await latestStoreWide(sql, workspaceId, appId),
    byStatus,
  };
}

// ---------------------------------------------------------------------------------------------
// Workspace-wide (the reviews inbox of every app)

export type WorkspaceAppCounts = {
  app: { id: string; name: string; platform: Platform; store: StoreId };
  total: number;
  /** Triage status `new`. */
  new: number;
  /** No developer response, and not ignored (and at or below `unansweredMaxRating`). */
  unanswered: number;
  /** When the oldest unanswered review was written. */
  unansweredOldestAt: number | null;
  /** Rating at or below the threshold, and not ignored. */
  lowRating: number;
  /** Mean of the stored ratings, two decimals; null with no review. */
  average: number | null;
  oldestAt: number | null;
  newestAt: number | null;
};

export type WorkspaceReviewsSummary = {
  basis: 'stored_reviews';
  /** Where every number comes from: only the reviews this server holds, never store-wide. */
  label: string;
  lowRatingThreshold: number;
  apps: WorkspaceAppCounts[];
  /** The highest rating `unanswered` counts: the `maxRating` of the request (default 5, every rating). */
  unansweredMaxRating: number;
  totals: {
    total: number;
    new: number;
    unanswered: number;
    unansweredOldestAt: number | null;
    lowRating: number;
    average: number | null;
  };
};

/**
 * Counts per app and in total over the stored reviews, in one grouped query. No review text and no
 * names of reviewers. `appIds` limits the apps (an API token limited to some apps); an empty list
 * matches nothing.
 */
export async function workspaceReviewsSummary(
  sql: Sql,
  workspaceId: string,
  options: { appIds?: readonly string[]; lowRatingThreshold: number; maxRating?: number },
): Promise<WorkspaceReviewsSummary> {
  const limited = options.appIds !== undefined;
  const ids = [...(options.appIds ?? [])];
  const maxRating = options.maxRating ?? DEFAULT_UNANSWERED_MAX_RATING;
  const emptySummary = (): WorkspaceReviewsSummary => ({
    basis: 'stored_reviews',
    label: 'From 0 stored reviews, not store-wide',
    lowRatingThreshold: options.lowRatingThreshold,
    apps: [],
    unansweredMaxRating: maxRating,
    totals: {
      total: 0,
      new: 0,
      unanswered: 0,
      unansweredOldestAt: null,
      lowRating: 0,
      average: null,
    },
  });
  if (limited && ids.length === 0) return emptySummary();
  const scope = limited ? ` AND id IN (${ids.map(() => '?').join(', ')})` : '';
  const apps = await sql.query(
    `SELECT id, name, platform FROM apps WHERE workspace_id = ?${scope} ORDER BY name, id`,
    [workspaceId, ...ids],
  );
  const reviewScope = limited ? ` AND app_id IN (${ids.map(() => '?').join(', ')})` : '';
  const rows = await sql.query(
    `SELECT app_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
            SUM(CASE WHEN developer_response IS NULL AND status <> 'ignored' AND rating <= ? THEN 1 ELSE 0 END) AS unanswered,
            MIN(CASE WHEN developer_response IS NULL AND status <> 'ignored' AND rating <= ? THEN created_at END) AS unanswered_oldest,
            SUM(CASE WHEN rating <= ? AND status <> 'ignored' THEN 1 ELSE 0 END) AS low_rating,
            SUM(rating) AS rating_sum, MIN(created_at) AS oldest, MAX(created_at) AS newest
       FROM app_reviews WHERE workspace_id = ?${reviewScope} GROUP BY app_id`,
    [maxRating, maxRating, options.lowRatingThreshold, workspaceId, ...ids],
  );
  const byApp = new Map(rows.map((r) => [String(r.app_id), r]));
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const out: WorkspaceAppCounts[] = [];
  const totals = {
    total: 0,
    new: 0,
    unanswered: 0,
    unansweredOldestAt: null as number | null,
    lowRating: 0,
    average: null as number | null,
  };
  let sum = 0;
  for (const a of apps) {
    const r = byApp.get(String(a.id));
    const total = n(r?.total);
    const platform = oneOf(a.platform, PLATFORMS, 'platform');
    out.push({
      app: {
        id: String(a.id),
        name: String(a.name),
        platform,
        store: storeOf(platform),
      },
      total,
      new: n(r?.new_count),
      unanswered: n(r?.unanswered),
      unansweredOldestAt:
        r?.unanswered_oldest === null || r?.unanswered_oldest === undefined
          ? null
          : Number(r.unanswered_oldest),
      lowRating: n(r?.low_rating),
      average: total > 0 ? round2(n(r?.rating_sum) / total) : null,
      oldestAt: r?.oldest === null || r?.oldest === undefined ? null : Number(r.oldest),
      newestAt: r?.newest === null || r?.newest === undefined ? null : Number(r.newest),
    });
    totals.total += total;
    totals.new += n(r?.new_count);
    totals.unanswered += n(r?.unanswered);
    if (r?.unanswered_oldest !== null && r?.unanswered_oldest !== undefined) {
      totals.unansweredOldestAt = Math.min(
        totals.unansweredOldestAt ?? Number.POSITIVE_INFINITY,
        Number(r.unanswered_oldest),
      );
    }
    totals.lowRating += n(r?.low_rating);
    sum += n(r?.rating_sum);
  }
  totals.average = totals.total > 0 ? round2(sum / totals.total) : null;
  return {
    basis: 'stored_reviews',
    label: `From ${totals.total} stored review${totals.total === 1 ? '' : 's'} across ${out.length} app${out.length === 1 ? '' : 's'}, not store-wide`,
    lowRatingThreshold: options.lowRatingThreshold,
    apps: out,
    unansweredMaxRating: maxRating,
    totals,
  };
}
