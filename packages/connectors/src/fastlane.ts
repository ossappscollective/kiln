import {
  APP_STORE_FIELDS,
  type AppStoreField,
  type AppStoreListing,
  DEFAULT_LOCALE,
  type FileChange,
  type Listing,
  type LocaleText,
  PLAY_FIELDS,
  type PlayField,
  type PlayListing,
} from '@mrm/core';

/**
 * Store listings as fastlane files. Pure: nothing here touches a network or a disk.
 *
 * Layout (see docs/spikes/repo-conventions.md for the pages it was checked against):
 *
 *   App Store (deliver)   <root>/<locale>/{name,subtitle,description,keywords,...}.txt
 *                         <root>/copyright.txt
 *   Google Play (supply)  <root>/<locale>/{title,short_description,full_description,video}.txt
 *                         <root>/<locale>/changelogs/<versionCode>.txt   (or default.txt)
 *
 * `<root>` is `fastlane/metadata` for the App Store and `fastlane/metadata/android` for Play,
 * or a bare `metadata` (and `metadata/android`), which are the defaults the two actions look for.
 *
 * Text model: a field's value is the file's text without one trailing line break, with line
 * breaks as `\n`. Writing puts the file's own conventions back (trailing break, CRLF), so a file
 * whose value did not change is never part of a change set.
 */

export type FileMap = Record<string, string>;

export type ListingRoots = {
  /** Folder that holds the App Store locale folders. */
  appStore: string;
  /** Folder that holds the Google Play locale folders. */
  googlePlay: string;
};

export const DEFAULT_LISTING_ROOTS: ListingRoots = {
  appStore: 'fastlane/metadata',
  googlePlay: 'fastlane/metadata/android',
};

export type ListingSnapshot = {
  listing: Listing;
  roots: ListingRoots;
  /** Whether any listing file was found for the store. */
  found: { appStore: boolean; googlePlay: boolean };
  /** The raw text of every listing file that was read. This is what a change set is diffed from. */
  files: FileMap;
  warnings: string[];
};

export type ReadListingOptions = {
  /** Where the listing lives. Each root that is left out is discovered from the file paths. */
  roots?: Partial<ListingRoots>;
};

const APP_STORE_FIELD_SET: ReadonlySet<string> = new Set(APP_STORE_FIELDS);
const PLAY_FIELD_SET: ReadonlySet<string> = new Set(PLAY_FIELDS);

/**
 * A folder name that can be a store locale. Deliberately loose (`en`, `en-US`, `zh-Hans`,
 * `es-419`): the stores' own lists were not checked, so this only rules out other folders.
 */
export function isLocaleDir(name: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(name);
}

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, '');

// ---------------------------------------------------------------------------------------------
// Text conventions

type TextStyle = { crlf: boolean; trailingNewline: boolean };

function styleOf(raw: string): TextStyle {
  return { crlf: raw.includes('\r\n'), trailingNewline: /\n$/.test(raw) };
}

/** File text to model value: drop a BOM and one trailing line break, normalize CRLF. */
function decode(raw: string): string {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  text = text.replace(/\r\n/g, '\n');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

const normalize = (value: string) => value.replace(/\r\n/g, '\n');

function encode(value: string, style: TextStyle): string {
  const text = normalize(value);
  if (text === '') return '';
  const body = style.crlf ? text.replace(/\n/g, '\r\n') : text;
  return style.trailingNewline ? body + (style.crlf ? '\r\n' : '\n') : body;
}

// ---------------------------------------------------------------------------------------------
// Paths

type Candidate = { root: string; depth: number };

/**
 * Which folders look like listing roots, judged by the file names under them. A folder is only
 * a root if it is named `metadata` (or `metadata/android` for Play), the names both actions use
 * by default. Anything else needs `roots` to be passed.
 */
export function discoverRoots(paths: readonly string[]): {
  roots: Partial<ListingRoots>;
  warnings: string[];
} {
  const appStore = new Set<string>();
  const play = new Set<string>();
  for (const path of paths) {
    const segs = path.split('/');
    const last = segs[segs.length - 1] ?? '';
    if (!last.endsWith('.txt')) continue;
    const name = last.slice(0, -4);
    const parent = segs[segs.length - 2];
    if (parent === undefined) continue;
    const tail = (rootSegs: string[]) => rootSegs[rootSegs.length - 1];
    if (parent === 'changelogs') {
      const locale = segs[segs.length - 3];
      const rootSegs = segs.slice(0, -3);
      if (locale !== undefined && isLocaleDir(locale) && /^(\d+|default)$/.test(name)) {
        if (tail(rootSegs) === 'android' && rootSegs[rootSegs.length - 2] === 'metadata') {
          play.add(rootSegs.join('/'));
        } else if (tail(rootSegs) === 'metadata') {
          play.add(rootSegs.join('/'));
        }
      }
      continue;
    }
    const rootSegs = segs.slice(0, -2);
    if (APP_STORE_FIELD_SET.has(name) && (isLocaleDir(parent) || parent === DEFAULT_LOCALE)) {
      if (tail(rootSegs) === 'metadata') appStore.add(rootSegs.join('/'));
    } else if (PLAY_FIELD_SET.has(name) && isLocaleDir(parent)) {
      if (tail(rootSegs) === 'android' && rootSegs[rootSegs.length - 2] === 'metadata') {
        play.add(rootSegs.join('/'));
      } else if (tail(rootSegs) === 'metadata') {
        play.add(rootSegs.join('/'));
      }
    }
  }
  const warnings: string[] = [];
  const pick = (found: Set<string>, label: string) => {
    const sorted = [...found].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
    );
    if (sorted.length > 1) {
      warnings.push(
        `Several ${label} metadata folders were found (${sorted.join(', ')}). Using ${sorted[0]}; pass roots to choose another.`,
      );
    }
    return sorted[0];
  };
  const roots: Partial<ListingRoots> = {};
  const a = pick(appStore, 'App Store');
  const g = pick(play, 'Google Play');
  if (a !== undefined) roots.appStore = a;
  if (g !== undefined) roots.googlePlay = g;
  return { roots, warnings };
}

function resolveRoots(paths: readonly string[], options?: ReadListingOptions) {
  const discovered = discoverRoots(paths);
  const roots: ListingRoots = {
    appStore: trimSlashes(
      options?.roots?.appStore ?? discovered.roots.appStore ?? DEFAULT_LISTING_ROOTS.appStore,
    ),
    googlePlay: trimSlashes(
      options?.roots?.googlePlay ?? discovered.roots.googlePlay ?? DEFAULT_LISTING_ROOTS.googlePlay,
    ),
  };
  return { roots, warnings: discovered.warnings };
}

type Parsed =
  | { store: 'app_store'; locale: string; field: AppStoreField }
  | { store: 'app_store'; copyright: true }
  | { store: 'google_play'; locale: string; field: PlayField }
  | { store: 'google_play'; locale: string; changelog: string };

/** Classifies one path against the roots, or returns undefined when it is not a listing file. */
function parsePath(path: string, roots: ListingRoots): Parsed | undefined {
  const under = (root: string) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  const apple = under(roots.appStore);
  if (apple !== undefined) {
    if (apple === 'copyright.txt') return { store: 'app_store', copyright: true };
    const m = /^([^/]+)\/([^/]+)\.txt$/.exec(apple);
    if (
      m &&
      (isLocaleDir(m[1] ?? '') || m[1] === DEFAULT_LOCALE) &&
      APP_STORE_FIELD_SET.has(m[2] ?? '')
    ) {
      return { store: 'app_store', locale: m[1] as string, field: m[2] as AppStoreField };
    }
  }
  const google = under(roots.googlePlay);
  if (google !== undefined) {
    const m = /^([^/]+)\/([^/]+)\.txt$/.exec(google);
    if (m && isLocaleDir(m[1] ?? '') && PLAY_FIELD_SET.has(m[2] ?? '')) {
      return { store: 'google_play', locale: m[1] as string, field: m[2] as PlayField };
    }
    const c = /^([^/]+)\/changelogs\/([^/]+)\.txt$/.exec(google);
    if (c && isLocaleDir(c[1] ?? '') && /^(\d+|default)$/.test(c[2] ?? '')) {
      return { store: 'google_play', locale: c[1] as string, changelog: c[2] as string };
    }
  }
  return undefined;
}

/** The paths a caller should read to build a listing: the metadata files and nothing else. */
export function listingFilePaths(
  paths: readonly string[],
  options?: ReadListingOptions,
): { paths: string[]; roots: ListingRoots; warnings: string[] } {
  const { roots, warnings } = resolveRoots(paths, options);
  return {
    paths: paths.filter((p) => parsePath(p, roots) !== undefined).sort(),
    roots,
    warnings,
  };
}

/** Which locales have listing files, judged from paths alone. */
export function listingLocales(
  paths: readonly string[],
  options?: ReadListingOptions,
): { roots: ListingRoots; ios: string[]; android: string[]; hasDefaultFolder: boolean } {
  const { roots } = resolveRoots(paths, options);
  const ios = new Set<string>();
  const android = new Set<string>();
  let hasDefaultFolder = false;
  for (const path of paths) {
    const parsed = parsePath(path, roots);
    if (!parsed || 'copyright' in parsed) continue;
    if (parsed.store === 'app_store') {
      if (parsed.locale === DEFAULT_LOCALE) hasDefaultFolder = true;
      else ios.add(parsed.locale);
    } else {
      android.add(parsed.locale);
    }
  }
  return { roots, ios: [...ios].sort(), android: [...android].sort(), hasDefaultFolder };
}

// ---------------------------------------------------------------------------------------------
// Reading

const emptyListing = (): { appStore: AppStoreListing; googlePlay: PlayListing } => ({
  appStore: { locales: {} },
  googlePlay: { locales: {}, changelogs: {} },
});

/**
 * Builds the normalized listing from a map of path to file text. Only files that match the
 * fastlane layout are used; everything else in the map is ignored. A store with no files is left
 * out of `listing`.
 */
export function readListing(files: FileMap, options?: ReadListingOptions): ListingSnapshot {
  const paths = Object.keys(files);
  const { roots, warnings } = resolveRoots(paths, options);
  const model = emptyListing();
  const used: FileMap = {};
  const found = { appStore: false, googlePlay: false };

  for (const path of paths.sort()) {
    const raw = files[path];
    if (raw === undefined) continue;
    const parsed = parsePath(path, roots);
    if (!parsed) continue;
    used[path] = raw;
    const value = decode(raw);
    if (parsed.store === 'app_store') {
      found.appStore = true;
      if ('copyright' in parsed) model.appStore.copyright = value;
      else {
        const locale = (model.appStore.locales[parsed.locale] ??= {});
        locale[parsed.field] = value;
      }
    } else {
      found.googlePlay = true;
      if ('changelog' in parsed) {
        const notes = (model.googlePlay.changelogs[parsed.locale] ??= {});
        notes[parsed.changelog] = value;
      } else {
        const locale = (model.googlePlay.locales[parsed.locale] ??= {});
        locale[parsed.field] = value;
      }
    }
  }

  // Locale folders that hold txt files we do not model are reported once, not guessed at.
  const stray = new Set<string>();
  for (const path of paths) {
    if (parsePath(path, roots) || !path.endsWith('.txt')) continue;
    for (const root of [roots.appStore, roots.googlePlay]) {
      const rest = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
      const dir = rest?.split('/')[0];
      if (rest?.includes('/') && dir !== undefined && !isLocaleDir(dir) && dir !== DEFAULT_LOCALE) {
        stray.add(`${root}/${dir}`);
      }
    }
  }
  const knownOtherDir =
    /\/(android|review_information|app_clip_review_information|trade_representative_contact_information)$/;
  for (const dir of [...stray].sort()) {
    if (knownOtherDir.test(dir)) continue;
    warnings.push(`Ignored ${dir}: its name is not a locale code.`);
  }
  for (const path of paths.sort()) {
    const m = /^(.*)\/changelogs\/([^/]+)\.txt$/.exec(path);
    if (m && m[1]?.startsWith(`${roots.googlePlay}/`) && !parsePath(path, roots)) {
      warnings.push(`Ignored ${path}: a changelog file is named after a version code, or default.`);
    }
  }

  const listing: Listing = {};
  if (found.appStore) listing.appStore = model.appStore;
  if (found.googlePlay) listing.googlePlay = model.googlePlay;
  return { listing, roots, found, files: used, warnings };
}

/**
 * Reads only the listing files of a repository: pass `listFiles()` output and a `readFile`.
 * Reads run a few at a time.
 */
export async function loadListing(
  paths: readonly string[],
  read: (path: string) => Promise<string | undefined>,
  options?: ReadListingOptions,
): Promise<ListingSnapshot> {
  const selected = listingFilePaths(paths, options);
  const files: FileMap = {};
  const missing: string[] = [];
  const queue = [...selected.paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const text = await read(path);
      if (text === undefined) missing.push(path);
      else files[path] = text;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  const snapshot = readListing(files, { roots: selected.roots });
  snapshot.warnings.unshift(...selected.warnings);
  for (const path of missing.sort())
    snapshot.warnings.push(`${path} was listed but could not be read.`);
  return snapshot;
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Every file a listing of one store would have, as path to normalized value. */
function layout(
  listing: Listing,
  roots: ListingRoots,
): { appStore?: Map<string, string>; googlePlay?: Map<string, string> } {
  const out: { appStore?: Map<string, string>; googlePlay?: Map<string, string> } = {};
  if (listing.appStore) {
    const map = new Map<string, string>();
    for (const [locale, text] of Object.entries(listing.appStore.locales)) {
      for (const field of APP_STORE_FIELDS) {
        const value = (text as LocaleText<AppStoreField>)[field];
        if (value !== undefined)
          map.set(`${roots.appStore}/${locale}/${field}.txt`, normalize(value));
      }
    }
    if (listing.appStore.copyright !== undefined) {
      map.set(`${roots.appStore}/copyright.txt`, normalize(listing.appStore.copyright));
    }
    out.appStore = map;
  }
  if (listing.googlePlay) {
    const map = new Map<string, string>();
    for (const [locale, text] of Object.entries(listing.googlePlay.locales)) {
      for (const field of PLAY_FIELDS) {
        const value = (text as LocaleText<PlayField>)[field];
        if (value !== undefined)
          map.set(`${roots.googlePlay}/${locale}/${field}.txt`, normalize(value));
      }
    }
    for (const [locale, notes] of Object.entries(listing.googlePlay.changelogs)) {
      for (const [code, value] of Object.entries(notes)) {
        map.set(`${roots.googlePlay}/${locale}/changelogs/${code}.txt`, normalize(value));
      }
    }
    out.googlePlay = map;
  }
  return out;
}

export type ListingChangeOptions = {
  /**
   * Trailing line break for files that are new. By default it follows the majority of the
   * store's existing files, and is off when there are none (fastlane itself writes none, and
   * supply uploads a file exactly as it is).
   */
  newFileTrailingNewline?: boolean;
};

function majorityTrailingNewline(files: FileMap, paths: Iterable<string>): boolean {
  let withBreak = 0;
  let without = 0;
  for (const path of paths) {
    const raw = files[path];
    if (raw === undefined || raw === '') continue;
    if (/\n$/.test(raw)) withBreak++;
    else without++;
  }
  return withBreak > without;
}

/**
 * The file changes that turn `before` into `after`. Only files whose value changed are listed:
 * a changed file keeps its own line ending and trailing break, a new file follows the store's
 * convention, and a value that is gone deletes its file. A store that is absent from `after` is
 * left alone. Files this module does not model (screenshots, review information, ...) are never
 * touched. The result is sorted by path.
 */
export function listingChangeSet(
  before: ListingSnapshot,
  after: Listing,
  options: ListingChangeOptions = {},
): FileChange[] {
  const roots = before.roots;
  const was = layout(before.listing, roots);
  const will = layout(after, roots);
  const changes: FileChange[] = [];

  for (const store of ['appStore', 'googlePlay'] as const) {
    const next = will[store];
    if (!next) continue;
    const prev = was[store] ?? new Map<string, string>();
    const newStyle: TextStyle = {
      crlf: false,
      trailingNewline:
        options.newFileTrailingNewline ?? majorityTrailingNewline(before.files, prev.keys()),
    };
    for (const [path, value] of next) {
      const old = prev.get(path);
      const raw = before.files[path];
      if (old === undefined || raw === undefined) {
        changes.push({ path, after: encode(value, newStyle) });
      } else if (old !== value) {
        changes.push({ path, before: raw, after: encode(value, styleOf(raw)) });
      }
    }
    for (const path of prev.keys()) {
      if (!next.has(path)) {
        const raw = before.files[path];
        changes.push(raw === undefined ? { path } : { path, before: raw });
      }
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
