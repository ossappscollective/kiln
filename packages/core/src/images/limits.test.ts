import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetStoreOf, slotLimitProblem } from '../listing/staged-changes.ts';
import { ASSET_RULES } from '../listing/store-asset-specs.ts';
import { limitOf } from './limits.ts';

test('the limit table: screenshots 10 (Apple) and 8 (Play), previews 3, everything else none', () => {
  assert.deepEqual(limitOf('app_store', 'screenshot'), {
    max: 10,
    rule: 'apple.screenshot.count',
    stagedMax: 10,
  });
  assert.deepEqual(limitOf('google_play', 'screenshot', 'phone'), {
    max: 8,
    rule: 'play.screenshot.count',
    stagedMax: 8,
  });
  assert.deepEqual(limitOf('app_store', 'preview'), {
    max: 3,
    rule: 'apple.preview.count',
    stagedMax: 1,
  });
  for (const kind of [
    'icon',
    'feature_graphic',
    'promo_graphic',
    'tv_banner',
    'app_icon',
  ] as const) {
    assert.deepEqual(limitOf('google_play', kind), { max: null, rule: null, stagedMax: 1 }, kind);
    assert.deepEqual(limitOf('app_store', kind), { max: null, rule: null, stagedMax: 1 }, kind);
  }
});

test('the staged limit (slotLimitProblem) and the rule text read this table, never their own numbers', () => {
  assert.equal(
    limitOf(assetStoreOf('ios'), 'screenshot', 'iphone_6_9').stagedMax,
    limitOf('app_store', 'screenshot').stagedMax,
  );
  assert.equal(limitOf(assetStoreOf('macos'), 'screenshot', 'mac').stagedMax, 10);
  assert.equal(limitOf(assetStoreOf('android'), 'screenshot', 'phone').stagedMax, 8);
  assert.equal(limitOf(assetStoreOf('android'), 'feature_graphic', null).stagedMax, 1);
  const over = slotLimitProblem('ios', { kind: 'screenshot', device: 'ipad_13' }, 11);
  assert.equal(over?.max, 10);
  assert.equal(over?.rule, limitOf('app_store', 'screenshot').rule);
  // the rule text names the same number
  assert.match(ASSET_RULES['apple.screenshot.count']?.text ?? '', /10/);
  assert.match(ASSET_RULES['play.screenshot.count']?.text ?? '', /8/);
});
