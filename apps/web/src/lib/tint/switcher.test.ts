import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLimiter, rowTintStyle } from './switcher.ts';
import { deriveTint, tintStyle } from './tokens.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a row takes the tint of its own app, never the surrounding one', () => {
  const orange = tintStyle(deriveTint('#e8782a'));
  const green = tintStyle(deriveTint('#2f9e5b'));
  const styles: Record<string, string> = { weather: orange, scanner: green };
  const styleOf = (id: string) => styles[id] ?? '';
  assert.equal(rowTintStyle({ key: 'scanner', ids: ['scanner'] }, styleOf), green);
  assert.equal(rowTintStyle({ key: 'weather', ids: ['weather'] }, styleOf), orange);
  assert.notEqual(green, orange);
});

test('an app whose palette is not known has no tint, and a later record of the app is tried', () => {
  assert.equal(rowTintStyle({ key: 'x', ids: ['x', 'y'] }, () => ''), '');
  assert.equal(rowTintStyle({ key: 'x', ids: ['x', 'y'] }, (id) => (id === 'y' ? '--a:1;' : '')), '--a:1;');
});

test('the limiter runs at most N jobs at once and each key once', async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  let done = 0;
  const job = () => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    done += 1;
  };
  for (const k of ['a', 'b', 'c', 'd', 'e', 'a', 'b']) run(k, job());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(done, 5);
  assert.equal(peak, 2);
});

test('the switcher list scopes each row, and the popup resets the surrounding tint', () => {
  const list = read('../../components/app/AppSwitcherList.svelte');
  const li = /<li\b[^>]*>/s.exec(list.slice(list.indexOf('{#each')))?.[0] ?? '';
  assert.match(li, /data-app-tint=\{rowTint/);
  assert.match(li, /style=\{rowTint/);
  assert.match(list, /rowTintStyle\(item, \(id\) => tint\.style\(id\)\)/);
  // The icon is plain: no ring, circle or coloured tile behind it.
  assert.match(list, /<AppIcon [^>]*\bneutral\b/);
  assert.doesNotMatch(list.slice(list.indexOf('<style>')), /\.ico\b|border-radius:\s*(50%|var\(--radius-full\))/);
  assert.doesNotMatch(list.slice(list.indexOf('<style>')), /box-shadow:\s*0 0 0 \d+px/);
  assert.match(list.slice(list.indexOf('<style>')), /li\.open \{\s*box-shadow: inset 3px 0 0 var\(--app-accent/);
  // The open app is not marked by being the one tinted name.
  assert.doesNotMatch(list.slice(list.indexOf('<style>')), /li\.open \.name \{[^}]*color:/);
  assert.match(list, /name="check"/);
  const field = read('../../components/app/AppSwitcherField.svelte');
  assert.match(field, /<div class="pop" data-tint-reset/);
  assert.match(field, /<AppIcon [^>]*\bneutral\b/);
  assert.match(read('../../components/app/AppNav.svelte'), /<AppIcon [^>]*\bneutral\b/);
  const icon = read('../../components/ui/AppIcon.svelte');
  assert.match(icon, /\.app-icon\.neutral \{\s*--tile: var\(--surface-sunken\)/);
});

test('the pending cart button carries the tint marker itself, and the top bar does not', () => {
  const btn = read('../../components/app/PendingCartButton.svelte');
  assert.match(btn, /data-app-tint=\{tintStyle \? '' : undefined\}/);
  const shell = read('../../components/Shell.svelte');
  assert.match(shell, /<PendingCartButton tintStyle=\{appTintStyle\} \/>/);
  assert.match(shell, /data-app-tint-glow/);
  assert.doesNotMatch(/<header[^>]*>/.exec(shell)?.[0] ?? '', /data-app-tint/);
});

test('the This app group tints its entries and the workspace group does not', () => {
  const nav = read('../../components/app/AppNav.svelte');
  assert.match(nav, /<nav class="this-app"[^>]*data-app-tint=/);
  assert.match(nav, /nav\.this-app a :global\(\.icon\)\s*\{\s*color: var\(--app-accent-ink/);
  assert.match(nav, /nav\.this-app a:not\(\[aria-current='page'\]\):hover\s*\{\s*background: var\(--app-tint-subtle/);
  assert.doesNotMatch(nav, /nav\.workspace[^{]*\{[^}]*--app-/);
  assert.match(nav, /<nav class="workspace"(?![^>]*data-app-tint)/);
});
