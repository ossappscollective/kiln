import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDraftContent } from '../listing/draft-readiness.ts';
import { imageFile, imageFiles, storeSet, storeView } from './fixtures.ts';
import { readinessImagesOf } from './readiness.ts';

/**
 * The decision for readiness (audit images.md F1): unknown-size images are `unplaced` with a warning, never added to a group's count;
 * Google Play counts every image type.
 */

test('Apple: ten placed images and two of unknown size: the set is 10 (not 12), unplaced is 2, one warning', () => {
  const view = storeView([storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(10))], { unplaced: 2 });
  const r = readinessImagesOf(view);
  assert.equal(r.locales[0]?.assets[0]?.images.length, 10);
  assert.equal(r.unplaced, 2);
  assert.equal(r.notice?.severity, 'warning');
  assert.equal(r.notice?.count, 2);
  assert.match(r.notice?.message ?? '', /2 images have a size/);
  // fed to the draft rules there is no count blocker, so readiness and the Graphics tab agree on "10"
  const findings = evaluateDraftContent({
    store: 'app_store',
    locales: r.locales.map((l) => ({ locale: l.locale, text: {}, assets: l.assets })),
  });
  assert.equal(
    findings.some((f) => f.rule === 'apple.screenshot.count'),
    false,
  );
  assert.equal(
    readinessImagesOf(storeView([], { unplaced: 1 })).notice?.message.startsWith('1 image has'),
    true,
  );
});

test('no unplaced image: no notice', () => {
  assert.equal(readinessImagesOf(storeView([storeSet('A', imageFiles(1))])).notice, null);
  assert.equal(readinessImagesOf(storeView([])).locales.length, 0);
});

test('sibling groups stay separate in the readiness input (counted per group)', () => {
  const view = storeView([
    storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(10, 1, 'a')),
    storeSet('APP_IPAD_PRO_129', imageFiles(2, 11, 'b')),
  ]);
  const sets = readinessImagesOf(view).locales[0]?.assets ?? [];
  assert.deepEqual(
    sets.map((s) => [s.target, s.images.length]),
    [
      ['APP_IPAD_PRO_3GEN_129', 10],
      ['APP_IPAD_PRO_129', 2],
    ],
  );
});

test('Google Play: TV and Wear screenshots and the TV banner count (play.tv.pair can fire from readiness)', () => {
  const view = {
    sets: [
      storeSet('tvScreenshots', imageFiles(2), {
        platform: 'android',
        device: 'tv',
        locale: 'en-US',
      }),
      storeSet('phoneScreenshots', [imageFile(1, { width: null, height: null })], {
        platform: 'android',
        device: 'phone',
        locale: 'en-US',
      }),
    ],
    unplaced: 0,
  };
  const r = readinessImagesOf(view);
  const kinds = (r.locales[0]?.assets ?? []).map((s) => s.device);
  assert.deepEqual(kinds, ['tv', 'phone']);
  const findings = evaluateDraftContent({
    store: 'google_play',
    locales: r.locales.map((l) => ({ locale: l.locale, text: {}, assets: l.assets })),
  });
  assert.equal(
    findings.some((f) => f.rule === 'play.tv.pair'),
    true,
  );
  // a phone image with no size is never an error
  assert.equal(
    findings.some((f) => f.severity === 'blocking' && f.rule?.startsWith('play.screenshot.size')),
    false,
  );
});
