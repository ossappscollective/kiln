import { ApiError } from './api.ts';

/**
 * Customer reviews of an app: types of the API (docs/api/reviews.md) and the pure logic of the
 * Reviews tab. Review text, titles and display names are written by customers: they are only ever
 * shown as plain text (never as HTML) and never put into a URL.
 */

export type ReviewStore = 'appstoreconnect' | 'googleplay';
export type ReviewStatus = 'new' | 'triaged' | 'replied_in_console' | 'ignored';
export type ReviewSort = 'newest' | 'rating' | 'updated';

export type DeveloperResponse = { body: string; at: number | null; state: string | null };

export type Review = {
  id: string;
  appId: string;
  store: ReviewStore;
  platform: 'ios' | 'android';
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
  app: { id: string; platform: 'ios' | 'android'; store: ReviewStore };
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

/** The sentence that must stay on the tab: replying is not part of this tool. */
export const NO_REPLY_NOTE =
  'Replying to reviews is not available here. A reply is a write to the store and this tool only reads reviews. Answer in App Store Connect or Google Play Console, then mark the review “Replied in store console” to keep this list accurate.';

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
