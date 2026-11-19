import {
  APP_STORE_FIELDS,
  type AppStoreField,
  type AppStoreListing,
  DEFAULT_LOCALE,
  type FileChange,
  type Listing,
  type ListingStore,
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
 * `<root>` is a folder that holds the locale folders. It is detected by its name and the files in
 * it: `metadata` (the default of both actions, usually `fastlane/metadata`), `metadata/ios` and
 * `metadata/android` (the platform folders), and `metadata/<app id>/ios` and
 * `metadata/<app id>/android` (one folder per app in a repository with several). A repository can
 * have several of them: `listingCandidates` lists all, `detectedTargets` groups them per app, and
 * a caller picks with `options.roots`. A root that is passed always wins over detection. A
 * Deliverfile or Fastfile `metadata_path` is a hint (`parseMetadataHints`).
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
  /** The folders that were read. */
  roots: ListingRoots;
  /** Which stores had their folder chosen by the caller (`options.roots`) instead of detected. */
  explicit: { appStore: boolean; googlePlay: boolean };
  /** Every folder that looks like a listing root, best first. */
  candidates: ListingCandidate[];
  /** The candidates grouped per app. */
  targets: DetectedTarget[];
  /** What was searched and what was there instead, for an empty result. */
  diagnostics: ListingDiagnostics;
  /** Whether any listing file was found for the store. */
  found: { appStore: boolean; googlePlay: boolean };
  /** The raw text of every listing file that was read. This is what a change set is diffed from. */
  files: FileMap;
  warnings: string[];
};

export type ReadListingOptions = {
  /**
   * Where the listing lives. Each root that is left out is discovered from the file paths. A root
   * that is given is used as it is, even if nothing is in it; an empty string means the store is
   * not read at all.
   */
  roots?: Partial<ListingRoots>;
  /** Folders named by a Deliverfile or Fastfile (see `parseMetadataHints`). Preferred when detecting. */
  hints?: Partial<MetadataHints>;
  /** Newest release notes read per locale (default `DEFAULT_MAX_CHANGELOGS`). */
  maxChangelogs?: number;
};

const APP_STORE_FIELD_SET: ReadonlySet<string> = new Set(APP_STORE_FIELDS);
const PLAY_FIELD_SET: ReadonlySet<string> = new Set(PLAY_FIELDS);

/**
 * A folder name that can be a store locale. Deliberately loose (`en`, `en-US`, `zh-Hans`,
 * `es-419`): the stores' own lists were not checked, so this only rules out other folders.
 */
export function isLocaleDir(name: string): boolean {
  return name !== 'ios' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(name);
}

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

const PLATFORM_DIRS: ReadonlySet<string> = new Set(['ios', 'android']);
const IGNORED_DIRS = /(^|\/)(node_modules|Pods|vendor|\.git|build|DerivedData)\//;
const CHANGELOG_NAME = /^(\d+|default)$/;

const storePlatform = (store: ListingStore) => (store === 'app_store' ? 'ios' : 'android');
const storeName = (store: ListingStore) => (store === 'app_store' ? 'App Store' : 'Google Play');

/** A listing folder that was found, with what it holds. */
export type ListingCandidate = {
  store: ListingStore;
  /** The folder that holds the locale folders. */
  root: string;
  /** The app id folder of a `metadata/<app id>/<platform>` layout. */
  app?: string;
  platform: 'ios' | 'android';
  /** `convention`: found by its name and the files in it. `hint`: named by a Deliverfile or Fastfile. */
  origin: 'convention' | 'hint';
  locales: string[];
  /** Number of listing files in it. */
  files: number;
  label: string;
};

/**
 * One app (or one folder) with the folders of its two stores, built from the candidates. The
 * roots are null for a store that this target has no folder for.
 */
export type DetectedTarget = {
  /** `default`, `app:<app id>` or `root:<folder>`. Stable for the same files. */
  key: string;
  label: string;
  app?: string;
  roots: { appStore: string | null; googlePlay: string | null };
};

/** Folders that a Deliverfile or Fastfile names as the metadata path (see `parseMetadataHints`). */
export type MetadataHints = {
  appStore: string[];
  googlePlay: string[];
  /** Literal app ids of an Appfile. A folder of such an app is preferred. */
  apps: string[];
  /** Where each folder was named, for the diagnostic. */
  sources: { file: string; store: ListingStore; root: string }[];
};

export const emptyHints = (): MetadataHints => ({
  appStore: [],
  googlePlay: [],
  apps: [],
  sources: [],
});

/**
 * Why a path is not a valid listing root, or undefined when it is. The rules of a repository
 * path: relative, no leading slash, no `..` or `.` or empty segment, no `.git`, no backslash.
 * A trailing slash and a leading `./` are tolerated (see `normalizeRoot`).
 */
export function checkListingRoot(path: string): string | undefined {
  const text = normalizeRoot(path);
  if (text === '') return 'Enter a folder path inside the repository.';
  if (text.length > 300) return 'The path is too long (at most 300 characters).';
  if (text.startsWith('/'))
    return 'The path must be relative to the repository, without a leading slash.';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  if (/[\\\x00-\x1f\x7f]/.test(text))
    return 'The path must not contain backslashes or control characters.';
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'The path must not contain empty, "." or ".." segments.';
    }
    if (segment.toLowerCase() === '.git') return 'The path must not point into .git.';
  }
  return undefined;
}

/** A root as stored: surrounding space, a leading `./` and trailing slashes removed. */
export function normalizeRoot(path: string): string {
  return path
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Joins a folder and a relative path, resolving `..`. Undefined when it leaves the repository. */
function joinRelative(dir: string, rel: string): string | undefined {
  if (rel.startsWith('/')) return undefined;
  const out = dir === '' ? [] : dir.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.pop() === undefined) return undefined;
    } else out.push(part);
  }
  return out.join('/');
}

type RootKind = { app?: string };

/**
 * Whether a folder is a conventional root for a store, judged by its name: `metadata`,
 * `metadata/ios` (or `metadata/android`), and `metadata/<app id>/ios` (or `/android`).
 */
function classifyRoot(store: ListingStore, rootSegs: string[]): RootKind | undefined {
  const n = rootSegs.length;
  const tail = rootSegs[n - 1];
  const prev = rootSegs[n - 2];
  const prev2 = rootSegs[n - 3];
  const platform = storePlatform(store);
  if (tail === 'metadata') return {};
  if (tail === platform && prev === 'metadata') return {};
  if (tail === platform && prev !== undefined && prev2 === 'metadata' && !PLATFORM_DIRS.has(prev)) {
    return { app: prev };
  }
  return undefined;
}

/** The store files of one folder, for counting. */
function parseUnder(path: string, store: ListingStore, root: string): Parsed | undefined {
  if (root === '') return undefined;
  const roots: ListingRoots =
    store === 'app_store' ? { appStore: root, googlePlay: '' } : { appStore: '', googlePlay: root };
  const parsed = parsePath(path, roots);
  return parsed?.store === store ? parsed : undefined;
}

function candidateOf(
  paths: readonly string[],
  store: ListingStore,
  root: string,
  origin: ListingCandidate['origin'],
  app?: string,
): ListingCandidate | undefined {
  const locales = new Set<string>();
  let files = 0;
  for (const path of paths) {
    const parsed = parseUnder(path, store, root);
    if (!parsed || 'copyright' in parsed) continue;
    files++;
    locales.add(parsed.locale);
  }
  if (files === 0) return undefined;
  const sorted = [...locales].sort();
  return {
    store,
    root,
    ...(app === undefined ? {} : { app }),
    platform: storePlatform(store),
    origin,
    locales: sorted,
    files,
    label: `${app ?? root} (${storeName(store)})`,
  };
}

/** Best first: named by a hint, then an app named by the Appfile, then the shallowest, then by name. */
function orderCandidates(
  candidates: readonly ListingCandidate[],
  hints: MetadataHints,
): ListingCandidate[] {
  const rank = (c: ListingCandidate) => [
    c.origin === 'hint' ? 0 : 1,
    c.app !== undefined && hints.apps.includes(c.app) ? 0 : 1,
    c.root.split('/').length,
  ];
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      const d = (ra[i] ?? 0) - (rb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.root < b.root ? -1 : a.root > b.root ? 1 : a.store < b.store ? -1 : 1;
  });
}

/**
 * Every folder that looks like a listing root, judged by the file names under it and the folder
 * names (`metadata`, `metadata/ios`, `metadata/<app id>/ios`, ...), plus the folders that a
 * Deliverfile or Fastfile names. Best first (see `orderCandidates`).
 */
export function listingCandidates(
  paths: readonly string[],
  hints: Partial<MetadataHints> = {},
): ListingCandidate[] {
  const all: MetadataHints = { ...emptyHints(), ...hints };
  const found = new Map<string, { store: ListingStore; root: string; app?: string }>();
  const add = (store: ListingStore, rootSegs: string[]) => {
    const kind = classifyRoot(store, rootSegs);
    if (!kind) return;
    const root = rootSegs.join('/');
    found.set(`${store}:${root}`, { store, root, ...kind });
  };
  for (const path of paths) {
    const segs = path.split('/');
    const last = segs[segs.length - 1] ?? '';
    if (!last.endsWith('.txt')) continue;
    const name = last.slice(0, -4);
    const parent = segs[segs.length - 2];
    if (parent === undefined) continue;
    if (parent === 'changelogs') {
      const locale = segs[segs.length - 3];
      if (locale !== undefined && isLocaleDir(locale) && CHANGELOG_NAME.test(name)) {
        add('google_play', segs.slice(0, -3));
      }
      continue;
    }
    if (APP_STORE_FIELD_SET.has(name) && (isLocaleDir(parent) || parent === DEFAULT_LOCALE)) {
      add('app_store', segs.slice(0, -2));
    } else if (PLAY_FIELD_SET.has(name) && isLocaleDir(parent)) {
      add('google_play', segs.slice(0, -2));
    }
  }
  const out: ListingCandidate[] = [];
  for (const entry of found.values()) {
    const c = candidateOf(paths, entry.store, entry.root, 'convention', entry.app);
    if (c) out.push(c);
  }
  for (const store of ['app_store', 'google_play'] as const) {
    for (const root of store === 'app_store' ? all.appStore : all.googlePlay) {
      const index = out.findIndex((c) => c.store === store && c.root === root);
      const existing = index >= 0 ? out[index] : undefined;
      if (existing) {
        out[index] = { ...existing, origin: 'hint' };
        continue;
      }
      const c = candidateOf(paths, store, root, 'hint');
      if (c) out.push(c);
    }
  }
  return orderCandidates(out, all);
}

/** The folders each store reads from when nothing is chosen: the best candidate of the best app. */
function defaultCandidates(sorted: readonly ListingCandidate[]): {
  appStore?: ListingCandidate;
  googlePlay?: ListingCandidate;
} {
  const first = sorted[0];
  const pick = (store: ListingStore) =>
    sorted.find((c) => c.store === store && c.app === first?.app) ??
    sorted.find((c) => c.store === store);
  const appStore = pick('app_store');
  const googlePlay = pick('google_play');
  return {
    ...(appStore ? { appStore } : {}),
    ...(googlePlay ? { googlePlay } : {}),
  };
}

/**
 * The candidates as targets: one per app id (its iOS and Android folders together), one
 * `default` for the folders that belong to no app, and one per extra folder of a store.
 */
export function detectedTargets(
  candidates: readonly ListingCandidate[],
  hints: Partial<MetadataHints> = {},
): DetectedTarget[] {
  const sorted = orderCandidates(candidates, { ...emptyHints(), ...hints });
  const targets = new Map<string, DetectedTarget>();
  const set = (key: string, label: string, c: ListingCandidate) => {
    let target = targets.get(key);
    if (!target) {
      target = {
        key,
        label,
        ...(c.app === undefined ? {} : { app: c.app }),
        roots: { appStore: null, googlePlay: null },
      };
      targets.set(key, target);
    }
    const slot = c.store === 'app_store' ? 'appStore' : 'googlePlay';
    if (target.roots[slot] === null) {
      target.roots[slot] = c.root;
      return true;
    }
    return false;
  };
  for (const c of sorted) {
    if (c.app !== undefined) {
      set(`app:${c.app}`, c.app, c);
    } else if (!set('default', 'Default folders', c)) {
      set(`root:${c.root}`, c.root, c);
    }
  }
  return [...targets.values()];
}

type ResolvedRoots = {
  roots: ListingRoots;
  /** Which stores had their folder chosen by the caller instead of detected. */
  explicit: { appStore: boolean; googlePlay: boolean };
  warnings: string[];
  candidates: ListingCandidate[];
  hints: MetadataHints;
};

/**
 * Discovered folders, unless the caller named them. A root given in `options.roots` always wins,
 * even if nothing is in it (the empty string means: this store is not read at all).
 */
function resolveRoots(paths: readonly string[], options?: ReadListingOptions): ResolvedRoots {
  const hints: MetadataHints = { ...emptyHints(), ...(options?.hints ?? {}) };
  const candidates = listingCandidates(paths, hints);
  const defaults = defaultCandidates(candidates);
  const warnings: string[] = [];
  const explicit = {
    appStore: options?.roots?.appStore !== undefined,
    googlePlay: options?.roots?.googlePlay !== undefined,
  };
  for (const store of ['app_store', 'google_play'] as const) {
    const slot = store === 'app_store' ? 'appStore' : 'googlePlay';
    if (explicit[slot]) continue;
    const list = candidates.filter((c) => c.store === store);
    if (list.length > 1) {
      warnings.push(
        `Several ${storeName(store)} metadata folders were found (${list.map((c) => c.root).join(', ')}). Using ${defaults[slot]?.root}; choose another listing target to use a different one.`,
      );
    }
  }
  const roots: ListingRoots = {
    appStore: normalizeRoot(
      options?.roots?.appStore ?? defaults.appStore?.root ?? DEFAULT_LISTING_ROOTS.appStore,
    ),
    googlePlay: normalizeRoot(
      options?.roots?.googlePlay ?? defaults.googlePlay?.root ?? DEFAULT_LISTING_ROOTS.googlePlay,
    ),
  };
  return { roots, explicit, warnings, candidates, hints };
}

/**
 * Compatibility: the folder each store would be read from, and the warnings. Use
 * `listingCandidates` to see all of them.
 */
export function discoverRoots(paths: readonly string[]): {
  roots: Partial<ListingRoots>;
  warnings: string[];
} {
  const resolved = resolveRoots(paths);
  const defaults = defaultCandidates(resolved.candidates);
  const roots: Partial<ListingRoots> = {};
  if (defaults.appStore) roots.appStore = defaults.appStore.root;
  if (defaults.googlePlay) roots.googlePlay = defaults.googlePlay.root;
  return { roots, warnings: resolved.warnings };
}

type Parsed =
  | { store: 'app_store'; locale: string; field: AppStoreField }
  | { store: 'app_store'; copyright: true }
  | { store: 'google_play'; locale: string; field: PlayField }
  | { store: 'google_play'; locale: string; changelog: string };

/** Classifies one path against the roots, or returns undefined when it is not a listing file. */
function parsePath(path: string, roots: ListingRoots): Parsed | undefined {
  const under = (root: string) =>
    root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
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
    if (c && isLocaleDir(c[1] ?? '') && CHANGELOG_NAME.test(c[2] ?? '')) {
      return { store: 'google_play', locale: c[1] as string, changelog: c[2] as string };
    }
  }
  return undefined;
}

/** How many of the newest release notes of each locale are read. Older ones are left alone. */
export const DEFAULT_MAX_CHANGELOGS = 10;

/**
 * The paths a caller should read to build a listing: the metadata files of the chosen folders and
 * nothing else (no screenshots, images or review information). Of the release notes of each
 * locale only the newest `maxChangelogs` (and `default`) are listed: a long running app has one
 * file per version code, hundreds of them, and each one is a request to GitHub.
 */
export function listingFilePaths(
  paths: readonly string[],
  options?: ReadListingOptions,
): { paths: string[]; roots: ListingRoots; warnings: string[] } {
  const resolved = resolveRoots(paths, options);
  return { ...selectFiles(paths, resolved, options), roots: resolved.roots };
}

function selectFiles(
  paths: readonly string[],
  resolved: ResolvedRoots,
  options?: ReadListingOptions,
): { paths: string[]; warnings: string[] } {
  const limit = Math.max(0, options?.maxChangelogs ?? DEFAULT_MAX_CHANGELOGS);
  const keep: string[] = [];
  const notes = new Map<string, { code: number; path: string }[]>();
  for (const path of paths) {
    const parsed = parsePath(path, resolved.roots);
    if (!parsed) continue;
    if (parsed.store === 'google_play' && 'changelog' in parsed && parsed.changelog !== 'default') {
      const list = notes.get(parsed.locale) ?? [];
      list.push({ code: Number(parsed.changelog), path });
      notes.set(parsed.locale, list);
    } else keep.push(path);
  }
  let skipped = 0;
  const trimmed: string[] = [];
  for (const [locale, list] of [...notes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    list.sort((a, b) => b.code - a.code || (a.path < b.path ? -1 : 1));
    keep.push(...list.slice(0, limit).map((n) => n.path));
    if (list.length > limit) {
      skipped += list.length - limit;
      trimmed.push(locale);
    }
  }
  const warnings = [...resolved.warnings];
  if (skipped > 0) {
    warnings.push(
      `Only the ${limit} newest release notes of each locale were read; ${skipped} older ones (${trimmed.join(', ')}) were left alone. They are not changed by a change set.`,
    );
  }
  return { paths: keep.sort(), warnings };
}

/** Which locales have listing files, judged from paths alone. */
export function listingLocales(
  paths: readonly string[],
  options?: ReadListingOptions,
): {
  roots: ListingRoots;
  ios: string[];
  android: string[];
  hasDefaultFolder: boolean;
  candidates: ListingCandidate[];
  targets: DetectedTarget[];
  hints: MetadataHints;
} {
  const { roots, candidates, hints } = resolveRoots(paths, options);
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
  return {
    roots,
    ios: [...ios].sort(),
    android: [...android].sort(),
    hasDefaultFolder,
    candidates,
    targets: detectedTargets(candidates, hints),
    hints,
  };
}

// ---------------------------------------------------------------------------------------------
// Diagnostics: where was the listing looked for, and what was there instead

export type UnusedFolder = {
  path: string;
  /** The store its files look like, when they say. */
  store: ListingStore | null;
  reason: string;
};

export type StoreDiagnostic = {
  /** The folder this store is read from (empty: the target has none for this store). */
  root: string;
  /** The folder was named by the caller (a custom path or target), not detected. */
  explicit: boolean;
  state: 'found' | 'missing' | 'no_listing_files' | 'not_used';
  /** What is directly inside the folder, folders with a trailing slash. */
  entries: string[];
  /** One sentence for a person: what was checked and why nothing was used. */
  message: string;
  /** The places that were looked at. */
  searched: string[];
  /** Folders that look like metadata but were not used, and why. */
  unused: UnusedFolder[];
};

export type ListingDiagnostics = { appStore: StoreDiagnostic; googlePlay: StoreDiagnostic };

const MAX_LISTED = 20;

function entriesOf(paths: readonly string[], root: string): string[] {
  if (root === '') return [];
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(`${root}/`)) continue;
    const rest = path.slice(root.length + 1);
    const slash = rest.indexOf('/');
    names.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...names].sort().slice(0, MAX_LISTED);
}

/** Folders that hold locale folders with listing files, or are named `metadata`, but are not used. */
function unusedFolders(paths: readonly string[], used: ReadonlySet<string>): UnusedFolder[] {
  const loose = new Map<string, { store: ListingStore; locales: Set<string> }>();
  const consider = (store: ListingStore, rootSegs: string[], locale: string) => {
    const root = rootSegs.join('/');
    if (root === '' || used.has(root)) return;
    const entry = loose.get(root) ?? { store, locales: new Set<string>() };
    entry.locales.add(locale);
    loose.set(root, entry);
  };
  for (const path of paths) {
    if (IGNORED_DIRS.test(path) || !path.endsWith('.txt')) continue;
    const segs = path.split('/');
    const name = (segs[segs.length - 1] ?? '').slice(0, -4);
    const parent = segs[segs.length - 2];
    if (parent === undefined) continue;
    if (parent === 'changelogs') {
      const locale = segs[segs.length - 3];
      if (locale !== undefined && isLocaleDir(locale) && CHANGELOG_NAME.test(name)) {
        consider('google_play', segs.slice(0, -3), locale);
      }
    } else if (
      APP_STORE_FIELD_SET.has(name) &&
      (isLocaleDir(parent) || parent === DEFAULT_LOCALE)
    ) {
      consider('app_store', segs.slice(0, -2), parent);
    } else if (PLAY_FIELD_SET.has(name) && isLocaleDir(parent)) {
      consider('google_play', segs.slice(0, -2), parent);
    }
  }
  const out: UnusedFolder[] = [...loose]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, { store, locales }]) => ({
      path,
      store,
      reason: `Holds ${storeName(store)} files for ${[...locales].sort().join(', ')}, but its name is not one of the folders that are detected automatically (metadata, metadata/${storePlatform(store)}, metadata/<app id>/${storePlatform(store)}). Choose it as the ${storeName(store)} folder of a listing target to use it.`,
    }));
  // `metadata` folders with no listing files at all.
  const metadataDirs = new Set<string>();
  for (const path of paths) {
    if (IGNORED_DIRS.test(path)) continue;
    const segs = path.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === 'metadata') metadataDirs.add(segs.slice(0, i + 1).join('/'));
    }
  }
  const hasListing = (dir: string) =>
    [...used, ...loose.keys()].some((r) => r === dir || r.startsWith(`${dir}/`));
  for (const dir of [...metadataDirs].sort()) {
    if (hasListing(dir)) continue;
    const entries = entriesOf(paths, dir);
    out.push({
      path: dir,
      store: null,
      reason: `Exists but no locale folder in it holds listing files such as name.txt, description.txt or title.txt. It contains: ${entries.join(', ') || 'nothing'}.`,
    });
  }
  return out.slice(0, 12);
}

const SEARCHED: Record<ListingStore, string[]> = {
  app_store: [
    '<folder>/metadata/<locale>/name.txt',
    '<folder>/metadata/ios/<locale>/name.txt',
    '<folder>/metadata/<app id>/ios/<locale>/name.txt',
  ],
  google_play: [
    '<folder>/metadata/android/<locale>/title.txt',
    '<folder>/metadata/<locale>/title.txt',
    '<folder>/metadata/<app id>/android/<locale>/title.txt',
  ],
};

function storeDiagnostic(
  store: ListingStore,
  root: string,
  explicit: boolean,
  found: boolean,
  paths: readonly string[],
  hints: MetadataHints,
  unused: UnusedFolder[],
): StoreDiagnostic {
  const name = storeName(store);
  const entries = entriesOf(paths, root);
  const rooted = root !== '' && paths.some((p) => p.startsWith(`${root}/`));
  const state: StoreDiagnostic['state'] = found
    ? 'found'
    : root === ''
      ? 'not_used'
      : rooted
        ? 'no_listing_files'
        : 'missing';
  const example = `${root}/en-US/${store === 'app_store' ? 'name' : 'title'}.txt`;
  const hinted = hints.sources.filter((s) => s.store === store);
  const searched = explicit
    ? root === ''
      ? []
      : [root]
    : [
        ...hinted.map((s) => `${s.root} (named by ${s.file})`),
        ...SEARCHED[store].map((p) => `${p} (<folder> is any folder, usually fastlane)`),
      ];
  const hintNote =
    !explicit && hinted.length > 0
      ? ` A Fastfile names ${hinted.map((s) => s.root).join(', ')} (${hinted.map((s) => s.file).join(', ')}), which holds no listing files here.`
      : '';
  let message: string;
  if (state === 'found') message = `${name} listing read from ${root}.`;
  else if (state === 'not_used')
    message = `This target has no ${name} folder, so no ${name} listing is read.`;
  else if (explicit && state === 'missing') {
    message = `The ${name} folder ${root} that was chosen does not exist in the repository, so nothing was read. Check the spelling and the branch, or choose another folder.`;
  } else if (explicit) {
    message = `The ${name} folder ${root} that was chosen exists but has no listing files in it. Expected ${example}. It contains: ${entries.join(', ') || 'nothing'}.`;
  } else if (state === 'no_listing_files') {
    message = `${root} exists but has no ${name} listing files in it (expected ${example}). It contains: ${entries.join(', ') || 'nothing'}.${hintNote}`;
  } else {
    message = `No ${name} listing folder was found in the repository, so nothing was read.${hintNote}`;
  }
  return {
    root,
    explicit,
    state,
    entries,
    message,
    searched,
    unused: unused.filter((u) => u.store === store || u.store === null),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading

const emptyListing = (): { appStore: AppStoreListing; googlePlay: PlayListing } => ({
  appStore: { locales: {} },
  googlePlay: { locales: {}, changelogs: {} },
});

function snapshotOf(
  files: FileMap,
  resolved: ResolvedRoots,
  allPaths: readonly string[],
  extraWarnings: readonly string[] = [],
): ListingSnapshot {
  const { roots } = resolved;
  const warnings = [...resolved.warnings, ...extraWarnings];
  const paths = Object.keys(files);
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

  // Locale folders that hold txt files we do not model are reported once, not guessed at. A
  // folder that is (or leads to) a listing folder of another target is not "ignored".
  const candidateRoots = resolved.candidates.map((c) => c.root);
  const stray = new Set<string>();
  for (const path of paths) {
    if (parsePath(path, roots) || !path.endsWith('.txt')) continue;
    for (const root of [roots.appStore, roots.googlePlay]) {
      if (root === '') continue;
      const rest = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
      const dir = rest?.split('/')[0];
      if (
        rest?.includes('/') &&
        dir !== undefined &&
        !isLocaleDir(dir) &&
        dir !== DEFAULT_LOCALE &&
        !PLATFORM_DIRS.has(dir) &&
        !candidateRoots.some((r) => r === `${root}/${dir}` || r.startsWith(`${root}/${dir}/`))
      ) {
        stray.add(`${root}/${dir}`);
      }
    }
  }
  const knownOtherDir =
    /\/(android|ios|review_information|app_clip_review_information|trade_representative_contact_information)$/;
  for (const dir of [...stray].sort()) {
    if (knownOtherDir.test(dir)) continue;
    warnings.push(`Ignored ${dir}: its name is not a locale code.`);
  }
  for (const path of paths.sort()) {
    const m = /^(.*)\/changelogs\/([^/]+)\.txt$/.exec(path);
    if (
      m &&
      roots.googlePlay !== '' &&
      m[1]?.startsWith(`${roots.googlePlay}/`) &&
      !parsePath(path, roots)
    ) {
      warnings.push(`Ignored ${path}: a changelog file is named after a version code, or default.`);
    }
  }

  const listing: Listing = {};
  if (found.appStore) listing.appStore = model.appStore;
  if (found.googlePlay) listing.googlePlay = model.googlePlay;

  const usedRoots = new Set<string>(candidateRoots);
  if (found.appStore) usedRoots.add(roots.appStore);
  if (found.googlePlay) usedRoots.add(roots.googlePlay);
  const unused = unusedFolders(allPaths, usedRoots);
  const diagnostics: ListingDiagnostics = {
    appStore: storeDiagnostic(
      'app_store',
      roots.appStore,
      resolved.explicit.appStore,
      found.appStore,
      allPaths,
      resolved.hints,
      unused,
    ),
    googlePlay: storeDiagnostic(
      'google_play',
      roots.googlePlay,
      resolved.explicit.googlePlay,
      found.googlePlay,
      allPaths,
      resolved.hints,
      unused,
    ),
  };
  return {
    listing,
    roots,
    found,
    files: used,
    warnings,
    explicit: resolved.explicit,
    candidates: resolved.candidates,
    targets: detectedTargets(resolved.candidates, resolved.hints),
    diagnostics,
  };
}

/**
 * Builds the normalized listing from a map of path to file text. Only files that match the
 * fastlane layout are used; everything else in the map is ignored. A store with no files is left
 * out of `listing`.
 */
export function readListing(files: FileMap, options?: ReadListingOptions): ListingSnapshot {
  const paths = Object.keys(files);
  return snapshotOf(files, resolveRoots(paths, options), paths);
}

/** How many files are read at the same time. */
export const READ_CONCURRENCY = 8;

/**
 * Reads only the listing files of a repository: pass `listFiles()` output and a `readFile`.
 * Only the files of the chosen folders are read, at most `READ_CONCURRENCY` at a time.
 */
export async function loadListing(
  paths: readonly string[],
  read: (path: string) => Promise<string | undefined>,
  options?: ReadListingOptions,
): Promise<ListingSnapshot> {
  const resolved = resolveRoots(paths, options);
  const selected = selectFiles(paths, resolved, options);
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
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
  const notes = selected.warnings.slice(resolved.warnings.length);
  const snapshot = snapshotOf(files, resolved, paths, notes);
  for (const path of missing.sort())
    snapshot.warnings.push(`${path} was listed but could not be read.`);
  return snapshot;
}

// ---------------------------------------------------------------------------------------------
// Hints: where a Deliverfile or Fastfile says the metadata is

/** Source with whole-line comments removed and trailing `# ...` comments cut (outside quotes). */
function stripRubyComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      let quote = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '#' && line[i + 1] !== '{') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Splits at `separator` where it is not inside quotes or brackets. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Evaluates the small part of Ruby that metadata paths are written in: string literals,
 * `File.join`, `a || b`, `ENV.fetch("X", default)`, a variable assigned earlier. Anything else
 * (a method call, an environment variable on its own) is undefined: it is never guessed.
 */
function evalRuby(expr: string, env: ReadonlyMap<string, string>, depth = 0): string | undefined {
  const text = expr.trim();
  if (text === '' || depth > 8) return undefined;
  const alternatives = splitTopLevel(text, '||');
  if (alternatives.length > 1) {
    for (const alternative of alternatives) {
      const value = evalRuby(alternative, env, depth + 1);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  const literal = /^(["'])([\s\S]*)\1$/.exec(text);
  if (literal && !literal[2]?.includes(literal[1] as string)) {
    const body = literal[2] ?? '';
    if (literal[1] === "'") return body;
    let broken = false;
    const filled = body.replace(/#\{\s*(\w+)\s*\}/g, (_, name: string) => {
      const value = env.get(name);
      if (value === undefined) broken = true;
      return value ?? '';
    });
    return broken || filled.includes('#{') ? undefined : filled;
  }
  const fetch = /^ENV\.fetch\s*\(([\s\S]*)\)$/.exec(text);
  if (fetch) {
    const args = splitTopLevel(fetch[1] ?? '', ',');
    return args.length > 1 ? evalRuby(args[1] ?? '', env, depth + 1) : undefined;
  }
  const join = /^File\.join\s*\(([\s\S]*)\)$/.exec(text);
  if (join) {
    const values = splitTopLevel(join[1] ?? '', ',').map((a) => evalRuby(a, env, depth + 1));
    if (values.some((v) => v === undefined)) return undefined;
    return (values as string[]).join('/').replace(/\/{2,}/g, '/');
  }
  const pathname = /^Pathname\.new\s*\(([\s\S]*?)\)(\.realpath|\.expand_path|\.to_s)*$/.exec(text);
  if (pathname) return evalRuby(pathname[1] ?? '', env, depth + 1);
  if (/^\w+$/.test(text)) return env.get(text);
  return undefined;
}

/** `name = expression` lines, evaluated in order, so a later line can use an earlier one. */
function rubyAssignments(code: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of code.split('\n')) {
    const m = /^\s*(\w+)\s*=\s*(?![=~>])(.+)$/.exec(line);
    if (!m) continue;
    const value = evalRuby(m[2] ?? '', env);
    if (value !== undefined) env.set(m[1] as string, value);
  }
  return env;
}

/** The argument text that starts at `from`: up to a top-level comma, an unmatched `)` or a line end. */
function readArgument(code: string, from: number): string {
  let depth = 0;
  let quote = '';
  let i = from;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ',' || ch === '\n')) break;
  }
  return code.slice(from, i);
}

const APP_STORE_CALL = /\b(upload_to_app_store|deliver)\b/g;
const PLAY_CALL = /\b(upload_to_play_store|supply)\b/g;

/** The nearest `deliver`/`supply` style call before `index`, or undefined. */
function enclosingStore(code: string, index: number): ListingStore | undefined {
  const before = code.slice(Math.max(0, index - 800), index);
  const last = (re: RegExp) => {
    let at = -1;
    for (const m of before.matchAll(re)) at = m.index ?? at;
    return at;
  };
  const apple = last(APP_STORE_CALL);
  const play = last(PLAY_CALL);
  if (apple < 0 && play < 0) return undefined;
  return apple > play ? 'app_store' : 'google_play';
}

/**
 * Reads the `metadata_path` a Deliverfile or Fastfile names, and the app ids an Appfile spells
 * out. Only what can be worked out from the text: a string, `File.join` of strings and earlier
 * assigned variables, with `ENV[...] || "default"` taken as its default. A path that depends on
 * anything else is left out. The paths are relative to the fastlane folder (where the lanes run),
 * so both readings, relative to that folder and to the repository, are returned; the caller keeps
 * the ones that hold listing files.
 */
export function parseMetadataHints(
  sources: readonly { path: string; source: string }[],
): MetadataHints {
  const hints = emptyHints();
  const addRoot = (file: string, store: ListingStore, value: string) => {
    const dir = dirname(file);
    const raw = value.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    const readings = new Set<string>();
    const relative = joinRelative(dir, raw);
    if (relative) readings.add(relative);
    const fromRoot = joinRelative('', raw);
    if (fromRoot) readings.add(fromRoot);
    for (const root of readings) {
      if (root === '' || checkListingRoot(root) !== undefined) continue;
      const list = store === 'app_store' ? hints.appStore : hints.googlePlay;
      if (!list.includes(root)) list.push(root);
      hints.sources.push({ file, store, root });
    }
  };
  for (const { path, source } of sources) {
    const name = path.split('/').pop() ?? path;
    const code = stripRubyComments(source);
    if (name === 'Appfile') {
      for (const m of code.matchAll(
        /^\s*(?:app_identifier|package_name)\s*\(?\s*(["'])([^"'#{}]+)\1/gm,
      )) {
        const id = m[2]?.trim();
        if (id && !hints.apps.includes(id)) hints.apps.push(id);
      }
      continue;
    }
    if (name !== 'Deliverfile' && name !== 'Fastfile') continue;
    const env = rubyAssignments(code);
    // The project root is the folder above the fastlane folder, whatever the file says it is.
    const callArgument = /\bmetadata_path\b(?:\s*(?::|=>)\s*|\s*\(\s*|[ \t]+(?=["'A-Za-z]))/g;
    for (const m of code.matchAll(callArgument)) {
      const at = m.index ?? 0;
      const before = code[at - 1];
      if (before === '"' || before === "'" || before === '.' || before === '@' || before === ':')
        continue;
      const store = name === 'Deliverfile' ? 'app_store' : enclosingStore(code, at);
      if (!store) continue;
      const value = evalRuby(readArgument(code, at + m[0].length), env);
      if (value !== undefined) addRoot(path, store, value);
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Every file a listing of one store would have, as path to normalized value. */
function layout(
  listing: Listing,
  roots: ListingRoots,
): { appStore?: Map<string, string>; googlePlay?: Map<string, string> } {
  const out: { appStore?: Map<string, string>; googlePlay?: Map<string, string> } = {};
  // A store whose folder is empty (a target without one) has nowhere to write: it is left alone.
  if (listing.appStore && roots.appStore !== '') {
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
  if (listing.googlePlay && roots.googlePlay !== '') {
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
