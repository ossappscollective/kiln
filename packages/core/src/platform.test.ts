import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSET_PLATFORMS, requiredSizes, storeSetKey } from './asset-sync.ts';
import { allowedEvents, transition } from './lifecycle.ts';
import {
  isApplePlatform,
  isGooglePlatform,
  PLATFORM_META,
  PLATFORMS,
  parsePlatform,
  platformLabel,
  platformsOfFamily,
  sortPlatforms,
  storeFamilyOf,
} from './platform.ts';
import { releaseNotesLimit } from './release-plan.ts';
import { rolloutTemplatesFor, storeRollout } from './rollout-plan.ts';
import {
  appleDisplayType,
  assetSlotSupport,
  assetStoreOf,
  isStageableTextField,
  slotMaxFiles,
} from './staged-changes.ts';
import { deviceFitsPlatform } from './store-asset-specs.ts';

test('the platforms, their labels, stores and families come from one table', () => {
  assert.deepEqual([...PLATFORMS], ['ios', 'macos', 'android']);
  assert.equal(platformLabel('macos'), 'macOS');
  assert.equal(PLATFORM_META.macos.storeName, 'Mac App Store');
  assert.equal(PLATFORM_META.macos.consoleName, 'App Store Connect');
  assert.equal(PLATFORM_META.macos.glyph, 'platform-macos');
  assert.equal(PLATFORM_META.macos.applePlatform, 'MAC_OS');
  assert.equal(PLATFORM_META.macos.credentialKind, 'app_store_connect');
  assert.equal(storeFamilyOf('macos'), 'apple');
  assert.ok(isApplePlatform('ios') && isApplePlatform('macos') && !isApplePlatform('android'));
  assert.ok(isGooglePlatform('android') && !isGooglePlatform('macos'));
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
