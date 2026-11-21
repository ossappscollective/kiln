import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSET_PLATFORMS, requiredSizes, storeSetKey } from './listing/asset-sync.ts';
import {
  appleDisplayType,
  assetSlotSupport,
  assetStoreOf,
  isStageableTextField,
  slotMaxFiles,
} from './listing/staged-changes.ts';
import { deviceFitsPlatform } from './listing/store-asset-specs.ts';
import {
  listingStoreOf,
  needsStoreAppId,
  PLATFORM_META,
  PLATFORMS,
  parsePlatform,
  platformLabel,
  platformsOfFamily,
  REVENUECAT_APP_TYPES,
  revenueCatAppTypes,
  sortPlatforms,
  storeFamilyOf,
  storeShortName,
  storeSideId,
  supports,
} from './platform.ts';
import { allowedEvents, transition } from './release/lifecycle.ts';
import { releaseNotesLimit } from './release/release-plan.ts';
import { rolloutTemplatesFor, storeRollout } from './release/rollout-plan.ts';

test('the platforms, their labels, stores and families come from one table', () => {
  assert.deepEqual([...PLATFORMS], ['ios', 'macos', 'android']);
  assert.equal(platformLabel('macos'), 'macOS');
  assert.equal(PLATFORM_META.macos.storeName, 'Mac App Store');
  assert.equal(PLATFORM_META.macos.consoleName, 'App Store Connect');
  assert.equal(PLATFORM_META.macos.glyph, 'platform-macos');
  assert.equal(PLATFORM_META.macos.applePlatform, 'MAC_OS');
  assert.equal(PLATFORM_META.macos.credentialKind, 'app_store_connect');
  assert.equal(storeFamilyOf('macos'), 'apple');
  assert.ok(supports('ios', 'approvalHold') && supports('macos', 'approvalHold'));
  assert.ok(!supports('android', 'approvalHold') && supports('android', 'releaseTracks'));
  assert.deepEqual(platformsOfFamily('apple'), ['ios', 'macos']);
  assert.equal(parsePlatform(' MacOS '), 'macos');
  assert.equal(parsePlatform('tvos'), undefined);
  assert.equal(parsePlatform(null), undefined);
  assert.deepEqual(sortPlatforms(['android', 'macos', 'ios', 'macos']), [
    'ios',
    'macos',
    'android',
  ]);
});

test('macOS follows the Apple lifecycle: released straight to rolling out, never through propagating', () => {
  assert.deepEqual(transition('macos', 'approved', 'release'), { ok: true, state: 'rolling_out' });
  assert.equal(transition('macos', 'propagating', 'propagated').ok, false);
  assert.deepEqual(allowedEvents('macos', 'approved'), allowedEvents('ios', 'approved'));
  assert.deepEqual(transition('android', 'approved', 'release'), {
    ok: true,
    state: 'propagating',
  });
});

test('macOS plans: the Apple phased release template fits, notes use the App Store limit, no share is read', () => {
  assert.deepEqual(
    rolloutTemplatesFor('macos').map((t) => t.id),
    rolloutTemplatesFor('ios').map((t) => t.id),
  );
  assert.equal(releaseNotesLimit('macos'), releaseNotesLimit('ios'));
  const seen = storeRollout({
    platform: 'macos',
    status: 'live',
    rawState: 'READY_FOR_SALE',
    fraction: null,
    syncedAt: 1,
  });
  assert.equal(seen.percent, null, 'only Google Play reports a share');
});

test('macOS stages the version localization fields and the Mac display only', () => {
  assert.equal(isStageableTextField('macos', 'promotional_text'), true);
  assert.equal(isStageableTextField('macos', 'short_description'), false);
  assert.equal(assetStoreOf('macos'), 'app_store');
  assert.equal(slotMaxFiles('macos', { kind: 'screenshot', device: 'mac' }), 10);
  assert.equal(assetSlotSupport('macos', { kind: 'screenshot', device: 'mac' }).ok, true);
  const phone = assetSlotSupport('macos', { kind: 'screenshot', device: 'iphone_6_9' });
  assert.equal(phone.ok, false);
  assert.match(phone.ok ? '' : phone.reason, /Mac screenshots only/);
  const onIos = assetSlotSupport('ios', { kind: 'screenshot', device: 'mac' });
  assert.equal(onIos.ok, false);
  assert.match(onIos.ok ? '' : onIos.reason, /macOS version/);
  assert.equal(assetSlotSupport('macos', { kind: 'app_icon', device: null }).ok, false);
  assert.equal(appleDisplayType('mac', 2560, 1600), 'APP_DESKTOP');
  assert.equal(deviceFitsPlatform('macos', 'imessage:mac'), false);
  assert.equal(deviceFitsPlatform('ios', 'iphone_6_5'), true);
  assert.equal(deviceFitsPlatform('ios', null), false);
  assert.equal(deviceFitsPlatform('android', 'phone'), true);
});

test('macOS screenshot sizes are the four 16:10 sizes Apple lists', () => {
  const sizes = requiredSizes('macos', { kind: 'screenshot', device: 'mac' }).map(
    (s) => `${s.width}x${s.height}`,
  );
  assert.deepEqual(sizes, ['1280x800', '1440x900', '2560x1600', '2880x1800']);
  assert.deepEqual([...ASSET_PLATFORMS], ['ios', 'macos', 'android']);
  assert.equal(
    storeSetKey('macos', 'en-US', { kind: 'screenshot', device: 'mac' }),
    'macos/en-US/screenshot:mac',
  );
});

test('the platform table carries the store facts that call sites used to branch on', () => {
  assert.equal(listingStoreOf('ios'), 'app_store');
  assert.equal(listingStoreOf('macos'), 'app_store');
  assert.equal(listingStoreOf('android'), 'google_play');
  assert.equal(storeShortName('macos'), 'App Store');
  assert.equal(storeShortName('android'), 'Google Play');
  assert.equal(needsStoreAppId('ios'), true);
  assert.equal(needsStoreAppId('android'), false);
  const app = { storeAppId: '123', identifier: 'com.example' };
  assert.equal(storeSideId('ios', app), '123');
  assert.equal(storeSideId('android', app), 'com.example');
  assert.equal(storeSideId('ios', { storeAppId: null, identifier: 'x' }), null);
});

test('RevenueCat app types per platform: macOS is the legacy Mac app or the shared App Store app, never a name check', () => {
  assert.deepEqual(revenueCatAppTypes('ios'), ['app_store']);
  assert.deepEqual(revenueCatAppTypes('macos'), ['mac_app_store', 'app_store']);
  assert.deepEqual(revenueCatAppTypes('android'), ['play_store']);
  for (const platform of PLATFORMS) {
    assert.equal(supports(platform, 'revenueCat'), true);
    for (const type of revenueCatAppTypes(platform)) assert.ok(REVENUECAT_APP_TYPES.includes(type));
  }
});
