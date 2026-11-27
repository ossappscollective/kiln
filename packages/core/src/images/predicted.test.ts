import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStoreImages } from '../listing/asset-sync.ts';
import { type StagedImage, predictedImagesOf } from './predicted.ts';
import { IPAD, imageFiles, storeSet, storeView, tenPlusTwo } from './fixtures.ts';

/**
 * The draft after the staged changes (audit images.md F2.2: the Graphics tab said "12 found" after the extra images were staged for removal
 * while the server's readiness said the draft was fine).
 */

const shots = (n: number): StagedImage[] => Array.from({ length: n }, (_, i) => ({ ...IPAD, name: `${i + 1}.png` }));
const slot = { locale: 'en-US', kind: 'screenshot', device: 'ipad_13' } as const;

test('12 in ONE group: the store view says 12 found; after staging 10 the draft is fine (store view still says it)', () => {
  const view = storeView([storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(12))]);
  assert.equal(checkStoreImages(view).filter((p) => p.rule === 'apple.screenshot.count').length, 1);
  const predicted = predictedImagesOf(view, [{ ...slot, files: shots(10) }]);
  assert.deepEqual(predicted.problems.filter((p) => p.rule === 'apple.screenshot.count'), []);
  assert.equal(predicted.displays[0]?.count, 10);
  assert.equal(predicted.displays[0]?.touched, true);
  assert.equal(predicted.applied, 1);
  // staging 11 is still over
  const still = predictedImagesOf(view, [{ ...slot, files: shots(11) }]);
  assert.equal(still.problems.filter((p) => p.rule === 'apple.screenshot.count').length, 1);
});

test('10 + 2 siblings: staging the display replaces BOTH groups with one group of the staged files (no 12 on top)', () => {
  const predicted = predictedImagesOf(tenPlusTwo(), [{ ...slot, files: shots(9) }]);
  const d = predicted.displays[0];
  assert.deepEqual(d?.groups, [{ target: 'APP_IPAD_PRO_3GEN_129', count: 9 }]);
  assert.equal(d?.images.every((i) => i.staged), true);
  assert.deepEqual(predicted.problems, []);
});

test('untouched displays keep the store groups and their refs (a removal or a pull can still name them)', () => {
  const predicted = predictedImagesOf(tenPlusTwo(), [
    { locale: 'fr-FR', kind: 'screenshot', device: 'iphone_6_9', files: [{ width: 1320, height: 2868 }] },
  ]);
  const en = predicted.displays.find((d) => d.locale === 'en-US');
  assert.equal(en?.touched, false);
  assert.equal(en?.count, 12);
  assert.equal(en?.images[11]?.ref, 'b-12');
  const fr = predicted.displays.find((d) => d.locale === 'fr-FR');
  assert.equal(fr?.touched, true);
  assert.equal(fr?.groups[0]?.target, 'screenshot:iphone_6_9');
});

test('a cleared set removes the display', () => {
  const predicted = predictedImagesOf(tenPlusTwo(), [{ ...slot, files: [], cleared: true }]);
  assert.deepEqual(predicted.displays, []);
  assert.deepEqual(predicted.facts, []);
});

test('PUSHED vs UNPUSHED: pushed sets are not applied again by default (the view was read after the push), unless asked', () => {
  const view = storeView([storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(4))]);
  const sets = [
    { ...slot, files: shots(2), pushed: true },
    { locale: 'en-US', kind: 'screenshot' as const, device: 'iphone_6_9', files: shots(1) },
  ];
  const ignore = predictedImagesOf(view, sets);
  assert.equal(ignore.skippedPushed, 1);
  assert.equal(ignore.applied, 1);
  assert.equal(ignore.displays.find((d) => d.device === 'ipad_13')?.count, 4);
  const apply = predictedImagesOf(view, sets, { pushed: 'apply' });
  assert.equal(apply.skippedPushed, 0);
  assert.equal(apply.applied, 2);
  assert.equal(apply.displays.find((d) => d.device === 'ipad_13')?.count, 2);
});

test('a staged file of a wrong size is judged by the same rule as the store (apple.screenshot.size)', () => {
  const predicted = predictedImagesOf(storeView([]), [{ ...slot, files: [{ width: 100, height: 100 }] }]);
  assert.equal(predicted.problems.some((p) => p.rule === 'apple.screenshot.size' && p.severity === 'error'), true);
});

test('Google Play: staging 9 phone screenshots is over 8; never mutates the view', () => {
  const view = { platform: 'android' as const, sets: [storeSet('phoneScreenshots', imageFiles(3), { platform: 'android', device: 'phone' })] };
  const before = JSON.stringify(view);
  const predicted = predictedImagesOf(view, [{ locale: 'en-US', kind: 'screenshot', device: 'phone', files: Array.from({ length: 9 }, () => ({ width: 1080, height: 1920 })) }]);
  assert.equal(predicted.problems.some((p) => p.rule === 'play.screenshot.count'), true);
  assert.equal(JSON.stringify(view), before);
});
