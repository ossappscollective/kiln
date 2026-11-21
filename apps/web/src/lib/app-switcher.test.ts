import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Platform } from '@kiln/core';
import { groupApps } from './app-groups.ts';
import {
  appSwitchHash,
  filterSwitcher,
  itemOfId,
  jumpTarget,
  moveActive,
  switcherItems,
} from './app-switcher.ts';
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
  assert.deepEqual(
    items.map((i) => i.name),
    ['Notes', 'Notes Pro', 'Weather', 'Zebra'],
  );
  assert.deepEqual(
    items.map((i) => i.number),
    [1, 2, 3, 4],
  );
  const weather = items[2];
  assert.deepEqual(weather?.platforms, ['ios', 'android']);
  assert.deepEqual(weather?.identifiers, ['com.acme.weather']);
});

test('only the first nine apps are numbered and Cmd or Ctrl + digit jumps by that number', () => {
  const many = switcherItems(
    groupApps(
      Array.from({ length: 12 }, (_, i) =>
        app(`a${i}`, `App ${String(i).padStart(2, '0')}`, 'ios', `com.x.a${i}`),
      ),
    ),
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
  assert.deepEqual(
    found.map((i) => i.name),
    ['Weather'],
  );
  assert.equal(found[0]?.number, 3);
});

test('matches by name first, then by bundle id, and names the best match first', () => {
  assert.deepEqual(
    filterSwitcher(items, 'notes').map((i) => i.name),
    ['Notes', 'Notes Pro'],
  );
  assert.deepEqual(
    filterSwitcher(items, 'pro').map((i) => i.name),
    ['Notes Pro'],
  );
  assert.deepEqual(
    filterSwitcher(items, 'org.zoo').map((i) => i.name),
    ['Zebra'],
  );
  assert.deepEqual(
    filterSwitcher(items, 'ACME weather').map((i) => i.name),
    ['Weather'],
  );
  assert.deepEqual(filterSwitcher(items, 'nothing like it'), []);
});

test('letters in order still find an app, for two letters or more', () => {
  assert.deepEqual(
    filterSwitcher(items, 'wthr').map((i) => i.name),
    ['Weather'],
  );
  assert.deepEqual(filterSwitcher(items, 'q'), []);
});

test('an address naming any record finds its app, and the icon of the first record with one is used', () => {
  assert.equal(itemOfId(items, '2')?.name, 'Weather');
  assert.equal(itemOfId(items, 'nope'), null);
  assert.equal(itemOfId(null, '1'), null);
  const withIcon = switcherItems(
    groupApps([
      app('1', 'Weather', 'ios', 'a'),
      { ...app('2', 'Weather', 'android', 'a'), iconUrl: '/icons/2' },
    ]),
  );
  assert.equal(withIcon[0]?.iconUrl, '/icons/2');
  assert.equal(items[0]?.iconUrl, null);
});

test('arrow keys move the highlight and stay inside the list', () => {
  assert.equal(moveActive('ArrowDown', 0, 3), 1);
  assert.equal(moveActive('ArrowDown', 2, 3), 2);
  assert.equal(moveActive('ArrowUp', 0, 3), 0);
  assert.equal(moveActive('End', 0, 3), 2);
  assert.equal(moveActive('Home', 2, 3), 0);
  assert.equal(moveActive('x', 5, 3), 2);
  assert.equal(moveActive('ArrowDown', 0, 0), 0);
});

test('filtering narrows by name and by identifier', () => {
  assert.deepEqual(
    filterSwitcher(items, 'zoo').map((i) => i.name),
    ['Zebra'],
  );
  assert.deepEqual(
    filterSwitcher(items, 'notes').map((i) => i.name),
    ['Notes', 'Notes Pro'],
  );
  assert.deepEqual(filterSwitcher(items, 'qqq'), []);
});

const iosOnly = { key: 'new', platforms: ['ios'] as Platform[] };
const both = { key: 'new', platforms: ['ios', 'android'] as Platform[] };
const androidOnly = { key: 'new', platforms: ['android'] as Platform[] };

test('another app opens on the same page, not on its overview', () => {
  assert.equal(appSwitchHash('#/portfolio/old/releases', iosOnly), '#/portfolio/new/releases');
  assert.equal(appSwitchHash('#/portfolio/old/listing', iosOnly), '#/portfolio/new/listing');
  assert.equal(appSwitchHash('#/portfolio/old/reviews', both), '#/portfolio/new/reviews');
  assert.equal(appSwitchHash('#/portfolio/old', both), '#/portfolio/new');
  assert.equal(appSwitchHash('#/portfolio/old/settings', both), '#/portfolio/new/settings');
});

test('the view carries over, the version, the locale and the release do not', () => {
  assert.equal(
    appSwitchHash('#/portfolio/old/builds?view=workflows&version=1.2&locale=de-DE', iosOnly),
    '#/portfolio/new/builds?view=workflows',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/listing?view=graphics&locale=fr-FR', both),
    '#/portfolio/new/listing?view=graphics',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/insights?view=rank', both),
    '#/portfolio/new/insights?view=rank',
  );
  assert.equal(appSwitchHash('#/portfolio/old/release/2.0.0', both), '#/portfolio/new/releases');
  assert.equal(
    appSwitchHash('#/portfolio/old/releases?version=2.0.0', both),
    '#/portfolio/new/releases',
  );
});

test('the platform scope stays when the new app has it, else all platforms', () => {
  assert.equal(
    appSwitchHash('#/portfolio/old/reviews?platform=ios', both),
    '#/portfolio/new/reviews?platform=ios',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/reviews?platform=android', iosOnly),
    '#/portfolio/new/reviews',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/reviews?platform=both', both),
    '#/portfolio/new/reviews?platform=both',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/reviews?platform=both', iosOnly),
    '#/portfolio/new/reviews',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/builds?platform=ios&view=tests', both),
    '#/portfolio/new/builds?platform=ios&view=tests',
  );
});

test('Search terms needs a Google Play record, and a page the role may not open falls back to the overview', () => {
  assert.equal(
    appSwitchHash('#/portfolio/old/insights?view=terms', both),
    '#/portfolio/new/insights?view=terms',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/insights?view=terms', iosOnly),
    '#/portfolio/new/insights',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/insights?view=terms', androidOnly),
    '#/portfolio/new/insights?view=terms',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/reviews', both, (a) => a !== 'reviews.read'),
    '#/portfolio/new',
  );
});

test('old addresses read as their new page, and a place that is not an app opens the overview', () => {
  assert.equal(
    appSwitchHash('#/portfolio/old/workflows', iosOnly),
    '#/portfolio/new/builds?view=workflows',
  );
  assert.equal(
    appSwitchHash('#/portfolio/old/assets', iosOnly),
    '#/portfolio/new/listing?view=graphics',
  );
  assert.equal(appSwitchHash('#/portfolio', both), '#/portfolio/new');
  assert.equal(appSwitchHash('#/reviews', both), '#/portfolio/new');
  assert.equal(appSwitchHash('', both), '#/portfolio/new');
});
