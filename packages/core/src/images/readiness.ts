import type { DraftSet } from '../listing/draft-readiness.ts';
import type { StoreImagesView } from '../listing/asset-sync.ts';

/**
 * How the store's images COUNT for readiness (docs/state-model.md, "Single owners (core)"): the DECISION that used to be made differently
 * per surface (audit images.md F1, F8).
 *
 * THE DIVERGENCE. Three connector reads fed three screens. The Graphics tab (read A) put an Apple image whose size no display recognises into
 * `unplaced` and left it out of every set; readiness (read B) counted it in the group of the first image that had a size. Limit 10 was
 * reached in one and not in the other. Google Play readiness read only phone, 7", 10", icon and feature graphic (no TV, Wear or TV banner,
 * no sizes), so `play.tv.pair` could never fire there, and a TV-over-limit blocker showed only in the Graphics tab.
 *
 * THE DECISION (one rule, stated here, applied to every surface that asks this function):
 *  1. An image of UNKNOWN SIZE (Apple: no display classifies it) belongs to no set. It is counted as `unplaced`, ONCE, per view, and it is
 *     NEVER added to a group's count. Readiness reports it as a WARNING (`images_unplaced`, with the number), never a blocker: it cannot
 *     push the count of a set over its limit, and it is not silently dropped either. The Graphics tab shows the same number.
 *  2. Google Play: every image type counts (phone, 7", 10", TV, Wear, icon, feature graphic, TV banner). Sizes the store gives are judged
 *     by the documented specs; a size this server measured itself from a header is only a note (`checkStoreImages`); no size at all is
 *     never an error.
 *  3. Counts are per store group (the unit of the store's limit); see `groupStoreImages` for the merged display.
 * The input is the SAME store read (read A) the Graphics tab uses, so readiness cannot see other images than the screen next to it.
 *
 * Pure. ES2017.
 */

export type ReadinessImageNotice = {
  code: 'images_unplaced';
  severity: 'warning';
  /** How many images no display recognises. */
  count: number;
  message: string;
};

export type ReadinessImages = {
  /** Per locale, the sets in the shape of `DraftContent.locales[].assets` (one entry per store group). */
  locales: { locale: string; assets: DraftSet[] }[];
  /** Images the store holds that could not be placed in any display. Never part of a set. */
  unplaced: number;
  /** The warning for `unplaced`, or null. */
  notice: ReadinessImageNotice | null;
};

export function readinessImagesOf(
  view: Pick<StoreImagesView, 'sets' | 'unplaced'>,
): ReadinessImages {
  const byLocale = new Map<string, DraftSet[]>();
  const order: string[] = [];
  for (const set of view.sets) {
    let list = byLocale.get(set.locale);
    if (list === undefined) {
      list = [];
      byLocale.set(set.locale, list);
      order.push(set.locale);
    }
    list.push({
      kind: set.kind,
      device: set.device,
      target: set.target,
      images: set.files.map((f) => ({ width: f.width, height: f.height })),
    });
  }
  const unplaced = Math.max(0, view.unplaced);
  return {
    locales: order.sort().map((locale) => ({ locale, assets: byLocale.get(locale) as DraftSet[] })),
    unplaced,
    notice:
      unplaced === 0
        ? null
        : {
            code: 'images_unplaced',
            severity: 'warning',
            count: unplaced,
            message: `${unplaced} ${unplaced === 1 ? 'image has' : 'images have'} a size that no display of the store accepts: ${unplaced === 1 ? 'it is' : 'they are'} not counted in any set.`,
          },
  };
}
