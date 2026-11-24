import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetadataLock, type Platform, type ReleaseState } from '@kiln/core';
import {
  buildVersionOptions,
  carryHeaderParams,
  headerParams,
  isLockedState,
  lockableSections,
  lockInfo,
  mergeLocales,
  optionText,
  pickersFor,
  resolveLocale,
  resolveVersion,
  versionState,
  withHeaderParams,
  panelOf,
  withPanel,
} from './app-header.ts';
import { withScope } from './app-scope.ts';
import type { ReleaseSummary } from './types.ts';

let n = 0;
const rel = (
  platform: Platform,
  version: string,
  status: ReleaseState | null,
  track: string | null = platform === 'android' ? 'production' : null,
): ReleaseSummary => ({
  id: `r${++n}`,
  appId: `app-${platform}`,
  platform,
  version,
  track,
  build: String(n),
  status,
  rawState: '',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: null,
  syncedAt: 0,
});

test('headerParams and withHeaderParams keep version and locale in the address', () => {
  assert.deepEqual(headerParams('#/portfolio/a1/listing?platform=ios&version=2.4.0&locale=en-US'), {
    version: '2.4.0',
    locale: 'en-US',
  });
  assert.deepEqual(headerParams('#/portfolio/a1/listing'), { version: null, locale: null });
  assert.deepEqual(headerParams('#/portfolio/a1/listing?version=&locale=%20'), {
    version: null,
    locale: null,
  });
  const next = withHeaderParams('#/portfolio/a1/listing?platform=ios', { version: '2.4.0' });
  assert.equal(next, '#/portfolio/a1/listing?platform=ios&version=2.4.0');
  assert.equal(
    withHeaderParams(next, { locale: 'de-DE' }),
    '#/portfolio/a1/listing?platform=ios&version=2.4.0&locale=de-DE',
  );
  assert.equal(withHeaderParams(next, { version: null }), '#/portfolio/a1/listing?platform=ios');
  assert.equal(
    withHeaderParams('#/portfolio/a1/assets?version=1', { version: null }),
    '#/portfolio/a1/assets',
  );
  // The platform control keeps what the pickers wrote, and the other way round.
  assert.equal(withScope(next, 'android'), '#/portfolio/a1/listing?platform=android&version=2.4.0');
});

test('carryHeaderParams puts the current version and locale on a tab link', () => {
  const here = '#/portfolio/a1/listing?platform=ios&version=2.4.0&locale=fr-FR';
  assert.equal(
    carryHeaderParams('#/portfolio/a1/assets?platform=ios', here),
    '#/portfolio/a1/assets?platform=ios&version=2.4.0&locale=fr-FR',
  );
  assert.equal(
    carryHeaderParams('#/portfolio/a1', here),
    '#/portfolio/a1?version=2.4.0&locale=fr-FR',
  );
  assert.equal(
    carryHeaderParams('#/portfolio/a1/assets', '#/portfolio/a1/listing?platform=ios'),
    '#/portfolio/a1/assets',
  );
  assert.equal(
    carryHeaderParams('#/portfolio/a1/assets?version=9', here),
    '#/portfolio/a1/assets?version=9&locale=fr-FR',
  );
});

test('the side panel lives in its own param and is dropped when moving to another section', () => {
  const here = '#/portfolio/a1/listing?platform=ios&locale=fr-FR&panel=fr-FR';
  assert.equal(panelOf(here), 'fr-FR');
  assert.equal(panelOf('#/portfolio/a1/listing?locale=fr-FR'), null);
  assert.equal(panelOf('#/portfolio/a1/listing?panel='), null);
  assert.equal(withPanel('#/portfolio/a1/listing?platform=ios', 'de-DE'), '#/portfolio/a1/listing?platform=ios&panel=de-DE');
  assert.equal(withPanel(here, null), '#/portfolio/a1/listing?platform=ios&locale=fr-FR');
  assert.equal(withPanel('#/portfolio/a1/listing?panel=x', null), '#/portfolio/a1/listing');
  // A tab link copies version and locale, never the panel: Products and back does not reopen it.
  assert.equal(carryHeaderParams('#/portfolio/a1/products', here), '#/portfolio/a1/products?locale=fr-FR');
  assert.equal(panelOf(carryHeaderParams('#/portfolio/a1/listing', here)), null);
});

test('a version carries a word that says its state, by store', () => {
  assert.equal(versionState('draft', 'ios').label, 'Prepare for submission');
  assert.equal(versionState('draft', 'android').label, 'Draft');
  assert.equal(versionState('build_chosen', 'macos').label, 'Prepare for submission');
  assert.deepEqual(versionState('live', 'ios'), { label: 'Live', tone: 'ok' });
  assert.equal(versionState('in_review', 'ios').label, 'In review');
  assert.equal(versionState('rolling_out', 'android').label, 'Rolling out');
  assert.equal(versionState(null, 'ios').label, 'Unknown state');
});

test('versions come newest first from the releases of the platforms in scope', () => {
  const releases = [
    rel('ios', '2.3.0', 'live'),
    rel('ios', '2.4.0', 'draft'),
    rel('android', '2.4.0', 'draft'),
    rel('android', '2.3.0', 'live'),
    rel('android', '2.3.0', 'draft', 'internal'),
    rel('ios', '2.10.0', 'in_review'),
  ];
  const both = buildVersionOptions(releases, ['ios', 'android']);
  assert.deepEqual(
    both.map((o) => o.version),
    ['2.10.0', '2.4.0', '2.3.0'],
  );
  assert.equal(both[0]?.state.label, 'In review');
  assert.deepEqual(both[0]?.platforms, ['ios']);
  // 2.4.0 is a draft on both: one word, no detail. 2.3.0: the production track stands for Android.
  assert.equal(both[1]?.detail, '');
  assert.equal(both[1]?.state.label, 'Prepare for submission');
  assert.equal(both[2]?.state.label, 'Live');
  const ios = buildVersionOptions(releases, ['ios']);
  assert.deepEqual(
    ios.map((o) => o.version),
    ['2.10.0', '2.4.0', '2.3.0'],
  );
  assert.deepEqual(buildVersionOptions(releases, ['macos']), []);
  assert.equal(buildVersionOptions(releases, ['ios', 'android'], 2).length, 2);
});

test('platforms in different states show both, and the dot follows the more urgent one', () => {
  const releases = [rel('ios', '3.0.0', 'live'), rel('android', '3.0.0', 'rejected')];
  const [option] = buildVersionOptions(releases, ['ios', 'android']);
  assert.equal(option?.state.label, 'Rejected');
  assert.equal(option?.detail, 'iOS Live · Android Rejected');
  assert.equal(
    optionText(option as NonNullable<typeof option>),
    '3.0.0 · iOS Live · Android Rejected',
  );
  const [single] = buildVersionOptions([rel('ios', '1.0', 'draft')], ['ios']);
  assert.equal(optionText(single as NonNullable<typeof single>), '1.0 · Prepare for submission');
});

test('resolveVersion keeps a version that exists and falls back to the newest', () => {
  const options = buildVersionOptions(
    [rel('ios', '2.0', 'live'), rel('ios', '1.0', 'live')],
    ['ios'],
  );
  assert.equal(resolveVersion('1.0', options), '1.0');
  assert.equal(resolveVersion('9.9', options), '2.0');
  assert.equal(resolveVersion(null, options), '2.0');
  assert.equal(resolveVersion('1.0', []), null);
});

test('which states are locked', () => {
  assert.equal(isLockedState('live', 'ios'), true);
  // Play listings are not tied to a release: Android never locks.
  assert.equal(isLockedState('live', 'android'), false);
  assert.equal(isLockedState('rolling_out', 'android'), false);
  assert.equal(isLockedState('rolling_out', 'macos'), true);
  assert.equal(isLockedState('in_review', 'ios'), true);
  assert.equal(isLockedState('in_review', 'android'), false);
  assert.equal(isLockedState('draft', 'ios'), false);
  assert.equal(isLockedState('rejected', 'ios'), false);
  assert.equal(isLockedState(null, 'ios'), false);
});

test('a live version says so, in the words of the banner', () => {
  const releases = [rel('ios', '2.3.0', 'live'), rel('ios', '2.4.0', 'draft')];
  const live = lockInfo(releases, '2.3.0', ['ios']);
  assert.equal(live.text, 'This version is live — metadata is locked');
  assert.deepEqual(live.locked, ['ios']);
  assert.equal(live.all, true);
  const draft = lockInfo(releases, '2.4.0', ['ios']);
  assert.equal(draft.text, '');
  assert.deepEqual(draft.editable, ['ios']);
  assert.equal(
    lockInfo([rel('ios', '5', 'in_review')], '5', ['ios']).text,
    'This version is in review — metadata is locked',
  );
  assert.equal(lockInfo(releases, null, ['ios']).text, '');
});

test('with several platforms, a lock can cover one of them', () => {
  const releases = [rel('ios', '2.3.0', 'live'), rel('android', '2.3.0', 'draft')];
  const partial = lockInfo(releases, '2.3.0', ['ios', 'android']);
  assert.deepEqual(partial.locked, ['ios']);
  assert.deepEqual(partial.editable, ['android']);
  assert.equal(partial.all, false);
  assert.equal(partial.text, 'iOS is live — iOS metadata is locked');
  const mixed = lockInfo([rel('ios', '1', 'live'), rel('macos', '1', 'in_review')], '1', [
    'ios',
    'macos',
  ]);
  assert.equal(mixed.all, true);
  assert.equal(mixed.text, 'Metadata is locked — iOS is live, macOS is in review');
  const same = lockInfo([rel('ios', '1', 'live'), rel('macos', '1', 'live')], '1', [
    'ios',
    'macos',
  ]);
  assert.equal(same.text, 'This version is live — metadata is locked');
  // A live Android release leaves Android editable.
  const play = lockInfo([rel('android', '1', 'live')], '1', ['android']);
  assert.deepEqual(play.editable, ['android']);
  // A platform that does not have the version yet is open for editing.
  const missing = lockInfo([rel('ios', '1', 'live')], '1', ['ios', 'android']);
  assert.deepEqual(missing.editable, ['android']);
});

test('platforms in the same locked state are named together', () => {
  const releases = [
    rel('ios', '1', 'live'),
    rel('macos', '1', 'live'),
    rel('android', '1', 'draft'),
  ];
  assert.equal(
    lockInfo(releases, '1', ['ios', 'macos', 'android']).text,
    'iOS and macOS are live — iOS and macOS metadata is locked',
  );
  const all = [
    rel('ios', '1', 'live'),
    rel('macos', '1', 'live'),
    rel('android', '1', 'rolling_out'),
  ];
  assert.equal(
    lockInfo(all, '1', ['ios', 'macos', 'android']).text,
    'iOS and macOS are live — iOS and macOS metadata is locked',
  );
});

test('a defaulted version falls back to the newest release of a platform that lacks it', () => {
  const releases = [
    rel('ios', '3.1.1', 'live'),
    rel('android', '4.2.0', 'draft'),
    rel('android', '4.1.0', 'live'),
  ];
  // The person chose 4.2.0: iOS has no such version, so it stays open.
  assert.deepEqual(lockInfo(releases, '4.2.0', ['ios', 'android']).locked, []);
  // 4.2.0 was only the default: iOS's own newest release (live) locks it.
  const defaulted = lockInfo(releases, '4.2.0', ['ios', 'android'], { fallbackToNewest: true });
  assert.deepEqual(defaulted.locked, ['ios']);
  assert.deepEqual(defaulted.editable, ['android']);
  assert.equal(defaulted.text, 'iOS is live — iOS metadata is locked');
});

test('locales merge into one sorted list and a stale choice reads as none', () => {
  assert.deepEqual(
    mergeLocales([
      ['fr-FR', 'de-DE'],
      ['en-US', 'de-DE', ' '],
    ]),
    ['de-DE', 'en-US', 'fr-FR'],
  );
  assert.deepEqual(mergeLocales([]), []);
  assert.equal(resolveLocale('de-DE', ['de-DE']), 'de-DE');
  assert.equal(resolveLocale('xx', ['de-DE']), null);
  assert.equal(resolveLocale(null, ['de-DE']), null);
});

test('the header shows on the versioned pages only', () => {
  assert.deepEqual(pickersFor('listing'), { version: true, locale: true });
  assert.deepEqual(pickersFor('assets'), { version: true, locale: true });
  assert.deepEqual(pickersFor('releases'), { version: true, locale: false });
  assert.equal(pickersFor('releases', { releaseOpen: true }), null);
  assert.deepEqual(pickersFor('aso', { asoView: 'fit' }), { version: true, locale: true });
  assert.equal(pickersFor('aso', { asoView: 'keywords' }), null);
  assert.equal(pickersFor('aso'), null);
  assert.deepEqual(pickersFor('insights', { asoView: 'fit' }), { version: true, locale: true });
  assert.equal(pickersFor('insights', { asoView: 'keywords' }), null);
  assert.equal(pickersFor('insights'), null);
  for (const s of ['dashboard', 'settings', 'reviews', 'workflows', 'builds'])
    assert.equal(pickersFor(s), null);
  assert.deepEqual([...lockableSections], ['listing', 'assets']);
});

test('the web lock and the server lock (core computeMetadataLock) agree for the same releases', () => {
  const cases: [Platform, [string, ReleaseState | null][]][] = [
    ['ios', [['2.3.0', 'live']]],
    ['ios', [['2.3.0', 'live'], ['2.4.0', 'draft']]],
    ['ios', [['2.3.0', 'live'], ['2.4.0', 'in_review']]],
    ['ios', [['2.3.0', 'live'], ['2.4.0', 'rejected']]],
    ['ios', [['2.3.0', 'rolling_out']]],
    ['macos', [['1.0', 'approved']]],
    ['ios', [['1.0', null]]],
    ['android', [['2.3.0', 'live']]],
    ['android', [['2.3.0', 'rolling_out']]],
  ];
  for (const [platform, versions] of cases) {
    const releases = versions.map(([version, status]) => rel(platform, version, status));
    const newest = versions.map(([version]) => version).sort((a, b) => (a < b ? 1 : -1))[0] ?? null;
    const web = lockInfo(releases, newest, [platform]).locked.length > 0;
    const server = computeMetadataLock(platform, versions.map(([version, status]) => ({ version, status }))).locked;
    assert.equal(server, web, `${platform} ${JSON.stringify(versions)}`);
  }
});
