import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const raw = readFileSync(fileURLToPath(new URL('../../styles/tint.css', import.meta.url)), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { selector: string; body: string };

/** Style rules of a stylesheet, descending into @media; at-rules themselves are not rules. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith('@')) out.push(...rules(body));
    else out.push({ selector: head, body });
    i = j;
  }
  return out;
}

const all = rules(css);

/** The comma separated parts of a selector list, not splitting inside parentheses. */
const parts = (selector: string): string[] => selector.split(/,(?![^(]*\))/).map((x) => x.trim());

test('the tint stylesheet scopes every tint token under [data-app-tint]', () => {
  assert.ok(all.length >= 6);
  for (const { selector, body } of all) {
    const scoped = parts(selector).every((s) => /\[data-app-tint(-glow)?\]/.test(s));
    if (scoped) continue;
    // The one allowed exception: the root snapshot of the default tokens, which only declares `--*-default`.
    assert.equal(selector, ':root', `a global selector in tint.css: ${selector}`);
    const props = [...body.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1] as string);
    assert.ok(props.length > 0 && props.every((p) => p.endsWith('-default')), `the :root rule declares only defaults: ${props.join(', ')}`);
  }
});

test('no global element, class or id selector, and no colour literal', () => {
  for (const { selector } of all) {
    if (selector === ':root') continue;
    for (const part of parts(selector)) assert.match(part, /^(:root[^ ]* )?\[data-app-tint(-glow)?\]/, part);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/.test(css), 'tokens only');
});

test('status colours, focus and surfaces are never re-mapped', () => {
  const props = all.flatMap((r) => [...r.body.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1] as string));
  const never = /^--(ok|bad|warn|info|danger|focus|ring|halo|ground|surface|sidebar|ink|muted|faint|line|scrim)(-|$)/;
  for (const p of props) assert.ok(!never.test(p), `${p} must not be re-mapped`);
});

test('forced colours and more contrast turn the tint off, and dialogs get the defaults back', () => {
  assert.match(css, /@media not \(\(prefers-contrast: more\) or \(forced-colors: active\)\)/);
  const reset = all.find((r) => r.selector.includes('dialog'));
  assert.ok(reset);
  assert.match(reset.selector, /^\[data-app-tint\] :is\(dialog, \[data-tint-reset\]\)$/);
  // Every token re-mapped for the app has its default put back.
  const remapped = (all.find((r) => r.selector === '[data-app-tint]')?.body.match(/--[a-z-]+(?=\s*:)/g) ?? []).filter((p) => !p.startsWith('--app-'));
  const restored = reset.body.match(/--[a-z-]+(?=\s*:)/g) ?? [];
  for (const p of remapped) assert.ok(restored.includes(p), `${p} is not restored for dialogs`);
});

test('the light, dark and system-dark sets define the same tokens', () => {
  const sets = all.filter((r) => r.body.includes('--app-accent:'));
  assert.equal(sets.length, 3);
  const names = (b: string) => (b.match(/--app-[a-z-]+(?=\s*:)/g) ?? []).sort().join();
  assert.equal(new Set(sets.map((s) => names(s.body))).size, 1);
  assert.equal(sets[1]?.body.replace(/\s+/g, ''), sets[2]?.body.replace(/\s+/g, ''), 'dark by choice and dark by system are identical');
});
