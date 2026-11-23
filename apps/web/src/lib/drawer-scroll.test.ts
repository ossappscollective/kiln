import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// A side drawer: fixed header, one scrolling body. A flex child scrolls only with min-height: 0, and cards (overflow: hidden)
// would otherwise shrink and clip instead (the "cut off at the bottom" bug).
for (const file of ['listing/LocaleDrawer', 'listing/HistoryDrawer', 'ci/RunDrawer', 'app/PendingCartDrawer']) {
  test(`${file}: the body is the single scroll container`, () => {
    const css = readFileSync(new URL(`../components/${file}.svelte`, import.meta.url), 'utf8').split('<style>')[1] ?? '';
    const rule = (sel: string) => new RegExp(`\\n  ${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const body = rule('.body');
    assert.match(body, /min-height:\s*0/);
    assert.match(body, /overflow:\s*auto/);
    assert.match(body, /overscroll-behavior:\s*contain/);
    assert.match(rule('.surface'), /min-height:\s*0/);
    assert.match(rule('header'), /flex:\s*none/);
  });
}

test('LocaleDrawer: cards inside the body never shrink', () => {
  const src = readFileSync(new URL('../components/listing/LocaleDrawer.svelte', import.meta.url), 'utf8');
  assert.match(src, /\.body > :global\(\*\) \{\s*flex-shrink: 0;/);
});
