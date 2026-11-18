import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetProblem, AssetSet } from '@mrm/core';
import { NOT_COMPARED } from './assets.ts';
import {
  defaultGroup,
  groupAvailability,
  groupOfKind,
  groupSummaries,
  sliceIndex,
  storeOnlyCount,
  storeStatusOf,
} from './assets-groups.ts';
import type { AssetItem } from './types.ts';

const item = (over: Partial<AssetItem> & { path: string }): AssetItem => ({
  locale: 'en-US',
  kind: 'screenshot',
  device: 'phone',
  deviceLabel: 'Phone',
  order: 1,
  bytes: 1,
  width: 1,
  height: 1,
  format: 'png',
  hasAlpha: false,
  oid: 'a',
  read: 'read',
  origin: 'store',
  ...over,
});

const problem = (over: Partial<AssetProblem>): AssetProblem => ({
  rule: 'r',
  severity: 'error',
  message: 'm',
  source: 's',
  verified: true,
  ...over,
});

const index = {
  assets: [
    item({ path: 'a/1.png' }),
    item({ path: 'a/2.png', order: 2 }),
    item({ path: 'a/feature.png', kind: 'feature_graphic', device: null, deviceLabel: '' }),
    item({ path: 'a/icon.png', kind: 'icon', locale: '', device: null, deviceLabel: '' }),
  ],
  sets: [] as AssetSet[],
  problems: [
    problem({ path: 'a/1.png' }),
    problem({ path: 'a/feature.png', severity: 'warning' }),
    problem({ kind: 'screenshot', locale: 'en-US', device: 'phone', severity: 'warning' }),
    problem({ severity: 'info' }),
  ],
};

test('kinds fall into the three groups', () => {
  assert.equal(groupOfKind('icon'), 'icon');
  assert.equal(groupOfKind('app_icon'), 'icon');
  assert.equal(groupOfKind('tv_banner'), 'play_graphics');
  assert.equal(groupOfKind('preview'), 'screenshots');
});

test('Google Play graphics only exist on an Android record, with a reason otherwise', () => {
  assert.equal(groupAvailability('play_graphics', 'android').available, true);
  const ios = groupAvailability('play_graphics', 'ios');
  assert.equal(ios.available, false);
  assert.ok(ios.reason?.includes('Google Play'));
  assert.equal(groupAvailability('screenshots', 'ios').available, true);
});

test('a slice keeps the files, the problems of its files and its own set problems', () => {
  const shots = sliceIndex(index, 'screenshots');
  assert.deepEqual(shots.assets.map((a) => a.path), ['a/1.png', 'a/2.png']);
  assert.equal(shots.problems.length, 2);
  assert.equal(sliceIndex(index, 'play_graphics').problems.length, 1);
  assert.equal(sliceIndex(index, 'icon').problems.length, 0);
});

test('summaries count files, errors and warnings per group', () => {
  const s = groupSummaries(index, 'ios');
  assert.deepEqual(s.map((g) => [g.id, g.files, g.errors, g.warnings, g.available]), [
    ['icon', 1, 0, 0, true],
    ['play_graphics', 1, 0, 1, false],
    ['screenshots', 2, 1, 1, true],
  ]);
  assert.equal(defaultGroup(s), 'screenshots');
  assert.equal(defaultGroup(groupSummaries({ assets: [], sets: [], problems: [] }, 'ios')), 'screenshots');
  assert.equal(defaultGroup(groupSummaries({ assets: [index.assets[3] as AssetItem], sets: [], problems: [] }, 'ios')), 'icon');
});

test('store status: not compared says so, same and differs follow the counts', () => {
  const none = storeStatusOf({ state: 'not_compared', text: NOT_COMPARED });
  assert.equal(none.id, 'in_repo');
  assert.ok(none.title.includes('Not yet compared'));
  assert.equal(storeStatusOf({ state: 'same', text: 't', storeCount: 3 }).id, 'in_both');
  assert.equal(storeStatusOf({ state: 'differs', text: 't', storeCount: 3 }).tone, 'warn');
  assert.equal(storeOnlyCount({ state: 'differs', text: 't', storeCount: 5 }, 3), 2);
  assert.equal(storeOnlyCount({ state: 'differs', text: 't', storeCount: 2 }, 3), 0);
  assert.equal(storeOnlyCount({ state: 'not_compared', text: 't' }, 3), 0);
});
