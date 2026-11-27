import type { StoreImageFile, StoreImageSet, StoreImagesView } from '../listing/asset-sync.ts';
import type { AssetKind } from '../listing/store-asset-specs.ts';

/** Test builders for store reads (shared by the images tests). Not exported from the package. */

export const IPAD = { width: 2064, height: 2752 };

export const imageFile = (
  position: number,
  over: Partial<StoreImageFile> = {},
): StoreImageFile => ({
  ref: `ref-${position}-${over.name ?? ''}`,
  position,
  name: `${position}.png`,
  width: IPAD.width,
  height: IPAD.height,
  bytes: 1000,
  checksum: null,
  checksumKind: null,
  state: null,
  downloadable: true,
  ...over,
});

/** `count` images from position `from` (1-based), refs prefixed by the group so every ref is unique. */
export const imageFiles = (count: number, from = 1, prefix = 'g'): StoreImageFile[] =>
  Array.from({ length: count }, (_, i) => imageFile(from + i, { ref: `${prefix}-${from + i}` }));

export const storeSet = (
  target: string,
  files: StoreImageFile[],
  over: Partial<StoreImageSet> = {},
): StoreImageSet => ({
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot' as AssetKind,
  device: 'ipad_13',
  deviceLabel: 'iPad 13"',
  target,
  files,
  ...over,
});

export const storeView = (
  sets: StoreImageSet[],
  over: Partial<StoreImagesView> = {},
): StoreImagesView => ({
  appId: 'app',
  platform: 'ios',
  store: 'app_store',
  version: { id: 'v1', versionString: '1.0', state: 'PREPARE_FOR_SUBMISSION', editable: true },
  readAt: 1_000,
  sets,
  unplaced: 0,
  notes: [],
  ...over,
});

/** The audit's scenario: 10 images in APP_IPAD_PRO_3GEN_129 and 2 in the legacy sibling, one display. */
export const tenPlusTwo = (): StoreImagesView =>
  storeView([
    storeSet('APP_IPAD_PRO_3GEN_129', imageFiles(10, 1, 'a')),
    storeSet('APP_IPAD_PRO_129', imageFiles(2, 11, 'b')),
  ]);
