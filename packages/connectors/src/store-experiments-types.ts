import type { StoreId } from '@kiln/core';

/**
 * Store experiments and custom product pages, store independent where there is anything to share (docs/adr/0048-store-experiments.md,
 * docs/spikes/store-experiments.md). Only Apple's App Store Connect API exposes them: Product Page Optimization experiments (v2) with their
 * treatments, and custom product pages with their versions and localizations. The Google Play Developer API has neither store listing
 * experiments nor custom store listings, so there is no Google connector: Kiln keeps a manual tracker and links out.
 *
 * Read only. No connector here creates, changes, starts or stops anything.
 */

/**
 * Where an experiment or a page version stands, in words that fit Apple's states. `approved` is Apple's `ACCEPTED` or `APPROVED`: whether the test
 * is running then is told by its dates (UNVERIFIED: Apple's reference lists no `RUNNING` state; its Help says the status turns to Running).
 */
export const STORE_EXPERIMENT_STATES = [
  'draft',
  'in_review',
  'approved',
  'rejected',
  'completed',
  'stopped',
  'replaced',
  'unknown',
] as const;
export type StoreExperimentState = (typeof STORE_EXPERIMENT_STATES)[number];
export const isStoreExperimentState = (value: unknown): value is StoreExperimentState =>
  typeof value === 'string' && (STORE_EXPERIMENT_STATES as readonly string[]).includes(value);

/** Apple's experiment `state` and custom page version `state` in this feature's words; an unknown one is `unknown` (the raw word is kept). */
export function appleExperimentState(raw: string | undefined): StoreExperimentState {
  switch ((raw ?? '').toUpperCase()) {
    case 'PREPARE_FOR_SUBMISSION':
      return 'draft';
    case 'READY_FOR_REVIEW':
    case 'WAITING_FOR_REVIEW':
    case 'IN_REVIEW':
      return 'in_review';
    case 'ACCEPTED':
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'COMPLETED':
      return 'completed';
    case 'STOPPED':
      return 'stopped';
    case 'REPLACED_WITH_NEW_VERSION':
      return 'replaced';
    default:
      return 'unknown';
  }
}

/** What a locale holds of media, as counts of asset-library placements (UNVERIFIED: one placement per screenshot or preview). */
export type StoreAssetCounts = {
  screenshots: number;
  previews: number;
  other: number;
  /** The old screenshot sets (deprecated by Apple in favour of the asset library), when the answer carried them. */
  screenshotSets: number;
};

export type StoreExperimentLocale = {
  locale: string;
  /** Apple's id of the localization resource. */
  ref: string;
  assets: StoreAssetCounts;
  /** Custom product pages only: the page version has promotional text in this locale. Null for a treatment (it has no text). */
  hasPromotionalText: boolean | null;
};

export type StoreExperimentTreatment = {
  id: string;
  name: string;
  /** The name of the alternative app icon the treatment shows, or null. */
  iconName: string | null;
  /** When the treatment was promoted to the product page, or null. */
  promotedAt: number | null;
  locales: StoreExperimentLocale[];
};

export type StoreExperiment = {
  /** Apple's id of the experiment. */
  id: string;
  name: string;
  /** Apple's `platform` (`IOS`, `MAC_OS`, `TV_OS`, ...), or null when the answer had none. */
  platform: string | null;
  state: StoreExperimentState;
  rawState: string | null;
  /** The share of visitors that sees a treatment, in percent (UNVERIFIED that it is a percentage), or null. */
  trafficProportion: number | null;
  reviewRequired: boolean | null;
  startedAt: number | null;
  endedAt: number | null;
  treatments: StoreExperimentTreatment[];
};

export type StoreCustomPageVersion = {
  id: string;
  version: string | null;
  state: StoreExperimentState;
  rawState: string | null;
  deepLink: string | null;
};

export type StoreCustomPage = {
  id: string;
  name: string;
  /** Whether the page can be reached by its address (Apple's `visible`), or null. */
  visible: boolean | null;
  /** The address to share, as Apple gives it. */
  url: string | null;
  /** The state of the version that counts (see `currentCustomPageVersion`). */
  state: StoreExperimentState;
  rawState: string | null;
  /** The deep link of the version that counts (iOS 18 and later), or null. */
  deepLink: string | null;
  versions: StoreCustomPageVersion[];
  /** The localizations of the version that counts. */
  locales: StoreExperimentLocale[];
};

export type ListExperimentsResult = {
  experiments: StoreExperiment[];
  customPages: StoreCustomPage[];
  /** False when a list stopped at a cap: the stores may have more than is shown. */
  complete: boolean;
  /** Sentences for a person (never a store response): a part that could not be read, a cap. */
  warnings: string[];
  /** Whether each part was read. A part Apple refused (a role without access, an app that is not live) is false and has a warning. */
  experimentsRead: boolean;
  customPagesRead: boolean;
};

export interface StoreExperimentsConnector {
  readonly store: StoreId;
  listExperiments(): Promise<ListExperimentsResult>;
}

/**
 * Of the versions of a custom product page, the one that counts: a version waiting, in review or rejected is the one being worked on, else the
 * approved one, else the first that is not replaced; the order Apple lists them in is not relied on. Null when there is no version.
 */
export function currentCustomPageVersion(
  versions: readonly StoreCustomPageVersion[],
): StoreCustomPageVersion | null {
  const rank = (v: StoreCustomPageVersion) =>
    v.state === 'draft' || v.state === 'in_review' || v.state === 'rejected'
      ? 0
      : v.state === 'approved'
        ? 1
        : v.state === 'replaced'
          ? 3
          : 2;
  let best: StoreCustomPageVersion | null = null;
  for (const v of versions) if (best === null || rank(v) < rank(best)) best = v;
  return best;
}

const empty = (): StoreAssetCounts => ({
  screenshots: 0,
  previews: 0,
  other: 0,
  screenshotSets: 0,
});
export const emptyAssetCounts = empty;
