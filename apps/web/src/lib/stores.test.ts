import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIconName } from './icons.ts';
import {
  platformBadgeText,
  platformById,
  platformInfo,
  storeBadgeText,
  storeById,
  storeForCredentialKind,
  storeForPlatform,
  storeForProjectKind,
  storeForRepositoryHost,
  storeIds,
  storeInfo,
} from './stores.ts';

test('every store and platform icon is a registered icon, and every label is non-empty', () => {
  for (const id of storeIds) {
    const info = storeInfo[id];
    assert.equal(info.store, id);
    assert.ok(isIconName(info.icon), `${id}: ${info.icon}`);
    assert.ok(info.label.length > 0 && info.fullLabel.length > 0);
  }
  for (const info of Object.values(platformInfo)) assert.ok(isIconName(info.icon), info.icon);
});

test('credential and connector kinds map to their store', () => {
  const rows: Array<[string | null | undefined, string, string]> = [
    ['app_store_connect', 'app_store', 'App Store Connect'],
    ['google_play', 'google_play', 'Google Play Console'],
    ['github_app', 'github', 'GitHub'],
    ['github_token', 'github', 'GitHub'],
    ['something_new', 'generic', 'Store'],
    ['', 'generic', 'Store'],
    [null, 'generic', 'Store'],
    [undefined, 'generic', 'Store'],
  ];
  for (const [kind, store, full] of rows) {
    const info = storeForCredentialKind(kind);
    assert.equal(info.store, store, String(kind));
    assert.equal(info.fullLabel, full, String(kind));
  }
});

test('platforms map to a store and a platform glyph', () => {
  assert.equal(storeForPlatform('ios').store, 'app_store');
  assert.equal(storeForPlatform('android').store, 'google_play');
  assert.equal(storeForPlatform('IOS').store, 'app_store');
  assert.equal(storeForPlatform('macos').store, 'mac_app_store');
  assert.equal(storeForPlatform('macos').label, 'Mac App Store');
  assert.deepEqual(
    [platformById('macos').label, platformById('macos').icon],
    ['macOS', 'platform-macos'],
  );
  assert.equal(platformById('MacOS').platform, 'macos');
  assert.equal(storeForPlatform('windows').store, 'generic');
  assert.equal(storeForPlatform(null).store, 'generic');
  assert.deepEqual([platformById('ios').label, platformById('ios').icon], ['iOS', 'platform-ios']);
  assert.deepEqual(
    [platformById('android').label, platformById('android').icon],
    ['Android', 'platform-android'],
  );
  assert.equal(platformById('Android').platform, 'android');
  assert.equal(platformById('tizen').platform, 'unknown');
  assert.equal(platformById(undefined).icon, 'smartphone');
});

test('repository hosts: GitHub by name, anything else a neutral Git host', () => {
  for (const host of [
    'github.com',
    'GitHub.com',
    'www.github.com',
    ' github.com ',
    'api.github.com',
  ]) {
    assert.equal(storeForRepositoryHost(host).store, 'github', host);
  }
  for (const host of [
    'gitlab.com',
    'notgithub.com',
    'github.com.evil.example',
    'bitbucket.org',
    '',
    null,
    undefined,
  ]) {
    assert.equal(storeForRepositoryHost(host).store, 'git', String(host));
  }
});

test('project kinds map to fastlane and expo, anything else is generic', () => {
  assert.equal(storeForProjectKind('fastlane').store, 'fastlane');
  assert.equal(storeForProjectKind('expo').store, 'expo');
  assert.equal(storeForProjectKind('unknown').store, 'generic');
  assert.equal(storeForProjectKind(null).store, 'generic');
});

test('an unknown store id is the neutral generic store', () => {
  assert.equal(storeById('app_store').store, 'app_store');
  assert.equal(storeById('nope').store, 'generic');
  assert.equal(storeById('toString').store, 'generic');
  assert.equal(storeById(null).icon, 'store');
});

test('badge variants: icon-only names the glyph, chip and full show text', () => {
  const play = storeInfo.google_play;
  assert.deepEqual(storeBadgeText(play, 'icon'), {
    visible: '',
    name: 'Google Play Console',
    iconNeedsTitle: true,
  });
  assert.deepEqual(storeBadgeText(play, 'chip'), {
    visible: 'Google Play',
    name: 'Google Play',
    iconNeedsTitle: false,
  });
  assert.deepEqual(storeBadgeText(play, 'full'), {
    visible: 'Google Play Console',
    name: 'Google Play Console',
    iconNeedsTitle: false,
  });
  assert.equal(storeBadgeText(storeInfo.app_store, 'full').visible, 'App Store Connect');
  for (const id of storeIds)
    for (const variant of ['icon', 'chip', 'full'] as const)
      assert.ok(storeBadgeText(storeInfo[id], variant).name.length > 0);
});

test('platform badge text: the label is hidden visually but kept as the name', () => {
  assert.deepEqual(platformBadgeText(platformInfo.ios, true), {
    visible: 'iOS',
    name: 'iOS',
    iconNeedsTitle: false,
  });
  assert.deepEqual(platformBadgeText(platformInfo.android, false), {
    visible: '',
    name: 'Android',
    iconNeedsTitle: false,
  });
});

test('only the App Store and Google Play use a tint; the rest stay neutral', () => {
  const tinted = storeIds.filter((id) => storeInfo[id].tint !== 'neutral').sort();
  assert.deepEqual(tinted, ['app_store', 'google_play', 'mac_app_store', 'testflight']);
});

test('each platform has its own tint and glyph, and an unknown one is neutral', () => {
  const real = [platformInfo.ios, platformInfo.macos, platformInfo.android];
  assert.equal(new Set(real.map((p) => p.tint)).size, 3);
  assert.equal(new Set(real.map((p) => p.icon)).size, 3);
  assert.deepEqual(real.map((p) => p.tint), ['ios', 'macos', 'android']);
  assert.equal(platformById('tizen').tint, 'neutral');
});
