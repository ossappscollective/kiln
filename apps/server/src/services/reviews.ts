import { type Platform, PLATFORMS } from '@mrm/core';
import { nullableNumber, nullableString, oneOf, type Param, type Row, type Sql } from '@mrm/db';

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
  title: nullableString(r.title),
  body: String(r.body),
  authorName: nullableString(r.author_name),
  territory: nullableString(r.territory),
  language: nullableString(r.language),
  appVersion: nullableString(r.app_version),
  buildNumber: nullableString(r.build_number),
  device: nullableString(r.device),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  firstSeenAt: Number(r.first_seen_at),
  fetchedAt: Number(r.fetched_at),
  developerResponse: parseResponse(r.developer_response),
  status: (isReviewStatus(r.status) ? r.status : 'new') as ReviewStatus,
  assigneeUserId: nullableString(r.assignee_user_id),
  internalNote: nullableString(r.internal_note),
  statusChangedAt: nullableNumber(r.status_changed_at),
  statusChangedBy: nullableString(r.status_changed_by),
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

/** The extra filters of the workspace-wide inbox. */
export type InboxFilter = ReviewFilter & {
  /** Only these apps. An empty list matches nothing. */
  appIds?: string[];
  store?: StoreKey;
  /** A member's user id: reviews assigned to them. */
  assigneeUserId?: string;
  /** Only reviews nobody is assigned to. */
  unassigned?: boolean;
};

/** `!`, `%` and `_` escaped, so a search for "100%" finds "100%" and not everything. */
export const escapeLike = (value: string): string => value.replace(/[!%_]/g, (c) => `!${c}`);

/** `prefix` is a table alias with its dot (`r.`) or empty. */
function conditions(
  filter: ReviewFilter & Partial<InboxFilter>,
  prefix: string,
): { parts: string[]; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  const c = (name: string) => `${prefix}${name}`;
  if (filter.ratings && filter.ratings.length > 0) {
    parts.push(`${c('rating')} IN (${filter.ratings.map(() => '?').join(', ')})`);
    params.push(...filter.ratings);
  }
  if (filter.territory) {
    parts.push(`${c('territory')} = ?`);
    params.push(filter.territory);
  }
  if (filter.language) {
    parts.push(`${c('language')} = ?`);
    params.push(filter.language);
  }
  if (filter.version) {
    parts.push(`${c('app_version')} = ?`);
    params.push(filter.version);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    parts.push(`${c('status')} IN (${filter.statuses.map(() => '?').join(', ')})`);
    params.push(...filter.statuses);
  }
  if (filter.hasResponse !== undefined) {
    parts.push(
      filter.hasResponse
        ? `${c('developer_response')} IS NOT NULL`
        : `${c('developer_response')} IS NULL`,
    );
  }
  if (filter.q) {
    const like = `%${escapeLike(filter.q.toLowerCase())}%`;
    parts.push(
      `(LOWER(COALESCE(${c('title')}, '')) LIKE ? ESCAPE '!' OR LOWER(${c('body')}) LIKE ? ESCAPE '!')`,
    );
    params.push(like, like);
  }
  if (filter.since !== undefined) {
    parts.push(`${c('created_at')} >= ?`);
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    parts.push(`${c('created_at')} < ?`);
    params.push(filter.until);
  }
  return { parts, params };
}

function where(
  workspaceId: string,
  appId: string,
  filter: ReviewFilter,
): { clause: string; params: Param[] } {
  const found = conditions(filter, '');
  return {
    clause: ['workspace_id = ?', 'app_id = ?', ...found.parts].join(' AND '),
    params: [workspaceId, appId, ...found.params],
  };
}

type Cursor = { s: ReviewSort; v: number[]; id: string };

export function encodeCursor(sort: ReviewSort, review: Review): string {
  const v =
    sort === 'newest'
      ? [review.createdAt]
      : sort === 'updated'
        ? [review.updatedAt]
        : [review.rating, review.createdAt];
  return Buffer.from(JSON.stringify({ s: sort, v, id: review.id } satisfies Cursor)).toString(
    'base64url',
  );
}

/** The cursor of an earlier page for the same sort, or undefined when it is not one. */
export function decodeCursor(raw: string, sort: ReviewSort): Cursor | undefined {
  if (raw.length > 400) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const c = value as Partial<Cursor>;
    const width = sort === 'rating' ? 2 : 1;
    if (c.s !== sort || typeof c.id !== 'string' || !Array.isArray(c.v) || c.v.length !== width)
      return undefined;
    if (!c.v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
    return { s: sort, v: c.v as number[], id: c.id };
  } catch {
    return undefined;
  }
}

const orderFor = (sort: ReviewSort, p: string): string =>
  sort === 'newest'
    ? `${p}created_at DESC, ${p}id DESC`
    : sort === 'updated'
      ? `${p}updated_at DESC, ${p}id DESC`
      : // Lowest first: the reviews that need looking at, newest of each rating first.
        `${p}rating ASC, ${p}created_at DESC, ${p}id DESC`;

function after(sort: ReviewSort, c: Cursor, p = ''): { clause: string; params: Param[] } {
  const [a = 0, b = 0] = c.v;
  if (sort === 'newest') {
    return {
      clause: `(${p}created_at < ? OR (${p}created_at = ? AND ${p}id < ?))`,
      params: [a, a, c.id],
    };
  }
  if (sort === 'updated') {
    return {
      clause: `(${p}updated_at < ? OR (${p}updated_at = ? AND ${p}id < ?))`,
      params: [a, a, c.id],
    };
  }
  return {
    clause: `(${p}rating > ? OR (${p}rating = ? AND (${p}created_at < ? OR (${p}created_at = ? AND ${p}id < ?))))`,
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
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_REVIEWS_PAGE), 1),
    MAX_REVIEWS_PAGE,
  );
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
    `SELECT ${REVIEW_COLUMNS} FROM app_reviews WHERE ${clause} ORDER BY ${orderFor(sort, '')} LIMIT ?`,
    [...params, limit + 1],
  );
  const page = rows.slice(0, limit).map(toReview);
  const last = page[page.length - 1];
  return {
    reviews: page,
    nextCursor: rows.length > limit && last ? encodeCursor(sort, last) : null,
  };
}

/** One review of the workspace-wide inbox: the review and the app it belongs to. */
export type InboxReview = Review & { app: { id: string; name: string; platform: Platform } };

export type InboxPage = { reviews: InboxReview[]; nextCursor: string | null };

/**
 * The reviews of every app of the workspace (or of `filter.appIds`), newest first by default.
 * Efficient on the workspace-first indexes of migration 21: the page is an index range scan in
 * the sort order with `LIMIT`; the app's name comes from one extra query for the apps on the
 * page. A review whose app no longer exists is not listed. `invalid_cursor` as in `listReviews`.
 */
export async function listWorkspaceReviews(
  sql: Sql,
  workspaceId: string,
  filter: InboxFilter,
  options: { sort?: ReviewSort; cursor?: string; limit?: number } = {},
): Promise<InboxPage | { error: 'invalid_cursor' }> {
  const sort = options.sort ?? 'newest';
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_REVIEWS_PAGE), 1),
    MAX_REVIEWS_PAGE,
  );
  if (filter.appIds && filter.appIds.length === 0) return { reviews: [], nextCursor: null };
  const found = conditions(filter, 'r.');
  const parts = ['r.workspace_id = ?', ...found.parts];
  const params: Param[] = [workspaceId, ...found.params];
  if (filter.appIds) {
    parts.push(`r.app_id IN (${filter.appIds.map(() => '?').join(', ')})`);
    params.push(...filter.appIds);
  }
  if (filter.store) {
    parts.push('r.store = ?');
    params.push(filter.store);
  }
  if (filter.assigneeUserId) {
    parts.push('r.assignee_user_id = ?');
    params.push(filter.assigneeUserId);
  }
  if (filter.unassigned) parts.push('r.assignee_user_id IS NULL');
  parts.push(
    'EXISTS (SELECT 1 FROM apps a WHERE a.id = r.app_id AND a.workspace_id = r.workspace_id)',
  );
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor, sort);
    if (!cursor) return { error: 'invalid_cursor' };
    const more = after(sort, cursor, 'r.');
    parts.push(more.clause);
    params.push(...more.params);
  }
  const columns = REVIEW_COLUMNS.split(',')
    .map((c) => `r.${c.trim()}`)
    .join(', ');
  const rows = await sql.query(
    `SELECT ${columns} FROM app_reviews r WHERE ${parts.join(' AND ')} ORDER BY ${orderFor(sort, 'r.')} LIMIT ?`,
    [...params, limit + 1],
  );
  const reviews = rows.slice(0, limit).map(toReview);
  const appIds = [...new Set(reviews.map((r) => r.appId))];
  const apps = new Map<string, { id: string; name: string; platform: Platform }>();
  if (appIds.length > 0) {
    const appRows = await sql.query(
      `SELECT id, name, platform FROM apps WHERE workspace_id = ? AND id IN (${appIds.map(() => '?').join(', ')})`,
      [workspaceId, ...appIds],
    );
    for (const a of appRows)
      apps.set(String(a.id), {
        id: String(a.id),
        name: String(a.name),
        platform: oneOf(a.platform, PLATFORMS, 'platform'),
      });
  }
  const page = reviews.map((r) => ({
    ...r,
    app: apps.get(r.appId) ?? { id: r.appId, name: '', platform: r.platform },
  }));
  const last = reviews[reviews.length - 1];
  return {
    reviews: page,
    nextCursor: rows.length > limit && last ? encodeCursor(sort, last) : null,
  };
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
  | {
      ok: true;
      review: Review;
      changed: string[];
      from: { status: ReviewStatus; assigneeUserId: string | null };
    }
  | { ok: false; error: 'not_found' | 'assignee_not_member' };

export async function triageReview(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    id: string;
    actorId: string;
    at: number;
  } & TriageInput,
): Promise<TriageResult> {
  const current = await getReview(sql, input.workspaceId, input.appId, input.id);
  if (!current) return { ok: false, error: 'not_found' };
  if (input.assigneeUserId) {
    const [member] = await sql.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [input.workspaceId, input.assigneeUserId],
    );
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
    const note =
      input.internalNote === null || input.internalNote.trim() === '' ? null : input.internalNote;
    if (note !== current.internalNote) {
      sets.push('internal_note = ?');
      params.push(note);
      changed.push('note');
    }
  }
  if (sets.length > 0) {
    await sql.execute(
      `UPDATE app_reviews SET ${sets.join(', ')} WHERE id = ? AND app_id = ? AND workspace_id = ?`,
      [...params, input.id, input.appId, input.workspaceId],
    );
  }
  const review = (await getReview(sql, input.workspaceId, input.appId, input.id)) as Review;
  return {
    ok: true,
    review,
    changed,
    from: { status: current.status, assigneeUserId: current.assigneeUserId },
  };
}

// ---------------------------------------------------------------------------------------------
// Removal

/** Removes every row about an app's reviews. Called in the transaction that deletes the app. */
export async function deleteReviewData(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<void> {
  // The reply drafts first (they point at reviews); the foreign key would cascade anyway.
  for (const table of [
    'review_translations',
    'review_reply_drafts',
    'app_reviews',
    'review_sync_state',
    'app_rating_summaries',
  ]) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [
      appId,
      workspaceId,
    ]);
  }
}

/** Rows of deleted apps, left behind by anything other than `deleteApp`. Bounded. */
export async function purgeOrphanReviewRows(sql: Sql, limit = 1000): Promise<number> {
  let removed = 0;
  for (const table of ['review_reply_drafts', 'app_reviews', 'app_rating_summaries']) {
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
  const limit = Math.max(1, Math.trunc(maxRows));
  // The drafts of the reviews that go (the foreign key cascades too; this does not depend on it).
  await sql.execute(
    `DELETE FROM review_reply_drafts WHERE review_id IN (
       SELECT id FROM app_reviews WHERE id IN (
         SELECT id FROM app_reviews WHERE created_at < ? ORDER BY created_at LIMIT ?))`,
    [olderThan, limit],
  );
  return sql.execute(
    `DELETE FROM app_reviews WHERE id IN (
       SELECT id FROM app_reviews WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
    [olderThan, limit],
  );
}
