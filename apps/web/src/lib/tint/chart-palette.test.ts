import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ratio } from './contrast.ts';
import { MAX_SERIES, MIN_DISTANCE, chartPalette, chartTokens, distance, withChart } from './chart-palette.ts';
import { oklchToHex, parseHex, maxChroma } from './oklch.ts';
import { palette } from '../tokens.ts';
import { deriveScheme, deriveTint, themeSurfaces, tintStyle, type Scheme } from './tokens.ts';
import { resolveTint } from './prefs.ts';

const schemes: Scheme[] = ['light', 'dark'];
const hues = Array.from({ length: 24 }, (_, i) => i * 15);
const px = (hex: string) => parseHex(hex) as NonNullable<ReturnType<typeof parseHex>>;

function accentOf(h: number, c: number, scheme: Scheme): string | null {
  const l = scheme === 'light' ? 0.5 : 0.75;
  const t = deriveScheme(oklchToHex(l, Math.min(c, maxChroma(l, h)), h), scheme);
  return t ? t.accent : null;
}

test('N = 1..8, both themes, every hue: 3:1 on every surface and well separated', () => {
  let checked = 0;
  for (const scheme of schemes)
    for (const h of hues)
      for (const c of [0.05, 0.1, 0.17]) {
        const accent = accentOf(h, c, scheme);
        if (!accent) continue;
        const sec = oklchToHex(0.6, 0.12, (h + 140) % 360);
        for (let n = 1; n <= MAX_SERIES; n += 1) {
          const colors = chartPalette(n, scheme, { accent, secondary: sec });
          assert.equal(colors.length, n);
          assert.equal(colors[0], accent, 'series 1 is the accent');
          for (const hex of colors) for (const b of themeSurfaces[scheme].backgrounds) assert.ok(ratio(px(hex), b) >= 3, `${scheme} h${h} c${c} ${hex}`);
          for (let i = 0; i < n; i += 1)
            for (let j = i + 1; j < n; j += 1) assert.ok(distance(colors[i] as string, colors[j] as string) >= MIN_DISTANCE, `${scheme} h${h} c${c} ${i}/${j} ${distance(colors[i] as string, colors[j] as string).toFixed(3)}`);
        }
        checked += 1;
      }
  assert.ok(checked > 60);
});

test('deterministic, and the icon secondary is the second series when its hue is distinct', () => {
  const accent = accentOf(250, 0.15, 'light') as string;
  const a = chartPalette(5, 'light', { accent, secondary: '#e8782a' });
  assert.deepEqual(a, chartPalette(5, 'light', { accent, secondary: '#e8782a' }));
  assert.notDeepEqual(a, chartPalette(5, 'light', { accent }));
  assert.ok(distance(a[0] as string, a[1] as string) >= MIN_DISTANCE * 2);
});

test('no tint, or a colour that is not usable: the default palette, unchanged', () => {
  for (const scheme of schemes) {
    const d = [palette[scheme]['viz-1'], palette[scheme]['viz-2']];
    assert.deepEqual(chartPalette(1, scheme, null), [d[0]]);
    assert.deepEqual(chartPalette(2, scheme, null), d);
    assert.deepEqual(chartPalette(2, scheme, { accent: scheme === 'light' ? '#ffffff' : '#000000' }), d, 'an accent that fails 3:1 falls back');
    const eight = chartPalette(8, scheme, null);
    assert.equal(eight.length, 8);
    assert.deepEqual(eight.slice(0, 2), d);
    for (let i = 0; i < 8; i += 1) for (let j = i + 1; j < 8; j += 1) assert.ok(distance(eight[i] as string, eight[j] as string) >= MIN_DISTANCE * 0.8, `${scheme} ${i}/${j}`);
    assert.equal(chartPalette(0, scheme, null).length, 1);
    assert.equal(chartPalette(99, scheme, null).length, 8);
  }
});

test('the tint carries chart tokens for both themes, in the inline style, and the gradient middle holds 3:1', () => {
  const tint = withChart(deriveTint('#e8782a') as NonNullable<ReturnType<typeof deriveTint>>, '#2a6de8');
  assert.ok(tint.chart);
  for (const scheme of schemes) {
    const c = tint.chart?.[scheme];
    assert.equal(c?.series.length, MAX_SERIES);
    for (const b of themeSurfaces[scheme].backgrounds) assert.ok(ratio(px(c?.mid as string), b) >= 3);
  }
  const style = tintStyle(tint);
  for (const p of ['l', 'd']) for (const k of ['1', '2', '8', 'mid']) assert.match(style, new RegExp(`--tint-${p}-viz-${k}:#[0-9a-f]{6}`));
  assert.doesNotMatch(tintStyle(deriveTint('#e8782a')), /viz/);
  assert.equal(chartTokens('light', { accent: '#ffffff' }), null);
});

test('resolveTint adds the chart tokens; monochrome and opt-out have none', () => {
  const t = resolveTint({ enabled: true, palette: { colors: ['#e8782a', '#2a6de8'], neutral: false } });
  assert.ok(t?.chart);
  assert.equal(resolveTint({ enabled: true, palette: { colors: [], neutral: true } }), null);
  assert.equal(resolveTint({ enabled: false, palette: { colors: ['#e8782a'], neutral: false } }), null);
  assert.ok(resolveTint({ enabled: true, appearance: { tint: 'custom', color: '#3b82f6' } })?.chart);
});

test('charts read --viz-* only, the stylesheet never re-maps grid, axis, hatch or wash, and no chart reads a store or status colour from it', () => {
  const css = readFileSync(new URL('../../styles/tint.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /--viz-(grid|axis|hatch|wash|line-width|area-opacity|glow)[a-z-]*\s*:/);
  assert.match(css, /--viz-1:\s*var\(--app-viz-1, var\(--viz-1-default\)\)/);
  const chart = readFileSync(new URL('../../components/analytics/Chart.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(chart.slice(chart.indexOf('<style>')), /var\(--(ok|bad|warn)[a-z-]*\)[^;]*;[^}]*(stroke|fill): var\(--viz/);
});
