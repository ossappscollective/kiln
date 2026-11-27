import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as t from './timings.ts';

test('every timing is a positive whole number of milliseconds', () => {
  for (const [name, value] of Object.entries(t)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} is a positive integer`);
    assert.match(name, /_MS$/, `${name} says its unit`);
  }
});

test('the browser derives its freshness from the server value it mirrors', () => {
  assert.equal(t.READINESS_FRESH_MS, t.CURRENT_READINESS_TTL_MS);
  assert.equal(t.READ_CACHE_TTL_MS, t.STORE_VIEW_TTL_MS);
  assert.equal(t.APP_LIST_MAX_AGE_MS, t.READ_CACHE_TTL_MS);
});

test('a derived reading is never kept longer than the read it is made from', () => {
  assert.ok(t.CURRENT_READINESS_TTL_MS <= t.STORE_VIEW_TTL_MS, 'readiness <= store view');
  assert.ok(t.GRAPHICS_FRESH_MS <= t.STORE_VIEW_TTL_MS, 'graphics freshness <= store view');
  assert.ok(t.IMAGE_REF_TTL_MS >= t.STORE_VIEW_TTL_MS, 'a ref outlives the view that made it');
  assert.ok(
    t.BUILD_LIST_TTL_MS <= t.STORE_BUILDS_READ_TTL_MS,
    'the browser keeps builds at least as long as the server',
  );
});

test('publish liveness: beat < silent < claim ends, stuck is the longest', () => {
  assert.ok(t.PUBLISH_CLAIM_TTL_MS >= t.PUBLISH_HEARTBEAT_MS * 3, 'three beats can be missed');
  assert.ok(
    t.PUBLISH_SILENT_AFTER_MS > t.PUBLISH_HEARTBEAT_MS * 2,
    'a missed beat is not yet silence',
  );
  assert.ok(t.PUBLISH_SILENT_AFTER_MS < t.PUBLISH_STUCK_AFTER_MS);
  assert.equal(
    t.PUBLISH_SILENT_AFTER_MS,
    60_000,
    'the server value, not the former 45 seconds of the browser',
  );
  assert.ok(
    t.PUBLISH_POLL_VISIBLE_MS < t.PUBLISH_POLL_HIDDEN_MS &&
      t.PUBLISH_POLL_HIDDEN_MS <= t.PUBLISH_POLL_MAX_MS,
  );
});
