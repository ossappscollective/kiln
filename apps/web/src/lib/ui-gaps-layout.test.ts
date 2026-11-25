import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const css = (s: string): string => s.slice(s.indexOf('<style>'));
const shell = read('../components/Shell.svelte');
const list = read('../components/app/AppSwitcherList.svelte');
const section = read('../components/app/AppSection.svelte');
const views = read('./views.ts');

test('left nav: a label stays on one line and gives way before the count and the hint', () => {
  const style = css(shell);
  assert.match(
    style,
    /nav a > span:not\(\.nav-count\):not\(\.visually-hidden\)\) \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
  );
  assert.match(style, /\.nav-count\) \{\s*flex-shrink: 0;\s*padding-inline: var\(--space-1\);/);
  assert.match(style, /\.nav-hint\) \{\s*flex-shrink: 0;/);
});

test('left nav: the workspace entries use the short names of the app-level group; titles keep the long ones', () => {
  assert.match(views, /labelKey: k\('shell:nav\.reviews'\),\s*navLabelKey: k\('app:rail\.inbox'\)/);
  assert.match(
    views,
    /labelKey: k\('shell:nav\.pending'\),\s*navLabelKey: k\('app:rail\.pending'\)/,
  );
  assert.match(shell, /<span>\{t\(v\.navLabelKey \?\? v\.labelKey\)\}<\/span>/);
  assert.match(shell, /section: current \? \{ label: t\(current\.labelKey\)/);
});

test('app switcher rows: the name has its own line; the pending chip shares the meta line with the ids', () => {
  const markup = list.slice(list.indexOf('<ul {id}'), list.indexOf('<style>'));
  const head =
    /<span class="head">([\s\S]*?)<\/span>\s*<span class="meta">/.exec(markup)?.[1] ?? '';
  assert.match(head, /class="name"/);
  assert.doesNotMatch(head, /class="chip"|PendingChip/);
  assert.match(markup, /<span class="meta">\s*<code class="ids"[\s\S]*<span class="chip">/);
  const style = css(list);
  assert.match(style, /\.chip \{\s*flex: none;/);
  assert.match(
    style,
    /\.ids \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/s,
  );
  assert.match(style, /\.name \{[^}]*white-space: nowrap;[^}]*\}/s);
  assert.match(style, /grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(markup, /data-app-tint=\{rowTint/);
});

test('Builds > Test builds: the Expo callout and the cards are one stack with a gap', () => {
  const snippet = section.slice(section.indexOf('{#snippet testBuilds'));
  assert.match(
    snippet.slice(0, snippet.indexOf('{/snippet}')),
    /<div class="stack">\s*<ConnectCallout [^>]*kind="expo" \/>\s*<TestBuilds /,
  );
});
