import { isDesktop, type Platform, supports } from '../platform.ts';
import type { ImageFormat } from './image-header.ts';
import type { ListingStore } from './listing.ts';

/**
 * What the stores accept as listing graphics, as data, and a pure checker that holds a list of
 * assets found in a repository against it. Nothing here reads a file or talks to a store: the
 * checks are against the specs below, as documented, and a store may still refuse an upload.
 *
 * Every number comes from an official page that was read on 2026-11-18 (see `SPEC_SOURCES`), or
 * is marked `unverified`: the rule is then kept as information and never as an error, and the
 * docs list it. Where a page gives no value (a maximum file size, for example) no check is made.
 *
 * Sources read:
 * - Apple screenshots: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
 *   (png, jpg and jpeg; 1 to 10 per device size; no alpha channel or transparency; the accepted
 *   resolutions per display size, copied below). The same sizes are the `DEVICE_RESOLUTIONS` of
 *   fastlane deliver (deliver/lib/deliver/app_screenshot.rb), which finds a screenshot's device
 *   type from its pixel size, not from its name.
 * - Apple app previews: https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/
 *   (.mov, .m4v, .mp4; 15 to 30 seconds; at most 500 MB; up to 3 per device size and language).
 *   The page was read only in part, so the per device resolutions of previews are not checked.
 * - Apple icon: https://developer.apple.com/design/human-interface-guidelines/app-icons (the
 *   specifications table: iOS, iPadOS and macOS layout size 1024x1024 px). Whether the App Store
 *   icon may have an alpha channel is NOT stated on the Apple pages that were read: UNVERIFIED.
 * - Google Play: https://support.google.com/googleplay/android-developer/answer/9866151 (icon:
 *   32-bit PNG with alpha, 512x512, up to 1024 KB; feature graphic: JPEG or 24-bit PNG without
 *   alpha, 1024x500; screenshots: JPEG or 24-bit PNG without alpha, 320 to 3840 px, the longer
 *   side at most twice the shorter, at most 8 per device type, at least two to publish; TV banner
 *   1280x720; Wear OS 1:1, at least 384x384). No maximum file size is stated for the feature
 *   graphic or screenshots: no check.
 * - fastlane layouts: https://docs.fastlane.tools/actions/deliver/ and
 *   https://docs.fastlane.tools/actions/supply/ (supply: `metadata/android/<locale>/images/`).
 */

export type AssetStore = ListingStore;

/**
 * - `screenshot`, `preview`: store listing media per locale and device.
 * - `feature_graphic`, `promo_graphic`, `tv_banner`, `icon`: Google Play listing graphics
 *   (`icon` is the store icon of the listing; fastlane `images/icon.png`).
 * - `app_icon`: the icon of the app itself found in the project (Expo `icon`, an Xcode
 *   `AppIcon.appiconset`, an Android `ic_launcher`); for the App Store it is the 1024 px icon that
 *   goes to the store with the build.
 */
export type AssetKind =
  | 'screenshot'
  | 'preview'
  | 'feature_graphic'
  | 'promo_graphic'
  | 'tv_banner'
  | 'icon'
  | 'app_icon';

export const ASSET_KINDS: readonly AssetKind[] = [
  'screenshot',
  'preview',
  'feature_graphic',
  'promo_graphic',
  'tv_banner',
  'icon',
  'app_icon',
];

export const ASSET_KIND_LABELS: Readonly<Record<AssetKind, string>> = {
  screenshot: 'Screenshots',
  preview: 'App previews',
  feature_graphic: 'Feature graphic',
  promo_graphic: 'Promo graphic',
  tv_banner: 'TV banner',
  icon: 'Store icon',
  app_icon: 'App icon',
};

export const SPEC_SOURCES = {
  appleScreenshots:
    'https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/',
  applePreviews:
    'https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/',
  appleIcon: 'https://developer.apple.com/design/human-interface-guidelines/app-icons',
  googlePlay: 'https://support.google.com/googleplay/android-developer/answer/9866151',
  fastlaneDeliver: 'https://docs.fastlane.tools/actions/deliver/',
  fastlaneSupply: 'https://docs.fastlane.tools/actions/supply/',
} as const;

// ---------------------------------------------------------------------------------------------
// App Store display sizes

type Size = readonly [number, number];
export type AppleFamily = 'iphone' | 'ipad' | 'mac' | 'tv' | 'vision' | 'watch';

export type AppleDisplay = {
  id: string;
  label: string;
  family: AppleFamily;
  /** Accepted pixel sizes, width by height, both orientations where Apple lists both. */
  sizes: readonly Size[];
};

const both = (...portrait: Size[]): Size[] => {
  const out: Size[] = [];
  for (const [w, h] of portrait) out.push([w, h], [h, w]);
  return out;
};

/**
 * Display sizes and the resolutions App Store Connect accepts (the screenshot specifications
 * page). Order matters only for classification of a size that two displays share: the first wins.
 * 2048x2732 is accepted for the 13 inch and the 12.9 inch (2nd generation) iPad alike, so they are
 * one entry; 3840x2160 is Apple TV and Apple Vision Pro, decided by `classifyAppleScreenshot`.
 */
export const APPLE_DISPLAYS: readonly AppleDisplay[] = [
  {
    id: 'iphone_6_9',
    label: 'iPhone 6.9" / 6.7"',
    family: 'iphone',
    sizes: both([1260, 2736], [1290, 2796], [1320, 2868]),
  },
  {
    id: 'iphone_6_5',
    label: 'iPhone 6.5"',
    family: 'iphone',
    sizes: both([1284, 2778], [1242, 2688]),
  },
  {
    id: 'iphone_6_1',
    label: 'iPhone 6.1"',
    family: 'iphone',
    sizes: both([1179, 2556], [1206, 2622]),
  },
  {
    id: 'iphone_5_8',
    label: 'iPhone 5.8"',
    family: 'iphone',
    sizes: both([1170, 2532], [1125, 2436], [1080, 2340]),
  },
  { id: 'iphone_5_5', label: 'iPhone 5.5"', family: 'iphone', sizes: both([1242, 2208]) },
  { id: 'iphone_4_7', label: 'iPhone 4.7"', family: 'iphone', sizes: both([750, 1334]) },
  // Portrait 640x1096 and 640x1136, landscape 1136x600 and 1136x640 (with or without the status bar).
  { id: 'iphone_4', label: 'iPhone 4"', family: 'iphone', sizes: both([640, 1096], [640, 1136]) },
  { id: 'iphone_3_5', label: 'iPhone 3.5"', family: 'iphone', sizes: both([640, 920], [640, 960]) },
  // Outer display 1398x2034, inner display 2007x2853 (the page notes screenshots become required
  // for apps built with the iOS 27.1 SDK or later from April 2027).
  {
    id: 'iphone_duo',
    label: 'iPhone Duo',
    family: 'iphone',
    sizes: both([1398, 2034], [2007, 2853]),
  },
  {
    id: 'ipad_13',
    label: 'iPad 13" / 12.9"',
    family: 'ipad',
    sizes: both([2064, 2752], [2048, 2732]),
  },
  {
    id: 'ipad_11',
    label: 'iPad 11"',
    family: 'ipad',
    sizes: both([1488, 2266], [1512, 2316], [1668, 2420], [1668, 2388], [1640, 2360]),
  },
  { id: 'ipad_10_5', label: 'iPad 10.5"', family: 'ipad', sizes: both([1668, 2224]) },
  {
    id: 'ipad_9_7',
    label: 'iPad 9.7"',
    family: 'ipad',
    sizes: both([1536, 2008], [768, 1004], [1536, 2048], [768, 1024]),
  },
  {
    id: 'mac',
    label: 'Mac',
    family: 'mac',
    sizes: [
      [1280, 800],
      [1440, 900],
      [2560, 1600],
      [2880, 1800],
    ],
  },
  {
    id: 'apple_tv',
    label: 'Apple TV',
    family: 'tv',
    sizes: [
      [1920, 1080],
      [3840, 2160],
    ],
  },
  { id: 'vision_pro', label: 'Apple Vision Pro', family: 'vision', sizes: [[3840, 2160]] },
  {
    id: 'watch',
    label: 'Apple Watch',
    family: 'watch',
    // Ultra 4 and 3, Ultra 2 and Ultra, Series 12 to 10, 9 to 7, 6 to 4 and SE, 3 to 1.
    sizes: [
      [422, 514],
      [410, 502],
      [416, 496],
      [396, 484],
      [368, 448],
      [312, 390],
    ],
  },
];

const DISPLAY_BY_ID = new Map(APPLE_DISPLAYS.map((d) => [d.id, d]));
export const IMESSAGE_PREFIX = 'imessage:';

/**
 * Whether a screenshot display belongs to an app record of this platform. On the Apple side an iOS
 * version takes the iPhone and iPad (and Watch, TV, Vision) displays and a macOS version takes only the Mac
 * display (`APP_DESKTOP`); an iMessage set is iOS only. Google Play takes every Play device. A `null`
 * device (not classified) fits no Apple platform here: the caller reports it separately.
 */
export function deviceFitsPlatform(platform: Platform, device: string | null): boolean {
  if (!supports(platform, 'screenshotsByDevice')) return true;
  if (device === null) return false;
  const imessage = device.startsWith(IMESSAGE_PREFIX);
  const base = DISPLAY_BY_ID.get(imessage ? device.slice(IMESSAGE_PREFIX.length) : device);
  if (base === undefined) return !isDesktop(platform);
  return isDesktop(platform) ? base.family === 'mac' && !imessage : base.family !== 'mac';
}

/**
 * Whether a kind of asset is a set per device class. Screenshots and previews are (Apple: display type;
 * Google Play: phone, tablet, TV, Wear); icons, the feature graphic, the promo graphic and the TV banner are
 * one per locale and have no device dimension on either store.
 */
export function kindHasDevice(kind: AssetKind): boolean {
  return kind === 'screenshot' || kind === 'preview';
}

/**
 * The label of a device class id of either store, or the id itself when it is not known. `null` (no device
 * class) gives an empty string: the caller decides whether that means "this kind has no device"
 * (`kindHasDevice`) or "the device is not recognised", and translates the second one.
 */
export function deviceLabel(store: AssetStore, id: string | null): string {
  if (id === null) return '';
  if (store === 'app_store') {
    const imessage = id.startsWith(IMESSAGE_PREFIX);
    const base = DISPLAY_BY_ID.get(imessage ? id.slice(IMESSAGE_PREFIX.length) : id);
    return base ? (imessage ? `iMessage, ${base.label}` : base.label) : id;
  }
  return PLAY_DEVICES.find((d) => d.id === id)?.label ?? id;
}

/**
 * The device part of a set, for an English message of this package: '' for a kind without a device
 * dimension, 'device not recognised' for a device-specific kind without a class, else the label.
 */
export function describeDevice(store: AssetStore, kind: AssetKind, id: string | null): string {
  if (!kindHasDevice(kind)) return '';
  return id === null ? 'device not recognised' : deviceLabel(store, id);
}

/**
 * The display size of a screenshot by its pixel size, as fastlane deliver does it (the name is not
 * used, except for the two sizes that are ambiguous). `null`: App Store Connect has no display
 * size with these dimensions.
 */
export function classifyAppleScreenshot(width: number, height: number, hint = ''): string | null {
  if (width === 3840 && height === 2160) return /vision/i.test(hint) ? 'vision_pro' : 'apple_tv';
  for (const display of APPLE_DISPLAYS) {
    if (display.id === 'vision_pro') continue;
    if (display.sizes.some(([w, h]) => w === width && h === height)) return display.id;
  }
  return null;
}

/** Preview files name their device in the file name (deliver: `IPHONE_67`, `IPAD_PRO_129`, `DESKTOP`). */
export function classifyApplePreviewName(name: string): string | null {
  const n = name.toUpperCase();
  if (/IPHONE_(?:69|67)/.test(n)) return 'iphone_6_9';
  if (/IPHONE_65/.test(n)) return 'iphone_6_5';
  if (/IPHONE_61/.test(n)) return 'iphone_6_1';
  if (/IPHONE_58/.test(n)) return 'iphone_5_8';
  if (/IPHONE_55/.test(n)) return 'iphone_5_5';
  if (/IPHONE_47/.test(n)) return 'iphone_4_7';
  if (/IPHONE_40/.test(n)) return 'iphone_4';
  if (/IPHONE_35/.test(n)) return 'iphone_3_5';
  if (/IPAD_PRO_(?:13|3GEN_129|129)|IPAD_13/.test(n)) return 'ipad_13';
  if (/IPAD_PRO_3GEN_11|IPAD_11/.test(n)) return 'ipad_11';
  if (/IPAD_105|IPAD_10_5/.test(n)) return 'ipad_10_5';
  if (/IPAD_97|IPAD_9_7/.test(n)) return 'ipad_9_7';
  if (/DESKTOP|\bMAC\b/.test(n)) return 'mac';
  if (/VISION/.test(n)) return 'vision_pro';
  if (/APPLE_TV|APPLETV/.test(n)) return 'apple_tv';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Google Play device types

export type PlayDevice = { id: string; label: string; dir: string };

/** The screenshot folders of `supply` (`metadata/android/<locale>/images/<dir>/`). */
export const PLAY_DEVICES: readonly PlayDevice[] = [
  { id: 'phone', label: 'Phone', dir: 'phoneScreenshots' },
  { id: 'tablet_7', label: '7-inch tablet', dir: 'sevenInchScreenshots' },
  { id: 'tablet_10', label: '10-inch tablet', dir: 'tenInchScreenshots' },
  { id: 'tv', label: 'Android TV', dir: 'tvScreenshots' },
  { id: 'wear', label: 'Wear OS', dir: 'wearScreenshots' },
];

/** The graphics of `supply`: `images/<name>.(png|jpg|jpeg)`. */
export const PLAY_GRAPHIC_FILES: Readonly<Record<string, AssetKind>> = {
  icon: 'icon',
  featureGraphic: 'feature_graphic',
  promoGraphic: 'promo_graphic',
  tvBanner: 'tv_banner',
};

// ---------------------------------------------------------------------------------------------
// Rules

export type AssetSeverity = 'error' | 'warning' | 'info';

export type AssetRule = {
  id: string;
  store: AssetStore;
  /** The rule as it is documented, in words a person can compare with the page. */
  text: string;
  source: string;
  /** False: the number was not found on an official page. Only ever informational. */
  verified: boolean;
};

/** Indexes rules by id (written without Object.fromEntries: the web build targets ES2017). */
function rulesById(rules: AssetRule[]): Record<string, AssetRule> {
  const out: Record<string, AssetRule> = {};
  for (const rule of rules) out[rule.id] = rule;
  return out;
}

const A = SPEC_SOURCES.appleScreenshots;
const G = SPEC_SOURCES.googlePlay;

export const ASSET_RULES: Readonly<Record<string, AssetRule>> = rulesById([
  {
    id: 'apple.screenshot.format',
    store: 'app_store',
    text: 'Screenshots are .jpeg, .jpg or .png files.',
    source: A,
    verified: true,
  },
  {
    id: 'apple.screenshot.alpha',
    store: 'app_store',
    text: "Screenshots can't include alpha channels or transparencies.",
    source: A,
    verified: true,
  },
  {
    id: 'apple.screenshot.size',
    store: 'app_store',
    text: 'A screenshot must have one of the resolutions listed for a display size.',
    source: A,
    verified: true,
  },
  {
    id: 'apple.screenshot.count',
    store: 'app_store',
    text: 'At most 10 screenshots per device size.',
    source: A,
    verified: true,
  },
  {
    id: 'apple.icon.size',
    store: 'app_store',
    text: 'The App Store icon is 1024x1024 px (the layout size of an iOS, iPadOS and macOS icon).',
    source: SPEC_SOURCES.appleIcon,
    verified: true,
  },
  {
    id: 'apple.icon.alpha',
    store: 'app_store',
    text: 'The App Store icon should have no alpha channel. UNVERIFIED: the Apple pages that were read do not state it.',
    source: SPEC_SOURCES.appleIcon,
    verified: false,
  },
  {
    id: 'apple.preview.format',
    store: 'app_store',
    text: 'App previews are .mov, .m4v or .mp4 files (H.264).',
    source: SPEC_SOURCES.applePreviews,
    verified: true,
  },
  {
    id: 'apple.preview.count',
    store: 'app_store',
    text: 'Up to 3 app previews per supported device size and language.',
    source: SPEC_SOURCES.applePreviews,
    verified: true,
  },
  {
    id: 'apple.preview.bytes',
    store: 'app_store',
    text: 'An app preview is at most 500 MB.',
    source: SPEC_SOURCES.applePreviews,
    verified: true,
  },
  {
    id: 'play.icon.format',
    store: 'google_play',
    text: 'The icon is a 32-bit PNG (with alpha).',
    source: G,
    verified: true,
  },
  {
    id: 'play.icon.size',
    store: 'google_play',
    text: 'The icon is 512 x 512 px.',
    source: G,
    verified: true,
  },
  {
    id: 'play.icon.bytes',
    store: 'google_play',
    text: 'The icon is at most 1024 KB.',
    source: G,
    verified: true,
  },
  {
    id: 'play.feature_graphic.format',
    store: 'google_play',
    text: 'The feature graphic is a JPEG or 24-bit PNG (no alpha).',
    source: G,
    verified: true,
  },
  {
    id: 'play.feature_graphic.size',
    store: 'google_play',
    text: 'The feature graphic is 1024 px by 500 px.',
    source: G,
    verified: true,
  },
  {
    id: 'play.tv_banner.format',
    store: 'google_play',
    text: 'The TV banner is a JPEG or 24-bit PNG (no alpha).',
    source: G,
    verified: true,
  },
  {
    id: 'play.tv_banner.size',
    store: 'google_play',
    text: 'The TV banner is 1280 px by 720 px.',
    source: G,
    verified: true,
  },
  {
    id: 'play.tv.pair',
    store: 'google_play',
    text: 'An app for Android TV needs at least one Android TV screenshot, and an Android TV banner.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.format',
    store: 'google_play',
    text: 'Screenshots are JPEG or 24-bit PNG (no alpha).',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.dimension',
    store: 'google_play',
    text: 'Screenshots are 320 px at least and 3840 px at most on each side.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.ratio',
    store: 'google_play',
    text: "The longer side of a screenshot can't be more than twice as long as the shorter side.",
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.count',
    store: 'google_play',
    text: 'You can add up to 8 screenshots for each supported device type.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.minimum',
    store: 'google_play',
    text: 'You must provide a minimum of two screenshots across different device types to publish your store listing.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.phone_promo',
    store: 'google_play',
    text: 'Highly recommended: for apps, at least four screenshots with minimum 1080px resolution.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.large_screen',
    store: 'google_play',
    text: 'Large screens (Chromebook and tablets): a minimum of 4 screenshots between 1,080 and 7,680 px, 16:9 for landscape or 9:16 for portrait.',
    source: G,
    verified: true,
  },
  {
    id: 'play.screenshot.wear',
    store: 'google_play',
    text: 'Wear OS screenshots have a 1:1 aspect ratio and a minimum size of 384 x 384 pixels.',
    source: G,
    verified: true,
  },
  {
    id: 'play.promo_graphic.spec',
    store: 'google_play',
    text: 'The promo graphic is listed only. UNVERIFIED: the Play Console page that was read has no requirement for it (fastlane supply still uploads it).',
    source: SPEC_SOURCES.fastlaneSupply,
    verified: false,
  },
  {
    id: 'inspect.extension',
    store: 'google_play',
    text: 'The file content is not the format its name says.',
    source: SPEC_SOURCES.fastlaneSupply,
    verified: true,
  },
  {
    id: 'inspect.unread',
    store: 'google_play',
    text: 'The file was not opened (too large, over the read budget or unreadable), so its format and size could not be checked.',
    source: SPEC_SOURCES.fastlaneSupply,
    verified: true,
  },
] satisfies AssetRule[]);

export type AssetProblem = {
  /** Stable code of the rule, for example `apple.screenshot.size`. */
  rule: string;
  severity: AssetSeverity;
  /** The documented rule, then what was found. One or two sentences. */
  message: string;
  /** The rule's page. */
  source: string;
  /** False: the rule's number is not on an official page that was read (never an error). */
  verified: boolean;
  /** Set for a problem of one file. */
  path?: string;
  locale?: string;
  kind?: AssetKind;
  device?: string | null;
  /** The store's own set that is over its limit (an App Store placement group), for a count problem of a store read. */
  set?: string | null | undefined;
  /** A count problem: how many the set holds and the most it may hold. */
  count?: number;
  max?: number;
};

// ---------------------------------------------------------------------------------------------
// Facts and checking

export type AssetFacts = {
  path: string;
  store: AssetStore;
  /** `en-US`, or `default` / `''` for an asset that belongs to no locale (an app icon of the project). */
  locale: string;
  kind: AssetKind;
  /** A display id (`iphone_6_9`, `imessage:ipad_13`) or a Play device id (`phone`), null when not known. */
  device: string | null;
  /**
   * The store's own set the file sits in (an App Store placement group such as `APP_IPAD_PRO_3GEN_129`), when the facts come from a store
   * read. Several store sets can show the same display (`ipad_13` is the 13" AND the 12.9" iPad) and Apple's limit is per set, so a set that is
   * named is counted by itself, never summed with its sibling. Absent: the files of one device count together (a repository scan).
   */
  set?: string | null | undefined;
  /** 1-based position among the files of the same locale, kind and device (file name order). */
  order: number;
  bytes: number | null;
  width: number | null;
  height: number | null;
  /** What the content is (sniffed), `video` for a preview, null when it was not read. */
  format: ImageFormat | 'video' | null;
  /** Lower case extension without the dot. */
  extension: string;
  hasAlpha: boolean | null;
  /** Whether the file was opened. */
  read: 'read' | 'not_read' | 'too_large' | 'unreadable';
};

export type AssetSet = {
  locale: string;
  kind: AssetKind;
  device: string | null;
  /** The store's own set (see `AssetFacts.set`), null when the files are counted by device. */
  set: string | null;
  deviceLabel: string;
  count: number;
  /** The most a set may hold, or null when there is no limit. */
  max: number | null;
  rule: string | null;
};

const KB = 1024;
const MB = 1024 * 1024;
/** Play: "at most 1024 KB". */
export const PLAY_ICON_MAX_BYTES = 1024 * KB;
/** Apple: "Maximum: 500 MB". */
export const APPLE_PREVIEW_MAX_BYTES = 500 * MB;

const rule = (id: string): AssetRule => ASSET_RULES[id] as AssetRule;

const countKey = (a: Pick<AssetFacts, 'locale' | 'kind' | 'device' | 'set'>) =>
  `${a.locale}\u0000${a.kind}\u0000${a.device ?? ''}\u0000${a.set ?? ''}`;

const maxFor = (store: AssetStore, kind: AssetKind): { max: number; rule: string } | null => {
  if (store === 'app_store') {
    if (kind === 'screenshot') return { max: 10, rule: 'apple.screenshot.count' };
    if (kind === 'preview') return { max: 3, rule: 'apple.preview.count' };
    return null;
  }
  if (kind === 'screenshot') return { max: 8, rule: 'play.screenshot.count' };
  return null;
};

/** Counts per locale, kind and device, with the limit of each set. Sorted. */
export function summarizeAssets(store: AssetStore, assets: readonly AssetFacts[]): AssetSet[] {
  const sets = new Map<string, AssetSet>();
  for (const a of assets) {
    if (a.store !== store) continue;
    const key = countKey(a);
    let set = sets.get(key);
    if (!set) {
      const limit = maxFor(store, a.kind);
      set = {
        locale: a.locale,
        kind: a.kind,
        device: a.device,
        set: a.set ?? null,
        deviceLabel: deviceLabel(store, a.device),
        count: 0,
        max: limit?.max ?? null,
        rule: limit?.rule ?? null,
      };
      sets.set(key, set);
    }
    set.count += 1;
  }
  return [...sets.values()].sort(
    (x, y) =>
      x.locale.localeCompare(y.locale) ||
      ASSET_KINDS.indexOf(x.kind) - ASSET_KINDS.indexOf(y.kind) ||
      (x.device ?? '').localeCompare(y.device ?? '') ||
      (x.set ?? '').localeCompare(y.set ?? ''),
  );
}

const sizeText = (a: AssetFacts) =>
  a.width !== null && a.height !== null ? `${a.width}x${a.height}` : 'unknown size';

function problem(
  ruleId: string,
  severity: AssetSeverity,
  found: string,
  where: Partial<Pick<AssetFacts, 'path' | 'locale' | 'kind' | 'device' | 'set'>> & {
    count?: number;
    max?: number;
  } = {},
): AssetProblem {
  const r = rule(ruleId);
  return {
    rule: ruleId,
    // A rule that is not verified is never more than information.
    severity: r.verified ? severity : 'info',
    message: `${r.text} ${found}`.trim(),
    source: r.source,
    verified: r.verified,
    ...where,
  };
}

const imageExtension = (e: string) => e === 'png' || e === 'jpg' || e === 'jpeg';

const whereOf = (a: AssetFacts) => ({
  path: a.path,
  locale: a.locale,
  kind: a.kind,
  device: a.device,
});

function checkFile(a: AssetFacts, out: AssetProblem[]): void {
  const w = whereOf(a);
  // A preview is never opened (video): its name and size are all there is to check.
  if (a.read !== 'read' && a.kind !== 'preview') {
    out.push(problem('inspect.unread', 'info', `(${a.read.replace('_', ' ')}).`, w));
    return;
  }
  // The name says one format and the content is another.
  if (a.format !== null && a.format !== 'video') {
    const named = a.extension === 'jpg' ? 'jpeg' : a.extension;
    if (named !== a.format)
      out.push(
        problem(
          'inspect.extension',
          'warning',
          `${a.path.split('/').pop()} is a ${a.format.toUpperCase()}.`,
          w,
        ),
      );
  }
  if (a.store === 'app_store') checkApple(a, out, w);
  else checkPlay(a, out, w);
}

function checkApple(a: AssetFacts, out: AssetProblem[], w: ReturnType<typeof whereOf>): void {
  if (a.kind === 'preview') {
    if (!['mov', 'm4v', 'mp4'].includes(a.extension)) {
      out.push(
        problem(
          'apple.preview.format',
          'error',
          `${a.path.split('/').pop()} is .${a.extension}.`,
          w,
        ),
      );
    }
    if (a.bytes !== null && a.bytes > APPLE_PREVIEW_MAX_BYTES) {
      out.push(problem('apple.preview.bytes', 'error', `It is ${Math.round(a.bytes / MB)} MB.`, w));
    }
    return;
  }
  if (a.kind === 'screenshot') {
    if (
      !imageExtension(a.extension) ||
      (a.format !== null && a.format !== 'png' && a.format !== 'jpeg')
    ) {
      out.push(
        problem(
          'apple.screenshot.format',
          'error',
          `It is ${a.format ? a.format.toUpperCase() : `.${a.extension}`}.`,
          w,
        ),
      );
    }
    if (a.hasAlpha === true)
      out.push(
        problem('apple.screenshot.alpha', 'error', 'It has an alpha channel or transparency.', w),
      );
    if (a.width !== null && a.height !== null && a.device === null) {
      out.push(problem('apple.screenshot.size', 'error', `${sizeText(a)} is not one of them.`, w));
    }
    // A file put in a display's set (staged by hand, uploaded) must have one of that display's sizes. A file of the
    // repository is classified by its size, so it always does.
    if (a.width !== null && a.height !== null && a.device !== null) {
      const id = a.device.startsWith(IMESSAGE_PREFIX)
        ? a.device.slice(IMESSAGE_PREFIX.length)
        : a.device;
      const display = APPLE_DISPLAYS.find((d) => d.id === id);
      if (
        display &&
        !display.sizes.some(([width, height]) => width === a.width && height === a.height)
      ) {
        out.push(
          problem(
            'apple.screenshot.size',
            'error',
            `${sizeText(a)} is not a size of the ${display.label} display.`,
            w,
          ),
        );
      }
    }
    return;
  }
  if (a.kind === 'app_icon') {
    if (a.width !== null && a.height !== null && (a.width !== 1024 || a.height !== 1024)) {
      out.push(problem('apple.icon.size', 'error', `It is ${sizeText(a)}.`, w));
    }
    if (a.hasAlpha === true)
      out.push(problem('apple.icon.alpha', 'warning', 'It has an alpha channel.', w));
  }
}

const within = (n: number, min: number, max: number) => n >= min && n <= max;

function checkPlay(a: AssetFacts, out: AssetProblem[], w: ReturnType<typeof whereOf>): void {
  const known = a.width !== null && a.height !== null;
  const jpegOrPng = a.format === null || a.format === 'png' || a.format === 'jpeg';
  switch (a.kind) {
    case 'icon':
      if (a.format !== null && a.format !== 'png')
        out.push(
          problem('play.icon.format', 'error', `It is ${String(a.format).toUpperCase()}.`, w),
        );
      if (known && (a.width !== 512 || a.height !== 512))
        out.push(problem('play.icon.size', 'error', `It is ${sizeText(a)}.`, w));
      if (a.bytes !== null && a.bytes > PLAY_ICON_MAX_BYTES)
        out.push(problem('play.icon.bytes', 'error', `It is ${Math.round(a.bytes / KB)} KB.`, w));
      return;
    case 'feature_graphic':
      if (!jpegOrPng)
        out.push(
          problem(
            'play.feature_graphic.format',
            'error',
            `It is ${String(a.format).toUpperCase()}.`,
            w,
          ),
        );
      if (a.hasAlpha === true)
        out.push(problem('play.feature_graphic.format', 'error', 'It has an alpha channel.', w));
      if (known && (a.width !== 1024 || a.height !== 500))
        out.push(problem('play.feature_graphic.size', 'error', `It is ${sizeText(a)}.`, w));
      return;
    case 'tv_banner':
      if (!jpegOrPng)
        out.push(
          problem('play.tv_banner.format', 'error', `It is ${String(a.format).toUpperCase()}.`, w),
        );
      if (a.hasAlpha === true)
        out.push(problem('play.tv_banner.format', 'error', 'It has an alpha channel.', w));
      if (known && (a.width !== 1280 || a.height !== 720))
        out.push(problem('play.tv_banner.size', 'error', `It is ${sizeText(a)}.`, w));
      return;
    case 'promo_graphic':
      out.push(problem('play.promo_graphic.spec', 'info', 'It is not checked.', w));
      return;
    case 'screenshot': {
      if (!jpegOrPng)
        out.push(
          problem('play.screenshot.format', 'error', `It is ${String(a.format).toUpperCase()}.`, w),
        );
      if (a.hasAlpha === true)
        out.push(problem('play.screenshot.format', 'error', 'It has an alpha channel.', w));
      if (!known) return;
      const width = a.width as number;
      const height = a.height as number;
      const short = Math.min(width, height);
      const long = Math.max(width, height);
      if (short < 320 || long > 3840)
        out.push(problem('play.screenshot.dimension', 'error', `It is ${sizeText(a)}.`, w));
      else if (long > short * 2)
        out.push(problem('play.screenshot.ratio', 'error', `It is ${sizeText(a)}.`, w));
      if (a.device === 'wear' && (width !== height || short < 384)) {
        out.push(problem('play.screenshot.wear', 'warning', `It is ${sizeText(a)}.`, w));
      }
      return;
    }
    default:
  }
}

/** True when the sides are 16:9 or 9:16 (within one percent). */
const isSixteenNine = (w: number, h: number) =>
  Math.abs(Math.max(w, h) / Math.min(w, h) - 16 / 9) < 0.016 * (16 / 9);

function checkSets(store: AssetStore, assets: readonly AssetFacts[], out: AssetProblem[]): void {
  for (const set of summarizeAssets(store, assets)) {
    if (set.max !== null && set.rule !== null && set.count > set.max) {
      out.push(
        problem(
          set.rule,
          'error',
          // The set is named when the store has several for one display: `en-US iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): 12 found.`
          `${[set.locale, describeDevice(store, set.kind, set.device)].filter(Boolean).join(' ')}${set.set !== null ? ` (${set.set})` : ''}: ${set.count} found.`,
          {
            locale: set.locale,
            kind: set.kind,
            device: set.device,
            set: set.set,
            count: set.count,
            max: set.max,
          },
        ),
      );
    }
  }
  if (store !== 'google_play') return;
  const locales = [...new Set(assets.filter((a) => a.store === store).map((a) => a.locale))].sort();
  for (const locale of locales) {
    const mine = assets.filter((a) => a.store === store && a.locale === locale);
    const shots = mine.filter((a) => a.kind === 'screenshot');
    if (shots.length > 0 && shots.length < 2) {
      out.push(
        problem('play.screenshot.minimum', 'warning', `${locale} has ${shots.length}.`, {
          locale,
          kind: 'screenshot',
        }),
      );
    }
    const phone = shots.filter((a) => a.device === 'phone');
    if (phone.length > 0) {
      const small = phone.some(
        (a) => a.width !== null && a.height !== null && Math.min(a.width, a.height) < 1080,
      );
      if (phone.length < 4 || small) {
        out.push(
          problem(
            'play.screenshot.phone_promo',
            'info',
            `${locale} has ${phone.length} phone screenshots${small ? ', some under 1080 px' : ''}.`,
            { locale, kind: 'screenshot', device: 'phone' },
          ),
        );
      }
    }
    for (const device of ['tablet_7', 'tablet_10']) {
      const tablet = shots.filter((a) => a.device === device);
      if (tablet.length === 0) continue;
      const off = tablet.some(
        (a) =>
          a.width !== null &&
          a.height !== null &&
          (!within(a.width, 1080, 7680) ||
            !within(a.height, 1080, 7680) ||
            !isSixteenNine(a.width, a.height)),
      );
      if (tablet.length < 4 || off) {
        out.push(
          problem(
            'play.screenshot.large_screen',
            'info',
            `${locale} ${describeDevice(store, 'screenshot', device)}: ${tablet.length} found${off ? ', some outside the sizes' : ''}.`,
            { locale, kind: 'screenshot', device },
          ),
        );
      }
    }
    const tvShots = shots.filter((a) => a.device === 'tv').length;
    const banner = mine.filter((a) => a.kind === 'tv_banner').length;
    if (tvShots > 0 !== banner > 0) {
      out.push(
        problem(
          'play.tv.pair',
          'warning',
          `${locale} has ${tvShots} TV screenshots and ${banner} banners.`,
          { locale },
        ),
      );
    }
  }
}

const SEVERITY_ORDER: Readonly<Record<AssetSeverity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * Holds the assets of one store against the documented specs. Pure and total: facts that are
 * unknown (an unread file) are never an error. Sorted: errors first, then by path.
 */
export function validateAssets(store: AssetStore, assets: readonly AssetFacts[]): AssetProblem[] {
  const out: AssetProblem[] = [];
  const mine = assets.filter((a) => a.store === store);
  for (const a of mine) checkFile(a, out);
  checkSets(store, mine, out);
  return out.sort(
    (x, y) =>
      SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] ||
      (x.path ?? '').localeCompare(y.path ?? '') ||
      x.rule.localeCompare(y.rule),
  );
}
