import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '@mrm/core';
import { groupApps } from './app-groups.ts';
import { filterSwitcher, jumpTarget, switcherItems } from './app-switcher.ts';
import type { AppSummary } from './types.ts';

const app = (id: string, name: string, platform: Platform, identifier: string): AppSummary => ({
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

const items = switcherItems(
  groupApps([
    app('1', 'Weather', 'ios', 'com.acme.weather'),
    app('2', 'Weather', 'android', 'com.acme.weather'),
    app('3', 'Notes', 'ios', 'com.acme.notes'),
    app('4', 'Notes Pro', 'ios', 'com.acme.notespro'),
    app('5', 'Zebra', 'android', 'org.zoo.app'),
  ]),
);

test('one item per product, numbered in list order, with the identifiers shown', () => {
  assert.deepEqual(items.map((i) => i.name), ['Notes', 'Notes Pro', 'Weather', 'Zebra']);
  assert.deepEqual(items.map((i) => i.number), [1, 2, 3, 4]);
  const weather = items[2];
  assert.deepEqual(weather?.platforms, ['ios', 'android']);
  assert.deepEqual(weather?.identifiers, ['com.acme.weather']);
});

test('only the first nine apps are numbered and Cmd or Ctrl + digit jumps by that number', () => {
  const many = switcherItems(
    groupApps(Array.from({ length: 12 }, (_, i) => app(`a${i}`, `App ${String(i).padStart(2, '0')}`, 'ios', `com.x.a${i}`))),
  );
  assert.equal(many[8]?.number, 9);
  assert.equal(many[9]?.number, null);
  assert.equal(jumpTarget(many, 2)?.name, 'App 02');
  assert.equal(jumpTarget(many, 9), null);
  assert.equal(jumpTarget(items, 7), null);
  assert.equal(jumpTarget(items, -1), null);
});

test('an empty query keeps the list; a query keeps the number of the app', () => {
  assert.equal(filterSwitcher(items, '  ').length, 4);
  const found = filterSwitcher(items, 'weath');
  assert.deepEqual(found.map((i) => i.name), ['Weather']);
  assert.equal(found[0]?.number, 3);
});

test('matches by name first, then by bundle id, and names the best match first', () => {
  assert.deepEqual(filterSwitcher(items, 'notes').map((i) => i.name), ['Notes', 'Notes Pro']);
  assert.deepEqual(filterSwitcher(items, 'pro').map((i) => i.name), ['Notes Pro']);
  assert.deepEqual(filterSwitcher(items, 'org.zoo').map((i) => i.name), ['Zebra']);
  assert.deepEqual(filterSwitcher(items, 'ACME weather').map((i) => i.name), ['Weather']);
  assert.deepEqual(filterSwitcher(items, 'nothing like it'), []);
});

test('letters in order still find an app, for two letters or more', () => {
  assert.deepEqual(filterSwitcher(items, 'wthr').map((i) => i.name), ['Weather']);
  assert.deepEqual(filterSwitcher(items, 'q'), []);
});
