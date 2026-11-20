import type { IconName } from './icons.ts';

/**
 * Which store, platform or tool something is, as a name, a label and an icon. Pure: the badge
 * components and the screens ask here instead of repeating strings. The icons are generic marks
 * (see icons.ts); the labels are the services' own names, used only to identify them.
 */

export type StoreId =
  | 'app_store'
  | 'mac_app_store'
  | 'google_play'
  | 'testflight'
  | 'github'
  | 'expo'
  | 'fastlane'
  | 'git'
  | 'generic';

export type StoreTint = 'info' | 'ok' | 'neutral';

export type StoreInfo = {
  store: StoreId;
  /** The short name, as in a chip: "App Store". */
  label: string;
  /** The console or service behind it, as in a connector: "App Store Connect". */
  fullLabel: string;
  icon: IconName;
  /**
   * The one restrained accent of the store when a tinted badge is asked for. These are the
   * existing status tints (info, ok), never a new color. The glyph and the name carry the meaning.
   */
  tint: StoreTint;
};

export const storeInfo: Record<StoreId, StoreInfo> = {
  app_store: {
    store: 'app_store',
    label: 'App Store',
    fullLabel: 'App Store Connect',
    icon: 'store-ios',
    tint: 'info',
  },
  mac_app_store: {
    store: 'mac_app_store',
    label: 'Mac App Store',
    fullLabel: 'App Store Connect',
    icon: 'store-ios',
    tint: 'info',
  },
  google_play: {
    store: 'google_play',
    label: 'Google Play',
    fullLabel: 'Google Play Console',
    icon: 'store-android',
    tint: 'ok',
  },
  testflight: {
    store: 'testflight',
    label: 'TestFlight',
    fullLabel: 'TestFlight',
    icon: 'send',
    tint: 'info',
  },
  github: { store: 'github', label: 'GitHub', fullLabel: 'GitHub', icon: 'repo', tint: 'neutral' },
  expo: { store: 'expo', label: 'Expo', fullLabel: 'Expo', icon: 'code', tint: 'neutral' },
  fastlane: {
    store: 'fastlane',
    label: 'Fastlane',
    fullLabel: 'Fastlane',
    icon: 'pipeline',
    tint: 'neutral',
  },
  git: {
    store: 'git',
    label: 'Git host',
    fullLabel: 'Git host',
    icon: 'git-branch',
    tint: 'neutral',
  },
  generic: { store: 'generic', label: 'Store', fullLabel: 'Store', icon: 'store', tint: 'neutral' },
};

export const storeIds = Object.keys(storeInfo) as StoreId[];

export const isStoreId = (value: unknown): value is StoreId =>
  typeof value === 'string' && Object.hasOwn(storeInfo, value);

/** A store by id. An unknown id is the neutral generic store, never an error. */
export function storeById(id: string | null | undefined): StoreInfo {
  return isStoreId(id) ? storeInfo[id] : storeInfo.generic;
}

/** The store behind a credential or connector kind: `app_store_connect`, `google_play`, `github_app`, `github_token`. */
export function storeForCredentialKind(kind: string | null | undefined): StoreInfo {
  switch (kind) {
    case 'app_store_connect':
      return storeInfo.app_store;
    case 'google_play':
      return storeInfo.google_play;
    case 'github_app':
    case 'github_token':
      return storeInfo.github;
    default:
      return storeInfo.generic;
  }
}

/** The store an app is published in, from its platform. */
export function storeForPlatform(platform: string | null | undefined): StoreInfo {
  const p = (platform ?? '').toLowerCase();
  if (p === 'ios') return storeInfo.app_store;
  if (p === 'macos') return storeInfo.mac_app_store;
  if (p === 'android') return storeInfo.google_play;
  return storeInfo.generic;
}

/** A repository host such as `github.com`. Any other host is the neutral Git host. */
export function storeForRepositoryHost(host: string | null | undefined): StoreInfo {
  const h = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (h === '') return storeInfo.git;
  return h === 'github.com' || h.endsWith('.github.com') ? storeInfo.github : storeInfo.git;
}

/** The tool of a repository project type: `fastlane` or `expo`. Anything else is the neutral generic store. */
export function storeForProjectKind(kind: string | null | undefined): StoreInfo {
  if (kind === 'fastlane') return storeInfo.fastlane;
  if (kind === 'expo') return storeInfo.expo;
  return storeInfo.generic;
}

// ---------------------------------------------------------------------------------------------
// Platforms

export type PlatformId = 'ios' | 'macos' | 'android' | 'unknown';

/** The tint of a platform: its own hue (see the `--platform-*` tokens), `neutral` for an unknown one. */
export type PlatformTint = 'ios' | 'macos' | 'android' | 'neutral';

export type PlatformInfo = {
  platform: PlatformId;
  label: string;
  icon: IconName;
  tint: PlatformTint;
};

export const platformInfo: Record<PlatformId, PlatformInfo> = {
  ios: { platform: 'ios', label: 'iOS', icon: 'platform-ios', tint: 'ios' },
  macos: { platform: 'macos', label: 'macOS', icon: 'platform-macos', tint: 'macos' },
  android: { platform: 'android', label: 'Android', icon: 'platform-android', tint: 'android' },
  unknown: { platform: 'unknown', label: 'Unknown platform', icon: 'smartphone', tint: 'neutral' },
};

/** A platform string (`ios`, `android`, any case). Anything else is the neutral smartphone. */
export function platformById(platform: string | null | undefined): PlatformInfo {
  const p = (platform ?? '').toLowerCase();
  return p === 'ios'
    ? platformInfo.ios
    : p === 'macos'
      ? platformInfo.macos
      : p === 'android'
        ? platformInfo.android
        : platformInfo.unknown;
}

// ---------------------------------------------------------------------------------------------
// Badge text and accessible names

export type BadgeVariant = 'icon' | 'chip' | 'full';

export type BadgeText = {
  /** The text drawn beside the icon; empty for the icon-only variant. */
  visible: string;
  /** The name assistive technology hears. Never empty. */
  name: string;
  /** True when the icon needs its own title because no text names it. */
  iconNeedsTitle: boolean;
};

/** What a store badge shows and says in each variant. The name is always present, so color is never the only signal. */
export function storeBadgeText(info: StoreInfo, variant: BadgeVariant): BadgeText {
  if (variant === 'icon') return { visible: '', name: info.fullLabel, iconNeedsTitle: true };
  const visible = variant === 'full' ? info.fullLabel : info.label;
  return { visible, name: visible, iconNeedsTitle: false };
}

/** The same for a platform badge: the label is shown unless `showLabel` is false. */
export function platformBadgeText(info: PlatformInfo, showLabel: boolean): BadgeText {
  return { visible: showLabel ? info.label : '', name: info.label, iconNeedsTitle: false };
}
