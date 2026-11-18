import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupApps, groupOf } from './app-groups.ts';
import type { AppSummary } from './types.ts';

const app = (id: string, platform: 'ios' | 'android', name: string, identifier: string): AppSummary => ({
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
    [['c-ios', 'c-and'], ['b-ios', 'b-and'], ['a-ios', 'a-and']],
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
