import { readinessImagesOf, setsOfImageRecords } from '@kiln/core';
import type { StoreImagesRead } from './store-draft-types.ts';
import type { SubmitAssetSet, SubmitImageFact } from './store-submit-types.ts';

/**
 * The images of a submit read, from the SAME store read the Graphics tab uses (`readStoreImages`), through the one readiness decision of
 * `@kiln/core` (`readinessImagesOf`, docs/state-model.md "Store images"). Before, `readSubmitState` made its own read of the placements
 * (Apple: a group's device taken from its first image with a size, images of unknown size counted in the group) and Google Play read five
 * of the eight image types. One read, one grouping, one rule:
 *  - an Apple image of unknown size is in no set: `unplaced` counts it once;
 *  - every Google Play image type counts (phone, 7", 10", TV, Wear, icon, feature graphic, TV banner). Google gives no pixel size in
 *    the listing: the sizes of Play images are known only to the server (it measures the file header, and a measured size is only ever a
 *    note), so `width` and `height` are null here and no size rule fires from a submit read; the counts and `play.tv.pair` do.
 *  - which version: the one `readStoreImages` reads (the editable version, else the live one; Play has one listing).
 */
export function submitImagesOf(read: Pick<StoreImagesRead, 'images' | 'unplaced'>): {
  byLocale: Map<string, SubmitAssetSet[]>;
  unplaced: number;
} {
  const ready = readinessImagesOf(
    { sets: setsOfImageRecords(read.images), unplaced: read.unplaced },
    (i): SubmitImageFact => ({
      id: i.id,
      checksum: i.checksum,
      width: i.width,
      height: i.height,
      state: i.state,
    }),
  );
  const byLocale = new Map<string, SubmitAssetSet[]>();
  for (const l of ready.locales) byLocale.set(l.locale, l.assets);
  return { byLocale, unplaced: ready.unplaced };
}
