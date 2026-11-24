/**
 * Colour maths for the app tint (docs/adr/0068-app-tint.md): sRGB hex <-> OKLab / OKLCH and the gamut clamp.
 * Pure, no DOM, deterministic. OKLab after Bjorn Ottosson (matrices of the reference implementation).
 */

export type Rgb = { r: number; g: number; b: number };
export type Oklch = { l: number; c: number; h: number };

const HEX6 = /^#?([0-9a-fA-F]{6})$/;

/** `#rrggbb` (or `rrggbb`) to 0..255 channels, or null when it is not a six digit hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX6.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const h2 = (v: number): string => byte(v).toString(16).padStart(2, '0');

export const toHex = (c: Rgb): string => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;

const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return s * 255;
};

export function rgbToOklab(c: Rgb): { l: number; a: number; b: number } {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB (unclamped, may leave 0..1 when the colour is out of gamut). */
function oklabToLinear(l: number, a: number, b: number): [number, number, number] {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

export function oklabToRgb(l: number, a: number, b: number): Rgb {
  const [r, g, bl] = oklabToLinear(l, a, b);
  return { r: byte(fromLinear(Math.max(0, Math.min(1, r)))), g: byte(fromLinear(Math.max(0, Math.min(1, g)))), b: byte(fromLinear(Math.max(0, Math.min(1, bl)))) };
}

export function rgbToOklch(c: Rgb): Oklch {
  const { l, a, b } = rgbToOklab(c);
  const chroma = Math.hypot(a, b);
  const h = chroma < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c: chroma, h };
}

const EPS = 1e-4;
const inGamut = (l: number, c: number, h: number): boolean => {
  const rad = (h * Math.PI) / 180;
  const [r, g, b] = oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad));
  return r >= -EPS && r <= 1 + EPS && g >= -EPS && g <= 1 + EPS && b >= -EPS && b <= 1 + EPS;
};

/** The largest chroma that stays inside sRGB at this lightness and hue (bisection, 24 steps: deterministic). */
export function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0;
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(l, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** An OKLCH colour as `#rrggbb`: the chroma is reduced (the hue and lightness kept) until it is inside sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  const cc = Math.min(Math.max(0, c), maxChroma(l, h));
  const rad = (h * Math.PI) / 180;
  return toHex(oklabToRgb(l, cc * Math.cos(rad), cc * Math.sin(rad)));
}

/** Smallest angle between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
