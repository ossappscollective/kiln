import type { FileChange, Listing } from '@mrm/core';
import {
  detectProject,
  type ExpoStoreSnapshot,
  expoStoreChangeSet,
  GithubError,
  GithubRateLimitError,
  type ListingSnapshot,
  listingChangeSet,
  loadExpoStoreConfig,
  loadListing,
  type ProjectDetection,
  staticStoreConfigs,
} from '@mrm/connectors';

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
};

type Read = (path: string) => Promise<string | undefined>;

/** A file the host refused to hand over as text (too large, binary). The rest of the listing is still usable. */
const isUnreadable = (error: unknown): error is GithubError =>
  error instanceof GithubError &&
  !(error instanceof GithubRateLimitError) &&
  (error.kind === 'not_text' || error.kind === 'too_large');

/**
 * Reads the listing sources of a repository from its file list: project detection first (so the
 * store config is found the way a scan finds it), then the Expo store config, then the fastlane
 * folders. Each file is read at most once.
 */
export async function readListings(files: string[], read: Read): Promise<RepositoryListings> {
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
  const expo = await loadExpoStoreConfig(detection, readStoreConfig);
  if (expo && unreadable !== undefined) expo.error = unreadable;

  const fastlane = await loadListing(files, cached);
  const dynamicStoreConfigs = (detection.expo?.storeConfigs ?? [])
    .filter((config) => config.dynamic)
    .map((config) => config.path);
  return { fastlane, ...(expo ? { expo } : {}), dynamicStoreConfigs };
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
  const warnings = [...fastlane.warnings];
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
  | { ok: false; path: string; error: string };

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
  files.push(...listingChangeSet(fastlane, toFastlane));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files, warnings };
}

// ---------------------------------------------------------------------------------------------
// From a stored scan

export type DetectedSource = { source: ListingSourceKind; path: string };
export type DetectedSources = { appStore: DetectedSource | null; googlePlay: DetectedSource | null };

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
