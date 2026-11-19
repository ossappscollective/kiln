import { type Platform, isPlatform } from '@mrm/core';
import { ApiError } from './api.ts';
import type { ReplyDraft, ReplyState } from './review-reply.ts';

/**
 * Customer reviews of an app: types of the API (docs/api/reviews.md) and the pure logic of the
 * Reviews tab. Review text, titles and display names are written by customers: they are only ever
 * shown as plain text (never as HTML) and never put into a URL.
 */

export type ReviewStore = 'appstoreconnect' | 'googleplay';

/**
 * The customer reviews of an App Store Connect app are one list for the app, whatever platforms it has. They
 * are read for the iOS record; a macOS record that shares its App Store id with an iOS record owns none
 * (the server answers `reviews_shared`). The iOS record that owns them, or null when the app's reviews are its own.
 */
export function reviewsOwner<T extends { id: string; platform: Platform; storeAppId: string | null }>(
  app: { platform: Platform; storeAppId: string | null },
  records: readonly T[],
): T | null {
  if (app.platform !== 'macos' || !app.storeAppId) return null;
  return records.find((r) => r.platform === 'ios' && r.storeAppId === app.storeAppId) ?? null;
}
export type ReviewStatus = 'new' | 'triaged' | 'replied_in_console' | 'ignored';
export type ReviewSort = 'newest' | 'rating' | 'updated';

export type DeveloperResponse = { body: string; at: number | null; state: string | null };

export type Review = {
  id: string;
  appId: string;
  store: ReviewStore;
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
  developerResponse: DeveloperResponse | null;
  status: ReviewStatus;
  assigneeUserId: string | null;
  internalNote: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  /** The reply draft (the text is included), or null. Absent in answers of a server without replies. */
  replyDraft?: ReplyDraft | null;
  /** Where the reply stands: `none`, or the status of the draft. */
  reply?: ReplyState;
};

export type ReviewsPage = { reviews: Review[]; nextCursor: string | null };

export type ReviewSyncResult = {
  at: number;
  fetched: number;
  added: number;
  updated: number;
  responses: number;
  skipped: number;
  complete: boolean;
  gap: { from: number; to: number } | null;
  warnings: string[];
  baseline: boolean;
  lowRatingEvents: number;
  ratingSummary: 'stored' | 'unchanged' | 'unavailable' | 'off';
};

export type ReviewSyncState = {
  store: ReviewStore;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  backoffUntil: number | null;
  lastGapAt: number | null;
  moreToRead: boolean;
  lastResult: ReviewSyncResult | null;
};

export type WeekBucket = { weekStart: number; count: number; average: number | null };

export type StoredSummary = {
  basis: 'stored_reviews';
  label: string;
  count: number;
  average: number | null;
  /** Index 0 is one star. */
  histogram: number[];
  oldestAt: number | null;
  newestAt: number | null;
  truncated: boolean;
  byVersion: { version: string; count: number; average: number }[];
  weeks: WeekBucket[];
  territories: { value: string; count: number }[];
  languages: { value: string; count: number }[];
};

export type StoreWideRating = {
  basis: 'store_wide';
  label: string;
  source: 'itunes_lookup';
  territory: string;
  average: number | null;
  ratingCount: number | null;
  currentVersionAverage: number | null;
  currentVersionCount: number | null;
  observedAt: number;
};

export type ReviewsSummary = {
  app: { id: string; platform: Platform; store: ReviewStore };
  stored: StoredSummary;
  storeWide: StoreWideRating[];
  byStatus: Record<ReviewStatus, number>;
  sync: ReviewSyncState;
  lowRatingThreshold: number;
  retentionDays: number | null;
};

export type ReviewSyncOutcome = { sync: ReviewSyncResult; state: ReviewSyncState };

export type TriageBody = {
  status?: ReviewStatus;
  assigneeUserId?: string | null;
  internalNote?: string | null;
};

// ---------------------------------------------------------------------------------------------
// Labels

export const statusLabels: Record<ReviewStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  replied_in_console: 'Replied in store console',
  ignored: 'Ignored',
};

export const statusOrder: ReviewStatus[] = ['new', 'triaged', 'replied_in_console', 'ignored'];

export const statusLabel = (status: string): string => statusLabels[status as ReviewStatus] ?? status;

export const sortLabels: Record<ReviewSort, string> = {
  newest: 'Newest first',
  rating: 'Lowest rating first',
  updated: 'Recently edited',
};

export const storeLabel = (store: string): string =>
  store === 'appstoreconnect' ? 'App Store' : store === 'googleplay' ? 'Google Play' : store;

// ---------------------------------------------------------------------------------------------
// Stars, text

export const MAX_RATING = 5;

/** "4 out of 5 stars", for assistive technology and for text. Anything else is clamped. */
export function ratingText(rating: number): string {
  const n = Math.min(MAX_RATING, Math.max(0, Math.round(Number.isFinite(rating) ? rating : 0)));
  return `${n} out of ${MAX_RATING} stars`;
}

/** Five booleans: which stars are filled. */
export function starFill(rating: number): boolean[] {
  const n = Math.min(MAX_RATING, Math.max(0, Math.round(Number.isFinite(rating) ? rating : 0)));
  return Array.from({ length: MAX_RATING }, (_, i) => i < n);
}

/** "4.3" with one decimal, or "No ratings" for none. */
export function averageText(average: number | null): string {
  return average === null || !Number.isFinite(average) ? '–' : average.toFixed(1);
}

export const COLLAPSE_AT = 320;

/**
 * Long text is shown cut at a word boundary until the person opens it. The text is returned as is
 * (a plain string for a text node), never as markup.
 */
export function collapseText(text: string, limit = COLLAPSE_AT): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const slice = text.slice(0, limit);
  const space = slice.lastIndexOf(' ');
  const end = space > limit * 0.6 ? space : limit;
  return { text: `${slice.slice(0, end).replace(/\s+$/, '')}…`, cut: true };
}

/** "iPhone, version 3.2.0 (412), US, en", skipping what is missing. */
export function reviewFacts(review: Pick<Review, 'device' | 'appVersion' | 'buildNumber' | 'territory' | 'language'>): string[] {
  const facts: string[] = [];
  if (review.device) facts.push(review.device);
  if (review.appVersion) facts.push(`Version ${review.appVersion}${review.buildNumber ? ` (${review.buildNumber})` : ''}`);
  if (review.territory) facts.push(territoryName(review.territory));
  if (review.language) facts.push(review.language);
  return facts;
}

/** "United States" for US where the runtime knows it, else the code. Store territory codes vary in case and length. */
export function territoryName(code: string, locale = 'en'): string {
  try {
    // Intl.DisplayNames is newer than the lib the web build's type settings assume.
    const Names = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of(c: string): string | undefined } })
      .DisplayNames;
    const name = Names ? new Names([locale], { type: 'region' }).of(code.toUpperCase()) : undefined;
    return name && name !== code.toUpperCase() ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

// ---------------------------------------------------------------------------------------------
// Filters

export type ReviewFilters = {
  ratings: number[];
  statuses: ReviewStatus[];
  /** '' any, 'yes' or 'no'. */
  response: '' | 'yes' | 'no';
  version: string;
  territory: string;
  language: string;
  q: string;
  /** Epoch milliseconds, or null. */
  since: number | null;
  sort: ReviewSort;
};

export const defaultFilters = (): ReviewFilters => ({
  ratings: [],
  statuses: [],
  response: '',
  version: '',
  territory: '',
  language: '',
  q: '',
  since: null,
  sort: 'newest',
});

export function hasActiveFilters(f: ReviewFilters): boolean {
  return (
    f.ratings.length > 0 ||
    f.statuses.length > 0 ||
    f.response !== '' ||
    f.version.trim() !== '' ||
    f.territory.trim() !== '' ||
    f.language.trim() !== '' ||
    f.q.trim() !== '' ||
    f.since !== null
  );
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * The query string for `GET /reviews`. A search term the person typed is sent (the server needs it
 * to search); nothing from a review is ever put here.
 */
export function filtersToQuery(f: ReviewFilters, options: { cursor?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (f.ratings.length > 0) params.set('rating', [...f.ratings].sort((a, b) => a - b).join(','));
  if (f.statuses.length > 0) params.set('status', f.statuses.join(','));
  if (f.response !== '') params.set('hasResponse', f.response === 'yes' ? 'true' : 'false');
  if (f.version.trim()) params.set('version', f.version.trim());
  if (f.territory.trim()) params.set('territory', f.territory.trim());
  if (f.language.trim()) params.set('language', f.language.trim());
  if (f.q.trim()) params.set('q', f.q.trim().slice(0, 100));
  if (f.since !== null) params.set('since', String(Math.trunc(f.since)));
  if (f.sort !== 'newest') params.set('sort', f.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  return params.toString();
}

export const sinceChoices: { id: string; label: string; days: number | null }[] = [
  { id: 'all', label: 'Any time', days: null },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
];

export const sinceFor = (days: number | null, now: number): number | null =>
  days === null ? null : now - days * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Lists

/** Adds a page to the list, skipping a review already there (a page can overlap after a sync). */
export function appendPage(current: readonly Review[], page: readonly Review[]): Review[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...page.filter((r) => !seen.has(r.id))];
}

/** Replaces one review (after a triage change) and leaves the order alone. */
export function replaceReview(current: readonly Review[], updated: Review): Review[] {
  return current.map((r) => (r.id === updated.id ? updated : r));
}

/** Whether the review has an answer: a response in the store, or a reply sent from here. */
export const isAnswered = (r: Pick<Review, 'developerResponse' | 'reply' | 'replyDraft'>): boolean =>
  r.developerResponse != null || r.reply?.status === 'sent' || r.replyDraft?.status === 'sent';

/**
 * Whether a review that just changed (triaged, answered) no longer belongs in a list filtered by status or
 * answer. It leaves the list then, so "New" shows only what is still new.
 */
export function leavesFilters(updated: Review, f: Pick<ReviewFilters, 'statuses' | 'response'>): boolean {
  if (f.statuses.length > 0 && !f.statuses.includes(updated.status)) return true;
  if (f.response === 'yes' && !isAnswered(updated)) return true;
  if (f.response === 'no' && isAnswered(updated)) return true;
  return false;
}

/** The review to select once `id` leaves the list: the one after it, else the one before, else null. */
export function neighborAfterRemoval(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** What to send for a triage edit: only the fields that differ from the stored review. Empty when nothing changed. */
export function triageDiff(
  review: Pick<Review, 'status' | 'assigneeUserId' | 'internalNote'>,
  draft: { status: ReviewStatus; assigneeUserId: string | null; internalNote: string },
): TriageBody {
  const body: TriageBody = {};
  if (draft.status !== review.status) body.status = draft.status;
  if (draft.assigneeUserId !== review.assigneeUserId) body.assigneeUserId = draft.assigneeUserId;
  const note = draft.internalNote.trim() === '' ? null : draft.internalNote;
  if (note !== (review.internalNote ?? null)) body.internalNote = note;
  return body;
}

export const MAX_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------
// Summary shapes for drawing

/** Five bars, five stars first. `share` is 0 to 1 of the largest bar, so the biggest bar is full width. */
export function histogramBars(histogram: readonly number[]): { stars: number; count: number; share: number; percent: number }[] {
  const counts = Array.from({ length: MAX_RATING }, (_, i) => Math.max(0, Math.trunc(histogram[i] ?? 0)));
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...counts);
  return counts
    .map((count, i) => ({
      stars: i + 1,
      count,
      share: max === 0 ? 0 : count / max,
      percent: total === 0 ? 0 : Math.round((count / total) * 100),
    }))
    .reverse();
}

export type TrendGeometry = {
  width: number;
  height: number;
  /** One column per week: a bar for the number of reviews. */
  bars: { x: number; y: number; w: number; h: number; weekStart: number; count: number; average: number | null }[];
  /** The average rating line, in segments: a week without reviews breaks the line. */
  segments: { x: number; y: number }[][];
  /** Where the 1 to 5 scale puts the line, so a caption can say what it is. */
  max: number;
};

/**
 * A small combined trend for an inline SVG, with no chart library: bars are reviews per week, the
 * line is the average rating (scale 1 to 5) of the weeks that have reviews.
 */
export function trendGeometry(weeks: readonly WeekBucket[], width = 320, height = 72, pad = 4): TrendGeometry {
  const n = weeks.length;
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const slot = n === 0 ? 0 : (width - pad * 2) / n;
  const barW = Math.max(1, slot * 0.7);
  const plotH = height - pad * 2;
  const bars = weeks.map((w, i) => {
    const h = w.count === 0 ? 0 : Math.max(1, Math.round((w.count / max) * plotH));
    return {
      x: round(pad + i * slot + (slot - barW) / 2),
      y: round(height - pad - h),
      w: round(barW),
      h,
      weekStart: w.weekStart,
      count: w.count,
      average: w.average,
    };
  });
  const segments: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  weeks.forEach((w, i) => {
    if (w.average === null || w.count === 0) {
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    const clamped = Math.min(5, Math.max(1, w.average));
    run.push({ x: round(pad + i * slot + slot / 2), y: round(height - pad - ((clamped - 1) / 4) * plotH) });
  });
  if (run.length > 0) segments.push(run);
  return { width, height, bars, segments, max };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** "6 weeks, 1 to 14 reviews a week; average 3.2 to 4.5" for the text alternative of the chart. */
export function trendDescription(weeks: readonly WeekBucket[]): string {
  const withReviews = weeks.filter((w) => w.count > 0);
  if (withReviews.length === 0) return `No reviews in these ${weeks.length} weeks.`;
  const counts = withReviews.map((w) => w.count);
  const averages = withReviews.map((w) => w.average ?? 0);
  const lo = Math.min(...averages).toFixed(1);
  const hi = Math.max(...averages).toFixed(1);
  return `${weeks.length} weeks, ${Math.min(...counts)} to ${Math.max(...counts)} reviews in a week with reviews; weekly average rating ${lo} to ${hi}.`;
}

export const weekLabel = (weekStart: number, locale?: string): string =>
  new Date(weekStart).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------------------------------------
// Sync state

export type SyncNotice = { tone: 'info' | 'warn' | 'error'; text: string };

/** The one line about when reviews were last read ("Last read 5 minutes ago", or "Not read yet"). */
export function lastReadText(state: Pick<ReviewSyncState, 'lastSuccessAt'>, ago: (at: number) => string): string {
  return state.lastSuccessAt === null ? 'Not read yet.' : `Last read ${ago(state.lastSuccessAt)}.`;
}

/**
 * What to tell the person about the state of the sync, most important first: a failure, a gap
 * (Google Play only keeps seven days), a backlog still being read.
 */
export function syncNotices(state: ReviewSyncState, now: number, ago: (at: number) => string): SyncNotice[] {
  const notices: SyncNotice[] = [];
  if (state.lastError) {
    const failures = state.consecutiveFailures;
    const when = state.lastAttemptAt !== null ? ` ${ago(state.lastAttemptAt)}` : '';
    notices.push({
      tone: 'error',
      text: `The last attempt${when} failed${failures > 1 ? ` (${failures} times in a row)` : ''}: ${state.lastError}`,
    });
  }
  const gap = state.lastResult?.gap ?? null;
  if (gap) {
    notices.push({
      tone: 'warn',
      text: `Reviews may be missing. Google Play only returns the last 7 days, and nothing was read between ${shortDate(gap.from)} and ${shortDate(gap.to)}. Those reviews cannot be recovered. Read more often: see MRM_REVIEW_SYNC_INTERVAL_MINUTES.`,
    });
  } else if (state.lastGapAt !== null) {
    notices.push({
      tone: 'warn',
      text: `Reviews were missed once: Google Play only returns the last 7 days and nothing was read for longer (noticed ${ago(state.lastGapAt)}).`,
    });
  }
  if (state.moreToRead) {
    notices.push({ tone: 'info', text: 'Older reviews are still being read. Read again to continue.' });
  }
  for (const warning of state.lastResult?.warnings ?? []) notices.push({ tone: 'info', text: warning });
  if (state.backoffUntil !== null && state.backoffUntil > now && state.lastError) {
    notices.push({ tone: 'info', text: `The scheduled read waits until ${shortDate(state.backoffUntil)} before trying again. Reading by hand ignores that.` });
  }
  return notices;
}

const shortDate = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Read 12 reviews: 3 new, 2 changed." */
export function syncSummaryText(result: ReviewSyncResult): string {
  const parts = [`${result.added} new`, `${result.updated} changed`];
  if (result.responses > 0) parts.push(`${result.responses} with a changed developer response`);
  const base = `Read ${result.fetched} ${result.fetched === 1 ? 'review' : 'reviews'}: ${parts.join(', ')}.`;
  return result.complete ? base : `${base} Not everything was read: read again to continue.`;
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A message for a failed request of this tab. The server's own message for a store failure is kept: it names what the store said. */
export function reviewErrorMessage(error: unknown, action: 'load' | 'sync' | 'triage' = 'load'): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const server = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'not_found':
      return 'This app or review no longer exists.';
    case 'forbidden':
      return action === 'sync'
        ? 'Only a member or admin can read reviews from the store.'
        : action === 'triage'
          ? 'Only a member or admin can triage reviews.'
          : 'You are not allowed to see reviews.';
    case 'sync_in_progress':
      return 'The reviews of this app are already being read. Wait a moment.';
    case 'rate_limited':
      return error.message;
    case 'app_not_synced':
      return 'The App Store id of this app is not known yet. Sync the app from the Releases tab first.';
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return server || 'The credential of this app cannot be used. Check it under Credentials.';
    case 'store_auth':
      return `The store did not accept the credential. ${server}`.trim();
    case 'store_forbidden':
      return `The credential is not allowed to read reviews. ${server}`.trim();
    case 'store_unavailable':
    case 'timeout':
      return `The store did not answer. Try again later. ${server}`.trim();
    case 'assignee_not_member':
      return 'The assignee is not a member of this workspace.';
    case 'invalid_request':
      return error.message;
  }
  return action === 'load' ? 'Reviews could not be loaded. Try again.' : error.message;
}

/** Whether a rating counts as low for this app (the server's threshold). */
export const isLowRating = (rating: number, threshold: number): boolean => rating <= threshold;

// ---------------------------------------------------------------------------------------------
// The workspace-wide inbox (GET /reviews): every app in one list

export type InboxApp = { id: string; name: string; platform: Platform };
export type InboxReview = Review & { app: InboxApp };
export type InboxPage = { reviews: InboxReview[]; nextCursor: string | null };

export type SummaryApp = {
  app: { id: string; name: string; platform: Platform; store: ReviewStore };
  total: number;
  new: number;
  unanswered: number;
  lowRating: number;
  average: number | null;
  oldestAt: number | null;
  newestAt: number | null;
};

/** `GET /reviews/summary`: counts only, no review text. `label` says what the numbers are computed from. */
export type WorkspaceReviewsSummary = {
  basis: 'stored_reviews';
  label: string;
  lowRatingThreshold: number;
  apps: SummaryApp[];
  totals: { total: number; new: number; unanswered: number; lowRating: number; average: number | null };
};

export type InboxFilters = ReviewFilters & {
  /** Only these apps; empty is every app. */
  appIds: string[];
  platform: '' | Platform;
  /** '' anyone, 'me', 'unassigned' or a member's user id. */
  assignee: string;
  /** '' any time, or '7', '30', '90' days. The `since` of the request is worked out when it is sent. */
  within: '' | '7' | '30' | '90';
};

export const defaultInboxFilters = (): InboxFilters => ({
  ...defaultFilters(),
  appIds: [],
  platform: '',
  assignee: '',
  within: '',
});

export function hasActiveInboxFilters(f: InboxFilters): boolean {
  return (
    hasActiveFilters({ ...f, since: null }) ||
    f.appIds.length > 0 ||
    f.platform !== '' ||
    f.assignee !== '' ||
    f.within !== ''
  );
}

const WITHIN_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };
const DAY = 24 * 60 * 60 * 1000;

export const withinChoices: { id: InboxFilters['within']; label: string }[] = [
  { id: '', label: 'Any time' },
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
];

/** The query string for `GET /reviews`. `now` turns "last 30 days" into a `since`. */
export function inboxFiltersToQuery(
  f: InboxFilters,
  now: number,
  options: { cursor?: string | null; limit?: number } = {},
): string {
  const days = WITHIN_DAYS[f.within];
  const params = new URLSearchParams(
    filtersToQuery({ ...f, since: days === undefined ? null : now - days * DAY }, options),
  );
  if (f.appIds.length > 0) params.set('appIds', f.appIds.join(','));
  if (f.platform !== '') params.set('platform', f.platform);
  if (f.assignee === 'unassigned') params.set('unassigned', 'true');
  else if (f.assignee !== '') params.set('assignee', f.assignee);
  return params.toString();
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const reviewStatuses: readonly string[] = statusOrder;
const sorts: readonly string[] = ['newest', 'rating', 'updated'];

/**
 * The filters in the page address, so a view can be bookmarked and shared: `#/reviews?rating=1,2&apps=ID`.
 * Only what differs from the defaults is written. Nothing from a review goes in; the search words are
 * the person's own, and are kept to 100 characters.
 */
export function inboxFiltersToSearch(f: InboxFilters): string {
  const params = new URLSearchParams();
  if (f.appIds.length > 0) params.set('apps', f.appIds.join(','));
  if (f.platform !== '') params.set('platform', f.platform);
  if (f.ratings.length > 0) params.set('rating', [...f.ratings].sort((a, b) => a - b).join(','));
  if (f.statuses.length > 0) params.set('status', f.statuses.join(','));
  if (f.response !== '') params.set('response', f.response);
  if (f.assignee !== '') params.set('assignee', f.assignee);
  if (f.version.trim()) params.set('version', f.version.trim());
  if (f.territory.trim()) params.set('territory', f.territory.trim());
  if (f.language.trim()) params.set('language', f.language.trim());
  if (f.q.trim()) params.set('q', f.q.trim().slice(0, 100));
  if (f.within !== '') params.set('within', f.within);
  if (f.sort !== 'newest') params.set('sort', f.sort);
  return params.toString();
}

/** The reverse. Anything that is not valid is dropped, never trusted: the address is typed by people and links. */
export function inboxFiltersFromSearch(search: string): InboxFilters {
  const f = defaultInboxFilters();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.replace(/^\?/, ''));
  } catch {
    return f;
  }
  const list = (name: string): string[] =>
    (params.get(name) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  const apps = list('apps');
  if (apps.length > 0 && apps.length <= 50 && apps.every((id) => ID_PATTERN.test(id))) f.appIds = [...new Set(apps)];
  const platform = params.get('platform');
  if (isPlatform(platform)) f.platform = platform;
  const ratings = list('rating');
  if (ratings.length > 0 && ratings.every((r) => /^[1-5]$/.test(r))) f.ratings = [...new Set(ratings.map(Number))].sort((a, b) => a - b);
  const statuses = list('status');
  if (statuses.length > 0 && statuses.every((s) => reviewStatuses.includes(s))) f.statuses = [...new Set(statuses)] as ReviewStatus[];
  const response = params.get('response');
  if (response === 'yes' || response === 'no') f.response = response;
  const assignee = params.get('assignee');
  if (assignee === 'me' || assignee === 'unassigned' || (assignee !== null && ID_PATTERN.test(assignee))) f.assignee = assignee;
  const version = params.get('version');
  if (version && version.length <= 100) f.version = version;
  const territory = params.get('territory');
  if (territory && /^[A-Za-z0-9_-]{1,10}$/.test(territory)) f.territory = territory;
  const language = params.get('language');
  if (language && /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(language)) f.language = language;
  const q = params.get('q');
  if (q) f.q = q.slice(0, 100);
  const within = params.get('within');
  if (within === '7' || within === '30' || within === '90') f.within = within;
  const sort = params.get('sort');
  if (sort !== null && sorts.includes(sort)) f.sort = sort as ReviewSort;
  return f;
}

/** The address of the inbox with these filters. */
export function inboxHref(f: InboxFilters): string {
  const search = inboxFiltersToSearch(f);
  return search === '' ? '#/reviews' : `#/reviews?${search}`;
}

/** The filters of a location hash (`#/reviews?...`); the defaults for anything else. */
export function parseInboxHash(hash: string): InboxFilters {
  const at = hash.indexOf('?');
  return at < 0 ? defaultInboxFilters() : inboxFiltersFromSearch(hash.slice(at + 1));
}

/** The inbox with one app already chosen, for a link from elsewhere. */
export const inboxForApp = (appId: string): string => inboxHref({ ...defaultInboxFilters(), appIds: [appId] });

/** Where the app is. The app's own page has a Reviews tab (the tab is one click away: the page does not read a tab from the address). */
export const appPageHref = (appId: string): string => `#/portfolio/${encodeURIComponent(appId)}`;

/** The quick views of the summary strip: what each count opens in the inbox. */
export type QuickView = { id: 'new' | 'unanswered' | 'low' | 'mine'; label: string };
export const quickViews: QuickView[] = [
  { id: 'new', label: 'New' },
  { id: 'unanswered', label: 'Unanswered' },
  { id: 'low', label: 'Low rating' },
  { id: 'mine', label: 'Assigned to me' },
];

/** The filters of a quick view. Low rating uses the server's own threshold; ignored reviews are not counted in the summary and are left out here too. */
export function quickViewFilters(id: QuickView['id'], lowThreshold: number): InboxFilters {
  const f = defaultInboxFilters();
  if (id === 'new') f.statuses = ['new'];
  else if (id === 'unanswered') {
    f.response = 'no';
    f.statuses = ['new', 'triaged', 'replied_in_console'];
  } else if (id === 'low') {
    f.ratings = Array.from({ length: Math.max(0, Math.min(MAX_RATING, Math.trunc(lowThreshold))) }, (_, i) => i + 1);
    f.statuses = ['new', 'triaged', 'replied_in_console'];
  } else f.assignee = 'me';
  return f;
}

/** The same figures as text for a screen reader: "3 new, 5 unanswered, 2 low rated". */
export function summaryStripText(totals: WorkspaceReviewsSummary['totals']): string {
  return `${totals.new} new, ${totals.unanswered} unanswered, ${totals.lowRating} low rated, in ${totals.total} stored ${totals.total === 1 ? 'review' : 'reviews'}.`;
}

/** The apps with something to look at first (most new, then most unanswered), for the strip. */
export function busiestApps(apps: readonly SummaryApp[], limit = 5): SummaryApp[] {
  return apps
    .filter((a) => a.new > 0 || a.unanswered > 0 || a.lowRating > 0)
    .sort((a, b) => b.new - a.new || b.unanswered - a.unanswered || b.lowRating - a.lowRating || a.app.name.localeCompare(b.app.name))
    .slice(0, Math.max(0, limit));
}

/** Replaces one review in an inbox list (after a triage change or a send); the app stays as listed. */
export function replaceInboxReview(current: readonly InboxReview[], updated: Review): InboxReview[] {
  return current.map((r) => (r.id === updated.id ? { ...r, ...updated, app: r.app } : r));
}

export function appendInboxPage(current: readonly InboxReview[], page: readonly InboxReview[]): InboxReview[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...page.filter((r) => !seen.has(r.id))];
}

// ---------------------------------------------------------------------------------------------
// Keyboard

export type InboxShortcut = 'next' | 'previous' | 'first' | 'last' | 'triage' | 'reply' | 'search';

/**
 * The shortcut of a key press, or null. Nothing fires while a field has the focus (`typing`) or
 * with a modifier held, so typing a reply never triages a review. j and k or the arrow keys move,
 * t marks the focused review triaged, r opens its reply, / jumps to the search box.
 */
export function shortcutFor(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; typing: boolean }): InboxShortcut | null {
  if (event.typing || event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'previous';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 't':
      return 'triage';
    case 'r':
      return 'reply';
    case '/':
      return 'search';
    default:
      return null;
  }
}

/** The index to focus after a move, staying inside the list. -1 is "nothing focused yet". */
export function moveIndex(current: number, count: number, move: InboxShortcut): number {
  if (count <= 0) return -1;
  if (move === 'first') return 0;
  if (move === 'last') return count - 1;
  if (move === 'next') return Math.min(count - 1, current < 0 ? 0 : current + 1);
  if (move === 'previous') return Math.max(0, current < 0 ? 0 : current - 1);
  return current;
}

/** The text a screen reader hears when the list changes. */
export const inboxAnnouncement = (shown: number, more: boolean): string =>
  shown === 0 ? 'No reviews match.' : `${shown}${more ? ' or more' : ''} ${shown === 1 && !more ? 'review' : 'reviews'} shown.`;
