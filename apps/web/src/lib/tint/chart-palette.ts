/**
 * The colours of chart series inside an app (docs/adr/0068-app-tint.md, design-system "App tint", Charts). ONE helper: the series
 * tokens `--viz-1`, `--viz-2`, ... that every chart reads inside a tinted subtree come from here (styles/tint.css maps `--app-viz-*`
 * onto them; the charts themselves only read --viz-*). Pure, deterministic, no DOM.
 *
 *  - Series 1 is the app accent (it already holds 3:1 on every surface). Series 2 is the secondary colour of the icon when it has
 *    a distinct hue, then every further series is picked from a pool of tonal steps and hue shifts of the app palette, each of which
 *    holds 3:1 against every theme surface, by farthest point (maximin) in OKLab so that no two series are close (MIN_DISTANCE).
 *  - No tint (no palette, monochrome, opt-out) or a colour that cannot be made safe: the existing default palette. Its first two
 *    colours are exactly the theme's --viz-1 and --viz-2; further ones are derived from them the same way.
 *  - Grid, axis and wash are not here: they stay neutral. Semantic series (success, danger, deltas, rating stars, store brand
 *    colours) never come from this list: they keep their own tokens.
 */
import { palette as themePalette } from '../tokens.ts';
import { ratio } from './contrast.ts';
import {
  type Oklch,
  type Rgb,
  maxChroma,
  oklchToHex,
  parseHex,
  rgbToOklab,
  rgbToOklch,
} from './oklch.ts';
import {
  MAX_TINT_CHROMA,
  MIN_TINT_CHROMA,
  type AppTint,
  type ChartTokens,
  type Scheme,
  type Surfaces,
  themeSurfaces,
} from './tokens.ts';

/** The most series a chart can ask for. */
export const MAX_SERIES = 8;
/** Smallest OKLab distance between any two series colours (Euclidean; white against black is 1). */
export const MIN_DISTANCE = 0.07;
const GRAPHIC = 3.05;
/** Hue-shifted series are at least this vivid, so a pale app colour still gives series that can be told apart. */
const MIN_SERIES_CHROMA = 0.11;

const LIGHTNESS: Record<Scheme, [number, number]> = { light: [0.25, 0.72], dark: [0.55, 0.95] };

/** OKLab distance of two colours. */
export function distance(a: string, b: string): number {
  const x = rgbToOklab(parseHex(a) as Rgb);
  const y = rgbToOklab(parseHex(b) as Rgb);
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
}

const okOn = (rgb: Rgb, surfaces: Surfaces): boolean =>
  surfaces.backgrounds.every((b) => ratio(rgb, b) >= GRAPHIC);

/** The colour of this hue and chroma whose lightness is nearest `l0` and that holds 3:1 on every surface; null when none does. */
function nearest(
  scheme: Scheme,
  h: number,
  c: number,
  l0: number,
  surfaces: Surfaces,
): string | null {
  const [lo, hi] = LIGHTNESS[scheme];
  let best: { hex: string; d: number } | null = null;
  for (let l = lo; l <= hi + 1e-9; l += 0.01) {
    const hex = oklchToHex(l, Math.min(c, maxChroma(l, h)), h);
    if (!okOn(parseHex(hex) as Rgb, surfaces)) continue;
    const d = Math.abs(l - l0);
    if (!best || d < best.d) best = { hex, d };
  }
  return best?.hex ?? null;
}

const lch = (hex: string): Oklch => rgbToOklch(parseHex(hex) as Rgb);

/** The series colours from an accent (already safe) and an optional secondary icon colour. Null when the accent is not usable. */
function build(
  accent: string,
  secondary: string | null | undefined,
  scheme: Scheme,
  surfaces: Surfaces,
): string[] | null {
  const base = parseHex(accent);
  if (!base || !okOn(base, surfaces)) return null;
  const a = lch(accent);
  const chosen = [accent];
  const far = (hex: string): number => Math.min(...chosen.map((c) => distance(c, hex)));

  if (secondary) {
    const s = lch(secondary);
    if (s.c >= MIN_TINT_CHROMA) {
      const hex = nearest(scheme, s.h, Math.min(s.c, MAX_TINT_CHROMA), s.l, surfaces);
      if (hex && far(hex) >= MIN_DISTANCE * 2) chosen.push(hex);
    }
  }

  const pool: string[] = [];
  const [lo, hi] = LIGHTNESS[scheme];
  for (let l = lo; l <= hi + 1e-9; l += 0.02) {
    const hex = oklchToHex(l, Math.min(a.c, maxChroma(l, a.h)), a.h);
    if (okOn(parseHex(hex) as Rgb, surfaces)) pool.push(hex);
  }
  for (let step = 1; step < 12; step += 1) {
    const h = (a.h + step * 30) % 360;
    const hex = nearest(scheme, h, Math.max(a.c, MIN_SERIES_CHROMA), a.l, surfaces);
    if (hex) pool.push(hex);
  }
  while (chosen.length < MAX_SERIES && pool.length > 0) {
    let bi = 0;
    let bd = -1;
    pool.forEach((hex, i) => {
      const d = far(hex);
      if (d > bd + 1e-9) {
        bd = d;
        bi = i;
      }
    });
    chosen.push(pool.splice(bi, 1)[0] as string);
  }
  return chosen.length === MAX_SERIES ? chosen : null;
}

/** The middle of the gradient: the OKLab midpoint of series 1 and 2, kept only when it also holds 3:1 (else series 1). */
function middle(series: string[], surfaces: Surfaces): string {
  const [x, y] = [
    rgbToOklab(parseHex(series[0] as string) as Rgb),
    rgbToOklab(parseHex(series[1] as string) as Rgb),
  ];
  const l = (x.l + y.l) / 2;
  const a = (x.a + y.a) / 2;
  const b = (x.b + y.b) / 2;
  const c = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const hex = oklchToHex(l, Math.min(c, maxChroma(l, h)), h);
  return okOn(parseHex(hex) as Rgb, surfaces) ? hex : (series[0] as string);
}

/**
 * N series colours for a scheme. `base` is the app's tint (its accent and, optionally, the secondary icon colour); null or an unusable
 * base gives the default palette of the theme. N is clamped to 1..MAX_SERIES.
 */
export function chartPalette(
  n: number,
  scheme: Scheme,
  base: { accent: string; secondary?: string | null | undefined } | null,
  surfaces: Surfaces = themeSurfaces[scheme],
): string[] {
  const count = Math.max(1, Math.min(MAX_SERIES, Math.floor(n) || 1));
  const colors = themePalette[scheme];
  const own = base ? build(base.accent, base.secondary, scheme, surfaces) : null;
  if (own) return own.slice(0, count);
  const defaults = [colors['viz-1'], colors['viz-2']] as string[];
  if (count <= 2) return defaults.slice(0, count);
  const more = build(defaults[0] as string, defaults[1], scheme, surfaces);
  return (more ?? defaults).slice(0, count).map((hex, i) => defaults[i] ?? hex);
}

/** The chart tokens of one scheme, or null when the default palette applies. */
export function chartTokens(
  scheme: Scheme,
  base: { accent: string; secondary?: string | null | undefined },
  surfaces: Surfaces = themeSurfaces[scheme],
): ChartTokens | null {
  const series = build(base.accent, base.secondary, scheme, surfaces);
  return series ? { series, mid: middle(series, surfaces) } : null;
}

/** The tint with its chart tokens attached (both themes, or none: a tint with only one theme's chart would look broken). */
export function withChart(tint: AppTint, secondary?: string | null): AppTint {
  const light = chartTokens('light', { accent: tint.light.accent, secondary });
  const dark = chartTokens('dark', { accent: tint.dark.accent, secondary });
  return light && dark ? { ...tint, chart: { light, dark } } : tint;
}
