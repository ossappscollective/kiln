import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  appendInboxPage,
  reviewsOwner,
  appendPage,
  busiestApps,
  defaultInboxFilters,
  hasActiveInboxFilters,
  inboxAnnouncement,
  inboxFiltersFromSearch,
  inboxFiltersToQuery,
  inboxFiltersToSearch,
  inboxForApp,
  inboxHref,
  moveIndex,
  parseInboxHash,
  quickViewFilters,
  replaceInboxReview,
  shortcutFor,
  summaryStripText,
  appPageHref,
  averageText,
  collapseText,
  defaultFilters,
  filtersToQuery,
  hasActiveFilters,
  histogramBars,
  lastReadText,
  ratingText,
  replaceReview,
  reviewErrorMessage,
  reviewFacts,
  sinceFor,
  starFill,
  statusLabel,
  syncNotices,
  syncSummaryText,
  toggleIn,
  trendDescription,
  trendGeometry,
  triageDiff,
  type InboxReview,
  type Review,
  type SummaryApp,
  type ReviewSyncResult,
  type ReviewSyncState,
  type WeekBucket,
} from './reviews.ts';

const review = (over: Partial<Review> = {}): Review => ({
  id: 'r1',
  appId: 'a1',
  store: 'appstoreconnect',
  platform: 'ios',
  storeReviewId: 's1',
  rating: 4,
  title: 'Nice',
  body: 'Works well.',
  authorName: 'someone',
  territory: 'US',
  language: 'en',
  appVersion: '3.2.0',
  buildNumber: '412',
  device: 'iPhone',
  createdAt: 1,
  updatedAt: 1,
  firstSeenAt: 1,
  fetchedAt: 1,
  developerResponse: null,
  status: 'new',
  assigneeUserId: null,
  internalNote: null,
  statusChangedAt: null,
  statusChangedBy: null,
  ...over,
});

const result = (over: Partial<ReviewSyncResult> = {}): ReviewSyncResult => ({
  at: 1000,
  fetched: 12,
  added: 3,
  updated: 2,
  responses: 0,
  skipped: 0,
  complete: true,
  gap: null,
  warnings: [],
  baseline: false,
  lowRatingEvents: 0,
  ratingSummary: 'stored',
  ...over,
});

const state = (over: Partial<ReviewSyncState> = {}): ReviewSyncState => ({
  store: 'googleplay',
  lastAttemptAt: 5000,
  lastSuccessAt: 5000,
  lastError: null,
  consecutiveFailures: 0,
  backoffUntil: null,
  lastGapAt: null,
  moreToRead: false,
  lastResult: null,
  ...over,
});

const ago = (at: number) => `at ${at}`;

test('stars are clamped to five and described in words', () => {
  assert.equal(ratingText(1), '1 out of 5 stars');
  assert.equal(ratingText(4), '4 out of 5 stars');
  assert.equal(ratingText(9), '5 out of 5 stars');
  assert.equal(ratingText(Number.NaN), '0 out of 5 stars');
  assert.deepEqual(starFill(3), [true, true, true, false, false]);
  assert.deepEqual(starFill(-2), [false, false, false, false, false]);
});

test('averageText shows one decimal or a dash', () => {
  assert.equal(averageText(4.256), '4.3');
  assert.equal(averageText(null), '–');
});

test('long text is cut at a word and short text is left alone', () => {
  assert.deepEqual(collapseText('short', 20), { text: 'short', cut: false });
  const cut = collapseText('alpha beta gamma delta epsilon zeta', 20);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.endsWith('…'));
  assert.ok(!cut.text.includes('epsilon'));
  // No space to break on: cut at the limit.
  assert.equal(collapseText('x'.repeat(50), 10).text, `${'x'.repeat(10)}…`);
});

test('markup in a review stays text: nothing here escapes or rewrites it', () => {
  const evil = '<img src=x onerror=alert(1)> <script>1</script>';
  assert.equal(collapseText(evil, 500).text, evil);
});

test('facts skip what is missing', () => {
  assert.deepEqual(reviewFacts({ device: null, appVersion: null, buildNumber: null, territory: null, language: null }), []);
  const facts = reviewFacts({ device: 'Pixel 8', appVersion: '1.0', buildNumber: '7', territory: null, language: 'de' });
  assert.deepEqual(facts, ['Pixel 8', 'Version 1.0 (7)', 'de']);
  assert.ok(reviewFacts({ device: null, appVersion: null, buildNumber: null, territory: 'US', language: null })[0]?.includes('US'));
});

test('filters become a query string without review text', () => {
  const f = defaultFilters();
  assert.equal(filtersToQuery(f), '');
  assert.equal(hasActiveFilters(f), false);
  f.ratings = [2, 1];
  f.statuses = ['new', 'triaged'];
  f.response = 'no';
  f.version = ' 3.2.0 ';
  f.q = ' crash ';
  f.since = 1700000000000.9;
  f.sort = 'rating';
  const q = new URLSearchParams(filtersToQuery(f, { limit: 25, cursor: 'abc' }));
  assert.equal(q.get('rating'), '1,2');
  assert.equal(q.get('status'), 'new,triaged');
  assert.equal(q.get('hasResponse'), 'false');
  assert.equal(q.get('version'), '3.2.0');
  assert.equal(q.get('q'), 'crash');
  assert.equal(q.get('since'), '1700000000000');
  assert.equal(q.get('sort'), 'rating');
  assert.equal(q.get('limit'), '25');
  assert.equal(q.get('cursor'), 'abc');
  assert.equal(hasActiveFilters(f), true);
  // The default sort is not sent.
  assert.equal(new URLSearchParams(filtersToQuery(defaultFilters())).has('sort'), false);
  // The search term is capped like the server's.
  f.q = 'x'.repeat(300);
  assert.equal(new URLSearchParams(filtersToQuery(f)).get('q')?.length, 100);
});

test('toggleIn adds and removes', () => {
  assert.deepEqual(toggleIn([1, 2], 3), [1, 2, 3]);
  assert.deepEqual(toggleIn([1, 2], 2), [1]);
});

test('sinceFor counts back from now', () => {
  assert.equal(sinceFor(null, 10), null);
  assert.equal(sinceFor(7, 8 * 86_400_000), 86_400_000);
});

test('pages are appended without duplicates and one review can be replaced in place', () => {
  const a = review({ id: 'a' });
  const b = review({ id: 'b' });
  const c = review({ id: 'c' });
  assert.deepEqual(appendPage([a, b], [b, c]).map((r) => r.id), ['a', 'b', 'c']);
  const changed = review({ id: 'b', status: 'ignored' });
  assert.deepEqual(replaceReview([a, b, c], changed).map((r) => r.status), ['new', 'ignored', 'new']);
});

test('a triage edit sends only what changed', () => {
  const r = review({ status: 'new', assigneeUserId: null, internalNote: null });
  assert.deepEqual(triageDiff(r, { status: 'new', assigneeUserId: null, internalNote: '  ' }), {});
  assert.deepEqual(triageDiff(r, { status: 'triaged', assigneeUserId: null, internalNote: '' }), { status: 'triaged' });
  assert.deepEqual(triageDiff(r, { status: 'new', assigneeUserId: 'u1', internalNote: 'call them' }), {
    assigneeUserId: 'u1',
    internalNote: 'call them',
  });
  const noted = review({ internalNote: 'old', assigneeUserId: 'u1' });
  assert.deepEqual(triageDiff(noted, { status: 'new', assigneeUserId: null, internalNote: '' }), {
    assigneeUserId: null,
    internalNote: null,
  });
  assert.deepEqual(triageDiff(noted, { status: 'new', assigneeUserId: 'u1', internalNote: 'old' }), {});
});

test('histogram bars run from five stars down, full width for the largest', () => {
  const bars = histogramBars([1, 0, 2, 3, 4]);
  assert.deepEqual(bars.map((b) => b.stars), [5, 4, 3, 2, 1]);
  assert.equal(bars[0]?.share, 1);
  assert.equal(bars[0]?.percent, 40);
  assert.equal(bars[4]?.count, 1);
  assert.equal(bars[3]?.share, 0);
  const empty = histogramBars([]);
  assert.equal(empty.length, 5);
  assert.ok(empty.every((b) => b.count === 0 && b.share === 0 && b.percent === 0));
});

const weeks = (...rows: [number, number | null][]): WeekBucket[] =>
  rows.map(([count, average], i) => ({ weekStart: i * 604_800_000, count, average }));

test('the trend geometry stays inside its box and breaks the line at an empty week', () => {
  const g = trendGeometry(weeks([2, 4], [4, 3], [0, null], [1, 5]), 100, 50, 5);
  assert.equal(g.bars.length, 4);
  for (const bar of g.bars) {
    assert.ok(bar.x >= 0 && bar.x + bar.w <= 100, 'bar inside the width');
    assert.ok(bar.y >= 0 && bar.y + bar.h <= 50, 'bar inside the height');
  }
  assert.equal(g.bars[2]?.h, 0);
  assert.equal(g.bars[1]?.h, 40, 'the busiest week fills the plot height');
  assert.equal(g.segments.length, 2);
  assert.equal(g.segments[0]?.length, 2);
  assert.equal(g.segments[1]?.length, 1);
  for (const point of g.segments.flat()) assert.ok(point.y >= 5 && point.y <= 45);
  // A five star week is at the top, a one star week at the bottom.
  const top = trendGeometry(weeks([1, 5]), 100, 50, 5).segments[0]?.[0]?.y;
  const bottom = trendGeometry(weeks([1, 1]), 100, 50, 5).segments[0]?.[0]?.y;
  assert.equal(top, 5);
  assert.equal(bottom, 45);
  assert.deepEqual(trendGeometry([]).bars, []);
});

test('the trend has a text alternative', () => {
  assert.equal(trendDescription(weeks([0, null], [0, null])), 'No reviews in these 2 weeks.');
  const text = trendDescription(weeks([2, 4], [4, 3], [0, null]));
  assert.ok(text.startsWith('3 weeks, 2 to 4 reviews'));
  assert.ok(text.includes('3.0 to 4.0'));
});

test('sync notices put a failure first, then a gap, then the backlog', () => {
  const none = syncNotices(state(), 9000, ago);
  assert.deepEqual(none, []);
  const notices = syncNotices(
    state({
      lastError: 'The store did not answer.',
      consecutiveFailures: 3,
      moreToRead: true,
      backoffUntil: 20_000,
      lastResult: result({ gap: { from: 1000, to: 900_000_000 }, warnings: ['Something small.'] }),
    }),
    9000,
    ago,
  );
  assert.equal(notices[0]?.tone, 'error');
  assert.ok(notices[0]?.text.includes('3 times in a row'));
  assert.ok(notices[0]?.text.includes('at 5000'));
  assert.equal(notices[1]?.tone, 'warn');
  assert.ok(notices[1]?.text.includes('cannot be recovered'));
  assert.ok(notices.some((n) => n.text.includes('still being read')));
  assert.ok(notices.some((n) => n.text === 'Something small.'));
  assert.ok(notices.some((n) => n.text.includes('waits until')));
  // A past backoff is not mentioned.
  assert.ok(!syncNotices(state({ lastError: 'x', backoffUntil: 100 }), 9000, ago).some((n) => n.text.includes('waits until')));
  // An old gap is remembered even when the last read had none.
  const old = syncNotices(state({ lastGapAt: 3000 }), 9000, ago);
  assert.equal(old[0]?.tone, 'warn');
});

test('texts for the last read and the result of one', () => {
  assert.equal(lastReadText(state({ lastSuccessAt: null }), ago), 'Not read yet.');
  assert.equal(lastReadText(state(), ago), 'Last read at 5000.');
  assert.equal(syncSummaryText(result()), 'Read 12 reviews: 3 new, 2 changed.');
  assert.equal(syncSummaryText(result({ fetched: 1, responses: 2 })), 'Read 1 review: 3 new, 2 changed, 2 with a changed developer response.');
  assert.ok(syncSummaryText(result({ complete: false })).endsWith('read again to continue.'));
});

test('error messages are plain and keep what the store said', () => {
  const error = (status: number, code: string, message = '', body: Record<string, unknown> = {}) =>
    new ApiError(status, code, message, undefined, { message, ...body });
  assert.equal(reviewErrorMessage(new Error('x')), 'Something went wrong. Try again.');
  assert.ok(reviewErrorMessage(error(403, 'forbidden'), 'sync').includes('member or admin'));
  assert.ok(reviewErrorMessage(error(403, 'forbidden'), 'triage').includes('triage'));
  assert.ok(reviewErrorMessage(error(409, 'sync_in_progress')).includes('already being read'));
  assert.ok(reviewErrorMessage(error(422, 'app_not_synced')).includes('Sync the app'));
  assert.ok(reviewErrorMessage(error(422, 'store_forbidden', 'Not allowed.'), 'sync').includes('Not allowed.'));
  assert.ok(reviewErrorMessage(error(422, 'assignee_not_member'), 'triage').includes('not a member'));
  assert.equal(reviewErrorMessage(error(500, 'weird'), 'load'), 'Reviews could not be loaded. Try again.');
});

test('status labels', () => {
  assert.equal(statusLabel('replied_in_console'), 'Replied in store console');
  assert.equal(statusLabel('something_new'), 'something_new');
});

// ----- the workspace-wide inbox ---------------------------------------------------------------

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

test('inbox filters: the defaults send nothing; every filter becomes its query parameter', () => {
  assert.equal(inboxFiltersToQuery(defaultInboxFilters(), NOW), '');
  assert.equal(hasActiveInboxFilters(defaultInboxFilters()), false);
  const f = {
    ...defaultInboxFilters(),
    appIds: ['a1', 'a2'],
    platform: 'android' as const,
    ratings: [2, 1],
    statuses: ['new' as const],
    response: 'no' as const,
    assignee: 'me',
    within: '30' as const,
    sort: 'rating' as const,
    q: ' crash ',
  };
  const query = new URLSearchParams(inboxFiltersToQuery(f, NOW, { limit: 25, cursor: 'abc' }));
  assert.equal(query.get('appIds'), 'a1,a2');
  assert.equal(query.get('platform'), 'android');
  assert.equal(query.get('rating'), '1,2');
  assert.equal(query.get('status'), 'new');
  assert.equal(query.get('hasResponse'), 'false');
  assert.equal(query.get('assignee'), 'me');
  assert.equal(query.get('since'), String(NOW - 30 * DAY_MS));
  assert.equal(query.get('sort'), 'rating');
  assert.equal(query.get('q'), 'crash');
  assert.equal(query.get('limit'), '25');
  assert.equal(query.get('cursor'), 'abc');
  const unassigned = new URLSearchParams(inboxFiltersToQuery({ ...defaultInboxFilters(), assignee: 'unassigned' }, NOW));
  assert.equal(unassigned.get('unassigned'), 'true');
  assert.equal(unassigned.get('assignee'), null);
  assert.equal(hasActiveInboxFilters({ ...defaultInboxFilters(), within: '7' }), true);
});

test('inbox filters round trip through the page address', () => {
  const f = {
    ...defaultInboxFilters(),
    appIds: ['a1'],
    platform: 'ios' as const,
    ratings: [1, 2],
    statuses: ['new' as const, 'triaged' as const],
    response: 'yes' as const,
    assignee: 'unassigned',
    version: '1.2',
    territory: 'US',
    language: 'en',
    q: 'a b&c=d',
    within: '90' as const,
    sort: 'updated' as const,
  };
  const search = inboxFiltersToSearch(f);
  assert.deepEqual(inboxFiltersFromSearch(search), f);
  assert.equal(inboxHref(defaultInboxFilters()), '#/reviews');
  assert.deepEqual(parseInboxHash(inboxHref(f)), f);
  assert.deepEqual(parseInboxHash('#/reviews'), defaultInboxFilters());
  assert.deepEqual(inboxForApp('x1'), '#/reviews?apps=x1');
  assert.equal(appPageHref('a b'), '#/portfolio/a%20b');
});

test('the address is not trusted: invalid values are dropped', () => {
  const f = inboxFiltersFromSearch('rating=9&status=bogus&sort=oldest&within=1&platform=windows&apps=a%20b&assignee=a/b&response=maybe&territory=x%20y&language=1');
  assert.deepEqual(f, defaultInboxFilters());
  assert.equal(inboxFiltersFromSearch(`q=${'x'.repeat(300)}`).q.length, 100);
  assert.deepEqual(inboxFiltersFromSearch('rating=1,1,2').ratings, [1, 2]);
  assert.deepEqual(inboxFiltersFromSearch('?apps=a,b,a').appIds, ['a', 'b']);
});

test('quick views open the counts of the summary strip', () => {
  assert.deepEqual(quickViewFilters('new', 2).statuses, ['new']);
  const unanswered = quickViewFilters('unanswered', 2);
  assert.equal(unanswered.response, 'no');
  assert.ok(!unanswered.statuses.includes('ignored'));
  const low = quickViewFilters('low', 2);
  assert.deepEqual(low.ratings, [1, 2]);
  assert.ok(!low.statuses.includes('ignored'));
  assert.deepEqual(quickViewFilters('low', 0).ratings, []);
  assert.equal(quickViewFilters('mine', 2).assignee, 'me');
});

const summaryApp = (name: string, n: number, u: number, l: number): SummaryApp => ({
  app: { id: name, name, platform: 'ios', store: 'appstoreconnect' },
  total: n + u,
  new: n,
  unanswered: u,
  lowRating: l,
  average: null,
  oldestAt: null,
  newestAt: null,
});

test('the summary strip text and the busiest apps', () => {
  assert.equal(summaryStripText({ total: 8, new: 3, unanswered: 5, lowRating: 2, average: 3 }), '3 new, 5 unanswered, 2 low rated, in 8 stored reviews.');
  assert.equal(summaryStripText({ total: 1, new: 0, unanswered: 0, lowRating: 0, average: null }), '0 new, 0 unanswered, 0 low rated, in 1 stored review.');
  const apps = [summaryApp('Quiet', 0, 0, 0), summaryApp('B', 2, 1, 0), summaryApp('A', 2, 1, 0), summaryApp('C', 5, 0, 0), summaryApp('D', 0, 4, 1)];
  assert.deepEqual(busiestApps(apps).map((a) => a.app.name), ['C', 'A', 'B', 'D']);
  assert.deepEqual(busiestApps(apps, 2).map((a) => a.app.name), ['C', 'A']);
  assert.deepEqual(busiestApps(apps, 0), []);
});

test('inbox lists: replacing keeps the app, appending skips what is there', () => {
  const app = { id: 'a1', name: 'Alpha', platform: 'ios' as const };
  const list: InboxReview[] = [{ ...review({ id: 'r1' }), app }, { ...review({ id: 'r2' }), app }];
  const next = replaceInboxReview(list, review({ id: 'r2', status: 'triaged' }));
  assert.equal(next[1]?.status, 'triaged');
  assert.deepEqual(next[1]?.app, app);
  assert.equal(next[0], list[0]);
  assert.deepEqual(appendInboxPage(list, [{ ...review({ id: 'r2' }), app }, { ...review({ id: 'r3' }), app }]).map((r) => r.id), ['r1', 'r2', 'r3']);
});

test('keyboard: shortcuts never fire while typing or with a modifier', () => {
  assert.equal(shortcutFor({ key: 'j', typing: false }), 'next');
  assert.equal(shortcutFor({ key: 'ArrowDown', typing: false }), 'next');
  assert.equal(shortcutFor({ key: 'k', typing: false }), 'previous');
  assert.equal(shortcutFor({ key: 'ArrowUp', typing: false }), 'previous');
  assert.equal(shortcutFor({ key: 'Home', typing: false }), 'first');
  assert.equal(shortcutFor({ key: 'End', typing: false }), 'last');
  assert.equal(shortcutFor({ key: 't', typing: false }), 'triage');
  assert.equal(shortcutFor({ key: 'r', typing: false }), 'reply');
  assert.equal(shortcutFor({ key: '/', typing: false }), 'search');
  assert.equal(shortcutFor({ key: 'r', typing: true }), null, 'typing a reply is not a shortcut');
  assert.equal(shortcutFor({ key: 't', typing: false, metaKey: true }), null);
  assert.equal(shortcutFor({ key: 'j', typing: false, ctrlKey: true }), null);
  assert.equal(shortcutFor({ key: 'x', typing: false }), null);
});

test('keyboard: moving stays inside the list', () => {
  assert.equal(moveIndex(-1, 3, 'next'), 0);
  assert.equal(moveIndex(0, 3, 'next'), 1);
  assert.equal(moveIndex(2, 3, 'next'), 2);
  assert.equal(moveIndex(0, 3, 'previous'), 0);
  assert.equal(moveIndex(-1, 3, 'previous'), 0);
  assert.equal(moveIndex(1, 3, 'last'), 2);
  assert.equal(moveIndex(2, 3, 'first'), 0);
  assert.equal(moveIndex(1, 0, 'next'), -1);
  assert.equal(moveIndex(1, 3, 'reply'), 1);
});

test('the announcement for a changed list', () => {
  assert.equal(inboxAnnouncement(0, false), 'No reviews match.');
  assert.equal(inboxAnnouncement(1, false), '1 review shown.');
  assert.equal(inboxAnnouncement(25, true), '25 or more reviews shown.');
});

test('reviewsOwner: a macOS record that shares its App Store id with an iOS record owns no reviews', () => {
  const ios = { id: 'i', platform: 'ios' as const, storeAppId: '555' };
  const mac = { id: 'm', platform: 'macos' as const, storeAppId: '555' };
  const macOnly = { id: 'm2', platform: 'macos' as const, storeAppId: '777' };
  assert.equal(reviewsOwner(mac, [ios, mac])?.id, 'i');
  assert.equal(reviewsOwner(macOnly, [ios, macOnly]), null);
  assert.equal(reviewsOwner({ platform: 'macos', storeAppId: null }, [ios]), null);
  assert.equal(reviewsOwner(ios, [ios, mac]), null);
});
