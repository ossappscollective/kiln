/**
 * Color tokens for both themes. `app.css` mirrors these hex values exactly (a test enforces it),
 * and `contrast.test.ts` checks the text and graphic pairs below against WCAG 2.2 AA.
 * Edit a color here and in `app.css` together. Shadows, radii, spacing and type live in
 * `app.css` only because they are not colors.
 */

export const themeNames = ['light', 'dark'] as const;
export type ThemeName = (typeof themeNames)[number];

const light = {
  // Surfaces, from the page background up to raised and interactive layers.
  ground: '#f6f7f9',
  surface: '#ffffff',
  'surface-sunken': '#f0f2f5',
  'surface-hover': '#f3f4f7',
  'surface-active': '#e8ebf0',
  // Text.
  ink: '#151922',
  muted: '#566074',
  faint: '#626c7f',
  // Borders.
  line: '#e1e4ea',
  'line-strong': '#c9ced8',
  'line-hover': '#aeb5c2',
  // The one accent.
  accent: '#3453d4',
  'accent-hover': '#2a44b3',
  'accent-ink': '#ffffff',
  'accent-bg': '#edf0fc',
  // Semantic: a tint for backgrounds, ink for text on it, a solid for dots and icons, a border.
  'ok-bg': '#e6f5ec',
  'ok-ink': '#14612f',
  ok: '#1f8a4c',
  'ok-line': '#b9e2c7',
  'bad-bg': '#fdecea',
  'bad-ink': '#9b1c14',
  bad: '#d92d20',
  'bad-line': '#f7c1bb',
  'warn-bg': '#fdf3da',
  'warn-ink': '#6b4700',
  warn: '#b45309',
  'warn-line': '#f1d58a',
  'info-bg': '#e8f1fd',
  'info-ink': '#164a8a',
  info: '#2f6fd0',
  'info-line': '#bcd5f5',
  // Solid destructive button.
  'danger-solid': '#c8281c',
  'danger-solid-hover': '#a81f15',
  'danger-solid-ink': '#ffffff',
  // Loading placeholders.
  'skeleton-from': '#eceff3',
  'skeleton-to': '#f6f7f9',
} as const;

const dark: Record<keyof typeof light, string> = {
  ground: '#0e1116',
  surface: '#151921',
  'surface-sunken': '#1a1f28',
  'surface-hover': '#1b202a',
  'surface-active': '#232936',
  ink: '#e9ebf0',
  muted: '#9ba3b2',
  faint: '#8c95a5',
  line: '#262c37',
  'line-strong': '#363e4c',
  'line-hover': '#4b5566',
  accent: '#8da2f7',
  'accent-hover': '#a6b6fa',
  'accent-ink': '#0b1020',
  'accent-bg': '#1c2446',
  'ok-bg': '#12301f',
  'ok-ink': '#86dfa4',
  ok: '#3fb870',
  'ok-line': '#1f4d33',
  'bad-bg': '#3a1714',
  'bad-ink': '#ffaca3',
  bad: '#f2685c',
  'bad-line': '#5c2621',
  'warn-bg': '#35290a',
  'warn-ink': '#f3cf78',
  warn: '#e3a834',
  'warn-line': '#574411',
  'info-bg': '#14284a',
  'info-ink': '#a7c8f8',
  info: '#5b9be8',
  'info-line': '#213f70',
  'danger-solid': '#e5584c',
  'danger-solid-hover': '#ef7a70',
  'danger-solid-ink': '#1a0603',
  'skeleton-from': '#1d222c',
  'skeleton-to': '#262c38',
};

export type TokenName = keyof typeof light;
export const palette: Record<ThemeName, Record<TokenName, string>> = { light, dark };

/** Text pairs that must reach WCAG AA (4.5:1), or the stated minimum. [foreground, background, minimum] */
export const textPairs: ReadonlyArray<readonly [TokenName, TokenName, number]> = [
  ['ink', 'surface', 7],
  ['ink', 'ground', 7],
  ['ink', 'surface-sunken', 7],
  ['ink', 'surface-hover', 7],
  ['ink', 'surface-active', 7],
  ['ink', 'accent-bg', 7],
  ['muted', 'surface', 4.5],
  ['muted', 'ground', 4.5],
  ['muted', 'surface-sunken', 4.5],
  ['muted', 'surface-hover', 4.5],
  ['muted', 'surface-active', 4.5],
  ['faint', 'surface', 4.5],
  ['faint', 'ground', 4.5],
  ['faint', 'surface-sunken', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'ground', 4.5],
  ['accent', 'surface-sunken', 4.5],
  ['accent', 'surface-hover', 4.5],
  ['accent', 'accent-bg', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['accent-ink', 'accent-hover', 4.5],
  ['ok-ink', 'ok-bg', 4.5],
  ['ok-ink', 'surface', 4.5],
  ['bad-ink', 'bad-bg', 4.5],
  ['bad-ink', 'surface', 4.5],
  ['bad-ink', 'surface-hover', 4.5],
  ['warn-ink', 'warn-bg', 4.5],
  ['warn-ink', 'surface', 4.5],
  ['info-ink', 'info-bg', 4.5],
  ['info-ink', 'surface', 4.5],
  ['danger-solid-ink', 'danger-solid', 4.5],
  ['danger-solid-ink', 'danger-solid-hover', 4.5],
];

/** Graphics that need 3:1 (WCAG 1.4.11): the focus ring and the status dots and icons. */
export const graphicPairs: ReadonlyArray<readonly [TokenName, TokenName, number]> = [
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
