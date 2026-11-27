import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkStoreImages,
  type StagedChangesView,
  type StoreImageFile,
  type StoreImageSet,
} from '@kiln/core';
import { buildGraphicSets } from './graphic-sets.ts';
import { overLimitOf } from './over-limit.ts';

const files = (n: number, prefix: string, from = 1): StoreImageFile[] =>
  Array.from({ length: n }, (_, i) => ({
    ref: `${prefix}${i + 1}`,
    position: from + i,
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
const set = (target: string, n: number, prefix: string, from = 1): StoreImageSet => ({
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'ipad_13',
  deviceLabel: 'iPad 13" / 12.9"',
  target,
  files: files(n, prefix, from),
});
const urls = {
  thumb: (r: string) => r,
  file: (r: string) => r,
  blob: (o: string) => o,
  repo: (p: string) => p,
};
const viewOf = (sets: StoreImageSet[]) => ({
  appId: 'a',
  platform: 'ios' as const,
  store: 'appstoreconnect' as const,
  version: null,
  readAt: 1,
  unplaced: 0,
  notes: [],
  sets,
});

test('12 in one group: the two rows past the limit, named by group and place, the sibling group left alone', () => {
  const view = viewOf([set('APP_IPAD_PRO_3GEN_129', 12, 'a'), set('APP_IPAD_PRO_129', 3, 'b', 13)]);
  const locales = buildGraphicSets({ platform: 'ios', view, staged: null, urls });
  const over = overLimitOf(checkStoreImages(view), locales).filter((o) => o.cause === 'group');
  assert.equal(over.length, 1);
  assert.equal(over[0]?.group, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(over[0]?.setId, 'en-US/screenshot/ipad_13');
  assert.deepEqual(
    over[0]?.extra.map((e) => e.key),
    ['a11', 'a12'],
  );
});

test('10 + 2 siblings: no group is over; the display is, for one staged set (trim 2); 10 in the group alone: nothing', () => {
  const view = viewOf([set('APP_IPAD_PRO_3GEN_129', 10, 'a'), set('APP_IPAD_PRO_129', 2, 'b', 11)]);
  const over = overLimitOf(
    checkStoreImages(view),
    buildGraphicSets({ platform: 'ios', view, staged: null, urls }),
  );
  assert.deepEqual(
    over.map((o) => [o.cause, o.count, o.max, o.extra.map((e) => e.key)]),
    [['display', 12, 10, ['b1', 'b2']]],
  );
  const alone = viewOf([set('APP_IPAD_PRO_3GEN_129', 10, 'a')]);
  assert.deepEqual(
    overLimitOf(
      checkStoreImages(alone),
      buildGraphicSets({ platform: 'ios', view: alone, staged: null, urls }),
    ),
    [],
  );
  assert.deepEqual(overLimitOf([], []), []);
});

test('the over-limit rows of a set that is already staged are the STAGED rows (a removal then names them by blob id)', () => {
  const view = viewOf([set('APP_IPAD_PRO_3GEN_129', 12, 'a')]);
  const staged = {
    assets: [
      {
        id: 'en-US/screenshot:ipad_13',
        kind: 'asset',
        locale: 'en-US',
        slot: { kind: 'screenshot', device: 'ipad_13' },
        slotKey: 'screenshot:ipad_13',
        label: 'x',
        source: 'local',
        status: 'changed',
        problems: [],
        pushedAt: null,
        pushed: false,
        createdAt: 1,
        updatedAt: 1,
        files: Array.from({ length: 11 }, (_, i) => ({
          id: `${i}`,
          position: i + 1,
          path: `uploads/${i}.png`,
          commit: '',
          oid: `o${i}`,
          bytes: 5,
          width: 2048,
          height: 2732,
          format: 'png',
          hasAlpha: false,
          upload: true,
        })),
      },
    ],
  } as unknown as StagedChangesView;
  const locales = buildGraphicSets({ platform: 'ios', view, staged, urls });
  // The problem the prediction gives for the staged set: 11 in the group the push writes.
  const problem = {
    severity: 'error',
    code: 'asset_spec',
    rule: 'apple.screenshot.count',
    message: 'm',
    locale: 'en-US',
    kind: 'screenshot',
    device: 'ipad_13',
    set: 'APP_IPAD_PRO_3GEN_129',
    count: 11,
    max: 10,
  } as never;
  const over = overLimitOf([problem], locales);
  assert.deepEqual(
    over[0]?.extra.map((e) => e.key),
    ['staged:o10:1'],
  );
});
