import type { ListingStore } from './listing.ts';

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
  /** The console behind it: "App Store Connect", "Google Play Console". */
  consoleName: string;
  family: StoreFamily;
  /** The store that sells it (what a connector, a review or a draft is tagged with). */
  store: StoreId;
  /** The same store as listing data names it. */
  listingStore: ListingStore;
  /** The store's own name in a sentence: "App Store" (also for macOS) or "Google Play". */
  storeShortName: string;
  /** The app has an id in the store's own system that a sync must have read first (Apple's numeric app id); Google Play uses the package name. */
  needsStoreAppId: boolean;
  /** A registered generic glyph (`apps/web/src/lib/icons.ts`), never a brand mark. */
  glyph: 'platform-ios' | 'platform-macos' | 'platform-android';
  /** Apple's `platform` value in App Store Connect API queries, when the family is Apple. */
  applePlatform?: 'IOS' | 'MAC_OS';
  /** What the credential of the platform's store is. */
  credentialKind: StoreCredentialKind;
  /** Order in a scope control and in merged rows. */
  order: number;
};

export const PLATFORM_META: Readonly<Record<Platform, PlatformMeta>> = {
  ios: {
    id: 'ios',
    label: 'iOS',
    storeName: 'App Store',
    consoleName: 'App Store Connect',
    family: 'apple',
    store: 'appstoreconnect',
    listingStore: 'app_store',
    storeShortName: 'App Store',
    needsStoreAppId: true,
    glyph: 'platform-ios',
    applePlatform: 'IOS',
    credentialKind: 'app_store_connect',
    order: 0,
  },
  macos: {
    id: 'macos',
    label: 'macOS',
    storeName: 'Mac App Store',
    consoleName: 'App Store Connect',
    family: 'apple',
    store: 'appstoreconnect',
    listingStore: 'app_store',
    storeShortName: 'App Store',
    needsStoreAppId: true,
    glyph: 'platform-macos',
    applePlatform: 'MAC_OS',
    credentialKind: 'app_store_connect',
    order: 1,
  },
  android: {
    id: 'android',
    label: 'Android',
    storeName: 'Google Play',
    consoleName: 'Google Play Console',
    family: 'google',
    store: 'googleplay',
    listingStore: 'google_play',
    storeShortName: 'Google Play',
    needsStoreAppId: false,
    glyph: 'platform-android',
    credentialKind: 'google_play',
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
export const listingStoreOf = (platform: Platform): ListingStore => PLATFORM_META[platform].listingStore;
/** "App Store" or "Google Play", for a sentence. */
export const storeShortName = (platform: Platform): string => PLATFORM_META[platform].storeShortName;
/** Whether the platform's store needs the app's store id read first (Apple), rather than the package name (Google Play). */
export const needsStoreAppId = (platform: Platform): boolean => PLATFORM_META[platform].needsStoreAppId;
/** The app's id in the store's own system: Apple's numeric app id (null before the first sync) or the Google Play package name. */
export const storeSideId = (
  platform: Platform,
  app: { storeAppId: string | null; identifier: string },
): string | null => (PLATFORM_META[platform].needsStoreAppId ? app.storeAppId : app.identifier);
export const isApplePlatform = (platform: Platform): boolean =>
  PLATFORM_META[platform].family === 'apple';
export const isGooglePlatform = (platform: Platform): boolean =>
  PLATFORM_META[platform].family === 'google';

/** Platforms in display order (iOS, macOS, Android), without duplicates. */
export const sortPlatforms = (platforms: readonly Platform[]): Platform[] =>
  PLATFORMS.filter((p) => platforms.includes(p));

/** The platforms that share a store family with `platform`, itself included. */
export const platformsOfFamily = (family: StoreFamily): Platform[] =>
  PLATFORMS.filter((p) => PLATFORM_META[p].family === family);
