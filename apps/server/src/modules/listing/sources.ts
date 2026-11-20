import {
  detectProject,
  type ExpoStoreSnapshot,
  expoSections,
  expoStoreChangeSet,
  fastlaneSectionFiles,
  GithubError,
  GithubRateLimitError,
  type ListingSnapshot,
  listingChangeSet,
  loadExpoStoreConfig,
  loadListing,
  type ProjectDetection,
  type RepoSections,
  readFastlaneSections,
  staticStoreConfigs,
} from '@mrm/connectors';
import {
  byFamily,
  type FileChange,
  type Listing,
  type ListingSections,
  listingStoreOf,
  type Platform,
} from '@mrm/core';

/**
 * Where each store's listing comes from. The rule (a product decision):
 *
 * - App Store: the Expo `store.config.json` when the repository has one (as `detectProject`
 *   reports it), otherwise the fastlane metadata folder. The two are never merged and a change
 *   only ever writes the chosen source's files.
 * - Google Play: fastlane only. EAS Metadata has no Play support.
 */
export type ListingSourceKind = 'expo-store-config' | 'fastlane';

export type StoreSource = {
  source: ListingSourceKind;
  /** The store config file, or the fastlane metadata folder. */
  path: string;
  /** Whether any listing text was found there. */
  found: boolean;
  /** The source exists but cannot be read (invalid JSON, ...). Nothing of it can be edited. */
  error?: string;
  /** Problems the connector noticed in this source (an Expo config: uncovered and unknown keys). */
  warnings: string[];
  /** Expo only: JSON paths EAS knows but the listing model does not cover (left untouched). */
  uncovered: string[];
  /** Expo only: JSON paths that are not in the EAS Metadata schema (left untouched). */
  unknown: string[];
};

export type ListingSources = { appStore: StoreSource; googlePlay: StoreSource };

/** Everything read from a repository that a listing can be made of. */
export type RepositoryListings = {
  fastlane: ListingSnapshot;
  /** Set when the repository has a JSON store config. */
  expo?: ExpoStoreSnapshot;
  /** Dynamic store configs (`store.config.js`): code, never read. */
  dynamicStoreConfigs: string[];
  /** Notes on what the choice of folders left out (an Expo store config that is not used). */
  notes: string[];
  /** The scan of the same files: the detected targets and candidates. */
  detection: ProjectDetection;
  /**
   * What the listing source of each store can say beyond the texts (categories, age rating, privacy
   * choices, media counts), read-only and for comparison only. A section the source cannot express
   * is absent: "not read". Never part of a change set. Absent in a value built by hand.
   */
  sections?: RepositorySections;
};

/** The store sections of the repository, per store, and what was noticed while reading them. */
export type RepositorySections = RepoSections;

export type ReadListingsOptions = {
  /** Folders to read, which win over detection. An empty string: that store is not read. */
  roots?: { appStore?: string; googlePlay?: string };
  /** A detected target (`DetectedTarget.key`): its folders are used. `roots` still win. */
  autoTarget?: string;
  /** Do not use an Expo store config for the App Store: the person chose a folder for it. */
  ignoreExpoConfig?: boolean;
  /** Newest release notes read per locale. */
  maxChangelogs?: number;
};

/** A detected target that the files do not have (they changed, or it never existed). */
export class UnknownTargetError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`There is no detected listing target "${key}" in this repository.`);
    this.name = 'UnknownTargetError';
    this.key = key;
  }
}

const IGNORED_PATHS = /(^|\/)(node_modules|Pods|vendor|\.git|build|DerivedData)\//;

type Read = (path: string) => Promise<string | undefined>;

/** A file the host refused to hand over as text (too large, binary). The rest of the listing is still usable. */
const isUnreadable = (error: unknown): error is GithubError =>
  error instanceof GithubError &&
  !(error instanceof GithubRateLimitError) &&
  (error.kind === 'not_text' || error.kind === 'too_large');

/**
 * Reads the listing sources of a repository from its file list: project detection first (so the
 * store config is found the way a scan finds it), then the Expo store config, then the fastlane
 * folders. Each file is read at most once, and only the files of the chosen folders are read.
 */
export async function readListings(
  allFiles: string[],
  read: Read,
  options: ReadListingsOptions = {},
): Promise<RepositoryListings> {
  const files = allFiles.filter((p) => !IGNORED_PATHS.test(p));
  const cache = new Map<string, Promise<string | undefined>>();
  const cached: Read = (path) => {
    let hit = cache.get(path);
    if (!hit) {
      hit = read(path);
      cache.set(path, hit);
    }
    return hit;
  };
  const detection = await detectProject(files, cached);
  let roots = options.roots;
  if (options.autoTarget !== undefined) {
    const target = detection.listing?.targets.find((t) => t.key === options.autoTarget);
    if (!target) throw new UnknownTargetError(options.autoTarget);
    roots = {
      appStore: target.roots.appStore ?? '',
      googlePlay: target.roots.googlePlay ?? '',
      ...options.roots,
    };
  }

  const notes: string[] = [];
  const staticConfigs = detection.expo?.storeConfigs ?? [];
  if (options.ignoreExpoConfig === true && staticConfigs.length > 0) {
    notes.push(
      `${staticConfigs.map((c) => c.path).join(', ')} is not used: the App Store folder was chosen, so the App Store listing comes from fastlane files.`,
    );
  }

  let unreadable: string | undefined;
  const readStoreConfig: Read = async (path) => {
    try {
      return await cached(path);
    } catch (error) {
      if (!isUnreadable(error)) throw error;
      unreadable = `${path} could not be read: ${error.message}`;
      return undefined;
    }
  };
  const expo =
    options.ignoreExpoConfig === true
      ? undefined
      : await loadExpoStoreConfig(detection, readStoreConfig);
  if (expo && unreadable !== undefined) expo.error = unreadable;

  const fastlane = await loadListing(files, cached, {
    ...(roots ? { roots } : {}),
    ...(detection.listing ? { hints: detection.listing.hints } : {}),
    ...(options.maxChangelogs === undefined ? {} : { maxChangelogs: options.maxChangelogs }),
  });
  const dynamicStoreConfigs =
    options.ignoreExpoConfig === true
      ? []
      : staticConfigs.filter((config) => config.dynamic).map((config) => config.path);

  // The sections beyond the texts: the category files and the age rating file of the fastlane
  // folder (a handful of small files; images are only counted from the paths), or the Expo store
  // config's own text. Same source rule as the texts: the Expo config for the App Store when it is
  // used and valid, fastlane otherwise; Google Play from fastlane.
  const sectionTexts: Record<string, string> = {};
  for (const path of fastlaneSectionFiles(files, fastlane.roots)) {
    const text = await readStoreConfig(path);
    if (text !== undefined) sectionTexts[path] = text;
  }
  const fromFastlane = readFastlaneSections(files, fastlane.roots, sectionTexts);
  const sections: RepositorySections = {
    appStore: expo && expo.error === undefined ? expoSections(expo.text) : fromFastlane.appStore,
    googlePlay: fromFastlane.googlePlay,
    warnings: fromFastlane.warnings,
  };
  return { fastlane, ...(expo ? { expo } : {}), dynamicStoreConfigs, notes, detection, sections };
}

/**
 * The sections of the repository for one platform's store, including the app wide `copyright`
 * of the merged listing as `details`. Empty when the listing has no such store (nothing to compare).
 */
export function repositorySections(
  listings: RepositoryListings,
  merged: Listing,
  platform: Platform,
): ListingSections {
  const found = byFamily(platform, { apple: merged.appStore, google: merged.googlePlay });
  if (!found) return {};
  const sections: ListingSections = {
    ...(listingStoreOf(platform) === 'app_store'
      ? (listings.sections?.appStore ?? {})
      : (listings.sections?.googlePlay ?? {})),
  };
  if (listingStoreOf(platform) === 'app_store') {
    const copyright = merged.appStore?.copyright;
    sections.details = copyright !== undefined ? { copyright } : {};
  }
  return sections;
}

/** The listing the person sees and edits: App Store from the Expo config when there is one. */
export function mergedListing(listings: RepositoryListings): Listing {
  const { fastlane, expo } = listings;
  const listing: Listing = {};
  const appStore = expo ? expo.listing.appStore : fastlane.listing.appStore;
  if (appStore && !(expo && expo.error !== undefined)) listing.appStore = appStore;
  if (fastlane.listing.googlePlay) listing.googlePlay = fastlane.listing.googlePlay;
  return listing;
}

export function listingSources(listings: RepositoryListings): ListingSources {
  const { fastlane, expo } = listings;
  const appStore: StoreSource = expo
    ? {
        source: 'expo-store-config',
        path: expo.path,
        found: expo.error === undefined && expo.found,
        ...(expo.error === undefined ? {} : { error: expo.error }),
        warnings: expo.warnings,
        uncovered: expo.uncovered,
        unknown: expo.unknown,
      }
    : {
        source: 'fastlane',
        path: fastlane.roots.appStore,
        found: fastlane.found.appStore,
        warnings: [],
        uncovered: [],
        unknown: [],
      };
  return {
    appStore,
    googlePlay: {
      source: 'fastlane',
      path: fastlane.roots.googlePlay,
      found: fastlane.found.googlePlay,
      warnings: [],
      uncovered: [],
      unknown: [],
    },
  };
}

/** Repository-level warnings: the fastlane ones, plus what the source rule left out. */
export function listingWarnings(listings: RepositoryListings): string[] {
  const { fastlane, expo, dynamicStoreConfigs } = listings;
  const warnings = [...fastlane.warnings, ...listings.notes];
  if (expo && fastlane.found.appStore) {
    warnings.push(
      `${expo.path} is the App Store listing source, so the App Store files under ${fastlane.roots.appStore} are ignored.`,
    );
  }
  if (!expo && dynamicStoreConfigs.length > 0) {
    warnings.push(
      `${dynamicStoreConfigs.join(', ')} is a script and is never read, so the App Store listing comes from fastlane.`,
    );
  }
  return warnings;
}

export type ListingChanges =
  | { ok: true; files: FileChange[]; warnings: string[] }
  | { ok: false; path: string; error: string; code?: 'outside_target' };

/**
 * The file changes that turn the repository into `desired`. A store left out of `desired` is
 * untouched. The App Store goes to the Expo config when there is one, so no fastlane App Store
 * file is ever written then; Google Play always goes to fastlane. Refuses (`ok: false`) when
 * `desired` has an App Store listing and the Expo config cannot be read, instead of writing it
 * somewhere else.
 */
export function listingChanges(listings: RepositoryListings, desired: Listing): ListingChanges {
  const { fastlane, expo } = listings;
  const files: FileChange[] = [];
  const warnings: string[] = [];
  const toFastlane: Listing = {};
  if (desired.googlePlay) toFastlane.googlePlay = desired.googlePlay;
  if (desired.appStore) {
    if (expo) {
      if (expo.error !== undefined) return { ok: false, path: expo.path, error: expo.error };
      const result = expoStoreChangeSet(expo, { appStore: desired.appStore });
      files.push(...result.changes);
      warnings.push(...result.warnings);
    } else {
      toFastlane.appStore = desired.appStore;
    }
  }
  if (toFastlane.appStore && fastlane.roots.appStore === '') {
    warnings.push(
      'The App Store listing was not changed: the selected target has no App Store folder.',
    );
  }
  if (toFastlane.googlePlay && fastlane.roots.googlePlay === '') {
    warnings.push(
      'The Google Play listing was not changed: the selected target has no Google Play folder.',
    );
  }
  files.push(...listingChangeSet(fastlane, toFastlane));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A change set only ever writes inside the folders of the chosen target (and the Expo config
  // when that is the App Store source). Anything else is a bug, so it is refused, not written.
  const inside = (path: string) =>
    (expo !== undefined && path === expo.path) ||
    [fastlane.roots.appStore, fastlane.roots.googlePlay].some(
      (root) => root !== '' && path.startsWith(`${root}/`),
    );
  const outside = files.find((f) => !inside(f.path));
  if (outside) {
    return {
      ok: false,
      path: outside.path,
      error: `${outside.path} is outside the folders of the selected listing target.`,
      code: 'outside_target',
    };
  }
  return { ok: true, files, warnings };
}

// ---------------------------------------------------------------------------------------------
// From a stored scan

export type DetectedSource = { source: ListingSourceKind; path: string };
export type DetectedSources = {
  appStore: DetectedSource | null;
  googlePlay: DetectedSource | null;
};

/**
 * Which source each store's listing would come from, judged from a scan alone (no reading of
 * files). The same rule as above; `null` when the scan found no listing for that store.
 */
export function detectedSources(detection: ProjectDetection): DetectedSources {
  const [config] = staticStoreConfigs(detection);
  const { iosMetadata, androidMetadata } = detection.paths;
  return {
    appStore: config
      ? { source: 'expo-store-config', path: config.path }
      : iosMetadata
        ? { source: 'fastlane', path: iosMetadata }
        : null,
    googlePlay: androidMetadata ? { source: 'fastlane', path: androidMetadata } : null,
  };
}
