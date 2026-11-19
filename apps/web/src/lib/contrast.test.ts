import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll('"', "'");

/** The body of the first rule whose selector is exactly `selector`, searched from `from`. */
function ruleBody(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  assert.notEqual(start, -1, `app.css has no rule for ${selector}`);
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
  test(`app.css mirrors the ${name} tokens in tokens.ts`, () => {
    const from =
      selector === ":root:not([data-theme='light'])"
        ? css.indexOf('prefers-color-scheme: dark')
        : 0;
    assert.deepEqual(hexTokens(ruleBody(selector, from)), palette[theme]);
  });
}
