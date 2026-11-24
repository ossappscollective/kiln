import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The "4 staged" chip of the Locales table once sat over the STORES icons and was cut off. Guard the layout contract at the source:
// the chip lives in the locale cell's wrapping flex row, in normal flow, and the stores column keeps the room of its badges.
const src = readFileSync(new URL('../components/listing/ListingMatrix.svelte', import.meta.url), 'utf8');
const markup = src.slice(0, src.indexOf('<style>'));
const css = src.slice(src.indexOf('<style>') + 7).replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel: string): string => {
  const m = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].find((x) => (x[1] as string).split(',').map((p) => p.trim()).includes(sel));
  assert.ok(m, `rule ${sel}`);
  return m[2] as string;
};

test('the staged chip is in the locale cell flow, next to the locale button, before the stores cell', () => {
  const th = markup.slice(markup.indexOf('<th scope="row" class="loc">'));
  const cell = th.slice(0, th.indexOf('</th>'));
  assert.match(cell, /<div class="loc-cell">/);
  assert.ok(cell.indexOf('locale-btn') < cell.indexOf('staged-chip'), 'the chip follows the locale button');
  assert.ok(cell.indexOf('staged-chip') < cell.indexOf('</div>'), 'the chip is inside the wrapping row');
  assert.match(th, /<td class="stores">\s*<div class="store-badges">/);
});

test('no rule of the locale cell, the chip or the stores column positions anything out of flow', () => {
  for (const sel of ['.loc-cell', '.loc-cell .locale-btn', 'button.bare.staged-chip', '.stores', '.store-badges']) {
    const body = rule(sel);
    assert.doesNotMatch(body, /position:\s*(absolute|fixed|relative)/, sel);
    assert.doesNotMatch(body, /(top|left|right|bottom|inset)\s*:/, sel);
    assert.doesNotMatch(body, /margin[a-z-]*:\s*-/, `${sel}: no negative margin`);
    assert.doesNotMatch(body, /transform\s*:/, sel);
  }
});

test('the locale cell wraps, its button gives way, the chip never shrinks or breaks', () => {
  assert.match(rule('.loc-cell'), /display:\s*flex/);
  assert.match(rule('.loc-cell'), /flex-wrap:\s*wrap/);
  assert.match(rule('.loc-cell .locale-btn'), /min-width:\s*0/);
  const chip = rule('button.bare.staged-chip');
  assert.match(chip, /flex:\s*none/);
  assert.match(chip, /white-space:\s*nowrap/);
});

test('the stores column keeps a fixed minimum width and its badges never shrink or wrap', () => {
  assert.match(rule('.stores'), /min-width:\s*[\d.]+rem/);
  assert.match(rule('.stores'), /white-space:\s*nowrap/);
  const badges = rule('.store-badges');
  assert.match(badges, /flex-shrink:\s*0/);
  assert.match(badges, /flex-wrap:\s*nowrap/);
});

test('a row with a chip and a row without keep the same columns: the chip adds no cell and no fixed row height', () => {
  assert.doesNotMatch(markup.slice(markup.indexOf('{#each rows as row')), /staged-chip[^>]*style=/);
  assert.doesNotMatch(css, /\.matrix\s+tr[^{]*\{[^}]*height\s*:/);
  const rowCells = markup.slice(markup.indexOf('<tr class:current'), markup.indexOf('</tr>', markup.indexOf('<tr class:current')));
  assert.equal((rowCells.match(/<th scope="row"/g) ?? []).length, 1);
});
