import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoreImagesView } from '@kiln/core';
import { createStoreCache, FRESH_MS, planFor, storeCacheKey } from './store-cache.ts';

const view = (appId: string, readAt = 1): StoreImagesView => ({
  appId, platform: 'android', store: 'googleplay', version: null, readAt, sets: [], unplaced: 0, notes: [],
});

test('a kept read is shown at once; an old one is shown and read again; nothing kept loads', () => {
  const c = createStoreCache(() => 100_000);
  const key = storeCacheKey('w', 'a', 'android');
  assert.equal(planFor(c.get(key), 100_000), 'load');
  c.set(key, view('a'), 100_000 - 5_000);
  assert.equal(planFor(c.get(key), 100_000), 'show');
  assert.equal(planFor(c.get(key), 100_000 + FRESH_MS), 'show_and_refresh');
});

test('an old entry is never dropped for its age (no flash of empty)', () => {
  let t = 0;
  const c = createStoreCache(() => t);
  c.set('w|a|ios', view('a'));
  t = 24 * 60 * 60 * 1000;
  assert.ok(c.get('w|a|ios'));
});

test('a publish drops every platform of the app and no other app', () => {
  const c = createStoreCache();
  c.set('w|a|ios', view('a'));
  c.set('w|a|android', view('a'));
  c.set('w|b|ios', view('b'));
  c.set('x|a|ios', view('a'));
  c.forgetApp('w', 'a');
  assert.equal(c.get('w|a|ios'), undefined);
  assert.equal(c.get('w|a|android'), undefined);
  assert.ok(c.get('w|b|ios'));
  assert.ok(c.get('x|a|ios'), 'another workspace is untouched');
});

test('the least recently used app goes when the cache is full', () => {
  const c = createStoreCache(Date.now, 2);
  c.set('w|1|ios', view('1'));
  c.set('w|2|ios', view('2'));
  c.get('w|1|ios');
  c.set('w|3|ios', view('3'));
  assert.equal(c.get('w|2|ios'), undefined);
  assert.ok(c.get('w|1|ios'));
  assert.equal(c.size(), 2);
});
