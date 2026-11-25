/**
 * Token derivation of the app tint (docs/adr/0068-app-tint.md, docs/design-system.md "App tint"). From ONE colour (the primary of
 * the app icon, or a colour a person picked) it derives, for the light and for the dark theme, a small set of colours that are
 * readable on the real theme surfaces:
 *
 *   accent        borders, indicators, the active bar                      >= 3:1 on every surface
 *   accentInk     text and icons in the accent colour (links, chip text)    >= 4.5:1 on every surface and on both tints
 *   accentHover   the hover of accentInk                                    >= 4.5:1 on every surface and on the subtle tint
 *   accentSolid   a filled chip or button, with onAccent on it              onAccent >= 4.5:1 on accentSolid
 *   tintSubtle / tintStrong   the accent over the surface at low opacity    ink, muted and faint >= 4.5:1 on them
 *   glow          the page glow (decorative)                                ink, muted and faint >= 4.5:1 under it
 *
 * The hue is kept and the chroma is capped, the lightness is searched in OKLCH (closest to the icon's own lightness) until every
 * pair passes, the chroma is clamped to sRGB. When a pair cannot be met the result is null: no tint, the default accent stays.
 * Pure and deterministic, no DOM.
 */
import { type ThemeName, palette as themePalette } from '../tokens.ts';
import { over, parseColor, ratio, toHexAlpha } from './contrast.ts';
import { maxChroma, oklchToHex, parseHex, type Rgb, rgbToOklch } from './oklch.ts';

export type Scheme = ThemeName;

/** The theme colours a tint is judged against. */
export type Surfaces = {
  /** Where text and indicators of the app sit. */
  backgrounds: Rgb[];
  /** The page ground (the glow is painted over it). */
  ground: Rgb;
  /** Body, secondary and faint text, with the surfaces each is used on (faint is for placeholders and headers on the page, the sidebar and cards, not on a sunken, hovered or pressed layer). */
  texts: { fg: Rgb; backs: Rgb[] }[];
};

export type SchemeTokens = {
  accent: string;
  accentInk: string;
  accentHover: string;
  accentSolid: string;
  onAccent: string;
  tintSubtle: string;
  tintStrong: string;
  glow: string;
};

/** The chart series of a theme (lib/tint/chart-palette.ts): MAX_SERIES colours and the middle of the single-series gradient. */
export type ChartTokens = { series: string[]; mid: string };

/** `chart` is added by withChart (chart-palette.ts); absent, charts keep the default palette. */
export type AppTint = {
  light: SchemeTokens;
  dark: SchemeTokens;
  chart?: Record<Scheme, ChartTokens>;
};

/** Below this chroma a colour is grey: no hue to keep, no tint. */
export const MIN_TINT_CHROMA = 0.04;
/** A very saturated colour is calmed down to this chroma (the lightness search then clamps it to the gamut). */
export const MAX_TINT_CHROMA = 0.17;
/** Targets with a hair of margin, so rounding to bytes in a browser never takes a pair under WCAG. */
const TEXT = 4.55;
const GRAPHIC = 3.05;

const NAMES = [
  'ground',
  'sidebar',
  'surface',
  'surface-sunken',
  'surface-hover',
  'surface-active',
] as const;
const TEXTS = ['ink', 'muted', 'faint'] as const;

export function surfacesOf(colors: Record<string, string>): Surfaces {
  const rgb = (name: string): Rgb => {
    const v = parseHex(colors[name] ?? '');
    if (!v) throw new Error(`no solid colour for ${name}`);
    return v;
  };
  const backgrounds = NAMES.map(rgb);
  const texts = TEXTS.map((name) => ({
    fg: rgb(name),
    backs: name === 'faint' ? backgrounds.slice(0, 3) : backgrounds,
  }));
  return { backgrounds, ground: rgb('ground'), texts };
}

/** The surfaces of both themes as theme.css (mirrored in lib/tokens.ts) defines them. */
export const themeSurfaces: Record<Scheme, Surfaces> = {
  light: surfacesOf(themePalette.light),
  dark: surfacesOf(themePalette.dark),
};

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const DARK_INK: Rgb = { r: 11, g: 13, b: 34 };

type Candidate = { hex: string; rgb: Rgb };

/** The lightness grid of a scheme, nearest to `l0` first (ties go to the darker one in light, the lighter one in dark). */
function lightnesses(scheme: Scheme, l0: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let l = lo; l <= hi + 1e-9; l += 0.005) out.push(Math.round(l * 1000) / 1000);
  const prefer = scheme === 'light' ? -1 : 1;
  return out.sort((x, y) => Math.abs(x - l0) - Math.abs(y - l0) || prefer * (x - y));
}

function candidate(l: number, c: number, h: number): Candidate {
  const hex = oklchToHex(l, c, h);
  return { hex, rgb: parseHex(hex) as Rgb };
}

/** The first lightness (nearest to the icon's own) whose colour satisfies `ok`, or null. */
function search(
  scheme: Scheme,
  h: number,
  c: number,
  l0: number,
  range: [number, number],
  ok: (x: Rgb) => boolean,
): Candidate | null {
  for (const l of lightnesses(scheme, l0, range[0], range[1])) {
    const cand = candidate(l, Math.min(c, maxChroma(l, h)), h);
    if (ok(cand.rgb)) return cand;
  }
  return null;
}

type Layer = NonNullable<ReturnType<typeof parseColor>>;

/** Whether every text colour keeps 4.5:1 on every surface it is used on, with each of the layers drawn over it. */
function textsPass(surfaces: Surfaces, layers: Layer[]): boolean {
  return surfaces.texts.every((t) =>
    t.backs.every((b) => layers.every((l) => ratio(t.fg, over(l, b)) >= TEXT)),
  );
}

const INK_RANGE: Record<Scheme, [number, number]> = { light: [0.2, 0.75], dark: [0.55, 0.97] };

/** Derives one theme. Null when a pair cannot be met. */
export function deriveScheme(
  primaryHex: string,
  scheme: Scheme,
  surfaces: Surfaces = themeSurfaces[scheme],
): SchemeTokens | null {
  const rgb = parseHex(primaryHex);
  if (!rgb) return null;
  const lch = rgbToOklch(rgb);
  if (lch.c < MIN_TINT_CHROMA) return null;
  const c = Math.min(lch.c, MAX_TINT_CHROMA);
  const { h } = lch;
  const bgs = surfaces.backgrounds;

  const accent = search(scheme, h, c, lch.l, INK_RANGE[scheme], (x) =>
    bgs.every((b) => ratio(x, b) >= GRAPHIC),
  );
  if (!accent) return null;

  // Tints: the accent over the surface, at an opacity that is lowered until the text on it passes.
  const base = scheme === 'light' ? [0.1, 0.18] : [0.14, 0.26];
  for (const scale of [1, 0.8, 0.6, 0.45, 0.3]) {
    const subtle = toHexAlpha(accent.rgb, (base[0] as number) * scale);
    const strong = toHexAlpha(accent.rgb, (base[1] as number) * scale);
    const tints = [subtle, strong].map(
      (t) => parseColor(t) as NonNullable<ReturnType<typeof parseColor>>,
    );
    if (!textsPass(surfaces, tints)) continue;
    const underTint = [...bgs, ...bgs.flatMap((b) => tints.map((t) => over(t, b)))];
    const ink = search(scheme, h, c, lch.l, INK_RANGE[scheme], (x) =>
      underTint.every((b) => ratio(x, b) >= TEXT),
    );
    if (!ink) continue;
    const subtleGrounds = bgs.map((b) =>
      over(tints[0] as NonNullable<ReturnType<typeof parseColor>>, b),
    );
    const shift = scheme === 'light' ? -0.05 : 0.05;
    const hoverL = Math.min(0.97, Math.max(0.2, rgbToOklch(ink.rgb).l + shift));
    const hoverCand = candidate(hoverL, Math.min(c, maxChroma(hoverL, h)), h);
    const hover = [...bgs, ...subtleGrounds].every((b) => ratio(hoverCand.rgb, b) >= TEXT)
      ? hoverCand
      : ink;

    const onAccentOf = (s: Rgb): Rgb | null => {
      const best = ratio(WHITE, s) >= ratio(DARK_INK, s) ? WHITE : DARK_INK;
      return ratio(best, s) >= TEXT ? best : null;
    };
    const solid = search(scheme, h, c, lch.l, [0.3, 0.9], (x) => onAccentOf(x) !== null);
    if (!solid) continue;
    const on = onAccentOf(solid.rgb) as Rgb;

    // The glow: lowered until body, secondary and faint text keep their contrast over it.
    let glow = toHexAlpha(accent.rgb, 0);
    for (const a of scheme === 'light' ? [0.14, 0.1, 0.06, 0.03] : [0.16, 0.11, 0.07, 0.04]) {
      const g = parseColor(toHexAlpha(accent.rgb, a)) as NonNullable<ReturnType<typeof parseColor>>;
      if (
        textsPass(
          {
            ...surfaces,
            texts: surfaces.texts.map((t) => ({ fg: t.fg, backs: [surfaces.ground] })),
          },
          [g],
        )
      ) {
        glow = toHexAlpha(accent.rgb, a);
        break;
      }
    }
    return {
      accent: accent.hex,
      accentInk: ink.hex,
      accentHover: hover.hex,
      accentSolid: solid.hex,
      onAccent: on === WHITE ? '#ffffff' : '#0b0d22',
      tintSubtle: subtle,
      tintStrong: strong,
      glow,
    };
  }
  return null;
}

/** Both themes, or null when either cannot be met (one theme with and one without the tint would look broken). */
export function deriveTint(primaryHex: string): AppTint | null {
  const light = deriveScheme(primaryHex, 'light');
  const dark = deriveScheme(primaryHex, 'dark');
  return light && dark ? { light, dark } : null;
}

/** Every pair that fails for one theme (an empty list is a pass). Used by the derivation tests, and a cheap guard at runtime. */
export function failures(t: SchemeTokens, surfaces: Surfaces): string[] {
  const bad: string[] = [];
  const px = (hex: string): Rgb => parseColor(hex) as Rgb;
  const bgs = surfaces.backgrounds;
  const sub = parseColor(t.tintSubtle) as NonNullable<ReturnType<typeof parseColor>>;
  const str = parseColor(t.tintStrong) as NonNullable<ReturnType<typeof parseColor>>;
  const glow = parseColor(t.glow) as NonNullable<ReturnType<typeof parseColor>>;
  const tinted = bgs.flatMap((b) => [over(sub, b), over(str, b)]);
  const check = (name: string, fg: Rgb, backs: Rgb[], min: number): void => {
    for (const b of backs)
      if (ratio(fg, b) < min) bad.push(`${name} ${ratio(fg, b).toFixed(2)} < ${min}`);
  };
  check('accent', px(t.accent), bgs, 3);
  check('accentInk', px(t.accentInk), [...bgs, ...tinted], 4.5);
  check('accentHover', px(t.accentHover), [...bgs, ...bgs.map((b) => over(sub, b))], 4.5);
  check('onAccent', px(t.onAccent), [px(t.accentSolid)], 4.5);
  for (const text of surfaces.texts) {
    for (const b of text.backs) check('text on tint', text.fg, [over(sub, b), over(str, b)], 4.5);
    check('text under glow', text.fg, [over(glow, surfaces.ground)], 4.5);
  }
  return bad;
}

const KEYS: Record<keyof SchemeTokens, string> = {
  accent: 'accent',
  accentInk: 'accent-ink',
  accentHover: 'accent-hover',
  accentSolid: 'accent-solid',
  onAccent: 'on-accent',
  tintSubtle: 'tint-subtle',
  tintStrong: 'tint-strong',
  glow: 'glow',
};

/**
 * The inline style that carries a tint: `--tint-l-*` and `--tint-d-*`, one set per theme. styles/tint.css picks the set that
 * belongs to the current theme (data-theme, else prefers-color-scheme) and maps it to the --app-* tokens. No colour name here
 * is a token the rest of the UI reads, so the style alone changes nothing.
 */
export function tintStyle(tint: AppTint | null): string {
  if (!tint) return '';
  const parts: string[] = [];
  for (const [prefix, set] of [
    ['l', tint.light],
    ['d', tint.dark],
  ] as const)
    for (const key of Object.keys(KEYS) as (keyof SchemeTokens)[])
      parts.push(`--tint-${prefix}-${KEYS[key]}:${set[key]}`);
  if (tint.chart)
    for (const [prefix, scheme] of [
      ['l', 'light'],
      ['d', 'dark'],
    ] as const) {
      tint.chart[scheme].series.forEach((hex, i) =>
        parts.push(`--tint-${prefix}-viz-${i + 1}:${hex}`),
      );
      parts.push(`--tint-${prefix}-viz-mid:${tint.chart[scheme].mid}`);
    }
  return `${parts.join(';')};`;
}
