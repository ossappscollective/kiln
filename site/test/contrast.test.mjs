import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const here = (rel) => new URL(rel, import.meta.url);
const tokensCss = readFileSync(here('../static/css/tokens.css'), 'utf8');

/** Body of the first rule whose selector is exactly `selector` (comments removed first). */
export function ruleBody(css, selector, from = 0) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replaceAll("'", '"');
  const start = clean.indexOf(`${selector} {`, from);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  let depth = 0;
  const open = clean.indexOf('{', start);
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}' && --depth === 0) return clean.slice(open + 1, i);
  }
  throw new Error(`unterminated rule ${selector}`);
}

export function vars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1].slice(2)] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}

/** The three theme blocks of a theme file: light, dark by choice, dark from the system setting. */
export function themes(css) {
  const light = vars(ruleBody(css, ':root'));
  const dark = vars(ruleBody(css, ':root[data-theme="dark"]'));
  const media = css.replace(/\/\*[\s\S]*?\*\//g, '').indexOf('@media (prefers-color-scheme: dark)');
  const darkMedia = vars(ruleBody(css, ':root:not([data-theme="light"])', media));
  return { light, dark, darkMedia };
}

const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? v : null);

function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const { light, dark, darkMedia } = themes(tokensCss);

// [foreground, background]: text and text-like pairs the site really draws, 4.5:1
const TEXT = [
  ['ink', 'ground'], ['ink', 'surface'], ['ink', 'surface-sunken'], ['ink', 'surface-hover'], ['ink', 'accent-bg'],
  ['muted', 'ground'], ['muted', 'surface'], ['muted', 'surface-sunken'], ['muted', 'surface-hover'],
  ['faint', 'ground'], ['faint', 'surface'], ['faint', 'surface-sunken'], ['faint', 'surface-hover'],
  ['accent', 'ground'], ['accent', 'surface'], ['accent', 'surface-sunken'], ['accent', 'surface-hover'],
  ['accent-hover', 'ground'], ['accent-hover', 'surface'], ['accent-hover', 'surface-sunken'],
  ['accent-ink', 'primary-from'], ['accent-ink', 'primary-to'],
  ['chip-ink', 'accent-bg'], ['chip-ink', 'surface-active'],
  ['title-end', 'ground'],
  ['ok-ink', 'ok-bg'], ['warn-ink', 'warn-bg'], ['info-ink', 'info-bg'], ['bad-ink', 'bad-bg'],
  ['platform-ios-ink', 'platform-ios-bg'], ['platform-macos-ink', 'platform-macos-bg'], ['platform-android-ink', 'platform-android-bg'],
];
// interface parts and graphics, 3:1
const UI = [
  ['focus', 'ground'], ['focus', 'surface'], ['focus', 'surface-sunken'],
  ['accent', 'ground'], ['ok', 'ground'], ['warn', 'warn-bg'], ['warn', 'surface'],
];

for (const [name, theme] of [['light', light], ['dark', dark], ['dark (system setting)', darkMedia]]) {
  test(`${name}: text pairs meet WCAG AA (4.5:1)`, () => {
    const failures = [];
    for (const [fg, bg] of TEXT) {
      const a = hex(theme[fg] ?? light[fg]);
      const b = hex(theme[bg] ?? light[bg]);
      assert.ok(a && b, `${fg} or ${bg} is not a solid #rrggbb colour in ${name}`);
      const ratio = contrast(a, b);
      if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${name}: interface colours reach 3:1`, () => {
    const failures = [];
    for (const [fg, bg] of UI) {
      const a = hex(theme[fg] ?? light[fg]);
      const b = hex(theme[bg] ?? light[bg]);
      assert.ok(a && b, `${fg} or ${bg} missing in ${name}`);
      const ratio = contrast(a, b);
      if (ratio < 3) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('the two dark blocks are identical', () => {
  assert.deepEqual(darkMedia, dark);
});

test('contrast helper: known values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#777777', '#777777'), 1);
});

test('site stylesheets use tokens, not colours of their own (print rules excepted)', () => {
  for (const f of ['site.css', 'home.css', 'docs.css']) {
    const css = readFileSync(here(`../static/css/${f}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const screen = css.includes('@media print') ? css.slice(0, css.indexOf('@media print')) : css;
    const withoutDataUris = screen.replace(/url\("data:[^"]*"\)/g, '');
    assert.deepEqual(withoutDataUris.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], `${f} hard-codes a hex colour`);
    assert.deepEqual(withoutDataUris.match(/\brgba?\(/g) ?? [], [], `${f} hard-codes an rgb colour`);
  }
});

// The site copies the app's tokens. When the app's theme file is next to it, the solid colours must be the same.
const appTheme = here('../../apps/web/src/styles/theme.css');
test('solid colours match the app theme (apps/web/src/styles/theme.css)', { skip: !existsSync(appTheme) }, () => {
  const app = themes(readFileSync(appTheme, 'utf8'));
  const mine = themes(tokensCss);
  const diffs = [];
  for (const block of ['light', 'dark', 'darkMedia']) {
    for (const [k, v] of Object.entries(mine[block])) {
      if (hex(v) && hex(app[block][k]) && app[block][k].toLowerCase() !== v.toLowerCase()) diffs.push(`${block} --${k}: ${v} vs app ${app[block][k]}`);
    }
    for (const [k, v] of Object.entries(app[block])) {
      if (hex(v) && !(k in mine[block])) diffs.push(`${block} --${k} is missing from the site tokens`);
    }
  }
  assert.deepEqual(diffs, []);
});
