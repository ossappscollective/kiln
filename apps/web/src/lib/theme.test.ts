import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_KEY, applyThemePref, parseThemePref, readThemePref, saveThemePref } from './theme.ts';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test('parseThemePref accepts only light and dark', () => {
  assert.equal(parseThemePref('dark'), 'dark');
  assert.equal(parseThemePref('light'), 'light');
  assert.equal(parseThemePref('auto'), 'auto');
  assert.equal(parseThemePref('purple'), 'auto');
  assert.equal(parseThemePref(null), 'auto');
});

test('the preference round-trips through storage, and auto clears it', () => {
  const store = memory();
  saveThemePref('dark', store);
  assert.equal(store.data.get(THEME_KEY), 'dark');
  assert.equal(readThemePref(store), 'dark');
  saveThemePref('auto', store);
  assert.equal(store.data.has(THEME_KEY), false);
  assert.equal(readThemePref(store), 'auto');
});

test('storage that throws or is missing never breaks the theme', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readThemePref(broken), 'auto');
  assert.doesNotThrow(() => saveThemePref('light', broken));
  assert.equal(readThemePref(undefined), 'auto');
});

test('applyThemePref sets data-theme for a choice and removes it for auto', () => {
  const attrs = new Map<string, string>();
  const root = { setAttribute: (n: string, v: string) => void attrs.set(n, v), removeAttribute: (n: string) => void attrs.delete(n) };
  applyThemePref('dark', root);
  assert.equal(attrs.get('data-theme'), 'dark');
  applyThemePref('auto', root);
  assert.equal(attrs.has('data-theme'), false);
});
