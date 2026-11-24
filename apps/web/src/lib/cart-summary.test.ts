import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CartSummary, createSummaryLoader, pendingAcrossText, pendingRows, pendingTotals } from './cart-summary.ts';
import type { AppSummary } from './types.ts';

const rec = (id: string, platform: 'ios' | 'android', name: string, identifier: string): AppSummary => ({
  id, name, platform, identifier, storeAppId: null, credentialId: 'c', repositoryId: null, createdAt: 0, lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncError: null,
});
const line = (id: string, platform: 'ios' | 'android', name: string, kinds: Record<string, number>) => ({
  appId: id, id, app: { id, name, platform, store: platform === 'ios' ? 'appstoreconnect' : 'googleplay' },
  count: Object.values(kinds).reduce((n, v) => n + v, 0), kinds,
});
const summary = (lines: ReturnType<typeof line>[]): CartSummary => ({
  apps: lines, totals: { apps: lines.length, count: lines.reduce((n, l) => n + l.count, 0) }, generatedAt: 1,
});
const apps = [rec('a-ios', 'ios', 'Shop', 'com.shop'), rec('a-and', 'android', 'Shop', 'com.shop'), rec('b', 'ios', 'Notes', 'com.notes')];

test('the records of one product are one row; the apps are counted as products, most pending first', () => {
  const s = summary([line('a-ios', 'ios', 'Shop', { listing: 2, graphics: 1 }), line('a-and', 'android', 'Shop', { listing: 1, review_reply: 2 }), line('b', 'ios', 'Notes', { price: 1 })]);
  const rows = pendingRows(s, apps);
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.appIds.length]), [['a-ios', 6, 2], ['b', 1, 1]]);
  assert.deepEqual(rows[0]?.kinds, [{ kind: 'listing', count: 3 }, { kind: 'graphics', count: 1 }, { kind: 'review_reply', count: 2 }]);
  assert.deepEqual(rows[0]?.platforms, ['ios', 'android']);
  assert.deepEqual(pendingTotals(rows, s), { changes: 7, apps: 2 });
  assert.equal(pendingAcrossText({ changes: 12, apps: 4 }), '12 pending changes across 4 apps');
  assert.equal(pendingAcrossText({ changes: 1, apps: 1 }), '1 pending change across 1 app');
});

test('nothing known is no badge; nothing pending is zero; unknown records stand alone', () => {
  assert.equal(pendingTotals([], null), null);
  assert.deepEqual(pendingTotals([], summary([])), { changes: 0, apps: 0 });
  assert.deepEqual(pendingRows(summary([line('x', 'ios', 'Solo', { listing: 1 })]), null).map((r) => r.key), ['x']);
});

function harness(read: (ws: string) => Promise<CartSummary>) {
  let changes = 0;
  const timers: (() => void)[] = [];
  let clock = 0;
  const loader = createSummaryLoader({
    read, onChange: () => void (changes += 1), now: () => clock,
    timer: (fn) => { timers.push(fn); return () => void timers.splice(timers.indexOf(fn), 1); },
  });
  return { loader, timers, changes: () => changes, tick: (ms: number) => void (clock += ms) };
}
const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => (resolve = r)); return { promise, resolve }; };

test('a burst of announcements is ONE read; ensure reads only when nothing is known or it is old', async () => {
  let reads = 0;
  const h = harness(async () => { reads += 1; return summary([line('b', 'ios', 'Notes', { price: 1 })]); });
  h.loader.request('w'); h.loader.request('w'); h.loader.request('w');
  assert.equal(h.timers.length, 1);
  h.timers[0]?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  await h.loader.ensure('w');
  assert.equal(reads, 1, 'fresh: no read on focus');
  h.tick(31_000);
  await h.loader.ensure('w');
  assert.equal(reads, 2);
});

test('another workspace drops the old count at once and a late answer of the old one is ignored', async () => {
  const slow = defer<CartSummary>();
  const h = harness((ws) => (ws === 'old' ? slow.promise : Promise.resolve(summary([line('n', 'ios', 'New', { listing: 5 })]))));
  const first = h.loader.refresh('old');
  await h.loader.refresh('new');
  assert.equal(h.loader.summaryOf('old'), null);
  assert.equal(h.loader.summaryOf('new')?.totals.count, 5);
  slow.resolve(summary([line('o', 'ios', 'Old', { listing: 99 })]));
  await first;
  assert.equal(h.loader.summaryOf('new')?.totals.count, 5, 'the old answer did not overwrite');
  assert.equal(h.loader.summaryOf('old'), null);
});

test('an older read of the same workspace never overwrites a newer one; a failed read keeps what was shown', async () => {
  const a = defer<CartSummary>();
  let n = 0;
  const h = harness(() => (++n === 1 ? a.promise : n === 2 ? Promise.resolve(summary([line('b', 'ios', 'B', { listing: 2 })])) : Promise.reject(new Error('offline'))));
  const slow = h.loader.refresh('w');
  await h.loader.refresh('w');
  a.resolve(summary([line('b', 'ios', 'B', { listing: 1 })]));
  await slow;
  assert.equal(h.loader.summaryOf('w')?.totals.count, 2);
  await h.loader.refresh('w');
  assert.equal(h.loader.summaryOf('w')?.totals.count, 2);
});
