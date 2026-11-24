import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { contrast, graphicPairs, palette, textPairs, themeNames } from './tokens.ts';

for (const theme of themeNames) {
  test(`${theme}: text pairs meet WCAG AA`, () => {
    const failures: string[] = [];
    for (const [fg, bg, min] of textPairs) {
      const ratio = contrast(palette[theme][fg], palette[theme][bg]);
      if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${theme}: status colors and the focus ring reach 3:1`, () => {
    const failures: string[] = [];
    for (const [fg, bg, min] of graphicPairs) {
      const ratio = contrast(palette[theme][fg], palette[theme][bg]);
      if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, []);
  });
}

// The formatter writes CSS strings with double quotes: compare with one quote style.
const css = readFileSync(new URL('../styles/theme.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll('"', "'");

/** The body of the first rule whose selector is exactly `selector`, searched from `from`. */
function ruleBody(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  assert.notEqual(start, -1, `theme.css has no rule for ${selector}`);
  let depth = 0;
  const open = css.indexOf('{', start);
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`Unclosed rule for ${selector}`);
}

function hexTokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm))
    out[m[1] as string] = (m[2] as string).toLowerCase();
  return out;
}

const blocks: Array<[string, string, 'light' | 'dark']> = [
  ['light', ':root', 'light'],
  ['dark by choice', ":root[data-theme='dark']", 'dark'],
  ['dark by system preference', ":root:not([data-theme='light'])", 'dark'],
];

for (const [name, selector, theme] of blocks) {
  test(`theme.css mirrors the ${name} tokens in tokens.ts`, () => {
    const from =
      selector === ":root:not([data-theme='light'])"
        ? css.indexOf('prefers-color-scheme: dark')
        : 0;
    assert.deepEqual(hexTokens(ruleBody(selector, from)), palette[theme]);
  });
}

test('theme.css keeps the dark tokens of the explicit and the system block identical', () => {
  const chosen = ruleBody(":root[data-theme='dark']");
  const system = ruleBody(
    ":root:not([data-theme='light'])",
    css.indexOf('prefers-color-scheme: dark'),
  );
  const lines = (body: string) =>
    body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  assert.deepEqual(lines(system), lines(chosen));
});

test('theme.css defines the brand gradient stops once, as the logo draws them', () => {
  const shared = ruleBody(':root', css.lastIndexOf(':root {'));
  const stops = hexOf(shared, /^\s*--brand-(blue|violet|ember):\s*(#[0-9a-fA-F]{6});/gm);
  assert.deepEqual(stops, { blue: '#7f99ff', violet: '#a98bff', ember: '#ffb04a' });
});

function hexOf(body: string, re: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(re)) out[m[1] as string] = (m[2] as string).toLowerCase();
  return out;
}

// No hard-coded colors in the screens: a color is a token in styles/theme.css. The allowed exceptions are drawn on
// purpose in fixed colors: the Kiln mark (Logo.svelte) and the QR codes (black on white, so a phone can scan them).
const here = fileURLToPath(new URL('..', import.meta.url));
const allowedLiterals = [
  'components/ui/Logo.svelte',
  'components/QrCode.svelte',
  'components/builds/PhoneLinkDialog.svelte',
  'components/builds/InternalShareDialog.svelte',
  'components/builds/TestFlightLinks.svelte',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.svelte') || e.name.endsWith('.css')
        ? [join(dir, e.name)]
        : [],
  );
}

test('components and app.css hard-code no colors', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(here)) {
    const rel = relative(here, file).replaceAll('\\', '/');
    if (rel === 'styles/theme.css' || allowedLiterals.includes(rel)) continue;
    // Only styles count: drop markup text such as "a colour such as #ffffff" by looking at CSS declarations and SVG attributes.
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const hits =
      text.match(/(?:^|[\s:(,'"])(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))(?=[\s;,)'"]|$)/gm) ?? [];
    const real = hits.filter((h) => !/colour such as/.test(h));
    if (real.length > 0 && !(rel === 'app.css' && real.every((h) => /#(000|fff)$/i.test(h.trim()))))
      offenders.push(`${rel}: ${real.map((h) => h.trim()).join(', ')}`);
  }
  assert.deepEqual(offenders, []);
});

// `--accent-ink` is the text ON a solid accent (white in light); on the pale `--accent-bg` it vanishes. A selected chip uses
// `--chip-ink` on `--chip-bg` (a tested pair): see components/ui/FilterChip.svelte.
test('no rule pairs --accent-ink text with a pale --accent-bg / --chip-bg background', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(here)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2] as string;
      if (
        /(^|[\s;])color:\s*var\(--accent-ink\)/.test(body) &&
        /background(-color)?:\s*var\(--(accent-bg|chip-bg|accent-soft)\)/.test(body)
      )
        offenders.push(`${relative(here, file)}: ${(m[1] as string).trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
