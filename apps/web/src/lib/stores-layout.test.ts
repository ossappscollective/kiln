import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const stores = read('../components/app/settings/StoresSection.svelte');
const copyValue = read('../components/ui/CopyValue.svelte');
const identifiers = read('../components/credentials/CredentialIdentifiers.svelte');
const css = (s: string): string => s.slice(s.indexOf('<style>'));

test('Stores: one label column (label, value) for the whole record card, no fixed multi-column row', () => {
  const style = css(stores);
  assert.ok(style.includes('grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr)'));
  assert.ok(style.includes('grid-template-columns: subgrid'));
  assert.doesNotMatch(style, /repeat\(\s*(auto-fit|auto-fill|[3-9])/);
  assert.doesNotMatch(style, /grid-template-columns:\s*repeat\(4/);
  assert.match(style, /@container \(min-width: 1100px\)/);
  assert.match(style, /@container \(max-width: 519px\)/);
  assert.match(stores, /<header class="head">[\s\S]*PlatformBadge[\s\S]*storeName\(app\.platform\)/);
});

test('Stores: bundle id, store id and identifiers go through CopyValue; groups for credential and identifiers', () => {
  assert.match(stores, /<CopyValue value=\{app\.identifier\}/);
  assert.match(stores, /<CopyValue value=\{app\.storeAppId\}/);
  assert.match(stores, /<CredentialIdentifiers compact aligned/);
  assert.ok(stores.indexOf("t('app:stores.credential')") < stores.indexOf("t('app:stores.identifiers')"));
  assert.doesNotMatch(stores, /<code>/);
});

test('CopyValue: one line with ellipsis, copy button inline after the value, wraps below 420px, tokens only', () => {
  const style = css(copyValue);
  const line = copyValue.slice(copyValue.indexOf('<div class="line">'), copyValue.indexOf('</div>', copyValue.indexOf('<div class="line">')));
  assert.ok(line.indexOf('<code') >= 0 && line.indexOf('<code') < line.indexOf('CopyButton'));
  assert.match(copyValue, /<CopyButton \{value\} iconOnly label=\{copyLabel\}/);
  assert.match(style, /\.line \{[^}]*display: flex/);
  assert.match(style, /\.value \{[^}]*min-width: 0[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(style, /\.copy \{[^}]*flex-shrink: 0/);
  assert.match(style, /@container \(max-width: 419px\)[\s\S]*overflow-wrap: anywhere/);
  assert.match(copyValue, /title=\{shown \?\? value\}/);
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

test('Credential identifiers (credentials page and Stores) share CopyValue and the same label column', () => {
  assert.ok(identifiers.includes('CopyValue'));
  assert.ok(css(identifiers).includes('grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr)'));
  assert.ok(css(identifiers).includes('grid-template-columns: subgrid'));
});
