import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@kiln/db';
import { recordAudit } from '../../services/audit.ts';

/**
 * Reviews of followed competitors (docs/adr/0055-review-summary-and-competitor-reviews.md, docs/api/competitor-reviews.md).
 *
 * Apple only: the App Store's public customer-reviews feed (a read of public data, like the rating read of a followed competitor).
 * Google Play has no official way to read the reviews of an app you do not own, and Kiln does not scrape its pages, so a Play
 * competitor has no reviews here. What is stored is only what the feed gives about a review: its id, stars, title, text, the app
 * version and the day. NEVER the author (the name is not even kept). Text is cut (title 200, text 1,000 characters), kept at most 90 days
 * and at most 200 reviews per competitor; a competitor that is unfollowed takes its reviews with it. Nothing here is sent to a model.
 */

export const COMPETITOR_REVIEW_RETENTION_DAYS = 90;
export const COMPETITOR_REVIEWS_MAX = 200;
/** A competitor is read again at the earliest after this long (the feed changes slowly; this also keeps Apple's load low). */
export const COMPETITOR_REVIEWS_MIN_INTERVAL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const TITLE_CHARS = 200;
const BODY_CHARS = 1_000;

export type FeedReview = {
  /** The id the feed gives the review (not an account id). */
  id: string;
  rating: number;
  title: string;
  body: string;
  version: string | null;
  /** Epoch milliseconds of the review's own date. */
  at: number;
};

const label = (v: unknown): string => {
  const x = (v as { label?: unknown } | undefined)?.label;
  return typeof x === 'string' ? x : '';
};
const clipText = (text: string, max: number): string =>
  Array.from(text.trim()).slice(0, max).join('');

/** The entries of an Apple customer-reviews feed (JSON). An entry without a star rating (the app's own entry) is skipped. The author is ignored. */
export function parseAppleReviewFeed(json: unknown): FeedReview[] {
  const feed = (json as { feed?: { entry?: unknown } } | null)?.feed;
  const raw = feed?.entry;
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: FeedReview[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const rating = Number(label(entry['im:rating']));
    const id = label(entry.id).trim();
    const at = Date.parse(label(entry.updated));
    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      id === '' ||
      id.length > 120 ||
      !Number.isFinite(at)
    )
      continue;
    const version = label(entry['im:version']).trim();
    out.push({
      id,
      rating,
      title: clipText(label(entry.title), TITLE_CHARS),
      body: clipText(label(entry.content), BODY_CHARS),
      version: version === '' ? null : version.slice(0, 40),
      at,
    });
  }
  return out;
}

export type StoredCompetitorForReviews = {
  id: string;
  appId: string;
  store: string;
  externalId: string;
  country: string;
};

export type RefreshOutcome =
  | {
      ok: true;
      state: 'read' | 'recent' | 'unchanged';
      fetched: number;
      stored: number;
      checkedAt: number;
      newCount: number;
    }
  | { ok: false; reason: 'play_not_available' };

export type RefreshOptions = {
  /** A scheduled read: when the newest review is the one seen last time nothing is written, and only `maxReviews` of the feed are kept. */
  scheduled?: boolean;
  /** The newest reviews of the feed that are looked at and stored (the volume guard of a scheduled read). */
  maxReviews?: number;
};

export type ReviewReader = (input: { id: string; country: string }) => Promise<FeedReview[]>;

/** Reads the feed of one Apple competitor (unless it was read in the last 15 minutes), stores what is new or edited, and prunes. */
export async function refreshCompetitorReviews(
  ctx: { db: Database; now: () => number; read: ReviewReader },
  input: {
    workspaceId: string;
    competitor: StoredCompetitorForReviews;
    actorId: string;
    options?: RefreshOptions;
  },
): Promise<RefreshOutcome> {
  const { competitor } = input;
  const options = input.options ?? {};
  if (competitor.store !== 'app_store') return { ok: false, reason: 'play_not_available' };
  const now = ctx.now();
  const [row] = await ctx.db.query(
    'SELECT reviews_checked_at AS at, reviews_last_seen_id AS seen FROM aso_competitors WHERE id = ?',
    [competitor.id],
  );
  const last = row?.at === null || row?.at === undefined ? null : Number(row.at);
  if (last !== null && now - last < COMPETITOR_REVIEWS_MIN_INTERVAL_MS)
    return { ok: true, state: 'recent', fetched: 0, stored: 0, checkedAt: last, newCount: 0 };
  const read = await ctx.read({ id: competitor.externalId, country: competitor.country });
  // Newest first, then the volume guard: a scheduled read looks at the newest N only.
  const sorted = read.slice().sort((a, b) => b.at - a.at);
  const feed =
    options.maxReviews === undefined ? sorted : sorted.slice(0, Math.max(1, options.maxReviews));
  const cutoff = now - COMPETITOR_REVIEW_RETENTION_DAYS * DAY_MS;
  const newestId = feed[0]?.id ?? null;
  // The cursor: the newest review of the last read. A scheduled read that finds the same one has nothing new; it writes nothing but the time.
  if (options.scheduled && newestId !== null && row?.seen === newestId) {
    await ctx.db.execute(
      'UPDATE aso_competitors SET reviews_checked_at = ?, reviews_new_count = 0 WHERE id = ?',
      [now, competitor.id],
    );
    return {
      ok: true,
      state: 'unchanged',
      fetched: feed.length,
      stored: 0,
      checkedAt: now,
      newCount: 0,
    };
  }
  let stored = 0;
  let newCount = 0;
  await ctx.db.transaction(async (tx) => {
    const known = new Set(
      (
        await tx.query(
          'SELECT store_review_id AS id FROM aso_competitor_reviews WHERE competitor_id = ?',
          [competitor.id],
        )
      ).map((r) => String(r.id)),
    );
    for (const r of feed) {
      if (r.at < cutoff) continue;
      if (!known.has(r.id)) newCount += 1;
      await tx.execute(
        `INSERT INTO aso_competitor_reviews (id, workspace_id, competitor_id, app_id, country, store_review_id, rating, title, body, app_version, reviewed_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (competitor_id, store_review_id) DO UPDATE SET rating = excluded.rating, title = excluded.title, body = excluded.body, app_version = excluded.app_version, reviewed_at = excluded.reviewed_at, fetched_at = excluded.fetched_at`,
        [
          randomUUID(),
          input.workspaceId,
          competitor.id,
          competitor.appId,
          competitor.country,
          r.id,
          r.rating,
          r.title,
          r.body,
          r.version,
          r.at,
          now,
        ],
      );
      stored += 1;
    }
    await tx.execute(
      'DELETE FROM aso_competitor_reviews WHERE competitor_id = ? AND reviewed_at < ?',
      [competitor.id, cutoff],
    );
    await tx.execute(
      `DELETE FROM aso_competitor_reviews WHERE competitor_id = ? AND id NOT IN (
         SELECT id FROM aso_competitor_reviews WHERE competitor_id = ? ORDER BY reviewed_at DESC, id DESC LIMIT ${COMPETITOR_REVIEWS_MAX})`,
      [competitor.id, competitor.id],
    );
    await tx.execute(
      'UPDATE aso_competitors SET reviews_checked_at = ?, reviews_last_seen_id = COALESCE(?, reviews_last_seen_id), reviews_new_count = ? WHERE id = ?',
      [now, newestId, newCount, competitor.id],
    );
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor: options.scheduled
        ? { type: 'system', id: input.actorId }
        : { type: 'user', id: input.actorId },
      action: 'aso.competitor_reviews_read',
      target: { type: 'aso_competitor', id: competitor.id },
      // Ids and counts. Never review text.
      detail: {
        competitorId: competitor.id,
        appId: competitor.appId,
        country: competitor.country,
        fetched: feed.length,
        stored,
        newCount,
        ...(options.scheduled ? { scheduled: true } : {}),
      },
      at: now,
    });
  });
  return { ok: true, state: 'read', fetched: feed.length, stored, checkedAt: now, newCount };
}

export type CompetitorReviewStats = {
  competitorId: string;
  name: string;
  store: string;
  country: string;
  /** `ok`, or `unavailable` with a reason for a store whose reviews cannot be read. */
  state: 'ok' | 'unavailable';
  reason?: 'play_has_no_review_api';
  checkedAt: number | null;
  count: number;
  average: number | null;
  /** Mean of the first and of the second half of the period (null without reviews in a half). */
  trend: { earlier: number | null; recent: number | null };
  stars: [number, number, number, number, number];
  latest: {
    id: string;
    rating: number;
    title: string;
    text: string;
    version: string | null;
    at: number;
  }[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function competitorReviewStats(
  db: Sql,
  input: { workspaceId: string; appId: string; days: number; now: number; latest?: number },
): Promise<{ days: number; competitors: CompetitorReviewStats[] }> {
  const from = input.now - input.days * DAY_MS;
  const mid = Math.floor((from + input.now) / 2);
  const competitors = await db.query(
    'SELECT id, name, store, country, reviews_checked_at AS checked FROM aso_competitors WHERE workspace_id = ? AND app_id = ? ORDER BY added_at, id',
    [input.workspaceId, input.appId],
  );
  const out: CompetitorReviewStats[] = [];
  for (const c of competitors) {
    const base = {
      competitorId: String(c.id),
      name: String(c.name),
      store: String(c.store),
      country: String(c.country),
      checkedAt: c.checked === null || c.checked === undefined ? null : Number(c.checked),
    };
    if (base.store !== 'app_store') {
      out.push({
        ...base,
        state: 'unavailable',
        reason: 'play_has_no_review_api',
        count: 0,
        average: null,
        trend: { earlier: null, recent: null },
        stars: [0, 0, 0, 0, 0],
        latest: [],
      });
      continue;
    }
    const rows = await db.query(
      'SELECT rating, COUNT(*) AS n, SUM(CASE WHEN reviewed_at < ? THEN 1 ELSE 0 END) AS e, SUM(CASE WHEN reviewed_at < ? THEN rating ELSE 0 END) AS es FROM aso_competitor_reviews WHERE competitor_id = ? AND reviewed_at >= ? GROUP BY rating',
      [mid, mid, String(c.id), from],
    );
    const stars: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let count = 0;
    let sum = 0;
    let earlyN = 0;
    let earlySum = 0;
    for (const r of rows) {
      const star = Number(r.rating);
      const n = Number(r.n);
      if (star < 1 || star > 5) continue;
      stars[star - 1] = n;
      count += n;
      sum += n * star;
      earlyN += Number(r.e);
      earlySum += Number(r.es);
    }
    const recentN = count - earlyN;
    const latest = await db.query(
      'SELECT id, rating, title, body, app_version, reviewed_at FROM aso_competitor_reviews WHERE competitor_id = ? AND reviewed_at >= ? ORDER BY reviewed_at DESC, id DESC LIMIT ?',
      [String(c.id), from, input.latest ?? 5],
    );
    out.push({
      ...base,
      state: 'ok',
      count,
      average: count > 0 ? round2(sum / count) : null,
      trend: {
        earlier: earlyN > 0 ? round2(earlySum / earlyN) : null,
        recent: recentN > 0 ? round2((sum - earlySum) / recentN) : null,
      },
      stars,
      latest: latest.map((r) => ({
        id: String(r.id),
        rating: Number(r.rating),
        title: String(r.title),
        text: clipText(String(r.body), 300),
        version: r.app_version === null ? null : String(r.app_version),
        at: Number(r.reviewed_at),
      })),
    });
  }
  return { days: input.days, competitors: out };
}

/** Our own app over the same period, from the stored reviews: to set beside the competitors. */
export async function ownReviewStats(
  db: Sql,
  input: { workspaceId: string; appId: string; days: number; now: number },
): Promise<{
  count: number;
  average: number | null;
  trend: { earlier: number | null; recent: number | null };
}> {
  const from = input.now - input.days * DAY_MS;
  const mid = Math.floor((from + input.now) / 2);
  const q = async (a: number, b: number) => {
    const [row] = await db.query(
      'SELECT COUNT(*) AS n, AVG(rating) AS avg FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND created_at >= ? AND created_at < ?',
      [input.workspaceId, input.appId, a, b],
    );
    const n = Number(row?.n ?? 0);
    return {
      n,
      avg: n > 0 && row?.avg !== null && row?.avg !== undefined ? Number(row.avg) : null,
    };
  };
  const early = await q(from, mid);
  const late = await q(mid, input.now + 1);
  const n = early.n + late.n;
  const total = (early.avg ?? 0) * early.n + (late.avg ?? 0) * late.n;
  return {
    count: n,
    average: n > 0 ? round2(total / n) : null,
    trend: {
      earlier: early.avg === null ? null : round2(early.avg),
      recent: late.avg === null ? null : round2(late.avg),
    },
  };
}
