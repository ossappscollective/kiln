import {
  type StoreImageFile,
  type StoreImageSet,
  type StoreImagesView,
  primaryStoreSet,
} from '../listing/asset-sync.ts';
import { ASSET_KINDS, type AssetKind } from '../listing/store-asset-specs.ts';
import { type ImageLimit, limitOf } from './limits.ts';
import type { AssetPlatform } from '../listing/asset-sync.ts';
import { assetStoreOf } from '../listing/staged-changes.ts';

/**
 * The store's images grouped for DISPLAY, once (docs/state-model.md, "Single owners (core)"). The App Store keeps one display (iPad 13")
 * in more than one placement group (`APP_IPAD_PRO_3GEN_129`, the legacy `APP_IPAD_PRO_129`), each with its own limit of 10. Two units
 * result, and the repo used them interchangeably in eight places (the Graphics tab set header, the staged seed, the remove validation,
 * the cart "before", the pull, `storeSideOf`, the diff, `overLimitOf`): "12 found, at most 10" came back as a disabled Add button, a
 * `set_too_large` on the first removal, and "12 -> 11" in the cart.
 *
 *  - a STORE GROUP is one placement group (`StoreGroup`): the store's own limit applies to it, it is what a store read is judged by;
 *  - a DISPLAY SET is every group of one (locale, kind, device) (`DisplaySet`): what a push replaces, what one staged set holds.
 *
 * `groupStoreImages(view)` returns the display sets, each carrying BOTH the per-group sets and the merged view, the primary group (the
 * ONE that Kiln compares with the repository and pushes to, `primaryStoreSet`) and the counts under three explicit names (`perGroup`,
 * `primary`, `merged`), so nothing sums by accident. Every consumer takes its set from here.
 *
 * Pure. ES2017.
 */

/** One placement group of a display: the store's own set. */
export type StoreGroup = {
  /** The store's name of the group (an Apple placement group, a Play image type). */
  target: string;
  /** The images of the group in the store's display order. */
  files: StoreImageFile[];
  count: number;
  /** The set as the view holds it. */
  set: StoreImageSet;
};

/** One image of the merged display view and the group it sits in. */
export type DisplayImage = { group: string; file: StoreImageFile };

export type DisplayCounts = {
  /** The count of each group: judged against the store's limit one by one. */
  perGroup: { target: string; count: number }[];
  /** The images of the primary group: what the repository comparison and a push use. */
  primary: number;
  /** All groups together: what a push REPLACES, and what a staged set of this display holds when it is seeded from the store. */
  merged: number;
};

export type DisplaySet = {
  /** `locale/kind:device` (`en-US/screenshot:ipad_13`), unique per display. */
  key: string;
  platform: AssetPlatform;
  locale: string;
  kind: AssetKind;
  device: string | null;
  deviceLabel: string;
  /** Every group of the display, in the store's order. */
  groups: StoreGroup[];
  /** The group compared with the repository and pushed to (`primaryStoreSet`). */
  primaryGroup: StoreGroup;
  /** `primaryGroup.target`: the name a staged set is pushed under. */
  pushTarget: string;
  /** The merged view: the primary group first, then the other groups by name; each image keeps its group. */
  images: DisplayImage[];
  /** The images of `images`. */
  files: StoreImageFile[];
  counts: DisplayCounts;
  limit: ImageLimit;
  /** The groups over the store's limit (each judged alone). Empty is the normal case, also for 10 + 2 across two groups. */
  overLimit: { group: string; count: number; max: number }[];
  /**
   * Whether the merged display fits ONE staged set (`counts.merged <= limit.stagedMax`). False for 10 + 2: seeding a staged set from the
   * store would hold 12 and be refused (`set_too_large`), though each store group is fine; the screen offers to trim before it stages.
   */
  stagedFits: boolean;
};

/** The key of a display (locale, kind, device). */
export const displayKeyOf = (ref: {
  locale: string;
  kind: AssetKind;
  device: string | null;
}): string => `${ref.locale}/${ref.kind}${ref.device === null ? '' : `:${ref.device}`}`;

const byTarget = (a: StoreGroup, b: StoreGroup): number =>
  a.target < b.target ? -1 : a.target > b.target ? 1 : 0;

/**
 * The display sets of a store read, sorted by locale, kind, device (the order `summarizeAssets` uses). A set with no images is kept (an
 * empty display is a display). Never mutates its input.
 */
export function groupStoreImages(
  view: Pick<StoreImagesView, 'platform' | 'sets'>,
): DisplaySet[] {
  const store = assetStoreOf(view.platform);
  const byKey = new Map<string, StoreImageSet[]>();
  const order: string[] = [];
  for (const set of view.sets) {
    const key = displayKeyOf(set);
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [set]);
      order.push(key);
    } else list.push(set);
  }
  const out: DisplaySet[] = [];
  for (const key of order) {
    const sets = byKey.get(key) as StoreImageSet[];
    const first = sets[0] as StoreImageSet;
    const groups: StoreGroup[] = sets.map((set) => ({
      target: set.target,
      files: set.files.slice(),
      count: set.files.length,
      set,
    }));
    const primarySet = primaryStoreSet(sets) as StoreImageSet;
    const primaryGroup = groups[sets.indexOf(primarySet)] as StoreGroup;
    const ordered = [primaryGroup, ...groups.filter((g) => g !== primaryGroup).sort(byTarget)];
    const images: DisplayImage[] = [];
    for (const g of ordered) for (const file of g.files) images.push({ group: g.target, file });
    const limit = limitOf(store, first.kind, first.device);
    const overLimit: DisplaySet['overLimit'] = [];
    if (limit.max !== null)
      for (const g of groups) if (g.count > limit.max) overLimit.push({ group: g.target, count: g.count, max: limit.max });
    out.push({
      key,
      platform: view.platform,
      locale: first.locale,
      kind: first.kind,
      device: first.device,
      deviceLabel: first.deviceLabel,
      groups,
      primaryGroup,
      pushTarget: primaryGroup.target,
      images,
      files: images.map((i) => i.file),
      counts: {
        perGroup: groups.map((g) => ({ target: g.target, count: g.count })),
        primary: primaryGroup.count,
        merged: images.length,
      },
      limit,
      overLimit,
      stagedFits: images.length <= limit.stagedMax,
    });
  }
  return out.sort(
    (x, y) =>
      x.locale.localeCompare(y.locale) ||
      ASSET_KINDS.indexOf(x.kind) - ASSET_KINDS.indexOf(y.kind) ||
      (x.device ?? '').localeCompare(y.device ?? ''),
  );
}

/** The display set with this locale, kind and device, or undefined. */
export function findDisplay(
  displays: readonly DisplaySet[],
  ref: { locale: string; kind: AssetKind; device: string | null },
): DisplaySet | undefined {
  const key = displayKeyOf(ref);
  return displays.filter((d) => d.key === key)[0];
}

/** The store image behind a ref (`StoreImageFile.ref`), with its display and group; undefined when no display holds it. */
export function findStoreImage(
  displays: readonly DisplaySet[],
  ref: string,
): { display: DisplaySet; group: StoreGroup; file: StoreImageFile; index: number } | undefined {
  for (const display of displays) {
    for (const group of display.groups) {
      const index = group.files.findIndex((f) => f.ref === ref);
      if (index >= 0) return { display, group, file: group.files[index] as StoreImageFile, index };
    }
  }
  return undefined;
}

/** Every store image ref the display holds: what a removal may name (the union of its sibling groups). */
export const refsOfDisplay = (display: DisplaySet): string[] => display.files.map((f) => f.ref);

/**
 * The counts the Assets tab shows next to the repository's, from the store view the caller already holds (it used to be computed on the
 * server from a view that was at most 60 seconds old and sent with `GET /assets`, so the repository section said "not yet compared" while
 * the Graphics section next to it showed the store's images). One entry per DISPLAY: `count` is the primary group (what a push writes and
 * the repository comparison pairs with), `groups` lists every group when the display has more than one, so nothing is summed. iMessage
 * apps are not compared with the repository and are left out.
 */
export type StoreSide = {
  observedAt: number;
  counts: {
    locale: string;
    kind: AssetKind;
    device: string | null;
    count: number;
    target: string;
    groups?: { target: string; count: number }[];
  }[];
};

export function storeSideOf(view: Pick<StoreImagesView, 'platform' | 'sets' | 'readAt'>): StoreSide {
  const counts: StoreSide['counts'] = [];
  for (const d of groupStoreImages(view)) {
    if ((d.device ?? '').startsWith('imessage:')) continue;
    counts.push({
      locale: d.locale,
      kind: d.kind,
      device: d.device,
      count: d.counts.primary,
      target: d.pushTarget,
      ...(d.groups.length > 1 ? { groups: d.counts.perGroup } : {}),
    });
  }
  return { observedAt: view.readAt, counts };
}
