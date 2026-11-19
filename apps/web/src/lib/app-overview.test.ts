import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataChips } from './app-chips.ts';
import { groupApps } from './app-groups.ts';
import { buildOverviewRows, overviewStats, rowStatus } from './app-overview.ts';
import { attentionCount } from './nav-badges.ts';
import type { PipelineSummaryApp } from './release-pipeline.ts';
import type { ReleaseLoad } from './portfolio.ts';
import type { SummaryApp } from './reviews.ts';
import type { AppSummary, ReleaseSummary } from './types.ts';

const app = (id: string, platform: 'ios' | 'android', extra: Partial<AppSummary> = {}): AppSummary => ({
  id,
  name: 'Shop',
  platform,
  identifier: 'com.shop',
  storeAppId: null,
  credentialId: 'c',
  repositoryId: null,
  createdAt: 0,
  lastSyncedAt: 1000,
  lastSyncAttemptAt: null,
  lastSyncError: null,
  ...extra,
});
const rel = (appId: string, platform: 'ios' | 'android', version: string, status: ReleaseSummary['status']): ReleaseSummary => ({
  id: `${appId}-${version}`,
  appId,
  platform,
  version,
  track: platform === 'ios' ? null : 'production',
  build: null,
  status,
  rawState: status ?? 'x',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: null,
  syncedAt: 0,
});
const summaryApp = (id: string, platform: 'ios' | 'android', total: number, average: number | null, n: number): SummaryApp => ({
  app: { id, name: 'Shop', platform, store: platform === 'ios' ? 'appstoreconnect' : 'googleplay' },
  total,
  new: n,
  unanswered: 0,
  lowRating: 0,
  average,
  oldestAt: null,
  newestAt: null,
});

test('a merged row has both platforms, the most urgent status and weighted rating', () => {
  const groups = groupApps([app('i', 'ios'), app('d', 'android')]);
  const releases: Record<string, ReleaseLoad> = {
    i: { state: 'ready', releases: [rel('i', 'ios', '2.0.0', 'in_review'), rel('i', 'ios', '1.0.0', 'live')] },
    d: { state: 'ready', releases: [rel('d', 'android', '2.0.0', 'live')] },
  };
  const [row] = buildOverviewRows(groups, releases, [summaryApp('i', 'ios', 10, 5, 2), summaryApp('d', 'android', 30, 3, 1)]);
  assert.ok(row);
  assert.equal(row.ios?.state === 'ready' && row.ios.latest?.version, '2.0.0');
  assert.equal(row.attention?.status, 'in_review');
  assert.equal(row.ratingCount, 40);
  assert.equal(row.rating, 3.5);
  assert.equal(row.newReviews, 3);
});

test('rows tolerate unloaded releases and reviews', () => {
  const groups = groupApps([app('i', 'ios', { lastSyncedAt: null, lastSyncError: 'boom' })]);
  const [row] = buildOverviewRows(groups, {}, null);
  assert.ok(row);
  assert.deepEqual(row.ios, { state: 'loading' });
  assert.equal(row.android, null);
  assert.equal(row.rating, null);
  assert.equal(row.newReviews, null);
  assert.equal(row.syncFailed, true);
  assert.equal(row.syncedAt, null);
  assert.deepEqual(overviewStats([row]), { apps: 1, inReview: 0, rollingOut: 0, problems: 1, unfinished: 0, newReviews: null });
});

test('stats count rows by their most urgent release', () => {
  const groups = groupApps([app('i', 'ios', { name: 'A', identifier: 'a' }), app('j', 'ios', { name: 'B', identifier: 'b' }), app('k', 'ios', { name: 'C', identifier: 'c' })]);
  const releases: Record<string, ReleaseLoad> = {
    i: { state: 'ready', releases: [rel('i', 'ios', '1', 'in_review')] },
    j: { state: 'ready', releases: [rel('j', 'ios', '1', 'rejected')] },
    k: { state: 'ready', releases: [rel('k', 'ios', '1', 'rolling_out')] },
  };
  const stats = overviewStats(buildOverviewRows(groups, releases, [summaryApp('i', 'ios', 1, 4, 5)]));
  assert.deepEqual(stats, { apps: 3, inReview: 1, rollingOut: 1, problems: 1, unfinished: 0, newReviews: 5 });
});

test('dataChips reports repository link and sync from the records', () => {
  const now = 10 * 60_000;
  const linked = dataChips([app('i', 'ios', { repositoryId: 'r', lastSyncedAt: now - 5 * 60_000 })], now);
  assert.deepEqual(linked.map((c) => c.id), ['repository', 'store_live', 'store_draft']);
  assert.equal(linked[0]?.value, 'Linked');
  assert.equal(linked[1]?.value, 'Synced 5 minutes ago');
  assert.equal(linked[2]?.placeholder, true);
  const mixed = dataChips([app('i', 'ios', { repositoryId: 'r' }), app('d', 'android', { lastSyncedAt: null })], now);
  assert.equal(mixed[0]?.value, 'Linked on 1 of 2');
  assert.equal(mixed[1]?.value, 'Not synced yet');
  assert.equal(dataChips([app('i', 'ios', { lastSyncError: 'x' })], now)[1]?.tone, 'warn');
});

test('a release left unfinished counts for the app and for the badge, a stale one does not', () => {
  const stall = (stale: boolean) => ({ step: 'approved', label: 'x', message: 'm', hours: 30, since: 1, stale, evidence: [] });
  const groups = groupApps([app('i', 'ios'), app('d', 'android')]);
  const line = (id: string, stale: boolean | null) =>
    ({ app: { id, name: id, platform: 'ios', store: 'appstoreconnect' }, state: 'approved', waitingOn: 'you', since: 1, summary: '', lastSyncedAt: 1, stalled: stale === null ? null : stall(stale) }) as unknown as PipelineSummaryApp;
  const [row] = buildOverviewRows(groups, {}, null, [line('i', false), line('d', true)]);
  assert.deepEqual(row!.unfinished.map((p) => p.app.id), ['i']);
  assert.equal(overviewStats([row!]).unfinished, 1);
  assert.equal(attentionCount([row!]), 1);
  const [quiet] = buildOverviewRows(groups, {}, null, [line('i', true), line('d', null)]);
  assert.equal(quiet!.unfinished.length, 0);
  assert.equal(attentionCount([quiet!]), 0);
});

test('the status cell has one pill, and unfinished releases collapse to one badge with a count', () => {
  const groups = groupApps([app('i', 'ios'), app('d', 'android')]);
  const stalled = (platform: 'ios' | 'android') =>
    ({ app: { id: platform === 'ios' ? 'i' : 'd', name: 'Shop', platform, store: 's' }, state: 'approved', waitingOn: 'you', since: 1, summary: '', lastSyncedAt: 1, stalled: { step: 'notes', label: 'x', message: `${platform} stalled`, hours: 80, since: 1, stale: false, evidence: [] } }) as unknown as PipelineSummaryApp;
  const releases: Record<string, ReleaseLoad> = { i: { state: 'ready', releases: [rel('i', 'ios', '2.0.0', 'in_review')] }, d: { state: 'ready', releases: [] } };

  const both = buildOverviewRows(groups, releases, null, [stalled('ios'), stalled('android')])[0];
  assert.ok(both);
  const s = rowStatus(both, false);
  assert.equal(s.primary.kind, 'release');
  assert.equal(s.unfinished?.count, 2);
  assert.equal(s.unfinished?.text, '2 releases left unfinished');
  assert.match(s.unfinished?.title ?? '', /iOS: ios stalled\nAndroid: android stalled/);

  const one = buildOverviewRows(groups, releases, null, [stalled('android')])[0];
  assert.ok(one);
  assert.equal(rowStatus(one, false).unfinished?.text, 'Release left unfinished: Android');
  assert.equal(rowStatus(one, false).unfinished?.count, 1);

  const none = buildOverviewRows(groups, releases, null, [])[0];
  assert.ok(none);
  assert.equal(rowStatus(none, false).unfinished, null);
});

test('a failed sync is the pill only when there is no release status; loading and empty are quiet', () => {
  const failing = groupApps([app('i', 'ios', { lastSyncError: 'boom' })]);
  const ready: Record<string, ReleaseLoad> = { i: { state: 'ready', releases: [] } };
  const row = buildOverviewRows(failing, ready, null)[0];
  assert.ok(row);
  assert.equal(rowStatus(row, false).primary.kind, 'sync-failed');
  const withRelease = buildOverviewRows(failing, { i: { state: 'ready', releases: [rel('i', 'ios', '1.0.0', 'live')] } }, null)[0];
  assert.ok(withRelease);
  assert.equal(rowStatus(withRelease, false).primary.kind, 'release');
  const quiet = buildOverviewRows(groupApps([app('i', 'ios')]), ready, null)[0];
  assert.ok(quiet);
  assert.deepEqual(rowStatus(quiet, false).primary, { kind: 'none', text: 'No releases' });
  assert.equal(rowStatus(quiet, true).primary.kind, 'loading');
  const fresh = buildOverviewRows(groupApps([app('i', 'ios', { lastSyncedAt: null })]), ready, null)[0];
  assert.ok(fresh);
  assert.deepEqual(rowStatus(fresh, false).primary, { kind: 'none', text: 'Not synced yet' });
});
