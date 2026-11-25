import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hexRatio, over, parseColor, ratio } from './contrast.ts';
import { hueDistance, maxChroma, oklchToHex, parseHex, rgbToOklch } from './oklch.ts';
import { extractPalette, NEUTRAL_PALETTE } from './palette.ts';
import {
  deriveScheme,
  deriveTint,
  failures,
  type Scheme,
  themeSurfaces,
  tintStyle,
} from './tokens.ts';

const css = readFileSync(fileURLToPath(new URL('../../styles/theme.css', import.meta.url)), 'utf8');

/** The solid colours of a theme block of theme.css (the first block that starts with `selector`). */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, selector);
  const end = css.indexOf('\n}', start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g))
    out[m[1] as string] = m[2] as string;
  return out;
}

test('the surfaces the tint is judged against are the ones theme.css defines', () => {
  const light = block(':root {');
  const dark = block(':root[data-theme="dark"] {');
  for (const name of [
    'ground',
    'sidebar',
    'surface',
    'surface-sunken',
    'surface-hover',
    'surface-active',
    'ink',
    'muted',
    'faint',
  ]) {
    assert.ok(light[name], `light ${name}`);
    assert.ok(dark[name], `dark ${name}`);
  }
  const rgb = (hex: string) => parseHex(hex);
  assert.deepEqual(themeSurfaces.light.ground, rgb(light.ground as string));
  assert.deepEqual(themeSurfaces.dark.ground, rgb(dark.ground as string));
  assert.deepEqual(
    themeSurfaces.light.backgrounds,
    ['ground', 'sidebar', 'surface', 'surface-sunken', 'surface-hover', 'surface-active'].map((n) =>
      rgb(light[n] as string),
    ),
  );
  assert.deepEqual(
    themeSurfaces.dark.texts.map((t) => t.fg),
    ['ink', 'muted', 'faint'].map((n) => rgb(dark[n] as string)),
  );
});

test('OKLCH round trip and gamut clamp', () => {
  for (const hex of ['#e02020', '#20a040', '#3050c0', '#ffd400', '#336699', '#808080']) {
    const c = rgbToOklch(parseHex(hex) as never);
    assert.equal(oklchToHex(c.l, c.c, c.h), hex);
  }
  // Out of gamut: the chroma is reduced, never the hue or a channel wrapped.
  const hex = oklchToHex(0.9, 0.4, 265);
  const back = rgbToOklch(parseHex(hex) as never);
  assert.ok(back.c <= maxChroma(0.9, 265) + 0.01);
  assert.ok(hueDistance(back.h, 265) < 8, String(back.h));
  assert.equal(maxChroma(0, 100), 0);
});

test('WCAG ratio and compositing', () => {
  assert.equal(hexRatio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(hexRatio('#777777', '#777777'), 1);
  const half = over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 });
  assert.equal(Math.round(half.r), 128);
  assert.deepEqual(parseColor('#11223380')?.a.toFixed(2), '0.50');
  assert.equal(parseColor('nope'), null);
});

function pixels(spec: [number, number, number, number][], each = 50): number[] {
  const out: number[] = [];
  for (const p of spec) for (let i = 0; i < each; i += 1) out.push(...p);
  return out;
}

test('palette: primary by chroma and population, secondary distinct, deterministic', () => {
  const data = pixels(
    [
      [220, 40, 40, 255],
      [40, 80, 220, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ],
    100,
  );
  // red x1, blue x1 equal weight; add more blue
  const more = [...data, ...pixels([[40, 80, 220, 255]], 200)];
  const p = extractPalette(more);
  assert.equal(p.neutral, false);
  const first = rgbToOklch(parseHex(p.colors[0] as string) as never);
  assert.ok(hueDistance(first.h, 265) < 25, `primary is blue: ${p.colors[0]}`);
  assert.ok(p.colors.length >= 2);
  assert.deepEqual(extractPalette(more), p);
});

test('palette: transparent, white, black and grey pixels are dropped; a mark with no chroma is neutral', () => {
  assert.deepEqual(
    extractPalette(
      pixels([
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [128, 128, 128, 255],
        [200, 30, 30, 10],
      ]),
    ),
    NEUTRAL_PALETTE,
  );
  assert.deepEqual(extractPalette([]), NEUTRAL_PALETTE);
  // A tiny coloured speck on white is below the share: neutral.
  const speck = [...pixels([[255, 255, 255, 255]], 1000), ...pixels([[220, 40, 40, 255]], 5)];
  assert.equal(extractPalette(speck).neutral, true);
  // Near-transparent colour is ignored, the opaque colour wins.
  const mixed = [...pixels([[220, 40, 40, 20]], 500), ...pixels([[30, 160, 60, 255]], 50)];
  const p = extractPalette(mixed);
  assert.equal(p.colors.length, 1);
  assert.ok(hueDistance(rgbToOklch(parseHex(p.colors[0] as string) as never).h, 145) < 25);
});

test('palette: merges neighbouring hues into one colour, returns at most three', () => {
  const data = pixels(
    [
      [220, 40, 40, 255],
      [225, 60, 30, 255],
      [40, 80, 220, 255],
      [40, 200, 80, 255],
      [230, 200, 30, 255],
      [160, 40, 200, 255],
    ],
    60,
  );
  const p = extractPalette(data);
  assert.ok(p.colors.length <= 3);
  assert.equal(new Set(p.colors).size, p.colors.length);
});

const schemes: Scheme[] = ['light', 'dark'];

test('every derived pair passes WCAG over all hues, chroma levels and both themes', () => {
  let derived = 0;
  let none = 0;
  for (const scheme of schemes) {
    for (let h = 0; h < 360; h += 5) {
      for (const c of [0.05, 0.1, 0.15, 0.22, 0.3]) {
        for (const l of [0.35, 0.55, 0.75, 0.92]) {
          const hex = oklchToHex(l, c, h);
          const t = deriveScheme(hex, scheme);
          if (!t) {
            none += 1;
            continue;
          }
          derived += 1;
          const bad = failures(t, themeSurfaces[scheme]);
          assert.deepEqual(bad, [], `${scheme} h=${h} c=${c} l=${l} ${hex}`);
          assert.ok(hexRatio(t.onAccent, t.accentSolid) >= 4.5);
          // Byte-rounded composites (what a browser draws) pass too.
          for (const bg of themeSurfaces[scheme].backgrounds) {
            const sub = parseColor(t.tintSubtle) as never;
            const under = over(sub, bg);
            const r = { r: Math.round(under.r), g: Math.round(under.g), b: Math.round(under.b) };
            assert.ok(
              ratio(parseHex(t.accentInk) as never, r) >= 4.5,
              `ink on subtle ${scheme} ${hex}`,
            );
          }
        }
      }
    }
  }
  assert.ok(derived > 1500, `derived ${derived}, none ${none}`);
  // The search almost always succeeds: a fallback is for odd colours, not the rule.
  assert.ok(none < derived * 0.05, `too many fallbacks: ${none} of ${derived + none}`);
});

test('yellow, lime and deep blue extremes derive safe tokens (or fall back)', () => {
  for (const hex of [
    '#ffff00',
    '#ffe600',
    '#c6ff00',
    '#bfff00',
    '#00008b',
    '#0a0aff',
    '#000080',
    '#1a1aa6',
    '#ff00ff',
    '#00ffff',
  ]) {
    for (const scheme of schemes) {
      const t = deriveScheme(hex, scheme);
      if (t) assert.deepEqual(failures(t, themeSurfaces[scheme]), [], `${scheme} ${hex}`);
    }
  }
  // Yellow keeps its hue in the accent text (a dark gold in light, the bright one in dark).
  const y = deriveScheme('#ffe600', 'light');
  assert.ok(y);
  assert.ok(
    hueDistance(
      rgbToOklch(parseHex(y.accentInk) as never).h,
      rgbToOklch(parseHex('#ffe600') as never).h,
    ) < 12,
  );
});

test('monochrome or grey input gives no tint', () => {
  for (const hex of [
    '#000000',
    '#ffffff',
    '#808080',
    '#8a8b8c',
    '#f0f0f0',
    'not a colour',
    '#12',
  ]) {
    assert.equal(deriveTint(hex), null, hex);
  }
});

test('deterministic', () => {
  const a = deriveTint('#3b82f6');
  const b = deriveTint('#3b82f6');
  assert.ok(a);
  assert.deepEqual(a, b);
  assert.equal(tintStyle(a), tintStyle(b));
});

test('tintStyle writes both themes and nothing for no tint', () => {
  assert.equal(tintStyle(null), '');
  const s = tintStyle(deriveTint('#e8590c'));
  for (const prefix of ['l', 'd'])
    for (const key of [
      'accent',
      'accent-ink',
      'accent-hover',
      'accent-solid',
      'on-accent',
      'tint-subtle',
      'tint-strong',
      'glow',
    ])
      assert.ok(s.includes(`--tint-${prefix}-${key}:#`), `${prefix} ${key}`);
  assert.ok(!/--accent\b|--ink\b/.test(s), 'the style names no token the UI reads');
});

test('a chroma above the cap is calmed down and the colour stays in gamut', () => {
  const t = deriveScheme('#00ff40', 'dark') ?? deriveScheme('#00ff40', 'light');
  assert.ok(t);
  for (const hex of [t.accent, t.accentInk, t.accentSolid]) assert.match(hex, /^#[0-9a-f]{6}$/);
  assert.ok(rgbToOklch(parseHex(t.accentSolid) as never).c <= 0.17 + 0.01);
});
