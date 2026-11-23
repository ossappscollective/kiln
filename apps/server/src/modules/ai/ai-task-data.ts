import type { Sql } from '@kiln/db';
import type { Review } from '../reviews/service.ts';
import { listReviews, type ReviewFilter } from '../reviews/service.ts';
import { clip } from './ai-task-types.ts';

/**
 * Review data for AI tasks, minimised (docs/adr/0024-ai-features.md). What leaves the server about a review is only: a short alias
 * (`r1`, `r2`, ... so a small model can cite an evidence id without copying a long one), the star rating, a clipped title and text with
 * personal details removed, the language, the app version and the day. NEVER the author's name, the device, the country, the store
 * review id, the internal note or who is assigned.
 *
 * The text of a review is written by a stranger. It is untrusted data: a task's system prompt says so, it is only ever a JSON string
 * value, and the model has no tool to act on anything it says.
 */

const DAY_MS = 86_400_000;
export const MAX_PERIOD_DAYS = 180;
export const DEFAULT_PERIOD_DAYS = 30;

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const PHONE = /(?:\+|\b)\d[\d\s().-]{6,}\d/g;

/** Email addresses, links, phone-like numbers and the reviewer's own name, replaced by a marker. A heuristic: it cannot find every name. */
export function redactPersonal(text: string, authorName: string | null): string {
  let out = text.replace(EMAIL, '[email]').replace(LINK, '[link]').replace(PHONE, '[number]');
  const name = (authorName ?? '').trim();
  if (Array.from(name).length >= 3) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '[name]');
  }
  return out;
}

export type AiReview = {
  /** The id of the review in this tool (what an evidence list is checked against). */
  id: string;
  /** The alias the model sees. */
  ref: string;
  rating: number;
  title: string;
  text: string;
  language: string | null;
  version: string | null;
  day: string;
  createdAt: number;
  hasReply: boolean;
};

export type ReviewWindow = { days: number; from: number; to: number };

export type LoadedReviews = {
  window: ReviewWindow;
  /** Reviews in the period, whatever was sent. */
  inPeriod: number;
  reviews: AiReview[];
  /** With a `lowest` quota: how many reviews are the newest and how many were added as low-rated. */
  sampled?: { newest: number; lowest: number };
};

export const periodDays = (scope: unknown): number => {
  const n = typeof scope === 'number' ? scope : Number(scope);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PERIOD_DAYS) : DEFAULT_PERIOD_DAYS;
};

export const toAiReview = (
  r: Review,
  ref: string,
  titleChars: number,
  textChars: number,
): AiReview => ({
  id: r.id,
  ref,
  rating: r.rating,
  title: clip(redactPersonal(r.title ?? '', r.authorName), titleChars),
  text: clip(redactPersonal(r.body, r.authorName), textChars),
  language: r.language,
  version: r.appVersion,
  day: new Date(r.createdAt).toISOString().slice(0, 10),
  createdAt: r.createdAt,
  hasReply: r.developerResponse !== null,
});

/**
 * The newest reviews of an app in a period that have some text, up to `limit`, with their aliases. `ratings` narrows by stars.
 * A review with neither title nor text is skipped (a rating alone says nothing a model can use).
 */
export async function loadReviewsForAi(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    now: number;
    days: number;
    limit: number;
    titleChars: number;
    textChars: number;
    ratings?: number[];
    skipIds?: Set<string>;
    /** Only reviews written in this language (the stored language code, such as `fr`). */
    language?: string;
    /** How many of `limit` are the most recent LOW-rated reviews (1 and 2 stars) instead of the newest of all: a sample that shows the complaints too. */
    lowest?: number;
  },
): Promise<LoadedReviews> {
  const to = input.now;
  const from = to - input.days * DAY_MS;
  const filter: ReviewFilter = {
    since: from,
    ...(input.ratings ? { ratings: input.ratings } : {}),
    ...(input.language ? { language: input.language } : {}),
  };
  const [count] = await sql.query(
    `SELECT COUNT(*) AS n FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND created_at >= ?${input.ratings ? ` AND rating IN (${input.ratings.map(() => '?').join(', ')})` : ''}${input.language ? ' AND language = ?' : ''}`,
    [input.workspaceId, input.appId, from, ...(input.ratings ?? []), ...(input.language ? [input.language] : [])],
  );
  const reviews: AiReview[] = [];
  const taken = new Set<string>();
  // Newest first; read pages until enough reviews with text were found (bounded: at most 5 pages of 100).
  const fill = async (f: ReviewFilter, target: number): Promise<number> => {
    let cursor: string | undefined;
    let added = 0;
    for (let page = 0; page < 5 && reviews.length < target; page += 1) {
      const out = await listReviews(sql, input.workspaceId, input.appId, f, {
        sort: 'newest',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if ('error' in out) break;
      for (const r of out.reviews) {
        if (reviews.length >= target) break;
        if (input.skipIds?.has(r.id) || taken.has(r.id)) continue;
        if ((r.title ?? '').trim() === '' && r.body.trim() === '') continue;
        taken.add(r.id);
        reviews.push(toAiReview(r, `r${reviews.length + 1}`, input.titleChars, input.textChars));
        added += 1;
      }
      if (out.nextCursor === null) break;
      cursor = out.nextCursor;
    }
    return added;
  };
  const lowest = input.ratings ? 0 : Math.max(0, Math.min(input.lowest ?? 0, input.limit - 1));
  const newest = await fill(filter, input.limit - lowest);
  let low = 0;
  if (lowest > 0) low = await fill({ ...filter, ratings: [1, 2] }, input.limit);
  return {
    window: { days: input.days, from, to },
    inPeriod: Number(count?.n ?? 0),
    reviews,
    sampled: { newest, lowest: low },
  };
}

/**
 * Counted by the server over ALL reviews of the period (with or without text), not over the sample: the stars (1 to 5), and the mean
 * rating of the first and of the second half of the period.
 */
export async function periodRatingStats(
  sql: Sql,
  input: { workspaceId: string; appId: string; from: number; to: number; language?: string },
): Promise<{
  stars: [number, number, number, number, number];
  earlier: { count: number; average: number | null };
  recent: { count: number; average: number | null };
}> {
  const lang = input.language ? ' AND language = ?' : '';
  const base = [input.workspaceId, input.appId];
  const extra = input.language ? [input.language] : [];
  const rows = await sql.query(
    `SELECT rating, COUNT(*) AS n FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND created_at >= ? AND created_at <= ?${lang} GROUP BY rating`,
    [...base, input.from, input.to, ...extra],
  );
  const stars: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const r of rows) {
    const star = Number(r.rating);
    if (star >= 1 && star <= 5) stars[star - 1] = Number(r.n);
  }
  const mid = Math.floor((input.from + input.to) / 2);
  const half = async (a: number, b: number) => {
    const [row] = await sql.query(
      `SELECT COUNT(*) AS n, AVG(rating) AS avg FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND created_at >= ? AND created_at < ?${lang}`,
      [...base, a, b, ...extra],
    );
    const n = Number(row?.n ?? 0);
    return { count: n, average: n > 0 && row?.avg !== null ? Math.round(Number(row?.avg) * 100) / 100 : null };
  };
  return { stars, earlier: await half(input.from, mid), recent: await half(mid, input.to + 1) };
}

/** The share of ids a model cited that were really in the data: returns the valid ones (distinct, in order) and how many were not. */
export function checkRefs(
  cited: unknown,
  byRef: Map<string, AiReview>,
): { valid: AiReview[]; dropped: number } {
  const valid: AiReview[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const list = Array.isArray(cited)
    ? cited
    : typeof cited === 'string'
      ? cited.split(/[\s,;]+/)
      : [];
  for (const raw of list) {
    const key = String(raw)
      .trim()
      .toLowerCase()
      .replace(/^review[ _-]?/, 'r')
      .replace(/^#/, 'r');
    if (key === '') continue;
    const normalized = /^\d+$/.test(key) ? `r${key}` : key;
    const found = byRef.get(normalized);
    if (!found) {
      dropped += 1;
      continue;
    }
    if (seen.has(found.id)) continue;
    seen.add(found.id);
    valid.push(found);
  }
  return { valid, dropped };
}

export const refMap = (reviews: AiReview[]): Map<string, AiReview> =>
  new Map(reviews.map((r) => [r.ref, r]));

export const round1 = (n: number): number => Math.round(n * 10) / 10;
