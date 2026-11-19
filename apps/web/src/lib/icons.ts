/**
 * The icon registry: every icon the UI can draw, as data. Icon.svelte picks one entry.
 *
 * Rules (checked by icons.test.ts and scripts/check-icons.ts):
 * - 24 x 24 viewBox. Names are kebab-case and unique.
 * - `body` is the inner markup of the <svg>: only <path d>, <circle> and <rect>, hand-authored.
 * - `stroke` icons are drawn with a 2px round stroke in `currentColor` and keep their geometry
 *   inside 1..23 so the stroke is never clipped. `fill` icons are solid, closed shapes inside 0..24.
 * - Nothing here is copied from a third-party icon set. The store and tool entries are GENERIC
 *   marks, not company logos (see `genericBrandIcons` and THIRD_PARTY_NOTICES.md).
 */

export type IconStyle = 'stroke' | 'fill';
export type IconDef = { style: IconStyle; body: string };

const stroke = (body: string): IconDef => ({ style: 'stroke', body });
const fill = (body: string): IconDef => ({ style: 'fill', body });

export const icons = {
  // ---- Status and feedback
  check: stroke('<path d="M5 12.5 9.5 17 19 7.5"/>'),
  x: stroke('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: stroke('<path d="M12 5v14M5 12h14"/>'),
  minus: stroke('<path d="M5 12h14"/>'),
  alert: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>'),
  'alert-triangle': stroke(
    '<path d="M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  ),
  info: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  'check-circle': stroke('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  'x-circle': stroke('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  help: stroke(
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
  ),
  // ---- Actions
  'external-link': stroke(
    '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  ),
  copy: stroke(
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  ),
  link: stroke(
    '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  ),
  download: stroke('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>'),
  upload: stroke('<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 20h14"/>'),
  refresh: stroke(
    '<path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5"/>',
  ),
  search: stroke('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  filter: stroke('<path d="M4 5h16l-6.2 7.5V19l-3.6 1.5v-8L4 5Z"/>'),
  sort: stroke('<path d="M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4M12.5 16.5 16 20l3.5-3.5"/>'),
  edit: stroke('<path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1ZM14 7l3 3"/>'),
  trash: stroke(
    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  ),
  eye: stroke(
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  ),
  'eye-off': stroke(
    '<path d="M3 3l18 18M10.6 5.6a9 9 0 0 1 1.4-.1c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ),
  more: stroke('<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>'),
  menu: stroke('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  'log-out': stroke('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>'),
  // ---- Arrows
  'chevron-down': stroke('<path d="m6 9 6 6 6-6"/>'),
  'chevron-up': stroke('<path d="m6 15 6-6 6 6"/>'),
  'chevron-left': stroke('<path d="m15 6-6 6 6 6"/>'),
  'chevron-right': stroke('<path d="m9 6 6 6-6 6"/>'),
  'arrow-up': stroke('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  'arrow-down': stroke('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  'arrow-left': stroke('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  'arrow-right': stroke('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  // ---- People, access and security
  user: stroke('<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6"/>'),
  users: stroke(
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c2 .7 3 2.4 3 5.2"/>',
  ),
  key: stroke('<circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 10-10M16 7l3 3M13 10l2 2"/>'),
  shield: stroke('<path d="m12 3 8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3Z"/>'),
  lock: stroke(
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ),
  unlock: stroke(
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  ),
  settings: stroke(
    '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>',
  ),
  bell: stroke('<path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15L6 17ZM10 21h4"/>'),
  mail: stroke('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>'),
  // ---- Time and activity
  clock: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: stroke(
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  ),
  history: stroke('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 4v4.5H8M12 8v4.5l3 1.5"/>'),
  activity: stroke('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  'trending-up': stroke('<path d="m3 17 6-6 4 4 8-8M15 7h6v6"/>'),
  zap: stroke('<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/>'),
  sparkles: stroke(
    '<path d="M10.5 3.5c.7 4.6 2 5.9 6.5 6.5-4.5.6-5.8 1.9-6.5 6.5-.7-4.6-2-5.9-6.5-6.5 4.5-.6 5.8-1.9 6.5-6.5Z"/><path d="M18 15c.3 2 .9 2.7 3 3-2.1.3-2.7 1-3 3-.3-2-.9-2.7-3-3 2.1-.3 2.7-1 3-3Z"/>',
  ),
  // ---- Marks and flags
  star: stroke(
    '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
  ),
  'star-filled': fill(
    '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
  ),
  flag: stroke('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  tag: stroke('<path d="M3 12V4h8l9 9-8 8-9-9ZM7.5 8.5h.01"/>'),
  hash: stroke('<path d="M5 9h15M4 15h15M10 4 8 20M16 4l-2 16"/>'),
  percent: stroke(
    '<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  ),
  rocket: stroke(
    '<path d="M12 3c3 2 5 5.5 5 9.5l-2 3H9l-2-3C7 8.5 9 5 12 3Z"/><circle cx="12" cy="10" r="1.5"/><path d="M9 16l-2 4 3-1M15 16l2 4-3-1"/>',
  ),
  // ---- Source control and files
  'git-branch': stroke(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10a6 6 0 0 1-6 6H6"/>',
  ),
  'git-commit': stroke('<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>'),
  'git-merge': stroke(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="15" r="2"/><path d="M6 7v10M6 9c0 4 3 6 10 6"/>',
  ),
  'git-pull-request': stroke(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17v-7a3 3 0 0 0-3-3h-3M15 4l-3 3 3 3"/>',
  ),
  folder: stroke(
    '<path d="M3.5 7a2 2 0 0 1 2-2H10l2 2.5h6.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z"/>',
  ),
  file: stroke('<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5"/>'),
  'file-text': stroke(
    '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v5h5M9 13h6M9 17h6"/>',
  ),
  image: stroke(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m20.5 16-4.5-4.5-8.5 8"/>',
  ),
  images: stroke(
    '<rect x="7" y="7" width="14" height="13" rx="2"/><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2M21 17l-4-4-6 6"/>',
  ),
  code: stroke('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  terminal: stroke(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  ),
  bug: stroke(
    '<path d="M9 8V6.5a3 3 0 0 1 6 0V8M7 8h10v6a5 5 0 0 1-10 0V8ZM12 11v8M7 12H3.5M17 12h3.5M7 17l-3 2M17 17l3 2M7 9 4 7M17 9l3-2"/>',
  ),
  // ---- Structure and layout
  box: stroke('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  archive: stroke(
    '<rect x="3.5" y="8" width="17" height="12" rx="1.5"/><path d="M3.5 8 6 4h12l2.5 4M10 12h4"/>',
  ),
  layers: stroke('<path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5"/>'),
  list: stroke('<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>'),
  grid: stroke(
    '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  ),
  columns: stroke('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>'),
  inbox: stroke(
    '<path d="M3.5 13 6 5h12l2.5 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5ZM3.5 13H9a3 3 0 0 0 6 0h5.5"/>',
  ),
  message: stroke(
    '<path d="M4 5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-7l-5 4v-4H6a2 2 0 0 1-2-2V5.5Z"/>',
  ),
  globe: stroke(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  ),
  language: stroke(
    '<path d="M4 5h9M8.5 3v2M6 5c.5 4 3 7 6.5 8.5M12 5c-.5 4-3 7-7 9M13 21l4.5-10L22 21M14.8 17.5h5.4"/>',
  ),
  network: stroke(
    '<circle cx="12" cy="6.5" r="2.5"/><circle cx="6" cy="17.5" r="2.5"/><circle cx="18" cy="17.5" r="2.5"/><path d="M10.7 8.7 7.3 15.3M13.3 8.7l3.4 6.6M8.5 17.5h7"/>',
  ),
  database: stroke(
    '<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  ),
  server: stroke(
    '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
  ),
  qr: stroke(
    '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20h.01M17 20h3v-3"/>',
  ),
  // ---- Devices and media
  smartphone: stroke('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>'),
  tablet: stroke('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>'),
  laptop: stroke('<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19"/>'),
  monitor: stroke('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  camera: stroke(
    '<path d="M4 8a2 2 0 0 1 2-2h1.5L9 4h6l1.5 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><circle cx="12" cy="12.5" r="3.5"/>',
  ),
  play: stroke('<path d="M7 5v14l12-7L7 5Z"/>'),
  pause: stroke(
    '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  ),
  stop: stroke('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  send: stroke('<path d="M21 3 3 10.5l7 3 3 7L21 3ZM10 13.5 21 3"/>'),
  sun: stroke(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  ),
  moon: stroke('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>'),
  // ---- Stores, platforms and tools. GENERIC marks, not company logos (see genericBrandIcons).
  store: stroke(
    '<path d="M4 9.5 5.5 4h13L20 9.5M4 9.5c0 1.4 1.1 2.5 2.5 2.5S9 10.9 9 9.5M9 9.5c0 1.4 1.3 2.5 3 2.5s3-1.1 3-2.5M15 9.5c0 1.4 1.1 2.5 2.5 2.5S20 10.9 20 9.5M5.5 12v8h13v-8M10 20v-4h4v4"/>',
  ),
  'store-ios': stroke('<path d="M5.5 8h13l1 12h-15l1-12ZM9 11V7.5a3 3 0 0 1 6 0V11"/>'),
  'store-android': stroke(
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M10 8v8l6-4-6-4Z"/>',
  ),
  'platform-ios': stroke(
    '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10 5.5h4M10.5 18.5h3"/>',
  ),
  'platform-android': stroke(
    '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M12 5.5h.01M9 18.5h6"/>',
  ),
  'platform-macos': stroke(
    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M3 12.5h18M9 20h6M12 16v4"/>',
  ),
  repo: stroke(
    '<path d="M5 19.5V5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2ZM5 19.5A2 2 0 0 0 7 21.5h12V17M9 7h6"/>',
  ),
  pipeline: stroke('<path d="M3 12h6l4-6h8M9 12h12M9 12l4 6h8"/>'),
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof icons;

export const iconNames = Object.keys(icons) as IconName[];

export function isIconName(value: string | undefined | null): value is IconName {
  return typeof value === 'string' && Object.hasOwn(icons, value);
}

/** The definition of an icon, or the neutral `help` glyph for a name this build does not know. */
export function iconDef(name: string | undefined | null): IconDef {
  return isIconName(name) ? icons[name] : icons.help;
}

// ---------------------------------------------------------------------------------------------
// Sizes

export const iconSizes = { sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof iconSizes | number;

/** A named size or a pixel number as pixels. Anything unusable falls back to the medium size. */
export function iconPixels(size: IconSize | undefined): number {
  if (typeof size === 'number') return Number.isFinite(size) && size > 0 ? size : iconSizes.md;
  return size ? (iconSizes[size] ?? iconSizes.md) : iconSizes.md;
}

// ---------------------------------------------------------------------------------------------
// Generic marks that stand in for a company's logo

/**
 * These icons name a store, platform or tool, but they are plain geometric glyphs drawn for this
 * project. They are NOT the companies' logos and reproduce none of them. The product names and
 * logos belong to their owners; the UI names them only to identify the service. Each entry must be
 * listed in THIRD_PARTY_NOTICES.md (icons.test.ts checks it).
 */
export const genericBrandIcons: Record<string, string> = {
  store: 'any store or marketplace (neutral fallback)',
  'store-ios': 'Apple App Store and App Store Connect',
  'store-android': 'Google Play and Google Play Console',
  'platform-ios': 'iOS',
  'platform-android': 'Android',
  'platform-macos': 'macOS',
  send: 'TestFlight',
  repo: 'GitHub',
  code: 'Expo',
  pipeline: 'Fastlane',
};
