import type { DraftSet, SubmitBlocker } from '../listing/draft-readiness.ts';
import type { AssetKind } from '../listing/store-asset-specs.ts';

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

/** What readiness needs of a store read: the Graphics view (`StoreImagesView`) satisfies it, and so does a connector's own grouping of its records. */
export type ReadinessImagesInput<F extends { width: number | null; height: number | null }> = {
  sets: readonly {
    locale: string;
    kind: AssetKind;
    device: string | null;
    target: string;
    files: readonly F[];
  }[];
  unplaced: number;
};

export type ReadinessImages<I = { width: number | null; height: number | null }> = {
  /** Per locale, the sets in the shape of `DraftContent.locales[].assets` (one entry per store group). */
  locales: { locale: string; assets: (Omit<DraftSet, 'images'> & { images: I[] })[] }[];
  /** Images the store holds that could not be placed in any display. Never part of a set. */
  unplaced: number;
  /** The warning for `unplaced`, or null. */
  notice: ReadinessImageNotice | null;
};

export function readinessImagesOf<
  F extends { width: number | null; height: number | null },
  I = { width: number | null; height: number | null },
>(
  view: ReadinessImagesInput<F>,
  pick: (file: F) => I = ((f: F) => ({ width: f.width, height: f.height })) as unknown as (file: F) => I,
): ReadinessImages<I> {
  type Set_ = ReadinessImages<I>['locales'][number]['assets'][number];
  const byLocale = new Map<string, Set_[]>();
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
      images: set.files.map(pick),
    });
  }
  const unplaced = Math.max(0, view.unplaced);
  return {
    locales: order.sort().map((locale) => ({ locale, assets: byLocale.get(locale) as Set_[] })),
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

/**
 * The records of a connector's store read (one per image, `position` the store's own) grouped into store sets (one per locale, kind, device
 * and group; the files in the store's order). The connectors use it so that the submit read and the Graphics read group alike; the server
 * view builder keeps its own (it also makes the refs).
 */
export function setsOfImageRecords<
  R extends { locale: string; kind: AssetKind; device: string | null; target: string; position: number },
>(records: readonly R[]): { locale: string; kind: AssetKind; device: string | null; target: string; files: R[] }[] {
  const byId = new Map<string, { locale: string; kind: AssetKind; device: string | null; target: string; files: R[] }>();
  for (const r of records.slice().sort((a, b) => a.position - b.position)) {
    const id = `${r.locale}\0${r.kind}\0${r.device ?? ''}\0${r.target}`;
    let set = byId.get(id);
    if (set === undefined) {
      set = { locale: r.locale, kind: r.kind, device: r.device, target: r.target, files: [] };
      byId.set(id, set);
    }
    set.files.push(r);
  }
  return [...byId.values()];
}

/**
 * What `GET /apps/:id/publish/readiness` answers (docs/api/pending.md "Current readiness"): what blocks a submit NOW, from one read of the store
 * through the decisions above. The server builds it (`readCurrentReadiness`), the browser reads it: ONE type (the browser kept a hand copy,
 * `PublishReadiness`).
 */
export type CurrentReadiness = {
  appId: string;
  ready: boolean;
  blockers: SubmitBlocker[];
  unknown: string[];
  /** The staged push was merged into the store's draft. */
  predicted: boolean;
  /** The version the submit would send, null when none. */
  versionString: string | null;
  /** When the store was read (epoch ms): the age of the images and texts behind the answer. */
  storeReadAt: number;
  /** Served from the server's 30 second cache (the store was not asked again). */
  cached: boolean;
};
