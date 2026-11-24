import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRESH_MS,
  PAGE_KINDS,
  failedCount,
  freshnessOf,
  mainLabelKey,
  planPage,
  runProgress,
  syncPageFor,
} from './sync-plan.ts';
import type { Reading, SourceInput, SyncKind } from './sync-sources.ts';

const NOW = 1_000_000_000_000;
const fresh = (kind: SyncKind): number => NOW - FRESH_MS[kind] / 2;
const stale = (kind: SyncKind): number => NOW - FRESH_MS[kind] * 2;
const input = (
  kind: SyncKind,
  reading: Partial<Reading>,
  appId = 'a',
  platform = 'ios',
): SourceInput => ({
  appId,
  platform,
  kind,
  reading: { lastReadAt: null, lastAttemptAt: null, failed: false, ...reading },
});
const all = () => true;
const plan = (
  inputs: SourceInput[],
  page: Parameters<typeof planPage>[1]['page'],
  allowed: (k: SyncKind) => boolean = all,
) => planPage(inputs, { page, now: NOW, allowed });
const brief = (p: ReturnType<typeof planPage>) =>
  p.main?.targets.map((t) => `${t.appId}:${t.kind}${t.sources ? `[${t.sources}]` : ''}`);

test('a section maps to the page that syncs what it shows', () => {
  assert.equal(syncPageFor('insights'), 'analytics');
  assert.equal(syncPageFor('analytics'), 'analytics');
  // Ratings and health read the reviews (ratings) and the analytics (crashes): both belong to the page.
  assert.equal(syncPageFor('insights', 'ratings'), 'health');
  // Timeline and reports: the app read (releases, listing history), reviews and analytics.
  assert.equal(syncPageFor('insights', 'timeline'), 'timeline');
  assert.deepEqual([...PAGE_KINDS.timeline], ['app', 'reviews', 'analytics']);
  assert.equal(syncPageFor('insights', 'countries'), 'analytics');
  assert.deepEqual([...PAGE_KINDS.health], ['reviews', 'analytics']);
  assert.equal(syncPageFor('reviews'), 'reviews');
  assert.equal(syncPageFor('products'), 'products');
  assert.equal(syncPageFor('builds'), 'builds');
  assert.equal(syncPageFor('test-builds'), 'builds');
  for (const s of ['dashboard', 'listing', 'releases', 'aso', 'settings', 'pending'] as const)
    assert.equal(syncPageFor(s), 'listing');
  assert.deepEqual(PAGE_KINDS.builds, ['eas', 'testflight']);
});

test('freshness: failed beats an old read, never beats stale, a recent read is fresh', () => {
  assert.equal(
    freshnessOf(input('reviews', { lastReadAt: fresh('reviews'), failed: true }), NOW),
    'failed',
  );
  assert.equal(freshnessOf(input('reviews', {}), NOW), 'never');
  assert.equal(freshnessOf(input('reviews', { lastReadAt: stale('reviews') }), NOW), 'stale');
  assert.equal(freshnessOf(input('reviews', { lastReadAt: fresh('reviews') }), NOW), 'fresh');
});

test("the main action reads only the page's kinds, and only what is not fresh", () => {
  const inputs = [
    input('reviews', { lastReadAt: stale('reviews') }),
    input('app', { lastReadAt: stale('app') }),
    input('analytics', { lastReadAt: stale('analytics') }),
  ];
  const p = plan(inputs, 'reviews');
  assert.equal(p.main?.mode, 'due');
  assert.deepEqual(brief(p), ['a:reviews']);
  assert.equal(mainLabelKey(p).key, 'app:syncButton.label.reviews');
  // Everything fresh: the button still works and reads the page again.
  const f = plan([input('reviews', { lastReadAt: fresh('reviews') })], 'reviews');
  assert.equal(f.main?.mode, 'fresh');
  assert.deepEqual(brief(f), ['a:reviews']);
});

test('failed things turn the button into a retry with their count, failed first', () => {
  const inputs = [
    input('eas', { lastReadAt: stale('eas') }),
    input('testflight', { lastReadAt: fresh('testflight'), failed: true }),
  ];
  const p = plan(inputs, 'builds');
  assert.equal(p.main?.mode, 'retry');
  assert.deepEqual(brief(p), ['a:testflight']);
  assert.deepEqual(mainLabelKey(p), { key: 'app:syncButton.retry', failed: 1 });
  assert.equal(p.menu[0]?.onPage, true);
});

test('analytics: failed sources first and alone, then the sources that are not fresh, a fresh one is left alone', () => {
  const parts = [
    { id: 'play_vitals', lastReadAt: fresh('analytics'), failed: false },
    { id: 'play_reports', lastReadAt: fresh('analytics'), failed: true },
    { id: 'play_sales', lastReadAt: stale('analytics'), failed: true },
  ];
  const a = plan(
    [input('analytics', { parts, failed: true, lastReadAt: fresh('analytics') }, 'a', 'android')],
    'analytics',
  );
  assert.deepEqual(brief(a), ['a:analytics[play_reports,play_sales]']);
  assert.equal(a.main?.count, 2);
  assert.equal(failedCount(a.failed), 2);
  const ok = plan(
    [
      input('analytics', {
        parts: [
          parts[0] as never,
          { id: 'play_sales', lastReadAt: stale('analytics'), failed: false },
        ],
        lastReadAt: fresh('analytics'),
      }),
    ],
    'analytics',
  );
  assert.equal(ok.main?.mode, 'due');
  assert.deepEqual(brief(ok), ['a:analytics[play_sales]']);
});

test('several records: failed first, then never read, then the platform', () => {
  const p = plan(
    [
      input('reviews', { lastReadAt: stale('reviews') }, 'a', 'ios'),
      input('reviews', {}, 'b', 'android'),
      input('reviews', { failed: true, lastReadAt: stale('reviews') }, 'c', 'macos'),
    ],
    'reviews',
  );
  assert.equal(p.main?.mode, 'retry');
  assert.deepEqual(brief(p), ['c:reviews']);
  assert.deepEqual(
    p.everything.map((t) => t.appId),
    ['c', 'b', 'a'],
  );
});

test('rights: a kind the role may not run is neither run nor listed; nothing applicable means no main action', () => {
  const inputs = [
    input('analytics', { lastReadAt: stale('analytics') }),
    input('app', { lastReadAt: stale('app') }),
  ];
  const p = plan(inputs, 'analytics', (k) => k !== 'analytics');
  assert.equal(p.main, null);
  assert.deepEqual(
    p.menu.map((m) => m.kind),
    ['app'],
  );
  assert.equal(plan([], 'listing').main, null);
});

test('the menu lists each kind with its read and failures, the page first; nothing failed means no failed targets', () => {
  const p = plan(
    [
      input('app', { lastReadAt: fresh('app') }),
      input('reviews', { lastReadAt: stale('reviews') }),
      input('products', { failed: true, lastReadAt: stale('products') }),
    ],
    'products',
  );
  assert.deepEqual(
    p.menu.map((m) => m.kind),
    ['products', 'app', 'reviews'],
  );
  assert.equal(p.menu[0]?.failed, 1);
  assert.equal(p.failed.length, 1);
  assert.equal(p.everything.length, 3);
  assert.equal(plan([input('app', { lastReadAt: fresh('app') })], 'listing').failed.length, 0);
});

test('progress counts the started kinds that ended', () => {
  assert.deepEqual(
    runProgress({
      'a:app': 'done',
      'a:reviews': 'running',
      'a:eas': 'skipped',
      'a:analytics': 'failed',
    }),
    { done: 2, total: 3 },
  );
});
