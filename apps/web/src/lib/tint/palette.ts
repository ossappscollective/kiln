/**
 * The main colours of an app icon, from its pixels (docs/adr/0068-app-tint.md). Deterministic: the same pixels always give the
 * same palette. The pixels are quantised in OKLab (hue bins of 15 degrees by three lightness bins), the near transparent,
 * near white, near black and almost grey pixels are dropped, each pixel counts by its chroma (so vivid, large areas win over a
 * pale halo), neighbouring hues are merged, and up to three colours come out: primary, secondary, tertiary. An icon without
 * usable chroma (a black and white mark) is `neutral`, and a neutral icon gets no tint. No DOM: `extract.ts` supplies the pixels.
 */
import { hueDistance, oklabToRgb, rgbToOklab, toHex } from './oklch.ts';

export type Palette = {
  /** `#rrggbb` colours, most important first. Empty when `neutral`. */
  colors: string[];
  /** No pixel with usable chroma: monochrome or grey. */
  neutral: boolean;
};

export const NEUTRAL_PALETTE: Palette = { colors: [], neutral: true };

/** A pixel is ignored when it is this transparent, or this close to white, black or grey. */
export const MIN_ALPHA = 128;
export const MIN_CHROMA = 0.045;
export const MIN_LIGHTNESS = 0.18;
export const MAX_LIGHTNESS = 0.95;
/** Less than this share of the opaque pixels with chroma: the icon reads as neutral. */
export const MIN_SHARE = 0.03;

const HUE_BINS = 24;
const L_BINS = 3;
/** Two palette colours are different colours when their hues are at least this far apart. */
const DISTINCT_HUE = 35;
/** A secondary colour needs this share of the primary's weight. */
const MIN_RELATIVE = 0.15;

type Bin = { w: number; l: number; a: number; b: number; n: number };

/** `data` is RGBA, four numbers per pixel (a canvas `ImageData.data`). */
export function extractPalette(data: ArrayLike<number>, maxColors = 3): Palette {
  const bins: Bin[] = [];
  for (let i = 0; i < HUE_BINS * L_BINS; i += 1) bins.push({ w: 0, l: 0, a: 0, b: 0, n: 0 });
  let opaque = 0;
  let usable = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] as number) < MIN_ALPHA) continue;
    opaque += 1;
    const lab = rgbToOklab({
      r: data[i] as number,
      g: data[i + 1] as number,
      b: data[i + 2] as number,
    });
    const c = Math.hypot(lab.a, lab.b);
    if (c < MIN_CHROMA || lab.l < MIN_LIGHTNESS || lab.l > MAX_LIGHTNESS) continue;
    usable += 1;
    const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
    const hb = Math.min(HUE_BINS - 1, Math.floor(hue / (360 / HUE_BINS)));
    const lb = Math.min(
      L_BINS - 1,
      Math.floor(((lab.l - MIN_LIGHTNESS) / (MAX_LIGHTNESS - MIN_LIGHTNESS)) * L_BINS),
    );
    const bin = bins[hb * L_BINS + lb] as Bin;
    bin.w += c;
    bin.l += lab.l * c;
    bin.a += lab.a * c;
    bin.b += lab.b * c;
    bin.n += 1;
  }
  if (opaque === 0 || usable / opaque < MIN_SHARE) return NEUTRAL_PALETTE;

  const taken: { h: number }[] = [];
  const colors: string[] = [];
  let primaryWeight = 0;
  for (let round = 0; round < Math.max(1, maxColors); round += 1) {
    // The heaviest bin whose hue is not near a colour already taken (ties: the lower index, so the result is stable).
    let best = -1;
    for (let i = 0; i < bins.length; i += 1) {
      const bin = bins[i] as Bin;
      if (bin.w <= 0) continue;
      const hue = ((Math.atan2(bin.b, bin.a) * 180) / Math.PI + 360) % 360;
      if (taken.some((t) => hueDistance(t.h, hue) < DISTINCT_HUE)) continue;
      if (best < 0 || bin.w > (bins[best] as Bin).w) best = i;
    }
    if (best < 0) break;
    const seed = bins[best] as Bin;
    const seedHue = ((Math.atan2(seed.b, seed.a) * 180) / Math.PI + 360) % 360;
    // Merge the bins within 20 degrees of the seed (any lightness): one cluster, averaged by weight.
    let w = 0;
    let l = 0;
    let a = 0;
    let b = 0;
    for (const bin of bins) {
      if (bin.w <= 0) continue;
      const hue = ((Math.atan2(bin.b, bin.a) * 180) / Math.PI + 360) % 360;
      if (hueDistance(seedHue, hue) > 20) continue;
      w += bin.w;
      l += bin.l;
      a += bin.a;
      b += bin.b;
      bin.w = 0;
    }
    if (round === 0) primaryWeight = w;
    else if (w < primaryWeight * MIN_RELATIVE) break;
    const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    taken.push({ h: hue });
    colors.push(toHex(oklabToRgb(l / w, a / w, b / w)));
  }
  return colors.length === 0 ? NEUTRAL_PALETTE : { colors, neutral: false };
}
