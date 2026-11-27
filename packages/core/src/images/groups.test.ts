import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStoreImages } from '../listing/asset-sync.ts';
import { displayKeyOf, findDisplay, findStoreImage, groupStoreImages, refsOfDisplay } from './groups.ts';
import { imageFiles, storeSet, storeView, tenPlusTwo } from './fixtures.ts';

/**
 * The display grouping (audit images.md F2): ONE function; the two units (store group, display set) are both there and named.
 */

test('10 + 2 across two placement groups: each group is fine (10 and 2), the display holds 12 and does not fit ONE staged set', () => {
  const [d, ...rest] = groupStoreImages(tenPlusTwo());
  assert.equal(rest.length, 0);
  assert.ok(d);
  assert.equal(d.key, 'en-US/screenshot:ipad_13');
  assert.deepEqual(d.counts, {
    perGroup: [
      { target: 'APP_IPAD_PRO_3GEN_129', count: 10 },
      { target: 'APP_IPAD_PRO_129', count: 2 },
    ],
    primary: 10,
    merged: 12,
  });
  assert.equal(d.limit.max, 10);
  assert.equal(d.limit.stagedMax, 10);
  assert.deepEqual(d.overLimit, []);
  assert.equal(d.stagedFits, false);
  // the store's own judging agrees: no count problem for 10 + 2
  assert.equal(checkStoreImages(tenPlusTwo()).filter((p) => p.rule === 'apple.screenshot.count').length, 0);
});

test('the primary group is the PUSHED one, first, whatever order the store lists them in', () => {
  const view = storeView([
    storeSet('APP_IPAD_PRO_129', imageFiles(2, 11, 'b')),
    storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(10, 1, 'a')),
  ]);
  const d = groupStoreImages(view)[0];
  assert.equal(d?.primaryGroup.target, 'APP_IPAD_PRO_3GEN_129');
  assert.equal(d?.pushTarget, 'APP_IPAD_PRO_3GEN_129');
  assert.deepEqual(d?.images.map((i) => i.group).filter((g, i, all) => all.indexOf(g) === i), ['APP_IPAD_PRO_3GEN_129', 'APP_IPAD_PRO_129']);
  assert.equal(d?.files.length, 12);
  assert.deepEqual(d?.groups.map((g) => g.target), ['APP_IPAD_PRO_129', 'APP_IPAD_PRO_3GEN_129']);
});

test('with no group of the pushed name the one with the most images stands in', () => {
  const view = storeView([
    storeSet('APP_IPAD_PRO_X', imageFiles(2, 1, 'a')),
    storeSet('APP_IPAD_PRO_Y', imageFiles(5, 3, 'b')),
  ]);
  assert.equal(groupStoreImages(view)[0]?.pushTarget, 'APP_IPAD_PRO_Y');
});

test('12 in ONE group is the real over-limit: the group is named and the display cannot be staged', () => {
  const view = storeView([storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(12))]);
  const d = groupStoreImages(view)[0];
  assert.deepEqual(d?.overLimit, [{ group: 'APP_IPAD_PRO_3GEN_129', count: 12, max: 10 }]);
  assert.equal(d?.stagedFits, false);
});

test('10 in each of two groups: both are at the limit, neither over; merged 20', () => {
  const view = storeView([storeSet('A', imageFiles(10, 1, 'a')), storeSet('B', imageFiles(10, 11, 'b'))]);
  const d = groupStoreImages(view)[0];
  assert.deepEqual(d?.overLimit, []);
  assert.equal(d?.counts.merged, 20);
});

test('displays are keyed by locale, kind and device and sorted like summarizeAssets', () => {
  const view = storeView([
    storeSet('APP_IPHONE_67', imageFiles(3), { device: 'iphone_6_9', locale: 'fr-FR' }),
    storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(1), { locale: 'en-US' }),
    storeSet('APP_IPHONE_67', imageFiles(2), { device: 'iphone_6_9', locale: 'en-US' }),
  ]);
  assert.deepEqual(groupStoreImages(view).map((d) => d.key), [
    'en-US/screenshot:ipad_13',
    'en-US/screenshot:iphone_6_9',
    'fr-FR/screenshot:iphone_6_9',
  ]);
});

test('Google Play: one group per device, limit 8, a kind without a device has a plain key', () => {
  const view = {
    platform: 'android' as const,
    sets: [
      storeSet('phoneScreenshots', imageFiles(9), { platform: 'android', device: 'phone', locale: 'en-US' }),
      storeSet('icon', imageFiles(1), { platform: 'android', kind: 'icon', device: null }),
    ],
  };
  const displays = groupStoreImages(view);
  const phone = findDisplay(displays, { locale: 'en-US', kind: 'screenshot', device: 'phone' });
  assert.equal(phone?.limit.max, 8);
  assert.deepEqual(phone?.overLimit, [{ group: 'phoneScreenshots', count: 9, max: 8 }]);
  const icon = findDisplay(displays, { locale: 'en-US', kind: 'icon', device: null });
  assert.equal(icon?.key, 'en-US/icon');
  assert.equal(icon?.limit.max, null);
  assert.equal(icon?.limit.stagedMax, 1);
  assert.equal(displayKeyOf({ locale: 'x', kind: 'icon', device: null }), 'x/icon');
});

test('an image is found by its ref across sibling groups; removals may name any of them', () => {
  const displays = groupStoreImages(tenPlusTwo());
  const hit = findStoreImage(displays, 'b-12');
  assert.equal(hit?.group.target, 'APP_IPAD_PRO_129');
  assert.equal(hit?.index, 1);
  assert.equal(hit?.file.position, 12);
  assert.equal(findStoreImage(displays, 'nope'), undefined);
  assert.equal(refsOfDisplay(displays[0] as never).length, 12);
});

test('does not mutate the view', () => {
  const view = tenPlusTwo();
  const before = JSON.stringify(view);
  groupStoreImages(view);
  assert.equal(JSON.stringify(view), before);
});
