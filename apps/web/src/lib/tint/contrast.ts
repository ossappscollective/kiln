/**
 * WCAG 2.x contrast for the app tint: relative luminance, the ratio, and alpha compositing, so a translucent tint is judged on
 * what is really drawn (the tint over the surface it sits on). Pure, no DOM.
 */
import { parseHex, type Rgb, toHex } from './oklch.ts';

/** A colour with an opacity from 0 to 1. */
export type Rgba = Rgb & { a: number };

const HEX8 = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

/** `#rrggbb` or `#rrggbbaa`, or null. */
export function parseColor(hex: string): Rgba | null {
  const m = HEX8.exec(hex.trim());
  if (!m) return null;
  const rgb = parseHex(m[1] as string) as Rgb;
  return { ...rgb, a: m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255 };
}

/** `#rrggbbaa`; the alpha is rounded to a byte, so what is measured is what is written. */
export function toHexAlpha(c: Rgb, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `${toHex(c)}${a.toString(16).padStart(2, '0')}`;
}

export function luminance(c: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** The WCAG ratio of two opaque colours, 1..21. */
export function ratio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` (with its alpha) drawn over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

/** Ratio of a hex pair; the background must be opaque. Convenience for tests and docs. */
export function hexRatio(fg: string, bg: string): number {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return 0;
  return ratio(over(f, b), b);
}
