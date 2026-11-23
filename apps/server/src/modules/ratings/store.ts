import type { Param, Sql } from '@kiln/db';
import type { Reading, Stars } from './history.ts';

/** Storage of the ratings history (migration 56). Only numbers, codes and dates: never review text. */
export type RatingRow = { territory: string; average: number; count: number | null; stars?: Stars | null; version?: string | null };

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Writes one day's readings; the newest read of a day replaces the earlier one. Stars are all set or all null. */
export async function writeRatingDay(sql: Sql, w: { workspaceId: string; appId: string; store: string; day: string; at: number; rows: RatingRow[] }): Promise<void> {
  for (const r of w.rows) {
    const s = r.stars ?? null;
    const params: Param[] = [w.workspaceId, w.appId, w.store, r.territory, w.day, Math.round(r.average * 1000), r.count, s?.[0] ?? null, s?.[1] ?? null, s?.[2] ?? null, s?.[3] ?? null, s?.[4] ?? null, r.version ?? null, w.at];
    await sql.execute(
      `INSERT INTO app_rating_days (workspace_id, app_id, store, territory, day, average_milli, rating_count, star1, star2, star3, star4, star5, version, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, store, territory, day) DO UPDATE SET average_milli = excluded.average_milli, rating_count = excluded.rating_count,
         star1 = excluded.star1, star2 = excluded.star2, star3 = excluded.star3, star4 = excluded.star4, star5 = excluded.star5,
         version = excluded.version, observed_at = excluded.observed_at`,
      params,
    );
  }
}

export async function readRatingDays(sql: Sql, workspaceId: string, appId: string, store: string, from?: string): Promise<Reading[]> {
  const rows = await sql.query(
    `SELECT territory, day, average_milli, rating_count, star1, star2, star3, star4, star5, version FROM app_rating_days
      WHERE workspace_id = ? AND app_id = ? AND store = ?${from ? ' AND day >= ?' : ''} ORDER BY day`,
    from ? [workspaceId, appId, store, from] : [workspaceId, appId, store],
  );
  return rows.map((r) => ({
    day: String(r.day),
    territory: String(r.territory),
    average: Number(r.average_milli) / 1000,
    count: n(r.rating_count),
    stars: r.star1 === null || r.star1 === undefined ? null : ([Number(r.star1), Number(r.star2), Number(r.star3), Number(r.star4), Number(r.star5)] as Stars),
    version: r.version === null || r.version === undefined ? null : String(r.version),
  }));
}

/** The countries read before (most ratings first), for choosing what to read next. */
export async function readCountryDays(sql: Sql, appId: string, store: string): Promise<{ territory: string; last: string }[]> {
  const rows = await sql.query('SELECT territory, MAX(day) AS last FROM app_rating_days WHERE app_id = ? AND store = ? GROUP BY territory', [appId, store]);
  return rows.map((r) => ({ territory: String(r.territory), last: String(r.last) }));
}

/** Written reviews of an app in a window: rating, country, version, build and day, plus the text only to match crash words in memory. */
export type ReviewLite = { day: string; rating: number; territory: string | null; version: string | null; build: string | null; title: string | null; body: string; createdAt: number };
export async function readReviewsLite(sql: Sql, workspaceId: string, appId: string, sinceMs: number, limit = 20_000): Promise<ReviewLite[]> {
  const rows = await sql.query(
    `SELECT rating, territory, app_version, build_number, title, body, created_at FROM app_reviews
      WHERE workspace_id = ? AND app_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, appId, sinceMs, limit],
  );
  return rows.map((r) => ({
    day: new Date(Number(r.created_at)).toISOString().slice(0, 10),
    rating: Number(r.rating),
    territory: r.territory === null || r.territory === undefined ? null : String(r.territory),
    version: r.app_version === null || r.app_version === undefined ? null : String(r.app_version),
    build: r.build_number === null || r.build_number === undefined ? null : String(r.build_number),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    body: String(r.body),
    createdAt: Number(r.created_at),
  }));
}

/** Review countries (App Store Connect's three letters), most reviews first. */
export async function reviewTerritories(sql: Sql, workspaceId: string, appId: string, limit = 12): Promise<string[]> {
  const rows = await sql.query(
    `SELECT territory, COUNT(*) AS c FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND territory IS NOT NULL GROUP BY territory ORDER BY c DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  return rows.map((r) => String(r.territory));
}
