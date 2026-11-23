import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SyncFacts, planKinds } from './sync-all.ts';

const facts = (over: Partial<SyncFacts> = {}): SyncFacts => ({
  platform: 'ios',
  hasStoreAppId: true,
  reviewsOwnedByIos: false,
  easLinked: false,
  analyticsEnabled: false,
  analyticsAppleReady: false,
  queued: new Set(),
  ...over,
});
const summary = (d: ReturnType<typeof planKinds>) => d.map((x) => `${x.kind}:${x.run ? 'run' : x.reason}`);

test('the order is critical first: app, reviews, eas, analytics', () => {
  assert.deepEqual(
    planKinds('owner', facts({ easLinked: true, analyticsEnabled: true, analyticsAppleReady: true })).map((d) => d.kind),
    ['app', 'reviews', 'eas', 'analytics'],
  );
});

test('what does not apply says why', () => {
  assert.deepEqual(summary(planKinds('owner', facts())), ['app:run', 'reviews:run', 'eas:not_linked', 'analytics:off']);
  assert.equal(summary(planKinds('owner', facts({ analyticsEnabled: true })))[3], 'analytics:not_ready');
  assert.equal(summary(planKinds('owner', facts({ analyticsEnabled: true, platform: 'android' })))[3], 'analytics:run');
  assert.equal(summary(planKinds('owner', facts({ hasStoreAppId: false })))[1], 'reviews:not_ready');
  assert.equal(summary(planKinds('owner', facts({ platform: 'macos', reviewsOwnedByIos: true })))[1], 'reviews:not_ready');
});

test('rights: a viewer runs nothing, a member cannot manage analytics, queued kinds are not queued twice', () => {
  assert.ok(summary(planKinds('viewer', facts({ easLinked: true }))).every((s) => s.endsWith('forbidden')));
  assert.equal(summary(planKinds('member', facts({ analyticsEnabled: true, analyticsAppleReady: true })))[3], 'analytics:forbidden');
  assert.equal(summary(planKinds('owner', facts({ queued: new Set(['app']) })))[0], 'app:already_queued');
});
