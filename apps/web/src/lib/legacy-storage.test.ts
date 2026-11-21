import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyKeyOf, readMigrated } from './legacy-storage.ts';
import { readThemePref, saveThemePref } from './theme.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test('the old key of a kiln.* key is its mrm.* name; other keys have none', () => {
  assert.equal(legacyKeyOf('kiln.theme'), 'mrm.theme');
  assert.equal(legacyKeyOf('kiln.sections.v1:w:u:p'), 'mrm.sections.v1:w:u:p');
  assert.equal(legacyKeyOf('other'), null);
});

test('a value saved under the old key is copied to the new key once, and the old key stays', () => {
  const s = fakeStorage({ 'mrm.workspace': 'w-1' });
  assert.equal(readMigrated(s, 'kiln.workspace'), 'w-1');
  assert.equal(s.data.get('kiln.workspace'), 'w-1');
  assert.equal(s.data.get('mrm.workspace'), 'w-1');
  s.data.set('mrm.workspace', 'changed-later');
  assert.equal(readMigrated(s, 'kiln.workspace'), 'w-1', 'the new key now wins');
});

test('the new key wins over the old one, and nothing is made up when neither exists', () => {
  const s = fakeStorage({ 'kiln.theme': 'dark', 'mrm.theme': 'light' });
  assert.equal(readMigrated(s, 'kiln.theme'), 'dark');
  assert.equal(readMigrated(fakeStorage(), 'kiln.theme'), null);
  assert.equal(readMigrated(fakeStorage({ 'mrm.theme': 'x' }), 'unrelated'), null);
});

test('a read-only or refusing storage still returns the old value', () => {
  const readOnly = { getItem: (k: string) => (k === 'mrm.theme' ? 'dark' : null) };
  assert.equal(readMigrated(readOnly, 'kiln.theme'), 'dark');
  const refusing = {
    getItem: (k: string) => (k === 'mrm.theme' ? 'dark' : null),
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(readMigrated(refusing, 'kiln.theme'), 'dark');
});

test('a theme chosen before the rename survives, and choosing auto afterwards is not undone by the old key', () => {
  const s = fakeStorage({ 'mrm.theme': 'dark' });
  assert.equal(readThemePref(s), 'dark');
  saveThemePref('auto', s);
  assert.equal(readThemePref(s), 'auto');
  assert.equal(s.data.has('mrm.theme'), false);
  saveThemePref('light', s);
  assert.equal(s.data.get('kiln.theme'), 'light');
});
