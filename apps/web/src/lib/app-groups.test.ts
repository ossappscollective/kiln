import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupApps, groupOf } from './app-groups.ts';
import type { AppSummary } from './types.ts';

const app = (
  id: string,
  platform: 'ios' | 'android',
  name: string,
  identifier: string,
): AppSummary => ({
  id,
  name,
  platform,
  identifier,
  storeAppId: null,
  credentialId: 'c',
  repositoryId: null,
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncAttemptAt: null,
  lastSyncError: null,
});

test('pairs iOS and Android by identifier, then by name', () => {
  const groups = groupApps([
    app('a-and', 'android', 'Shop', 'com.shop'),
    app('a-ios', 'ios', 'Shop', 'com.shop'),
    app('b-and', 'android', 'Notes Android', 'com.notes.app'),
    app('b-ios', 'ios', 'Notes', 'com.notes.app'),
    app('c-ios', 'ios', 'Maps', 'com.maps.ios'),
    app('c-and', 'android', 'maps', 'com.maps.android'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.members.map((m) => m.id)),
    [
      ['c-ios', 'c-and'],
      ['b-ios', 'b-and'],
      ['a-ios', 'a-and'],
    ],
  );
  assert.equal(groups[0]?.key, 'c-ios');
});

test('a record with no partner, or an ambiguous one, stays alone', () => {
  const groups = groupApps([
    app('i1', 'ios', 'Solo', 'com.solo'),
    app('x1', 'ios', 'Twin', 'com.twin'),
    app('x2', 'ios', 'Twin', 'com.twin2'),
    app('x3', 'android', 'Twin', 'com.twin3'),
  ]);
  const sizes = groups.map((g) => g.members.length).sort();
  assert.deepEqual(sizes, [1, 1, 1, 1]);
  assert.equal(groups.find((g) => g.name === 'Solo')?.android, null);
});

test('groupOf finds the group of either record', () => {
  const groups = groupApps([app('i', 'ios', 'A', 'a'), app('d', 'android', 'A', 'a')]);
  assert.equal(groupOf(groups, 'd')?.key, 'i');
  assert.equal(groupOf(groups, 'zzz'), null);
});

test('joins iOS, macOS and Android into one group, in that order, with the same or another bundle id', () => {
  const m = (id: string, platform: 'ios' | 'macos' | 'android', name: string, identifier: string) =>
    app(id, platform as 'ios', name, identifier);
  const groups = groupApps([
    m('a-and', 'android', 'Trail', 'com.trail'),
    m('a-mac', 'macos', 'Trail', 'com.trail'),
    m('a-ios', 'ios', 'Trail', 'com.trail'),
    // A Mac app with its own bundle id joins by name.
    m('b-ios', 'ios', 'Notes', 'com.notes.ios'),
    m('b-mac', 'macos', 'Notes', 'com.notes.mac'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.members.map((x) => x.id)),
    [
      ['b-ios', 'b-mac'],
      ['a-ios', 'a-mac', 'a-and'],
    ],
  );
  const trail = groups[1];
  assert.deepEqual(trail?.platforms, ['ios', 'macos', 'android']);
  assert.equal(trail?.macos?.id, 'a-mac');
  assert.equal(trail?.key, 'a-ios');
  assert.equal(groups[0]?.android, null);
  assert.equal(groupOf(groups, 'a-mac')?.key, 'a-ios');
});

test('a macOS app alone, or with two iOS candidates, stays alone', () => {
  const m = (id: string, platform: 'ios' | 'macos', name: string, identifier: string) =>
    app(id, platform as 'ios', name, identifier);
  const groups = groupApps([
    m('m1', 'macos', 'Solo', 'com.solo'),
    m('i1', 'ios', 'Twin', 'com.a'),
    m('i2', 'ios', 'Twin', 'com.b'),
    m('m2', 'macos', 'Twin', 'com.c'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.members.length),
    [1, 1, 1, 1],
  );
  assert.deepEqual(groups.find((g) => g.name === 'Solo')?.platforms, ['macos']);
});
