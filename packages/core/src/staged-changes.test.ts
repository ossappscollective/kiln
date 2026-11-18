import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLE_VERSION_LOCALIZATION_ATTRIBUTES,
  PLAY_LISTING_MEMBERS,
  STAGEABLE_TEXT_FIELDS,
  appleDisplayType,
  assetSlotSupport,
  isStageableTextField,
  parseSlotKey,
  playImageType,
  slotKey,
  slotMaxFiles,
} from './staged-changes.ts';

test('only the version localization fields of the App Store are stageable; Play has all four', () => {
  assert.deepEqual([...STAGEABLE_TEXT_FIELDS.ios].sort(), Object.keys(APPLE_VERSION_LOCALIZATION_ATTRIBUTES).sort());
  assert.deepEqual([...STAGEABLE_TEXT_FIELDS.android].sort(), Object.keys(PLAY_LISTING_MEMBERS).sort());
  for (const field of ['name', 'subtitle', 'privacy_url', 'apple_tv_privacy_policy', 'copyright']) {
    assert.equal(isStageableTextField('ios', field), false, field);
  }
  assert.equal(isStageableTextField('ios', 'description'), true);
  assert.equal(isStageableTextField('android', 'title'), true);
  assert.equal(isStageableTextField('android', 'subtitle'), false);
});

test('slot keys round trip and refuse nonsense', () => {
  assert.equal(slotKey({ kind: 'screenshot', device: 'phone' }), 'screenshot:phone');
  assert.equal(slotKey({ kind: 'icon', device: null }), 'icon');
  assert.deepEqual(parseSlotKey('screenshot:iphone_6_5'), { kind: 'screenshot', device: 'iphone_6_5' });
  assert.deepEqual(parseSlotKey('feature_graphic'), { kind: 'feature_graphic', device: null });
  assert.equal(parseSlotKey('screenshot'), undefined, 'a screenshot set needs a device');
  assert.equal(parseSlotKey('icon:phone'), undefined, 'a graphic has no device');
});

test('Google Play image types are the AppImageType values; the promo graphic has none', () => {
  assert.equal(playImageType({ kind: 'screenshot', device: 'phone' }), 'phoneScreenshots');
  assert.equal(playImageType({ kind: 'screenshot', device: 'tablet_7' }), 'sevenInchScreenshots');
  assert.equal(playImageType({ kind: 'screenshot', device: 'tablet_10' }), 'tenInchScreenshots');
  assert.equal(playImageType({ kind: 'screenshot', device: 'tv' }), 'tvScreenshots');
  assert.equal(playImageType({ kind: 'screenshot', device: 'wear' }), 'wearScreenshots');
  assert.equal(playImageType({ kind: 'icon', device: null }), 'icon');
  assert.equal(playImageType({ kind: 'feature_graphic', device: null }), 'featureGraphic');
  assert.equal(playImageType({ kind: 'tv_banner', device: null }), 'tvBanner');
  assert.equal(playImageType({ kind: 'promo_graphic', device: null }), undefined);
  assert.equal(assetSlotSupport('android', { kind: 'promo_graphic', device: null }).ok, false);
  assert.equal(assetSlotSupport('android', { kind: 'feature_graphic', device: null }).ok, true);
});

test('App Store: only screenshots of a known display can be pushed; previews and the app icon cannot', () => {
  assert.equal(assetSlotSupport('ios', { kind: 'screenshot', device: 'iphone_6_5' }).ok, true);
  assert.equal(assetSlotSupport('ios', { kind: 'screenshot', device: 'iphone_6_9' }).ok, true);
  assert.equal(assetSlotSupport('ios', { kind: 'screenshot', device: 'watch' }).ok, false, 'no display type name known');
  for (const kind of ['preview', 'app_icon', 'icon', 'feature_graphic'] as const) {
    assert.equal(assetSlotSupport('ios', { kind, device: null }).ok, false, kind);
  }
  assert.equal(appleDisplayType('iphone_6_5', 1242, 2688), 'APP_IPHONE_65');
  assert.equal(appleDisplayType('iphone_6_9', 1290, 2796), 'APP_IPHONE_67');
  assert.equal(appleDisplayType('iphone_6_9', 1320, 2868), 'APP_IPHONE_69');
  assert.equal(appleDisplayType('iphone_6_9', null, null), undefined, 'the 6.9 inch name depends on the size');
  assert.equal(appleDisplayType('nope', 1, 1), undefined);
});

test('set sizes follow the stores documented limits', () => {
  assert.equal(slotMaxFiles('ios', { kind: 'screenshot', device: 'iphone_6_5' }), 10);
  assert.equal(slotMaxFiles('android', { kind: 'screenshot', device: 'phone' }), 8);
  assert.equal(slotMaxFiles('android', { kind: 'icon', device: null }), 1);
});
