import { encodePng, type Raster } from '../services/png-codec.ts';
import type { DemoApp } from './content.ts';

/**
 * Generated placeholder art: flat gradients and simple shapes drawn straight into a pixel buffer and
 * written with the server's own PNG codec. Nothing here is copied from a real product.
 */

type Rgb = [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const darken = (c: Rgb, t: number): Rgb => mix(c, [0, 0, 0], t);

function raster(width: number, height: number, alpha: boolean): Raster {
  return {
    width,
    height,
    channels: alpha ? 4 : 3,
    data: new Uint8Array(width * height * (alpha ? 4 : 3)),
  };
}

function put(r: Raster, x: number, y: number, c: Rgb, a = 255) {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = (y * r.width + x) * r.channels;
  r.data[i] = c[0];
  r.data[i + 1] = c[1];
  r.data[i + 2] = c[2];
  if (r.channels === 4) r.data[i + 3] = a;
}

function rect(r: Raster, x0: number, y0: number, w: number, h: number, c: Rgb, radius = 0) {
  for (let y = Math.max(0, y0); y < Math.min(r.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x0 + w); x++) {
      if (radius > 0) {
        const dx = Math.max(x0 + radius - x, x - (x0 + w - 1 - radius), 0);
        const dy = Math.max(y0 + radius - y, y - (y0 + h - 1 - radius), 0);
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      put(r, x, y, c);
    }
  }
}

function disc(r: Raster, cx: number, cy: number, rad: number, c: Rgb) {
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) put(r, x, y, c);
}

function gradient(r: Raster, top: Rgb, bottom: Rgb) {
  for (let y = 0; y < r.height; y++) {
    const c = mix(top, bottom, y / Math.max(1, r.height - 1));
    for (let x = 0; x < r.width; x++) put(r, x, y, c);
  }
}

function glyph(r: Raster, kind: DemoApp['glyph'], cx: number, cy: number, size: number, c: Rgb) {
  if (kind === 'note') {
    rect(
      r,
      Math.round(cx - size * 0.32),
      Math.round(cy - size * 0.4),
      Math.round(size * 0.64),
      Math.round(size * 0.8),
      c,
      Math.round(size * 0.08),
    );
    for (let i = 0; i < 3; i++)
      rect(
        r,
        Math.round(cx - size * 0.2),
        Math.round(cy - size * 0.2 + i * size * 0.2),
        Math.round(size * 0.4),
        Math.max(2, Math.round(size * 0.05)),
        [90, 90, 90],
      );
  } else if (kind === 'sun') {
    disc(r, cx, cy, size * 0.22, c);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      disc(r, cx + Math.cos(a) * size * 0.4, cy + Math.sin(a) * size * 0.4, size * 0.05, c);
    }
  } else {
    disc(r, cx, cy, size * 0.36, c);
    disc(r, cx, cy, size * 0.28, [60, 60, 60]);
    rect(
      r,
      Math.round(cx - size * 0.02),
      Math.round(cy - size * 0.2),
      Math.max(2, Math.round(size * 0.04)),
      Math.round(size * 0.2),
      c,
    );
  }
}

const cache = new Map<string, Uint8Array>();
const memo = (key: string, make: () => Uint8Array) => {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = make()));
  return v;
};

/** The app icon as a square PNG. */
export function iconPng(app: DemoApp, size: number, options: { alpha?: boolean } = {}): Uint8Array {
  return memo(`icon:${app.key}:${size}:${options.alpha ? 'a' : 'o'}`, () => {
    const r = raster(size, size, options.alpha === true);
    gradient(r, mix(app.color, [255, 255, 255], 0.25), darken(app.color, 0.15));
    glyph(r, app.glyph, size / 2, size / 2, size * 0.6, app.accent);
    // The alpha variant has transparent corners, which is what a store refuses on an iOS icon.
    if (options.alpha)
      for (let y = 0; y < size / 16; y++)
        for (let x = 0; x < size / 16; x++) put(r, x, y, [0, 0, 0], 0);
    return encodePng(r);
  });
}

/** The icon as an SVG data URL (small; for places that want a link instead of bytes). */
export function iconDataUrl(app: DemoApp): string {
  const c = (rgb: Rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c(mix(app.color, [255, 255, 255], 0.25))}"/><stop offset="1" stop-color="${c(darken(app.color, 0.15))}"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#g)"/><circle cx="64" cy="64" r="24" fill="${c(app.accent)}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** A screenshot placeholder: gradient, a status bar, and a few cards. `index` varies the picture. */
export function screenshotPng(
  app: DemoApp,
  width: number,
  height: number,
  index: number,
  options: { alpha?: boolean } = {},
): Uint8Array {
  return memo(`shot:${app.key}:${width}x${height}:${index}:${options.alpha ? 'a' : 'o'}`, () => {
    const r = raster(width, height, options.alpha === true);
    gradient(r, mix(app.color, [255, 255, 255], 0.55), mix(app.color, [255, 255, 255], 0.15));
    const pad = Math.round(Math.min(width, height) * 0.06);
    rect(
      r,
      pad,
      pad,
      width - pad * 2,
      Math.round(height * 0.04),
      mix(app.color, [0, 0, 0], 0.35),
      Math.round(pad / 2),
    );
    const cards = 3 + (index % 3);
    const cardH = Math.round((height * 0.72) / cards - pad * 0.5);
    for (let i = 0; i < cards; i++) {
      const y = Math.round(height * 0.12) + i * (cardH + Math.round(pad * 0.5));
      rect(r, pad, y, width - pad * 2, cardH, [255, 255, 255], Math.round(pad / 2));
      rect(
        r,
        pad * 2,
        y + Math.round(cardH * 0.25),
        Math.round((width - pad * 4) * (0.45 + ((i + index) % 4) * 0.12)),
        Math.max(4, Math.round(cardH * 0.12)),
        mix(app.color, [0, 0, 0], 0.25),
        4,
      );
      rect(
        r,
        pad * 2,
        y + Math.round(cardH * 0.55),
        Math.round((width - pad * 4) * 0.7),
        Math.max(4, Math.round(cardH * 0.09)),
        [200, 205, 212],
        4,
      );
    }
    glyph(r, app.glyph, width / 2, height - pad * 3, Math.min(width, height) * 0.14, app.accent);
    if (options.alpha)
      for (let y = 0; y < height / 40; y++)
        for (let x = 0; x < width; x++) put(r, x, y, [0, 0, 0], 0);
    return encodePng(r);
  });
}

/** The Google Play feature graphic, 1024 x 500. */
export function featureGraphicPng(app: DemoApp): Uint8Array {
  return memo(`feature:${app.key}`, () => {
    const r = raster(1024, 500, false);
    gradient(r, mix(app.color, [255, 255, 255], 0.3), darken(app.color, 0.25));
    glyph(r, app.glyph, 220, 250, 300, app.accent);
    rect(r, 420, 190, 480, 40, [255, 255, 255], 12);
    rect(r, 420, 260, 340, 28, [255, 255, 255], 10);
    return encodePng(r);
  });
}
