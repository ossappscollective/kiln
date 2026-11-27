import {
  type AssetKind,
  assetStoreOf,
  deviceLabel,
  groupStoreImages,
  limitOf,
  type Platform,
  type StagedChangesView,
  type StoreImagesView,
} from '@kiln/core';
import { deviceText } from './device-text.ts';
import { stagedFileRows, stagedSetOf } from './sync.ts';

/**
 * What the Graphics tab shows per language and screen size: the store's images, or, where a change is staged, the staged set (the
 * files a push would make the store's set), with the address to draw each from. Pure: the addresses come in as functions.
 */
export type GraphicRow = {
  key: string;
  /** 1-based. */
  position: number;
  name: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** A picture to draw small (a proxied store thumbnail, an uploaded file, a repository file), or null. */
  thumb: string | null;
  /** The ORIGINAL file, for the viewer, Save and Copy, or null when there is no preview. */
  full: string | null;
  /** The store image's `ref` (absent for a staged row). */
  ref?: string;
  /** The git blob id of a staged file (absent for a store image): what a removal names it by. */
  oid?: string;
  /** This image is part of a staged set, not what the store holds. */
  staged: boolean;
  /** The store's own group the image sits in (an App Store placement group); null for a staged row. */
  group: string | null;
};

export type GraphicSet = {
  id: string;
  locale: string;
  kind: AssetKind;
  device: string | null;
  deviceLabel: string;
  /** A change to this set is staged (the rows are the staged ones). */
  staged: boolean;
  /** The staged set is EMPTY: a push removes every image the store holds in it (`rows` is then empty). */
  cleared: boolean;
  /** How many images the store holds in it now (0 for a set that exists only as a staged one). */
  storeCount: number;
  rows: GraphicRow[];
  /**
   * The store's own groups this display is held in, with the images in each, when it is more than one (the App Store's 13" and legacy
   * 12.9" groups): the grid shows them together, each group has its own limit and is never added to another.
   */
  groups: { target: string; count: number }[];
  /** The display is held in more than one store group (`groups` has them). */
  grouped: boolean;
  /** The most images ONE store group takes (the store's limit, judged group by group), 0 when the kind has none. */
  max: number;
  /** The most images a staged set of this display holds (what a push writes). */
  stagedMax: number;
  /** The images of the display in all its groups: the number a push replaces (`DisplaySet.counts.merged`; for a staged set, its files). */
  total: number;
};

export type GraphicLocale = { locale: string; sets: GraphicSet[]; /** The images of its displays (a total of `GraphicSet.total`). */ imageCount: number; /** Some set of the locale is staged. */ hasStaged: boolean };

export type AddressBook = {
  thumb: (ref: string) => string;
  file: (ref: string) => string;
  blob: (oid: string) => string;
  repo: (path: string, commit: string) => string;
};

const setKey = (locale: string, kind: string, device: string | null) =>
  `${locale}/${kind}/${device ?? ''}`;

export function buildGraphicSets(args: {
  platform: Platform;
  view: StoreImagesView | null;
  staged: StagedChangesView | null;
  urls: AddressBook;
}): GraphicLocale[] {
  const { platform, view, staged, urls } = args;
  const store = assetStoreOf(platform);
  const sets = new Map<string, GraphicSet>();
  // The store's side: ONE display per (locale, kind, device) from the core owner (`groupStoreImages`): its images in every group (the
  // primary group first), the count of each group and the limits. Nothing here sums or compares a group against a limit.
  for (const d of view ? groupStoreImages(view) : []) {
    if (d.files.length === 0) continue;
    const rows: GraphicRow[] = d.images.map((image, index) => {
      const f = image.file;
      return {
        key: f.ref,
        position: index + 1,
        name: f.name ?? '',
        width: f.width,
        height: f.height,
        bytes: f.bytes,
        thumb: f.downloadable ? urls.thumb(f.ref) : null,
        full: f.downloadable ? urls.file(f.ref) : null,
        ref: f.ref,
        staged: false,
        group: image.group,
      };
    });
    sets.set(setKey(d.locale, d.kind, d.device), {
      id: setKey(d.locale, d.kind, d.device),
      locale: d.locale,
      kind: d.kind,
      device: d.device,
      deviceLabel: deviceText(d.kind, d.device, d.deviceLabel),
      staged: false,
      cleared: false,
      storeCount: d.counts.merged,
      rows,
      groups: d.groups.length > 1 ? d.counts.perGroup.map((g) => ({ target: g.target, count: g.count })) : [],
      grouped: d.groups.length > 1,
      max: d.limit.max ?? 0,
      stagedMax: d.limit.stagedMax,
      total: d.counts.merged,
    });
  }
  for (const a of staged?.assets ?? []) {
    if (a.pushed) continue;
    const key = setKey(a.locale, a.slot.kind, a.slot.device);
    const found = sets.get(key);
    // A key names the file (its blob id and which copy of it), never its place: removing an image does not give the ones after it a
    // new key, so the grid patches in place instead of drawing them again.
    const seen: Record<string, number> = {};
    const rows: GraphicRow[] = stagedFileRows(
      stagedSetOf(staged, a.locale, a.slot.kind, a.slot.device),
    ).map((r) => {
      const url = r.upload
        ? urls.blob(r.oid)
        : r.commit !== ''
          ? urls.repo(r.path, r.commit)
          : null;
      const copy = (seen[r.oid] = (seen[r.oid] ?? 0) + 1);
      return {
        key: `staged:${r.oid}:${copy}`,
        position: r.position,
        name: r.name,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        thumb: url,
        full: url,
        oid: r.oid,
        staged: true,
        group: null,
      };
    });
    const limit = limitOf(store, a.slot.kind, a.slot.device);
    sets.set(key, {
      id: key,
      locale: a.locale,
      kind: a.slot.kind,
      device: a.slot.device,
      deviceLabel:
        found?.deviceLabel ??
        deviceText(a.slot.kind, a.slot.device, deviceLabel(store, a.slot.device)),
      staged: true,
      cleared: a.cleared === true,
      storeCount: found?.storeCount ?? 0,
      rows,
      // A staged set is ONE set that a push writes to one group: the store's groups are what it replaces, shown as the store's note.
      groups: found?.groups ?? [],
      grouped: found?.grouped ?? false,
      max: limit.max ?? 0,
      stagedMax: limit.stagedMax,
      total: rows.length,
    });
  }
  const out: GraphicLocale[] = [];
  for (const set of sets.values()) {
    const own = out.find((l) => l.locale === set.locale);
    if (own) own.sets.push(set);
    else out.push({ locale: set.locale, sets: [set], imageCount: 0, hasStaged: false });
  }
  for (const l of out) {
    l.sets.sort(
      (a, b) => a.kind.localeCompare(b.kind) || (a.device ?? '').localeCompare(b.device ?? ''),
    );
    l.imageCount = l.sets.reduce((n, s) => n + s.rows.length, 0);
    l.hasStaged = l.sets.some((s) => s.staged);
  }
  return out.sort((a, b) => a.locale.localeCompare(b.locale));
}

/** A move of the image at `from` by `delta` places (-1 earlier, +1 later), or null when it cannot move that way. 1-based. */
export function moveBy(
  from: number,
  delta: number,
  count: number,
): { from: number; to: number } | null {
  const to = from + delta;
  return from >= 1 && from <= count && to >= 1 && to <= count && to !== from ? { from, to } : null;
}

/**
 * Whether another image can be added to the set: a staged set of the display (what a push writes) has room (`stagedMax`, the limit of one
 * staged set; the images of every group of the display count, because a push replaces all of them). Each store group is judged alone
 * elsewhere (`DisplaySet.overLimit`); this is about the set an add would stage.
 */
export const canAddMore = (set: Pick<GraphicSet, 'rows' | 'stagedMax'>): boolean => set.rows.length < set.stagedMax;
