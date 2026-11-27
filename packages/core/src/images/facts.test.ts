import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStoreImages } from '../listing/asset-sync.ts';
import { assetFactsOf, evaluateDraftContent } from '../listing/draft-readiness.ts';
import { summarizeAssets } from '../listing/store-asset-specs.ts';
import {
  assetFact,
  displayImageFacts,
  imagePathOf,
  measuredPathsOf,
  storeImageFacts,
  validateImageFacts,
} from './facts.ts';
import { imageFile, imageFiles, storeSet, storeView, tenPlusTwo } from './fixtures.ts';
import { groupStoreImages } from './groups.ts';

/**
 * ONE AssetFacts builder (audit images.md F7: four builders, four path formats, extension hard-coded or empty).
 */

test('one path format for store, display and draft: locale/kind/device#position', () => {
  assert.equal(
    imagePathOf({ locale: 'en-US', kind: 'screenshot', device: 'ipad_13', position: 4 }),
    'en-US/screenshot/ipad_13#4',
  );
  assert.equal(
    imagePathOf({ locale: 'en-US', kind: 'icon', device: null, position: 1 }),
    'en-US/icon/all#1',
  );
  const view = tenPlusTwo();
  const store = storeImageFacts(view).map((f) => f.path);
  const display = displayImageFacts(groupStoreImages(view)).map((f) => f.path);
  assert.equal(store.length, 12);
  assert.deepEqual(store.slice().sort(), display.slice().sort());
  // a draft built from the same sets gives the same paths (the sibling group's positions continue the counter)
  const draft = assetFactsOf({
    store: 'app_store',
    locales: [
      {
        locale: 'en-US',
        text: {},
        assets: view.sets.map((s) => ({
          kind: s.kind,
          device: s.device,
          target: s.target,
          images: s.files.map((f) => ({ width: f.width, height: f.height })),
        })),
      },
    ],
  }).map((f) => f.path);
  assert.deepEqual(draft.slice().sort(), store.slice().sort());
});

test('Apple counts per store group (set), Google Play per device (set null)', () => {
  const apple = storeImageFacts(tenPlusTwo());
  assert.deepEqual([...new Set(apple.map((f) => f.set))].sort(), [
    'APP_IPAD_PRO_129',
    'APP_IPAD_PRO_3GEN_129',
  ]);
  assert.deepEqual(
    summarizeAssets('app_store', apple).map((s) => [s.set, s.count]),
    [
      ['APP_IPAD_PRO_129', 2],
      ['APP_IPAD_PRO_3GEN_129', 10],
    ],
  );
  const play = storeImageFacts({
    platform: 'android',
    sets: [storeSet('phoneScreenshots', imageFiles(3), { platform: 'android', device: 'phone' })],
  });
  assert.deepEqual(
    play.map((f) => f.set),
    [null, null, null],
  );
});

test('extension: from the name, jpg is jpeg, else the format, else png (a nameless Apple image was reported as "It is .")', () => {
  const base = {
    store: 'app_store',
    locale: 'en-US',
    kind: 'screenshot',
    device: 'ipad_13',
    position: 1,
    width: 2064,
    height: 2752,
  } as const;
  assert.equal(assetFact({ ...base, name: 'a.JPG' }).extension, 'jpeg');
  assert.equal(assetFact({ ...base, name: 'a.png' }).extension, 'png');
  assert.equal(assetFact({ ...base, name: null, format: 'jpeg' }).extension, 'jpeg');
  assert.equal(assetFact({ ...base, name: null }).extension, 'png');
  assert.equal(assetFact({ ...base, extension: 'png', name: 'x.jpg' }).extension, 'png');
  // a nameless store image raises no format problem
  const view = storeView([storeSet('APP_IPAD_PRO_3GEN_129', [imageFile(1, { name: null })])]);
  assert.deepEqual(checkStoreImages(view), []);
});

test('read: a known size is read, an unknown one is not (never an error); an explicit repo path is kept', () => {
  const known = assetFact({
    store: 'app_store',
    locale: 'en-US',
    kind: 'screenshot',
    device: 'ipad_13',
    position: 1,
    width: 1,
    height: 2,
  });
  assert.equal(known.read, 'read');
  const unknown = assetFact({
    store: 'google_play',
    locale: 'en-US',
    kind: 'screenshot',
    device: 'phone',
    position: 1,
    width: null,
    height: null,
    path: 'repo/a.png',
  });
  assert.equal(unknown.read, 'not_read');
  assert.equal(unknown.path, 'repo/a.png');
  assert.equal(unknown.set, null);
});

test('a size measured from a header is only a note; a size the store gave is judged', () => {
  const bad = (sizeFrom: 'store' | 'header') =>
    storeView([
      storeSet('APP_IPAD_PRO_3GEN_129', [imageFile(1, { width: 100, height: 100, sizeFrom })]),
    ]);
  const store = checkStoreImages(bad('store'));
  assert.equal(
    store.some((p) => p.severity === 'error' && p.rule === 'apple.screenshot.size'),
    true,
  );
  const header = checkStoreImages(bad('header'));
  assert.equal(
    header.every((p) => p.severity === 'info'),
    true,
  );
  assert.deepEqual([...measuredPathsOf(bad('header'))], ['en-US/screenshot/ipad_13#1']);
  assert.deepEqual(validateImageFacts('app_store', [], new Set(['x'])), []);
});

test('the draft readiness over 10 + 2 and the Graphics tab agree: no count blocker either way', () => {
  const view = tenPlusTwo();
  const draft = evaluateDraftContent({
    store: 'app_store',
    locales: [
      {
        locale: 'en-US',
        text: {},
        assets: view.sets.map((s) => ({
          kind: s.kind,
          device: s.device,
          target: s.target,
          images: s.files.map((f) => ({ width: f.width, height: f.height })),
        })),
      },
    ],
  });
  assert.equal(
    draft.some((f) => f.rule === 'apple.screenshot.count'),
    false,
  );
  assert.equal(
    checkStoreImages(view).some((p) => p.rule === 'apple.screenshot.count'),
    false,
  );
});
