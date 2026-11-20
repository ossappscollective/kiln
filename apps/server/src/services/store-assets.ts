import { isLocaleDir } from '@mrm/connectors';
import { type AssetKind, type AssetStore, classifyApplePreviewName, type Platform, PLAY_DEVICES, PLAY_GRAPHIC_FILES, supports } from '@mrm/core';

/**
 * Which files of a repository are store media, and what each one is. Pure: a list of paths in, a
 * list of candidates out; nothing is read here (asset-index.ts reads the bytes).
 *
 * Layouts (the same target and root rules as the text listing: `roots` are the folders that
 * `readListings` chose, or those of the selected listing target):
 *
 * - Google Play, fastlane `supply`:
 *   `<googlePlay root>/<locale>/images/{icon,featureGraphic,promoGraphic,tvBanner}.(png|jpg|jpeg)`
 *   and `.../images/{phone,sevenInch,tenInch,tv,wear}Screenshots/<file>.(png|jpg|jpeg)`.
 *   https://docs.fastlane.tools/actions/supply/ ("extension can be png, jpg or jpeg";
 *   screenshots "will appear in the Play Store in alphanumerical filename order").
 * - App Store, fastlane `deliver`: `screenshots_path` is "a path to a folder containing subfolders
 *   for each language" (https://docs.fastlane.tools/actions/deliver/); the default is
 *   `./fastlane/screenshots`, next to `fastlane/metadata`. deliver's loader
 *   (deliver/lib/deliver/loader.rb) globs `*.{png,jpg,jpeg}` case-insensitively in each language
 *   folder and sorts by path; `iMessage/<language>/` and `appleTV/<language>/` are special folders
 *   with language folders inside, and `default` is the language-less folder. The device of a
 *   screenshot is found from its pixel size (`AppScreenshot`), not from its name, so it is
 *   classified after the header is read (asset-index.ts). Many repositories keep the screenshots
 *   inside the metadata folder instead (`<root>/screenshots/<locale>/`, as `oss-weather` does with
 *   a Fastfile `screenshots_path`); both places are looked at. A `screenshots_path` that is only in a
 *   Fastfile or Deliverfile is NOT followed.
 * - App previews: deliver's `app_previews_path` defaults to `./fastlane/app-previews`, "structured
 *   with language-specific subfolders, similar to screenshots" (`.mov`, `.m4v`, `.mp4`; device from
 *   the file name). Listed with their size, never opened.
 * - Project icons (`app_icon`): Expo `icon` of `app.json`, an Xcode `AppIcon.appiconset`, an
 *   Android `ic_launcher.png`. These are not listing files; they feed the app icon only.
 */

export type AssetCandidate = {
  path: string;
  store: AssetStore;
  /** A locale folder name, `default`, or `''` for a project icon. */
  locale: string;
  kind: AssetKind;
  /** A Play device id, or an App Store display id when the name says (previews). Null: from the size. */
  device: string | null;
  /** A screenshot of the iMessage folder: its device ids carry `IMESSAGE_PREFIX`. */
  imessage: boolean;
  /** Lower case, no dot. */
  extension: string;
  origin: 'store' | 'project';
  /** Smaller is read first when only some files can be read (the GitHub budget). */
  priority: number;
};

export type DiscoveryFolders = {
  /** Folders that were searched for App Store screenshots. */
  screenshots: string[];
  previews: string[];
  /** The Play folder that holds `<locale>/images`, or null. */
  androidImages: string | null;
};

export type Discovery = {
  candidates: AssetCandidate[];
  folders: DiscoveryFolders;
  notes: string[];
};

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const VIDEO_EXT = /\.(mov|m4v|mp4)$/i;
const IGNORED_PATHS = /(^|\/)(node_modules|Pods|vendor|\.git|build|DerivedData)\//;

const extensionOf = (path: string) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);

/** Where deliver looks for screenshots, given the folder of the App Store locale folders. */
export function screenshotFolders(appStoreRoot: string): string[] {
  const folders = [join(appStoreRoot, 'screenshots')];
  // The default: `fastlane/screenshots` next to `fastlane/metadata`.
  const match = /^(?:(.*)\/)?metadata$/.exec(appStoreRoot);
  if (match) folders.push(join(match[1] ?? '', 'screenshots'));
  return folders;
}

export function previewFolders(appStoreRoot: string): string[] {
  const folders = [join(appStoreRoot, 'app-previews')];
  const match = /^(?:(.*)\/)?metadata$/.exec(appStoreRoot);
  if (match) folders.push(join(match[1] ?? '', 'app-previews'));
  return folders;
}

const priorityOf = (kind: AssetKind) =>
  kind === 'app_icon'
    ? 0
    : kind === 'icon'
      ? 1
      : kind === 'feature_graphic'
        ? 2
        : kind === 'tv_banner'
          ? 3
          : kind === 'promo_graphic'
            ? 4
            : kind === 'screenshot'
              ? 5
              : 6;

const under = (path: string, folder: string) =>
  folder === '' ? true : path.startsWith(`${folder}/`);

/**
 * The store media of one platform. `roots` are the listing roots (the folder of the locale folders
 * of each store); an empty string means that store is not read. `store` says which one is wanted.
 */
export function discoverStoreAssets(
  files: readonly string[],
  roots: { appStore: string; googlePlay: string },
  store: AssetStore,
): Discovery {
  const candidates: AssetCandidate[] = [];
  const notes: string[] = [];
  const folders: DiscoveryFolders = { screenshots: [], previews: [], androidImages: null };
  const seen = new Set<string>();
  const add = (c: AssetCandidate) => {
    if (seen.has(c.path)) return;
    seen.add(c.path);
    candidates.push(c);
  };
  let ignoredImages = 0;

  if (store === 'google_play' && roots.googlePlay !== '') {
    const root = roots.googlePlay;
    const devices = new Map(PLAY_DEVICES.map((d) => [d.dir, d.id]));
    for (const path of files) {
      if (!under(path, root) || IGNORED_PATHS.test(path)) continue;
      const parts = path.slice(root === '' ? 0 : root.length + 1).split('/');
      const [locale, images, first, second, ...rest] = parts;
      if (!locale || images !== 'images' || !isLocaleDir(locale) || first === undefined) continue;
      if (second === undefined) {
        // images/<name>.<ext>
        const dot = first.lastIndexOf('.');
        const kind = dot > 0 ? PLAY_GRAPHIC_FILES[first.slice(0, dot)] : undefined;
        if (!kind) continue;
        if (!IMAGE_EXT.test(first)) {
          ignoredImages++;
          continue;
        }
        folders.androidImages = root;
        add({
          path,
          store,
          locale,
          kind,
          device: null,
          imessage: false,
          extension: extensionOf(path),
          origin: 'store',
          priority: priorityOf(kind) });
      } else if (rest.length === 0) {
        const device = devices.get(first);
        if (!device) continue;
        folders.androidImages = root;
        if (!IMAGE_EXT.test(second)) {
          ignoredImages++;
          continue;
        }
        add({
          path,
          store,
          locale,
          kind: 'screenshot',
          device,
          imessage: false,
          extension: extensionOf(path),
          origin: 'store',
          priority: priorityOf('screenshot') });
      }
    }
  }

  if (store === 'app_store' && roots.appStore !== '') {
    folders.screenshots = screenshotFolders(roots.appStore);
    folders.previews = previewFolders(roots.appStore);
    for (const path of files) {
      if (IGNORED_PATHS.test(path)) continue;
      for (const folder of folders.screenshots) {
        if (!under(path, folder)) continue;
        const parts = path.slice(folder.length + 1).split('/');
        let imessage = false;
        let locale: string | undefined;
        let name: string | undefined;
        if (parts.length === 2) [locale, name] = parts;
        else if (parts.length === 3 && (parts[0] === 'iMessage' || parts[0] === 'appleTV')) {
          imessage = parts[0] === 'iMessage';
          [, locale, name] = parts;
        } else continue;
        if (!locale || !name || (locale !== 'default' && !isLocaleDir(locale))) continue;
        if (!IMAGE_EXT.test(name)) {
          if (/\.(webp|gif|bmp|tiff?|heic|avif)$/i.test(name)) ignoredImages++;
          continue;
        }
        add({
          path,
          store,
          locale,
          kind: 'screenshot',
          device: null,
          imessage,
          extension: extensionOf(path),
          origin: 'store',
          priority: priorityOf('screenshot') });
      }
      for (const folder of folders.previews) {
        if (!under(path, folder)) continue;
        const parts = path.slice(folder.length + 1).split('/');
        const [locale, name] = parts;
        if (parts.length !== 2 || !locale || !name || !VIDEO_EXT.test(name)) continue;
        if (locale !== 'default' && !isLocaleDir(locale)) continue;
        add({
          path,
          store,
          locale,
          kind: 'preview',
          device: classifyApplePreviewName(name),
          imessage: false,
          extension: extensionOf(path),
          origin: 'store',
          priority: priorityOf('preview') });
      }
    }
    // The device of a preview that names none cannot be told, and a preview never goes through the size check.
  }

  if (ignoredImages > 0) {
    notes.push(
      `${ignoredImages} image file${ignoredImages === 1 ? '' : 's'} in the media folders ${ignoredImages === 1 ? 'is' : 'are'} not .png, .jpg or .jpeg, which fastlane does not upload, and ${ignoredImages === 1 ? 'is' : 'are'} not listed.`,
    );
  }
  candidates.sort(
    (a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return { candidates, folders, notes };
}

/** `order` (1-based, by file name) for the files of every locale, kind and device group. */
export function orderWithinSets<
  T extends { path: string; locale: string; kind: AssetKind; device: string | null },
>(items: readonly T[]): Map<string, number> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = `${item.locale}\u0000${item.kind}\u0000${item.device ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(item.path);
    groups.set(key, list);
  }
  const order = new Map<string, number>();
  for (const paths of groups.values()) {
    // The same order as deliver (sorted by path) and Google Play (file name order): code points.
    paths.sort((a, b) =>
      basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : a < b ? -1 : 1,
    );
    paths.forEach((path, index) => order.set(path, index + 1));
  }
  return order;
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A path made of `rel` taken from the folder `dir`, or undefined when it leaves the repository. */
export function resolveRelative(dir: string, rel: string): string | undefined {
  if (rel.startsWith('/') || /[\\\x00-\x1f]/.test(rel)) return undefined;
  const out = dir === '' ? [] : dir.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** The icon paths an Expo `app.json` names for a platform, repository relative, most specific first. */
export function expoIconPaths(appJson: string | undefined, platform: Platform, dir = ''): string[] {
  // Expo has no macOS target: its `icon` belongs to the iOS and Android apps, so a macOS record takes none.
  if (appJson === undefined || platform === 'macos') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(appJson);
  } catch {
    return [];
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(parsed)) return [];
  const expo = isObject(parsed.expo) ? parsed.expo : parsed;
  const section = isObject(expo[platform]) ? (expo[platform] as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const value of [section.icon, expo.icon]) {
    if (typeof value !== 'string' || value.length > 300 || !/\.(png|jpe?g)$/i.test(value)) continue;
    const path = resolveRelative(dir, value);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

const APPICONSET = /^(.*\/)?([^/]*AppIcon[^/]*\.appiconset)\/[^/]+\.png$/i;
const MIPMAP = /^(.*)\/src\/main\/res\/mipmap-(xxxhdpi|xxhdpi|xhdpi|hdpi|mdpi)\/ic_launcher\.png$/;
const DENSITY = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi'];

/** What names an app, to choose between several icon sets of a repository with several apps. */
export function appHints(identifier: string, name: string): string[] {
  const hints = new Set<string>();
  const last = identifier.split('.').pop();
  for (const h of [identifier, last, name, name.replace(/[^A-Za-z0-9]/g, '')]) {
    const v = (h ?? '').trim().toLowerCase();
    if (v.length >= 3) hints.add(v);
  }
  return [...hints];
}

export type ProjectIcons = { candidates: AssetCandidate[]; notes: string[] };

/**
 * The icon of the app itself found in the project: the Expo `icon` (paths from `expoIconPaths`),
 * else an Xcode app icon set (iOS) or an Android launcher icon. When a repository holds several icon
 * sets, only one whose path names the app (its identifier's last part or its name) is used; with no
 * such set, none is, and a note says so.
 */
export function discoverProjectIcons(
  files: readonly string[],
  input: {
    platform: Platform;
    store: AssetStore;
    expoPaths: readonly string[];
    hints: readonly string[];
  },
): ProjectIcons {
  const fileSet = new Set(files);
  const candidates: AssetCandidate[] = [];
  const notes: string[] = [];
  const base = {
    store: input.store,
    locale: '',
    kind: 'app_icon' as const,
    device: null,
    imessage: false,
    origin: 'project' as const };
  const push = (path: string, priority: number) =>
    candidates.push({ ...base, path, extension: extensionOf(path), priority });
  for (const path of input.expoPaths) if (fileSet.has(path)) push(path, 0);

  const pickGroup = <T>(groups: Map<string, T[]>, what: string): T[] => {
    if (groups.size === 0) return [];
    if (groups.size === 1) return [...groups.values()][0] ?? [];
    const named = [...groups.entries()].filter(([dir]) =>
      input.hints.some((h) => dir.toLowerCase().includes(h)),
    );
    if (named.length === 1) return named[0]?.[1] ?? [];
    notes.push(
      `The repository has ${groups.size} ${what}; none could be tied to this app by its name, so none is used for the app icon.`,
    );
    return [];
  };

  if (supports(input.platform, 'screenshotsByDevice')) {
    const sets = new Map<string, string[]>();
    for (const path of files) {
      if (IGNORED_PATHS.test(path)) continue;
      const m = APPICONSET.exec(path);
      if (!m) continue;
      const dir = path.slice(0, path.lastIndexOf('/'));
      sets.set(dir, [...(sets.get(dir) ?? []), path]);
    }
    for (const path of pickGroup(sets, 'Xcode app icon sets').slice(0, 12)) push(path, 1);
  } else {
    const mipmaps = new Map<string, { path: string; density: number }[]>();
    for (const path of files) {
      if (IGNORED_PATHS.test(path)) continue;
      const m = MIPMAP.exec(path);
      if (!m) continue;
      const module = m[1] ?? '';
      mipmaps.set(module, [
        ...(mipmaps.get(module) ?? []),
        { path, density: DENSITY.indexOf(m[2] ?? '') },
      ]);
    }
    const chosen = pickGroup(mipmaps, 'Android launcher icon sets');
    chosen.sort((a, b) => a.density - b.density);
    const best = chosen[0];
    if (best) push(best.path, 1);
  }
  return { candidates, notes };
}
