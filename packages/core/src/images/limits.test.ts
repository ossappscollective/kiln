import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSET_RULES } from '../listing/store-asset-specs.ts';
import { slotLimitProblem, slotMaxFiles } from '../listing/staged-changes.ts';
import { limitOf } from './limits.ts';

test('the limit table: screenshots 10 (Apple) and 8 (Play), previews 3, everything else none', () => {
  assert.deepEqual(limitOf('app_store', 'screenshot'), { max: 10, rule: 'apple.screenshot.count', stagedMax: 10 });
  assert.deepEqual(limitOf('google_play', 'screenshot', 'phone'), { max: 8, rule: 'play.screenshot.count', stagedMax: 8 });
  assert.deepEqual(limitOf('app_store', 'preview'), { max: 3, rule: 'apple.preview.count', stagedMax: 1 });
  for (const kind of ['icon', 'feature_graphic', 'promo_graphic', 'tv_banner', 'app_icon'] as const) {
    assert.deepEqual(limitOf('google_play', kind), { max: null, rule: null, stagedMax: 1 }, kind);
    assert.deepEqual(limitOf('app_store', kind), { max: null, rule: null, stagedMax: 1 }, kind);
  }
});

test('slotMaxFiles (staging) and the rule text read this table, never their own numbers', () => {
  assert.equal(slotMaxFiles('ios', { kind: 'screenshot', device: 'iphone_6_9' }), limitOf('app_store', 'screenshot').stagedMax);
  assert.equal(slotMaxFiles('macos', { kind: 'screenshot', device: 'mac' }), 10);
  assert.equal(slotMaxFiles('android', { kind: 'screenshot', device: 'phone' }), 8);
  assert.equal(slotMaxFiles('android', { kind: 'feature_graphic', device: null }), 1);
  const over = slotLimitProblem('ios', { kind: 'screenshot', device: 'ipad_13' }, 11);
  assert.equal(over?.max, 10);
  assert.equal(over?.rule, limitOf('app_store', 'screenshot').rule);
  // the rule text names the same number
  assert.match(ASSET_RULES['apple.screenshot.count']?.text ?? '', /10/);
  assert.match(ASSET_RULES['play.screenshot.count']?.text ?? '', /8/);
});
