import {
  type AssetKind,
  assetStoreOf,
  deviceLabel,
  type Platform,
  type StagedChangesView,
  type StoreImagesView,
  slotMaxFiles,
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
  /** The most images the store takes in this set, 0 when unknown. */
  max: number;
};

export type GraphicLocale = { locale: string; sets: GraphicSet[] };

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
  const targetOf = new Map<string, string>();
  for (const s of view?.sets ?? []) {
    if (s.files.length === 0) continue;
    const key = setKey(s.locale, s.kind, s.device);
    const own = sets.get(key);
    for (const f of s.files) targetOf.set(f.ref, s.target);
    const rows: GraphicRow[] = s.files.map((f) => ({
      key: f.ref,
      position: f.position,
      name: f.name ?? '',
      width: f.width,
      height: f.height,
      bytes: f.bytes,
      thumb: f.downloadable ? urls.thumb(f.ref) : null,
      full: f.downloadable ? urls.file(f.ref) : null,
      ref: f.ref,
      staged: false,
    }));
    if (own) {
      own.rows.push(...rows);
      own.storeCount += rows.length;
      own.groups.push({ target: s.target, count: rows.length });
    } else
      sets.set(key, {
        id: key,
        locale: s.locale,
        kind: s.kind,
        device: s.device,
        deviceLabel: deviceText(s.kind, s.device, s.deviceLabel),
        staged: false,
        cleared: false,
        storeCount: rows.length,
        rows,
        groups: [{ target: s.target, count: rows.length }],
        max: slotMaxFiles(platform, { kind: s.kind, device: s.device }),
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
      };
    });
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
      groups: found?.groups ?? [],
      max: found?.max ?? slotMaxFiles(platform, a.slot),
    });
  }
  const out: GraphicLocale[] = [];
  for (const set of sets.values()) {
    // The groups of a display are shown one after the other (each in its own order), not interleaved by place.
    const groupOf = (r: GraphicRow) => set.groups.findIndex((g) => g.target === targetOf.get(r.key));
    set.rows.sort((x, y) => groupOf(x) - groupOf(y) || x.position - y.position);
    if (set.groups.length < 2) set.groups = [];
    const own = out.find((l) => l.locale === set.locale);
    if (own) own.sets.push(set);
    else out.push({ locale: set.locale, sets: [set] });
  }
  for (const l of out)
    l.sets.sort(
      (a, b) => a.kind.localeCompare(b.kind) || (a.device ?? '').localeCompare(b.device ?? ''),
    );
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

/** Whether another image can be added to the set. */
export const canAddMore = (set: Pick<GraphicSet, 'rows' | 'max'>): boolean =>
  set.max === 0 || set.rows.length < set.max;
