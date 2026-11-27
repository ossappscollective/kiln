import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStoreImages, type StoreImageFile, type StoreImageSet } from '@kiln/core';
import { overLimitOf } from './over-limit.ts';

const files = (n: number, prefix: string): StoreImageFile[] =>
  Array.from({ length: n }, (_, i) => ({
    ref: `${prefix}${i + 1}`,
    position: i + 1,
    name: `${i + 1}.png`,
    width: 2048,
    height: 2732,
    bytes: 1000,
    sizeFrom: 'store' as const,
    checksum: null,
    checksumKind: null,
    state: null,
    downloadable: true,
  }));
const set = (target: string, n: number, prefix: string): StoreImageSet => ({
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'ipad_13',
  deviceLabel: 'iPad 13" / 12.9"',
  target,
  files: files(n, prefix),
});

test('12 in one group: the two images past the limit, named by group and place, the sibling group left alone', () => {
  const view = { platform: 'ios' as const, sets: [set('APP_IPAD_PRO_3GEN_129', 12, 'a'), set('APP_IPAD_PRO_129', 3, 'b')] };
  const over = overLimitOf(checkStoreImages(view), view);
  assert.equal(over.length, 1);
  assert.equal(over[0]?.group, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(over[0]?.setId, 'en-US/screenshot/ipad_13');
  assert.deepEqual(over[0]?.extra, [
    { ref: 'a11', position: 11 },
    { ref: 'a12', position: 12 },
  ]);
});

test('10 + 2 siblings, or 10 in the group: nothing is over, nothing to remove', () => {
  const view = { platform: 'ios' as const, sets: [set('APP_IPAD_PRO_3GEN_129', 10, 'a'), set('APP_IPAD_PRO_129', 2, 'b')] };
  assert.deepEqual(overLimitOf(checkStoreImages(view), view), []);
  assert.deepEqual(overLimitOf([], null), []);
});
