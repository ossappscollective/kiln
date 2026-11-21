/**
 * Solid color tokens for both themes. `styles/theme.css` mirrors these hex values exactly (a test enforces it)
 * and `contrast.test.ts` checks the text and graphic pairs below against WCAG 2.2 AA.
 * Edit a color here and in `styles/theme.css` together. Everything else of the look (translucent borders, shadows,
 * glows, gradients, radii, spacing, type) lives in `styles/theme.css` only because it is not a solid color.
 */

export const themeNames = ['light', 'dark'] as const;
export type ThemeName = (typeof themeNames)[number];

const light = {
  // Surfaces: the page, the sidebar, then cards and the raised, sunken (a segmented-control track, a code block) and pressed layers.
  ground: '#f5f6fd',
  sidebar: '#ffffff',
  surface: '#ffffff',
  'surface-sunken': '#eceefb',
  'surface-hover': '#f7f8ff',
  'surface-active': '#e2e5f8',
  // Text.
  ink: '#14173a',
  muted: '#545a8c',
  faint: '#5f6596',
  // The accent: links, focus and selected tints. `chip-ink` is the text on `accent-bg`; `focus` is the ring.
  accent: '#4552d9',
  'accent-hover': '#3640b8',
  'accent-ink': '#ffffff',
  'accent-bg': '#eff0fd',
  'chip-ink': '#3a45b8',
  focus: '#6d4bdc',
  // The primary button gradient runs from `primary-from` to `primary-to` (the text on it is `accent-ink`); `title-end` is where the page-title gradient ends.
  'primary-from': '#4552d9',
  'primary-to': '#6a4fe0',
  'title-end': '#5b3fd0',
  // Semantic: a tint for backgrounds, ink for text on it, a solid for dots and icons, a border.
  'ok-bg': '#e3f5ee',
  'ok-ink': '#0b6e4f',
  ok: '#0b7a57',
  'ok-line': '#b5e3d0',
  // Danger, with the solid destructive button.
  'bad-bg': '#fdecea',
  'bad-ink': '#9b1c14',
  bad: '#d92d20',
  'bad-line': '#f7c1bb',
  'danger-solid': '#c8281c',
  'danger-solid-hover': '#a81f15',
  'danger-solid-ink': '#ffffff',
  // Warning.
  'warn-bg': '#fdf3da',
  'warn-ink': '#8a5200',
  warn: '#b45309',
  'warn-line': '#f1d58a',
  // Info.
  'info-bg': '#e8f1fd',
  'info-ink': '#164a8a',
  info: '#2f6fd0',
  'info-line': '#bcd5f5',
  // Platform tints (iOS sky, macOS violet, Android lime): the glyph and the name still say which.
  'platform-ios-bg': '#e1f1fc',
  'platform-ios-ink': '#0b4f80',
  'platform-ios-line': '#b3d6ee',
  'platform-macos-bg': '#efe9fb',
  'platform-macos-ink': '#4a2f94',
  'platform-macos-line': '#d0c3f0',
  'platform-android-bg': '#e4f5dc',
  'platform-android-ink': '#2f5d10',
  'platform-android-line': '#c0e0ae',
  // Chart marks: series 1 and 2, and the middle and end of the single-series line gradient.
  'viz-1': '#4552d9',
  'viz-2': '#c96a00',
  'viz-mid': '#7a54e6',
  'viz-end': '#c96a00',
  // Loading placeholders.
  'skeleton-from': '#eceefb',
  'skeleton-to': '#f5f6fd',
} as const;

const dark: Record<keyof typeof light, string> = {
  // Surfaces: the page, the sidebar, then cards and the raised, sunken (a segmented-control track, a code block) and pressed layers.
  ground: '#0b0d22',
  sidebar: '#0d1029',
  surface: '#141838',
  'surface-sunken': '#0e1130',
  'surface-hover': '#181d45',
  'surface-active': '#232a63',
  // Text.
  ink: '#eceeff',
  muted: '#a3a9d6',
  faint: '#8f96c9',
  // The accent: links, focus and selected tints. `chip-ink` is the text on `accent-bg`; `focus` is the ring.
  accent: '#7f99ff',
  'accent-hover': '#9bb0ff',
  'accent-ink': '#0b0d22',
  'accent-bg': '#232a54',
  'chip-ink': '#b9c6ff',
  focus: '#a98bff',
  // The primary button gradient runs from `primary-from` to `primary-to` (the text on it is `accent-ink`); `title-end` is where the page-title gradient ends.
  'primary-from': '#7f99ff',
  'primary-to': '#a98bff',
  'title-end': '#a98bff',
  // Semantic: a tint for backgrounds, ink for text on it, a solid for dots and icons, a border.
  'ok-bg': '#1e3449',
  'ok-ink': '#5ee0b0',
  ok: '#5ee0b0',
  'ok-line': '#2a545c',
  // Danger, with the solid destructive button.
  'bad-bg': '#352644',
  'bad-ink': '#ff9aa6',
  bad: '#ff7a8a',
  'bad-line': '#5a3551',
  'danger-solid': '#ff6b7d',
  'danger-solid-hover': '#ff8e9b',
  'danger-solid-ink': '#1c0610',
  // Warning.
  'warn-bg': '#352d3a',
  'warn-ink': '#ffb04a',
  warn: '#ffb04a',
  'warn-line': '#5a463d',
  // Info.
  'info-bg': '#1f3252',
  'info-ink': '#8fe0f7',
  info: '#5fd0f0',
  'info-line': '#2a4f6f',
  // Platform tints (iOS sky, macOS violet, Android lime): the glyph and the name still say which.
  'platform-ios-bg': '#0f2b40',
  'platform-ios-ink': '#9fd2f5',
  'platform-ios-line': '#1d4a6c',
  'platform-macos-bg': '#261c47',
  'platform-macos-ink': '#cbb9f7',
  'platform-macos-line': '#43347a',
  'platform-android-bg': '#1f3112',
  'platform-android-ink': '#b5e08f',
  'platform-android-line': '#35521f',
  // Chart marks: series 1 and 2, and the middle and end of the single-series line gradient.
  'viz-1': '#7f99ff',
  'viz-2': '#ffb04a',
  'viz-mid': '#a98bff',
  'viz-end': '#ffb04a',
  // Loading placeholders.
  'skeleton-from': '#181d45',
  'skeleton-to': '#232a63',
};

export type TokenName = keyof typeof light;
export const palette: Record<ThemeName, Record<TokenName, string>> = { light, dark };

/** Text pairs that must reach WCAG AA (4.5:1), or the stated minimum. [foreground, background, minimum] */
export const textPairs: ReadonlyArray<readonly [TokenName, TokenName, number]> = [
  ['ink', 'surface', 7],
  ['ink', 'ground', 7],
  ['ink', 'sidebar', 7],
  ['ink', 'surface-sunken', 7],
  ['ink', 'surface-hover', 7],
  ['ink', 'surface-active', 7],
  ['ink', 'accent-bg', 7],
  ['muted', 'surface', 4.5],
  ['muted', 'ground', 4.5],
  ['muted', 'sidebar', 4.5],
  ['muted', 'surface-sunken', 4.5],
  ['muted', 'surface-hover', 4.5],
  ['muted', 'surface-active', 4.5],
  ['faint', 'surface', 4.5],
  ['faint', 'ground', 4.5],
  ['faint', 'sidebar', 4.5],
  ['faint', 'surface-sunken', 4.5],
  ['faint', 'surface-hover', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'ground', 4.5],
  ['accent', 'sidebar', 4.5],
  ['accent', 'surface-sunken', 4.5],
  ['accent', 'surface-hover', 4.5],
  ['accent', 'accent-bg', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['accent-ink', 'accent-hover', 4.5],
  ['accent-ink', 'primary-from', 4.5],
  ['accent-ink', 'primary-to', 4.5],
  ['chip-ink', 'accent-bg', 4.5],
  ['chip-ink', 'surface', 4.5],
  ['title-end', 'ground', 4.5],
  ['title-end', 'surface', 4.5],
  ['ok-ink', 'ok-bg', 4.5],
  ['ok-ink', 'surface', 4.5],
  ['bad-ink', 'bad-bg', 4.5],
  ['bad-ink', 'surface', 4.5],
  ['bad-ink', 'surface-hover', 4.5],
  ['warn-ink', 'warn-bg', 4.5],
  ['warn-ink', 'surface', 4.5],
  ['info-ink', 'info-bg', 4.5],
  ['info-ink', 'surface', 4.5],
  ['platform-ios-ink', 'platform-ios-bg', 4.5],
  ['platform-ios-ink', 'surface', 4.5],
  ['platform-macos-ink', 'platform-macos-bg', 4.5],
  ['platform-macos-ink', 'surface', 4.5],
  ['platform-android-ink', 'platform-android-bg', 4.5],
  ['platform-android-ink', 'surface', 4.5],
  ['danger-solid-ink', 'danger-solid', 4.5],
  ['danger-solid-ink', 'danger-solid-hover', 4.5],
];

/** Graphics that need 3:1 (WCAG 1.4.11): the focus ring, the status dots and icons, the chart marks. */
export const graphicPairs: ReadonlyArray<readonly [TokenName, TokenName, number]> = [
  ['focus', 'surface', 3],
  ['focus', 'ground', 3],
  ['focus', 'sidebar', 3],
  ['accent', 'surface', 3],
  ['accent', 'ground', 3],
  ['ok', 'surface', 3],
  ['bad', 'surface', 3],
  ['warn', 'surface', 3],
  ['info', 'surface', 3],
  ['ok', 'ok-bg', 3],
  ['bad', 'bad-bg', 3],
  ['warn', 'warn-bg', 3],
  ['info', 'info-bg', 3],
  ['viz-1', 'surface', 3],
  ['viz-2', 'surface', 3],
  ['viz-mid', 'surface', 3],
  ['viz-end', 'surface', 3],
];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` color, per WCAG. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb color: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(Number.parseInt(h as string, 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

/** WCAG contrast ratio between two `#rrggbb` colors, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}
