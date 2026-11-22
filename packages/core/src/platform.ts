import type { ListingStore } from './listing/listing.ts';

/**
 * The platforms an app can be on, and everything call sites need to know about one: its label, the
 * store it is sold in, which store family (Apple's App Store Connect or Google Play) serves it, and
 * the name of its generic glyph. One place, so a screen or a service never hard-codes `ios` or
 * `android` to decide a label or a store.
 *
 * macOS is a third platform of the same app entry (an app group has one record per platform). It is
 * Apple's family: the connector, the credential kind, the lifecycle and the draft/submit/rollout
 * machinery are the App Store Connect ones, with the platform key `MAC_OS` where the API takes one.
 * Its bundle id may be the iOS one (universal purchase) or another.
 */

export const PLATFORMS = ['ios', 'macos', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type StoreFamily = 'apple' | 'google';

/** The RevenueCat app types this tool reads (RevenueCat's own words, as its API v2 uses them). Every other type is ignored, never an error. */
export const REVENUECAT_APP_TYPES = ['app_store', 'mac_app_store', 'play_store'] as const;
export type RevenueCatAppType = (typeof REVENUECAT_APP_TYPES)[number];

/** The stores this app talks to, as the id used in the API, the database and error messages. One place: add a store here. */
export const STORE_IDS = ['appstoreconnect', 'googleplay'] as const;
export type StoreId = (typeof STORE_IDS)[number];

/** The kind of stored credential a store needs (see `credentialKinds` in credentials.ts). */
export type StoreCredentialKind = 'app_store_connect' | 'google_play';

export type PlatformMeta = {
  id: Platform;
  /** The name in a chip or a control: "iOS", "macOS", "Android". */
  label: string;
  /** The store the platform is sold in: "App Store", "Mac App Store", "Google Play". */
  storeName: string;
  /** The same store in a sentence: "the App Store", "the Mac App Store", "Google Play". */
  storeNameWithArticle: string;
  /** The console behind it: "App Store Connect", "Google Play Console". */
  consoleName: string;
  family: StoreFamily;
  /** The device the app runs on: a phone or tablet app, or a desktop one. */
  formFactor: 'mobile' | 'desktop';
  /** What the store calls the app's identifier: "Bundle ID" or "Package name" (`identifierNoun` is the sentence form). */
  identifierLabel: string;
  /** The identifier in a sentence: "bundle ID", "package name". */
  identifierNoun: string;
  /** What a release is built from, as a column or a field label: "Build" or "Version codes". */
  buildLabel: string;
  /** The same for one: "Build" or "Version code". */
  buildLabelSingular: string;
  /** The store that sells it (what a connector, a review or a draft is tagged with). */
  store: StoreId;
  /** The same store as listing data names it. */
  listingStore: ListingStore;
  /** The store's own name in a sentence: "App Store" (also for macOS) or "Google Play". */
  storeShortName: string;
  /** The app has an id in the store's own system that a sync must have read first (Apple's numeric app id); Google Play uses the package name. */
  needsStoreAppId: boolean;
  /** What the store can do; ask with `supports`. */
  capabilities: PlatformCapabilities;
  /** A registered generic glyph (`apps/web/src/lib/icons.ts`), never a brand mark. */
  glyph: 'platform-ios' | 'platform-macos' | 'platform-android';
  /** Apple's `platform` value in App Store Connect API queries, when the family is Apple. */
  applePlatform?: 'IOS' | 'MAC_OS';
  /** What the credential of the platform's store is. */
  credentialKind: StoreCredentialKind;
  /**
   * The RevenueCat app types (`app_store`, `mac_app_store`, `play_store`) that carry this platform's purchases, most specific first
   * (docs/adr/0039-revenuecat.md). Ask `revenueCatAppTypes`. A macOS app is `mac_app_store` for a legacy Mac app and the shared
   * `app_store` app for a universal purchase.
   */
  revenueCatAppTypes: readonly RevenueCatAppType[];
  /** Order in a scope control and in merged rows. */
  order: number;
};

/**
 * What a platform's store can do, one flag per behaviour that code used to guess from "is it Apple or Google". The record is
 * exhaustive: a new platform has to say yes or no to every capability, so nothing is inherited by accident from the first two.
 * Code asks `supports(platform, 'releaseTracks')`, never "is it Android".
 */
export const CAPABILITIES = [
  /** A release is addressed by a track and version codes (Google Play), not by a version and a build (App Store). */
  'releaseTracks',
  /** A draft is one transactional edit that is committed (Google Play); the outcome of a commit cannot be read back at once. */
  'transactionalEdits',
  /** An approved version waits for the developer to release it (Apple's Pending Developer Release). */
  'approvalHold',
  /** A release can be sent to the store directly with its track, codes and share (Google Play). */
  'directRelease',
  /** The store's reports come from a Cloud Storage bucket the developer names (Google Play). */
  'playReportsBucket',
  /** The store's analytics need an Analytics Reports request to be enabled first (Apple). */
  'appleAnalyticsReports',
  /** Search-term reports can be imported (Google Play Console export). */
  'searchTermsImport',
  /** The store can check a release before it is rolled out (Google Play). */
  'releaseCheck',
  /** A new store version can be created from here (Apple). */
  'versionCreation',
  /** The store has its own beta channel with public links we can read (TestFlight). */
  'betaTesting',
  /** The store has a phased release by days (Apple), set apart from a staged rollout by share (Google Play). */
  'phasedRelease',
  /** A store-wide rating can be read without the developer API (the iTunes lookup, Apple). */
  'storeWideRating',
  /** Reviews can be read "since" a point in time (Apple); the other store has a fixed recent window. */
  'reviewsSinceCursor',
  /** Reviews are only readable for a recent window, so a long pause leaves a gap (Google Play). */
  'limitedReviewWindow',
  /** Screenshots are uploaded per device display type (Apple); the other store has graphics per type. */
  'screenshotsByDevice',
  /** The listing has a hidden keywords field (Apple). */
  'keywordField',
  /** Public search results carry the app names (Apple's search does; Google Play's do not). */
  'searchResultsHaveNames',
  /** Public search is read from an unofficial source that must be switched on (Google Play). */
  'unofficialSearch',
  /** The store's own analytics report the rating over time (Google Play). */
  'ratingHistory',
  /** A CI artifact can be installed from a download link or a QR code (an Android APK). */
  'sideloadInstall',
  /** A build can be put on Google Play's internal app sharing, which gives a download link at once. */
  'internalAppSharing',
  /** An app's identifier is a bundle id (letters, digits, dots, hyphens; case-insensitive) rather than a package name (case-sensitive). */
  'bundleIdentifier',
  /** The store sells in-app purchases and subscriptions that can be read (and their display texts edited) through its API. */
  'inAppPurchases',
  /** RevenueCat has an app type for the store, so the app's products can be read from a RevenueCat project (see `revenueCatAppTypes`). */
  'revenueCat',
  /**
   * The store's API lists Product Page Optimization experiments and custom product pages (Apple). Google Play's API has neither store listing
   * experiments nor custom store listings: its app gets a manual tracker and links to the Console (docs/adr/0048-store-experiments.md).
   */
  'storeExperimentsApi',
  /**
   * The store's API lists beta tester feedback and crash submissions (Apple's TestFlight). Google Play's Developer API has no counterpart
   * (docs/adr/0049-testflight-feedback.md).
   */
  'testflightFeedbackApi',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type PlatformCapabilities = Readonly<Record<Capability, boolean>>;

const APPLE_CAPABILITIES: PlatformCapabilities = {
  releaseTracks: false,
  transactionalEdits: false,
  approvalHold: true,
  directRelease: false,
  playReportsBucket: false,
  appleAnalyticsReports: true,
  searchTermsImport: false,
  releaseCheck: false,
  versionCreation: true,
  betaTesting: true,
  phasedRelease: true,
  storeWideRating: true,
  reviewsSinceCursor: true,
  limitedReviewWindow: false,
  screenshotsByDevice: true,
  keywordField: true,
  searchResultsHaveNames: true,
  unofficialSearch: false,
  bundleIdentifier: true,
  internalAppSharing: false,
  ratingHistory: false,
  sideloadInstall: false,
  inAppPurchases: true,
  revenueCat: true,
  storeExperimentsApi: true,
  testflightFeedbackApi: true,
};

const GOOGLE_CAPABILITIES: PlatformCapabilities = {
  releaseTracks: true,
  transactionalEdits: true,
  approvalHold: false,
  directRelease: true,
  playReportsBucket: true,
  appleAnalyticsReports: false,
  searchTermsImport: true,
  releaseCheck: true,
  versionCreation: false,
  betaTesting: false,
  phasedRelease: false,
  storeWideRating: false,
  reviewsSinceCursor: false,
  limitedReviewWindow: true,
  screenshotsByDevice: false,
  keywordField: false,
  searchResultsHaveNames: false,
  unofficialSearch: true,
  bundleIdentifier: false,
  internalAppSharing: true,
  ratingHistory: true,
  sideloadInstall: true,
  inAppPurchases: true,
  revenueCat: true,
  storeExperimentsApi: false,
  testflightFeedbackApi: false,
};

export const PLATFORM_META: Readonly<Record<Platform, PlatformMeta>> = {
  ios: {
    id: 'ios',
    label: 'iOS',
    storeName: 'App Store',
    storeNameWithArticle: 'the App Store',
    consoleName: 'App Store Connect',
    family: 'apple',
    formFactor: 'mobile',
    identifierLabel: 'Bundle ID',
    identifierNoun: 'bundle ID',
    buildLabel: 'Build',
    buildLabelSingular: 'Build',
    store: 'appstoreconnect',
    listingStore: 'app_store',
    storeShortName: 'App Store',
    needsStoreAppId: true,
    capabilities: APPLE_CAPABILITIES,
    glyph: 'platform-ios',
    applePlatform: 'IOS',
    credentialKind: 'app_store_connect',
    revenueCatAppTypes: ['app_store'],
    order: 0,
  },
  macos: {
    id: 'macos',
    label: 'macOS',
    storeName: 'Mac App Store',
    storeNameWithArticle: 'the Mac App Store',
    consoleName: 'App Store Connect',
    family: 'apple',
    formFactor: 'desktop',
    identifierLabel: 'Bundle ID',
    identifierNoun: 'bundle ID',
    buildLabel: 'Build',
    buildLabelSingular: 'Build',
    store: 'appstoreconnect',
    listingStore: 'app_store',
    storeShortName: 'App Store',
    needsStoreAppId: true,
    capabilities: APPLE_CAPABILITIES,
    glyph: 'platform-macos',
    applePlatform: 'MAC_OS',
    credentialKind: 'app_store_connect',
    revenueCatAppTypes: ['mac_app_store', 'app_store'],
    order: 1,
  },
  android: {
    id: 'android',
    label: 'Android',
    storeName: 'Google Play',
    storeNameWithArticle: 'Google Play',
    consoleName: 'Google Play Console',
    family: 'google',
    formFactor: 'mobile',
    identifierLabel: 'Package name',
    identifierNoun: 'package name',
    buildLabel: 'Version codes',
    buildLabelSingular: 'Version code',
    store: 'googleplay',
    listingStore: 'google_play',
    storeShortName: 'Google Play',
    needsStoreAppId: false,
    capabilities: GOOGLE_CAPABILITIES,
    glyph: 'platform-android',
    credentialKind: 'google_play',
    revenueCatAppTypes: ['play_store'],
    order: 2,
  },
};

export const isPlatform = (value: unknown): value is Platform =>
  typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/** A platform string (any case), or undefined. */
export const parsePlatform = (value: string | null | undefined): Platform | undefined => {
  const v = (value ?? '').trim().toLowerCase();
  return isPlatform(v) ? v : undefined;
};

export const platformMeta = (platform: Platform): PlatformMeta => PLATFORM_META[platform];
export const platformLabel = (platform: Platform): string => PLATFORM_META[platform].label;
export const storeFamilyOf = (platform: Platform): StoreFamily => PLATFORM_META[platform].family;
/** The store behind a platform. */
export const storeOf = (platform: Platform): StoreId => PLATFORM_META[platform].store;
/** The store as listing data names it (`app_store` or `google_play`). */
export const listingStoreOf = (platform: Platform): ListingStore =>
  PLATFORM_META[platform].listingStore;
/** "App Store" or "Google Play", for a sentence. */
export const storeShortName = (platform: Platform): string =>
  PLATFORM_META[platform].storeShortName;
/** Whether the platform's store needs the app's store id read first (Apple), rather than the package name (Google Play). */
export const needsStoreAppId = (platform: Platform): boolean =>
  PLATFORM_META[platform].needsStoreAppId;
/** The app's id in the store's own system: Apple's numeric app id (null before the first sync) or the Google Play package name. */
export const storeSideId = (
  platform: Platform,
  app: { storeAppId: string | null; identifier: string },
): string | null => (PLATFORM_META[platform].needsStoreAppId ? app.storeAppId : app.identifier);
/**
 * Chooses a value by the store family of a platform. The record names every family, so adding one (a Microsoft or a Linux
 * store) makes the compiler list each place that still has to say what the new family does. Both values are computed, so it is
 * for plain values; use `switch (storeFamilyOf(platform))` with `assertNever` for code that must run only for one family.
 */
export const byFamily = <const C extends Readonly<Record<StoreFamily, unknown>>>(
  platform: Platform,
  choices: C,
): C[StoreFamily] => choices[PLATFORM_META[platform].family];
/** Whether the platform's app runs on a desktop (macOS, later Windows or Linux) rather than a phone or tablet. */
export const isDesktop = (platform: Platform): boolean =>
  PLATFORM_META[platform].formFactor === 'desktop';
/** Whether the platform's store has the capability. */
export const supports = (platform: Platform, capability: Capability): boolean =>
  PLATFORM_META[platform].capabilities[capability];
/** The RevenueCat app types that can carry the platform's purchases, most specific first; empty when the platform has no RevenueCat support. */
export const revenueCatAppTypes = (platform: Platform): readonly RevenueCatAppType[] =>
  supports(platform, 'revenueCat') ? PLATFORM_META[platform].revenueCatAppTypes : [];
/** `supports` for a platform that arrives as a string or may be missing (a row, a query): unknown means no. */
export const platformSupports = (
  platform: string | null | undefined,
  capability: Capability,
): boolean => {
  const parsed = parsePlatform(platform);
  return parsed !== undefined && supports(parsed, capability);
};

/** Platforms in display order (iOS, macOS, Android), without duplicates. */
export const sortPlatforms = (platforms: readonly Platform[]): Platform[] =>
  PLATFORMS.filter((p) => platforms.includes(p));

/** The platforms that share a store family with `platform`, itself included. */
export const platformsOfFamily = (family: StoreFamily): Platform[] =>
  PLATFORMS.filter((p) => PLATFORM_META[p].family === family);
