import { isApplePlatform, type Platform } from './platform.ts';
import type { ReleaseFieldId, StagedReleaseFieldView } from './release-fields.ts';
import { type AssetKind, type AssetStore, deviceFitsPlatform, PLAY_DEVICES } from './store-asset-specs.ts';

/**
 * Staged store changes (docs/api/staged-changes.md, docs/adr/0009-staged-store-drafts.md): the
 * listing texts and graphics a person has collected for one app, to be written into the store as a
 * DRAFT later (and never submitted for review from here). Pure: which items can be staged at all,
 * how they map to each store's own names, and the shapes the API and the web app share. Nothing here
 * talks to a store or to a database.
 *
 * ES2017 only: the web app imports this file.
 *
 * What is VERIFIED and what is not is marked next to each table. Google's names come from
 * https://developers.google.com/android-publisher/api-ref/rest/v3/AppImageType and
 * `edits.listings` (read 2026-11-18). Apple's display type names are NOT verified (Apple's page
 * for `ScreenshotDisplayType` lists no values), see `APPLE_DISPLAY_TYPES`. The App Store connector writes through the App
 * Asset Library, which finds the placement group from Apple's reference data and the pixel size: these names are this
 * server's own name of a set (the `target`), not an Apple id.
 */

export const STAGED_KINDS = ['listing_text', 'asset', 'release_field'] as const;
export type StagedKind = (typeof STAGED_KINDS)[number];

/**
 * Where a staged value came from. `repo`: the repository's listing files or media (read through the
 * clone roots of the app's listing target). `local`: typed in by a person. `store`: copied from the
 * store's own snapshot that the last sync stored. Staging never reads or writes a store.
 */
export const STAGED_SOURCES = ['repo', 'local', 'store'] as const;
export type StagedSource = (typeof STAGED_SOURCES)[number];

export const STAGED_LIMITS = {
  /** Staged rows per app (a text is a row, a file of an asset set is a row). */
  maxItems: 600,
  /** Hard cap on a staged text (the stores' limits are far lower; this only bounds storage). */
  maxTextChars: 20_000,
  /** One locale code. */
  maxLocaleChars: 35,
  /** Files in one push, and bytes read for it. A push reads bytes from the clone at apply time only. */
  maxAssetFilesPerPush: 100,
  maxAssetBytesPerPush: 64 * 1024 * 1024,
  /** One uploaded file. The stores state no maximum for screenshots; this is this server's own cap. */
  maxAssetFileBytes: 8 * 1024 * 1024,
} as const;

/** Formats a push uploads. Everything else (webp, gif, video, an unread file) is refused at staging. */
export const PUSHABLE_IMAGE_FORMATS: readonly string[] = ['png', 'jpeg'];

// ---------------------------------------------------------------------------------------------
// Listing text

/**
 * The listing fields a push can write, per platform.
 *
 * - App Store and Mac App Store: the fields of the version localization (`appStoreVersionLocalizations`): description,
 *   keywords, promotional text, what's new, marketing and support URL. Name, subtitle and the
 *   privacy policy URL live on the app INFO localization and are not written by this feature (they
 *   cannot be staged: refused with `field_not_pushable`). The app-wide copyright is not per locale
 *   and not staged.
 * - Google Play: every field of `edits.listings` (title, short and full description, video).
 */
export const STAGEABLE_TEXT_FIELDS: Readonly<Record<Platform, readonly string[]>> = {
  ios: ['description', 'keywords', 'promotional_text', 'release_notes', 'marketing_url', 'support_url'],
  // The same version localization fields; a macOS version has its own, written to the macOS version only.
  macos: ['description', 'keywords', 'promotional_text', 'release_notes', 'marketing_url', 'support_url'],
  android: ['title', 'short_description', 'full_description', 'video'],
};

/** Apple attribute of an `appStoreVersionLocalizations` resource for a listing field (names as the read connector uses). */
export const APPLE_VERSION_LOCALIZATION_ATTRIBUTES: Readonly<Record<string, string>> = {
  description: 'description',
  keywords: 'keywords',
  promotional_text: 'promotionalText',
  release_notes: 'whatsNew',
  marketing_url: 'marketingUrl',
  support_url: 'supportUrl',
};

/** Google `Listing` member for a listing field. */
export const PLAY_LISTING_MEMBERS: Readonly<Record<string, string>> = {
  title: 'title',
  short_description: 'shortDescription',
  full_description: 'fullDescription',
  video: 'video',
};

export const isStageableTextField = (platform: Platform, field: string): boolean =>
  STAGEABLE_TEXT_FIELDS[platform].indexOf(field) !== -1;

// ---------------------------------------------------------------------------------------------
// Graphics

/** One set of graphics in a locale: screenshots of one device class, or a single Play graphic. */
export type AssetSlot = { kind: AssetKind; device: string | null };

export const slotKey = (slot: AssetSlot): string => (slot.device === null ? slot.kind : `${slot.kind}:${slot.device}`);

export function parseSlotKey(key: string): AssetSlot | undefined {
  const at = key.indexOf(':');
  const kind = (at === -1 ? key : key.slice(0, at)) as AssetKind;
  const device = at === -1 ? null : key.slice(at + 1);
  if (kind === 'screenshot') return device === null || device === '' ? undefined : { kind, device };
  if (device !== null) return undefined;
  return { kind, device: null };
}

/**
 * App Store Connect `screenshotDisplayType` of the deprecated set based screenshot resources, per
 * display id of `APPLE_DISPLAYS`. UNVERIFIED: Apple's `ScreenshotDisplayType` page lists no values.
 * Only `APP_IPHONE_67` and `APP_IPAD_PRO_3GEN_129` were seen in data the read connector parses; the
 * rest are the names fastlane and third party tools use. A display that is not listed here cannot be
 * pushed (`unsupported_device`), and the iPhone 6.9 inch display depends on the pixel size, see
 * `appleDisplayType`.
 */
export const APPLE_DISPLAY_TYPES: Readonly<Record<string, string>> = {
  iphone_6_5: 'APP_IPHONE_65',
  iphone_6_1: 'APP_IPHONE_61',
  iphone_5_8: 'APP_IPHONE_58',
  iphone_5_5: 'APP_IPHONE_55',
  iphone_4_7: 'APP_IPHONE_47',
  iphone_4: 'APP_IPHONE_40',
  iphone_3_5: 'APP_IPHONE_35',
  ipad_13: 'APP_IPAD_PRO_3GEN_129',
  ipad_11: 'APP_IPAD_PRO_3GEN_11',
  ipad_10_5: 'APP_IPAD_105',
  ipad_9_7: 'APP_IPAD_97',
  mac: 'APP_DESKTOP',
  apple_tv: 'APP_APPLE_TV',
};

/** The size Apple files under the 6.7 inch display type; the rest of `iphone_6_9` under 6.9 inch (UNVERIFIED). */
const IPHONE_67_SIZES: readonly (readonly number[])[] = [
  [1290, 2796],
  [2796, 1290],
];

/** The `screenshotDisplayType` for a device class and pixel size, or undefined when this server has no name for it. */
export function appleDisplayType(device: string, width: number | null, height: number | null): string | undefined {
  if (device === 'iphone_6_9') {
    if (width === null || height === null) return undefined;
    for (let i = 0; i < IPHONE_67_SIZES.length; i++) {
      const size = IPHONE_67_SIZES[i] as readonly number[];
      if (size[0] === width && size[1] === height) return 'APP_IPHONE_67';
    }
    return 'APP_IPHONE_69';
  }
  return APPLE_DISPLAY_TYPES[device];
}

/** Google `AppImageType` of a slot, or undefined. VERIFIED list (AppImageType page). `promo_graphic` has no type. */
export function playImageType(slot: AssetSlot): string | undefined {
  if (slot.kind === 'screenshot') {
    for (let i = 0; i < PLAY_DEVICES.length; i++) {
      const d = PLAY_DEVICES[i] as (typeof PLAY_DEVICES)[number];
      if (d.id === slot.device) return d.dir;
    }
    return undefined;
  }
  if (slot.kind === 'icon') return 'icon';
  if (slot.kind === 'feature_graphic') return 'featureGraphic';
  if (slot.kind === 'tv_banner') return 'tvBanner';
  return undefined;
}

export type SlotSupport = { ok: true } | { ok: false; reason: string };

/** Whether a push can write this slot at all (before looking at a file). */
export function assetSlotSupport(platform: Platform, slot: AssetSlot): SlotSupport {
  if (isApplePlatform(platform)) {
    if (slot.kind !== 'screenshot') {
      return {
        ok: false,
        reason:
          slot.kind === 'preview'
            ? 'App previews (video) are not pushed: this server uploads images only.'
            : slot.kind === 'app_icon'
              ? 'The App Store icon is part of the app build; the App Store Connect API has no icon upload.'
              : 'This kind of graphic does not exist on the App Store.',
      };
    }
    if (slot.device === null || (APPLE_DISPLAY_TYPES[slot.device] === undefined && slot.device !== 'iphone_6_9')) {
      return { ok: false, reason: 'This display size has no known App Store Connect screenshot display type.' };
    }
    if (!deviceFitsPlatform(platform, slot.device)) {
      return {
        ok: false,
        reason: platform === 'macos' ? 'A macOS version takes Mac screenshots only (the Mac display).' : 'The Mac display belongs to the macOS version of the app, not the iOS one.',
      };
    }
    return { ok: true };
  }
  if (slot.kind === 'promo_graphic') {
    return { ok: false, reason: 'Google Play has no image type for the promo graphic in the Developer API (AppImageType).' };
  }
  if (slot.kind === 'preview' || slot.kind === 'app_icon') {
    return { ok: false, reason: 'This kind of graphic is not a Google Play listing image.' };
  }
  return playImageType(slot) === undefined ? { ok: false, reason: 'Not a Google Play image type.' } : { ok: true };
}

/** The most files one set can hold (a push replaces the whole set), from the stores' documented limits. */
export function slotMaxFiles(platform: Platform, slot: AssetSlot): number {
  if (slot.kind === 'screenshot') return isApplePlatform(platform) ? 10 : 8;
  return 1;
}

export const assetStoreOf = (platform: Platform): AssetStore => (isApplePlatform(platform) ? 'app_store' : 'google_play');

// ---------------------------------------------------------------------------------------------
// What the API shows

export type StagedProblem = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  limit?: number;
  actual?: number;
  unit?: 'characters' | 'bytes';
};

export type StagedTextView = {
  id: string;
  kind: 'listing_text';
  locale: string;
  field: string;
  label: string;
  source: StagedSource;
  /** The staged text. Listing text is shown in the product anyway; it is never logged or audited. */
  value: string;
  valueHash: string;
  limit: number | null;
  unit: 'characters' | 'bytes';
  /** The last value the tool knew in the store's editable (App Store) or live (Google Play) listing. Null: none stored. */
  before: string | null;
  /** `changed`, `unchanged` (the stored store value is the same), `invalid` (an error problem). */
  status: 'changed' | 'unchanged' | 'invalid';
  problems: StagedProblem[];
  pushedAt: number | null;
  /** Pushed, and the staged value is still the one that was pushed. */
  pushed: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type StagedAssetFileView = {
  id: string;
  position: number;
  path: string;
  commit: string;
  /** The git blob id: the identity of the bytes. A push checks the bytes it reads against it. */
  oid: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  format: string | null;
  hasAlpha: boolean | null;
  /**
   * The file was uploaded or fixed in the app: its bytes are kept by this server (`path` is `uploads/<id>/<name>`, `commit` is
   * empty) and are shown from `GET .../staged/assets/blob`, not from the repository.
   */
  upload?: boolean;
};

export type StagedAssetView = {
  /** Stable id of the set: `<locale>/<slotKey>`. */
  id: string;
  kind: 'asset';
  locale: string;
  slot: AssetSlot;
  slotKey: string;
  label: string;
  source: StagedSource;
  /** The files of the set, in order. A push makes the store's set exactly these files. */
  files: StagedAssetFileView[];
  status: 'changed' | 'invalid';
  problems: StagedProblem[];
  pushedAt: number | null;
  pushed: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StagedChangesView = {
  app: { id: string; name: string; platform: Platform; store: 'appstoreconnect' | 'googleplay' };
  text: StagedTextView[];
  assets: StagedAssetView[];
  totals: { text: number; assetSets: number; assetFiles: number; errors: number; warnings: number; changed: number; /** Staged release fields. Present from the server. */ release?: number };
  /** False when any item has an error: a push is refused while there are some. */
  valid: boolean;
  /**
   * The release fields staged for this app (docs/api/releases-write.md): App Store version fields or a Google Play draft
   * release. Always present from the server.
   */
  release?: StagedReleaseFieldView[];
  /** What a push can write for this platform (so a screen can say why something cannot be staged). */
  pushable: { textFields: string[]; /** Release fields that can be staged (see `PUT .../staged/release-fields`). */ releaseFields?: ReleaseFieldId[] };
  limits: typeof STAGED_LIMITS;
};
