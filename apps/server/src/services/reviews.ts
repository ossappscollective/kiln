import type { Platform } from '@mrm/core';
import type { Param, Row, Sql } from '@mrm/db';

/**
 * The review inbox as data: rows of `app_reviews`, listing with filters, sorting and a cursor,
 * the internal triage fields, deleting and pruning. Read only toward the stores: nothing here
 * talks to one. Review text and display names are untrusted third-party text: they are returned
 * as plain strings and never interpreted. This file imports nothing from the sync code, so
 * `apps.ts` can call `deleteReviewData` without a cycle.
 */

export const reviewStatuses = ['new', 'triaged', 'replied_in_console', 'ignored'] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];
export const isReviewStatus = (value: unknown): value is ReviewStatus =>
  typeof value === 'string' && (reviewStatuses as readonly string[]).includes(value);

export const reviewSorts = ['newest', 'rating', 'updated'] as const;
export type ReviewSort = (typeof reviewSorts)[number];

export type StoreKey = 'appstoreconnect' | 'googleplay';

export type ReviewResponse = { body: string; at: number | null; state: string | null };

export type Review = {
  id: string;
  appId: string;
  store: StoreKey;
  platform: Platform;
  storeReviewId: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string | null;
  territory: string | null;
  language: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  device: string | null;
  createdAt: number;
  updatedAt: number;
  firstSeenAt: number;
  fetchedAt: number;
  developerResponse: ReviewResponse | null;
  status: ReviewStatus;
  assigneeUserId: string | null;
  internalNote: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
};

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function parseResponse(raw: unknown): ReviewResponse | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.body !== 'string') return null;
    return {
      body: v.body,
      at: typeof v.at === 'number' ? v.at : null,
      state: typeof v.state === 'string' ? v.state : null,
    };
  } catch {
    return null;
  }
}

export const toReview = (r: Row): Review => ({
  id: String(r.id),
  appId: String(r.app_id),
  store: String(r.store) as StoreKey,
  platform: String(r.store) === 'googleplay' ? 'android' : 'ios',
  storeReviewId: String(r.store_review_id),
  rating: Number(r.rating),
  title: str(r.title),
  body: String(r.body),
  authorName: str(r.author_name),
  territory: str(r.territory),
  language: str(r.language),
  appVersion: str(r.app_version),
  buildNumber: str(r.build_number),
  device: str(r.device),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  firstSeenAt: Number(r.first_seen_at),
  fetchedAt: Number(r.fetched_at),
  developerResponse: parseResponse(r.developer_response),
  status: (isReviewStatus(r.status) ? r.status : 'new') as ReviewStatus,
  assigneeUserId: str(r.assignee_user_id),
  internalNote: str(r.internal_note),
  statusChangedAt: numOrNull(r.status_changed_at),
  statusChangedBy: str(r.status_changed_by),
});

export const REVIEW_COLUMNS = `id, app_id, store, store_review_id, rating, title, body, author_name,
  territory, language, app_version, build_number, device, created_at, updated_at, first_seen_at,
  fetched_at, developer_response, status, assignee_user_id, internal_note, status_changed_at,
  status_changed_by`;

// ---------------------------------------------------------------------------------------------
// Listing

export const DEFAULT_REVIEWS_PAGE = 25;
export const MAX_REVIEWS_PAGE = 100;
export const MAX_SEARCH_LENGTH = 100;

export type ReviewFilter = {
  ratings?: number[];
  territory?: string;
  language?: string;
  version?: string;
  statuses?: ReviewStatus[];
  hasResponse?: boolean;
  /** Text search in the title and the body. */
  q?: string;
  /** Epoch milliseconds; reviews created at or after it. */
  since?: number;
  /** Epoch milliseconds; reviews created before it. */
  until?: number;
};

/** `!`, `%` and `_` escaped, so a search for "100%" finds "100%" and not everything. */
export const escapeLike = (value: string): string => value.replace(/[!%_]/g, (c) => `!${c}`);

function where(workspaceId: string, appId: string, filter: ReviewFilter): { clause: string; params: Param[] } {
  const parts = ['workspace_id = ?', 'app_id = ?'];
  const params: Param[] = [workspaceId, appId];
  if (filter.ratings && filter.ratings.length > 0) {
    parts.push(`rating IN (${filter.ratings.map(() => '?').join(', ')})`);
    params.push(...filter.ratings);
  }
  if (filter.territory) {
    parts.push('territory = ?');
    params.push(filter.territory);
  }
  if (filter.language) {
    parts.push('language = ?');
    params.push(filter.language);
  }
  if (filter.version) {
    parts.push('app_version = ?');
    params.push(filter.version);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    parts.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
    params.push(...filter.statuses);
  }
  if (filter.hasResponse !== undefined) {
    parts.push(filter.hasResponse ? 'developer_response IS NOT NULL' : 'developer_response IS NULL');
  }
  if (filter.q) {
    const like = `%${escapeLike(filter.q.toLowerCase())}%`;
    parts.push("(LOWER(COALESCE(title, '')) LIKE ? ESCAPE '!' OR LOWER(body) LIKE ? ESCAPE '!')");
    params.push(like, like);
  }
  if (filter.since !== undefined) {
    parts.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    parts.push('created_at < ?');
    params.push(filter.until);
  }
  return { clause: parts.join(' AND '), params };
}

type Cursor = { s: ReviewSort; v: number[]; id: string };

export function encodeCursor(sort: ReviewSort, review: Review): string {
  const v =
    sort === 'newest' ? [review.createdAt] : sort === 'updated' ? [review.updatedAt] : [review.rating, review.createdAt];
  return Buffer.from(JSON.stringify({ s: sort, v, id: review.id } satisfies Cursor)).toString('base64url');
}

/** The cursor of an earlier page for the same sort, or undefined when it is not one. */
export function decodeCursor(raw: string, sort: ReviewSort): Cursor | undefined {
  if (raw.length > 400) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const c = value as Partial<Cursor>;
    const width = sort === 'rating' ? 2 : 1;
    if (c.s !== sort || typeof c.id !== 'string' || !Array.isArray(c.v) || c.v.length !== width) return undefined;
    if (!c.v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
    return { s: sort, v: c.v as number[], id: c.id };
  } catch {
    return undefined;
  }
}

const ORDER: Record<ReviewSort, string> = {
  newest: 'created_at DESC, id DESC',
  updated: 'updated_at DESC, id DESC',
  // Lowest first: the reviews that need looking at, newest of each rating first.
  rating: 'rating ASC, created_at DESC, id DESC',
};

function after(sort: ReviewSort, c: Cursor): { clause: string; params: Param[] } {
  const [a = 0, b = 0] = c.v;
  if (sort === 'newest') return { clause: '(created_at < ? OR (created_at = ? AND id < ?))', params: [a, a, c.id] };
  if (sort === 'updated') return { clause: '(updated_at < ? OR (updated_at = ? AND id < ?))', params: [a, a, c.id] };
  return {
    clause: '(rating > ? OR (rating = ? AND (created_at < ? OR (created_at = ? AND id < ?))))',
    params: [a, a, b, b, c.id],
  };
}

export type ReviewPage = { reviews: Review[]; nextCursor: string | null };

/** `invalid_cursor` when the cursor is not one this sort produced. */
export async function listReviews(
  sql: Sql,
  workspaceId: string,
  appId: string,
  filter: ReviewFilter,
  options: { sort?: ReviewSort; cursor?: string; limit?: number } = {},
): Promise<ReviewPage | { error: 'invalid_cursor' }> {
  const sort = options.sort ?? 'newest';
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_REVIEWS_PAGE), 1), MAX_REVIEWS_PAGE);
  const base = where(workspaceId, appId, filter);
  let clause = base.clause;
  const params = [...base.params];
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor, sort);
    if (!cursor) return { error: 'invalid_cursor' };
    const more = after(sort, cursor);
    clause += ` AND ${more.clause}`;
    params.push(...more.params);
  }
  const rows = await sql.query(
    `SELECT ${REVIEW_COLUMNS} FROM app_reviews WHERE ${clause} ORDER BY ${ORDER[sort]} LIMIT ?`,
    [...params, limit + 1],
  );
  const page = rows.slice(0, limit).map(toReview);
  const last = page[page.length - 1];
  return { reviews: page, nextCursor: rows.length > limit && last ? encodeCursor(sort, last) : null };
}

export async function getReview(
  sql: Sql,
  workspaceId: string,
  appId: string,
  id: string,
): Promise<Review | undefined> {
  const [row] = await sql.query(
    `SELECT ${REVIEW_COLUMNS} FROM app_reviews WHERE id = ? AND app_id = ? AND workspace_id = ?`,
    [id, appId, workspaceId],
  );
  return row ? toReview(row) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Triage (internal only: nothing here is sent to a store)

export const MAX_NOTE_LENGTH = 2000;

export type TriageInput = {
  status?: ReviewStatus;
  assigneeUserId?: string | null;
  internalNote?: string | null;
};

export type TriageResult =
  | { ok: true; review: Review; changed: string[]; from: { status: ReviewStatus; assigneeUserId: string | null } }
  | { ok: false; error: 'not_found' | 'assignee_not_member' };

export async function triageReview(
  sql: Sql,
  input: { workspaceId: string; appId: string; id: string; actorId: string; at: number } & TriageInput,
): Promise<TriageResult> {
  const current = await getReview(sql, input.workspaceId, input.appId, input.id);
  if (!current) return { ok: false, error: 'not_found' };
  if (input.assigneeUserId) {
    const [member] = await sql.query('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
      input.workspaceId,
      input.assigneeUserId,
    ]);
    if (!member) return { ok: false, error: 'assignee_not_member' };
  }
  const changed: string[] = [];
  const sets: string[] = [];
  const params: Param[] = [];
  if (input.status !== undefined && input.status !== current.status) {
    sets.push('status = ?', 'status_changed_at = ?', 'status_changed_by = ?');
    params.push(input.status, input.at, input.actorId);
    changed.push('status');
  }
  if (input.assigneeUserId !== undefined && input.assigneeUserId !== current.assigneeUserId) {
    sets.push('assignee_user_id = ?');
    params.push(input.assigneeUserId);
    changed.push('assignee');
  }
  if (input.internalNote !== undefined) {
    const note = input.internalNote === null || input.internalNote.trim() === '' ? null : input.internalNote;
    if (note !== current.internalNote) {
      sets.push('internal_note = ?');
      params.push(note);
      changed.push('note');
    }
  }
  if (sets.length > 0) {
    await sql.execute(`UPDATE app_reviews SET ${sets.join(', ')} WHERE id = ? AND app_id = ? AND workspace_id = ?`, [
      ...params,
      input.id,
      input.appId,
      input.workspaceId,
    ]);
  }
  const review = (await getReview(sql, input.workspaceId, input.appId, input.id)) as Review;
  return { ok: true, review, changed, from: { status: current.status, assigneeUserId: current.assigneeUserId } };
}

// ---------------------------------------------------------------------------------------------
// Removal

/** Removes every row about an app's reviews. Called in the transaction that deletes the app. */
export async function deleteReviewData(sql: Sql, workspaceId: string, appId: string): Promise<void> {
  for (const table of ['app_reviews', 'review_sync_state', 'app_rating_summaries']) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [appId, workspaceId]);
  }
}

/** Rows of deleted apps, left behind by anything other than `deleteApp`. Bounded. */
export async function purgeOrphanReviewRows(sql: Sql, limit = 1000): Promise<number> {
  let removed = 0;
  for (const table of ['app_reviews', 'app_rating_summaries']) {
    removed += await sql.execute(
      `DELETE FROM ${table} WHERE id IN (
         SELECT x.id FROM ${table} x WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = x.app_id) LIMIT ?)`,
      [limit],
    );
  }
  removed += await sql.execute(
    'DELETE FROM review_sync_state WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = review_sync_state.app_id)',
  );
  return removed;
}

/**
 * Data protection: reviews older than the retention (by the store's date of the review) are
 * deleted, at most `maxRows` at a time. Returns how many. `olderThan` is epoch milliseconds.
 */
export async function pruneReviews(sql: Sql, olderThan: number, maxRows = 1000): Promise<number> {
  return sql.execute(
    `DELETE FROM app_reviews WHERE id IN (
       SELECT id FROM app_reviews WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
    [olderThan, Math.max(1, Math.trunc(maxRows))],
  );
}
