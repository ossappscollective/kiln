import {
  type AssetKind,
  type AssetSlot,
  isApplePlatform,
  PLAY_DEVICES,
  PLAY_GRAPHIC_FILES,
  type Platform,
} from '@mrm/core';
import { screenshotFolders } from './store-assets.ts';

/**
 * Where the files of a set go in a repository, and which files have to be written or deleted to make the repository's set
 * the wanted one (docs/adr/0012-assets-two-way-sync.md). Pure: paths and ids in, steps out; the caller reads and writes bytes.
 *
 * Layouts are the ones the asset index reads (store-assets.ts):
 * - App Store (fastlane deliver): `<screenshots folder>/<locale>/<file>`; the display is found from the pixel size, not the
 *   name. The folder is the one the repository already uses for screenshots, else `<metadata>/../screenshots` or
 *   `<metadata>/screenshots` next to the listing folder.
 * - Google Play (fastlane supply): `<root>/<locale>/images/<phoneScreenshots|...>/<file>` and
 *   `<root>/<locale>/images/<icon|featureGraphic|promoGraphic|tvBanner>.<ext>`.
 * Order is the order of the file names (deliver sorts by path, supply by file name), so files that have to move are renamed
 * to `<device>-01.png`, `<device>-02.png`, ... and a set whose order already follows its names keeps them.
 */

export type RepoSetFile = { path: string; oid: string | null };

export type PlanLayout = {
  dir: string /** A graphic of Google Play has one fixed name. */;
  fixedStem: string | null;
  stem: string;
};

export type LayoutInput = {
  platform: Platform;
  locale: string;
  slot: AssetSlot;
  roots: { appStore: string | null; googlePlay: string | null };
  /** Every store file of the repository (the asset index), to learn where this repository keeps its files. */
  existing: readonly { path: string; locale: string; kind: AssetKind; device: string | null }[];
};

const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const join = (...parts: string[]): string => parts.filter((p) => p !== '').join('/');

/** deliver's default is `screenshots` next to the `metadata` folder; inside the listing folder when it is not called that. */
const defaultScreenshotFolder = (appStoreRoot: string): string => {
  const folders = screenshotFolders(appStoreRoot);
  return folders[1] ?? folders[0] ?? 'screenshots';
};

export function layoutFor(
  input: LayoutInput,
): { ok: true; layout: PlanLayout } | { ok: false; message: string } {
  const { platform, locale, slot } = input;
  const stem = slot.device ?? slot.kind;
  if (isApplePlatform(platform)) {
    if (slot.kind !== 'screenshot')
      return {
        ok: false,
        message: 'Only App Store screenshots are put in a repository from here.',
      };
    const mine = input.existing.find(
      (a) => a.locale === locale && a.kind === slot.kind && a.device === slot.device,
    );
    if (mine) return { ok: true, layout: { dir: dirname(mine.path), fixedStem: null, stem } };
    // Where does this repository keep its screenshots? `<base>/<locale>/<file>` of any other locale.
    for (const a of input.existing) {
      if (a.kind !== 'screenshot') continue;
      const folder = dirname(a.path);
      if (basename(folder) === a.locale && a.locale !== '')
        return { ok: true, layout: { dir: join(dirname(folder), locale), fixedStem: null, stem } };
    }
    if (input.roots.appStore === null)
      return {
        ok: false,
        message: 'This repository has no App Store listing folder to put screenshots in.',
      };
    return {
      ok: true,
      layout: {
        dir: join(defaultScreenshotFolder(input.roots.appStore), locale),
        fixedStem: null,
        stem,
      },
    };
  }
  const root = input.roots.googlePlay;
  if (root === null)
    return {
      ok: false,
      message: 'This repository has no Google Play listing folder to put images in.',
    };
  if (slot.kind === 'screenshot') {
    const device = PLAY_DEVICES.find((d) => d.id === slot.device);
    if (!device) return { ok: false, message: 'Not a Google Play screenshot type.' };
    return {
      ok: true,
      layout: { dir: join(root, locale, 'images', device.dir), fixedStem: null, stem },
    };
  }
  const name = Object.keys(PLAY_GRAPHIC_FILES).find((n) => PLAY_GRAPHIC_FILES[n] === slot.kind);
  if (name === undefined) return { ok: false, message: 'Not a Google Play graphic.' };
  return { ok: true, layout: { dir: join(root, locale, 'images'), fixedStem: name, stem } };
}

export type Wanted =
  /** A file of the repository that is part of the wanted set (it keeps its path unless the set has to be renamed). */
  | { kind: 'existing'; path: string; oid: string }
  /** New content (a file of the store, an upload). */
  | { kind: 'new'; oid: string; format: 'png' | 'jpeg' };

export type PlanStep =
  | {
      op: 'write';
      path: string;
      oid: string;
      from: { kind: 'new'; index: number } | { kind: 'repo'; path: string };
      replacesOid: string | null;
    }
  | { op: 'delete'; path: string; oid: string };

export type SetPlan = {
  steps: PlanStep[] /** The path of each wanted file in the end. */;
  paths: string[];
  renamed: boolean;
  unchanged: number;
  left: string[];
};

const extOf = (format: string): string => (format === 'jpeg' ? 'jpg' : 'png');
const extOfPath = (path: string): string => {
  const e = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
};

/** `<stem>-01.png`: two digits at least, so the names sort as the numbers do. */
export function generatedName(
  layout: PlanLayout,
  index: number,
  count: number,
  ext: string,
): string {
  if (layout.fixedStem !== null) return `${layout.fixedStem}.${ext}`;
  const width = Math.max(2, String(count).length);
  return `${layout.stem}-${String(index + 1).padStart(width, '0')}.${ext}`;
}

const ascending = (paths: readonly string[]): boolean =>
  paths.every((p, i) => i === 0 || basename(paths[i - 1] as string) < basename(p));

/**
 * The steps that make the repository's set (`current`, in index order) the wanted one. A new file takes over the path of the
 * file at its position when that has the same extension, so the order of the names stays; if the names then do not sort in
 * the wanted order, or collide, every file gets a generated name. Files of the repository that are not wanted are deleted
 * only when `prune` is set (always for a Google Play graphic, which holds one file).
 */
export function planSet(input: {
  layout: PlanLayout;
  current: readonly RepoSetFile[];
  wanted: readonly Wanted[];
  prune: boolean;
}): SetPlan {
  const { layout, current, wanted } = input;
  const taken = new Set(current.map((c) => c.path));
  const names = (canonical: boolean): string[] => {
    const used = new Set<string>();
    const out: string[] = [];
    wanted.forEach((w, i) => {
      let path: string;
      if (!canonical && w.kind === 'existing') path = w.path;
      else if (
        !canonical &&
        layout.fixedStem === null &&
        current[i] &&
        extOfPath(current[i].path) === extOf(w.kind === 'new' ? w.format : extOfPath(w.path)) &&
        !used.has(current[i].path)
      )
        path = current[i].path;
      else {
        const ext = w.kind === 'new' ? extOf(w.format) : extOfPath(w.path) || 'png';
        path = `${layout.dir}/${generatedName(layout, i, wanted.length, ext)}`;
        if (!canonical) {
          let n = 2;
          while ((used.has(path) || taken.has(path)) && layout.fixedStem === null)
            path = `${layout.dir}/${generatedName(layout, i, wanted.length, ext).replace(/(\.[a-z]+)$/, `-${n++}$1`)}`;
        }
      }
      used.add(path);
      out.push(path);
    });
    return out;
  };
  let paths = names(false);
  let renamed = false;
  if (new Set(paths).size !== paths.length || !ascending(paths)) {
    paths = names(true);
    renamed = true;
  }
  const byPath = new Map(current.map((c) => [c.path, c.oid]));
  const steps: PlanStep[] = [];
  let unchanged = 0;
  const finalPaths = new Set(paths);
  wanted.forEach((w, i) => {
    const path = paths[i] as string;
    const now = byPath.get(path) ?? null;
    if (w.kind === 'existing') {
      if (path === w.path) {
        unchanged++;
        return;
      }
      steps.push({
        op: 'write',
        path,
        oid: w.oid,
        from: { kind: 'repo', path: w.path },
        replacesOid: now,
      });
      return;
    }
    if (now !== null && now === w.oid) {
      unchanged++;
      return;
    }
    steps.push({
      op: 'write',
      path,
      oid: w.oid,
      from: { kind: 'new', index: i },
      replacesOid: now,
    });
  });
  const left: string[] = [];
  for (const c of current) {
    if (finalPaths.has(c.path) || c.oid === null) continue;
    // A file that moved is deleted at its old place; the others only when asked (or when the set holds one file).
    const moved = wanted.some((w) => w.kind === 'existing' && w.path === c.path);
    if (moved || input.prune || layout.fixedStem !== null)
      steps.push({ op: 'delete', path: c.path, oid: c.oid });
    else left.push(c.path);
  }
  return { steps, paths, renamed, unchanged, left };
}
