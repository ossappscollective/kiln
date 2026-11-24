import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKey, parseEntry, readEntry, writeEntry } from './cache.ts';
import { oklchToHex } from './oklch.ts';
import { NEUTRAL_PALETTE } from './palette.ts';
import { readTintPref, resolveTint, saveTintPref, TINT_PREF_KEY } from './prefs.ts';
import { deriveTint } from './tokens.ts';

const memory = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
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

/** The tint without its chart tokens (chart-palette.test.ts covers those). */
const plain = (t: ReturnType<typeof resolveTint>) => (t ? { light: t.light, dark: t.dark } : t);

test('the palette cache round-trips per app and survives broken storage and bad entries', () => {
  const s = memory();
  assert.equal(readEntry('a1', s), null);
  writeEntry('a1', { url: '/api/workspaces/w/apps/a1/icon?v=3', palette: { colors: ['#3b82f6', '#e8590c'], neutral: false } }, s);
  assert.deepEqual(readEntry('a1', s)?.palette.colors, ['#3b82f6', '#e8590c']);
  assert.equal(readEntry('a1', s)?.url, '/api/workspaces/w/apps/a1/icon?v=3');
  assert.equal(readEntry('a2', s), null, 'keyed by app');
  writeEntry('n', { url: 'u', palette: NEUTRAL_PALETTE }, s);
  assert.equal(readEntry('n', s)?.palette.neutral, true);
  s.m.set(cacheKey('bad'), '{not json');
  assert.equal(readEntry('bad', s), null);
  assert.equal(parseEntry({ url: 'u', colors: ['red'], neutral: false }), null, 'colours must be hex');
  assert.equal(parseEntry({ url: 'u', colors: [], neutral: false }), null, 'neutral must agree with the colours');
  assert.equal(parseEntry(null), null);
  assert.doesNotThrow(() => writeEntry('a', { url: 'u', palette: NEUTRAL_PALETTE }, broken));
  assert.equal(readEntry('a', broken), null);
});

test('the personal switch is on by default and off only when saved off', () => {
  const s = memory();
  assert.equal(readTintPref(s), true);
  saveTintPref(false, s);
  assert.equal(s.m.get(TINT_PREF_KEY), 'off');
  assert.equal(readTintPref(s), false);
  saveTintPref(true, s);
  assert.equal(readTintPref(s), true);
  assert.equal(s.m.has(TINT_PREF_KEY), false);
  assert.equal(readTintPref(broken), true);
  assert.doesNotThrow(() => saveTintPref(false, broken));
});

const blue = { colors: ['#3b82f6', '#e8590c'], neutral: false };

test('resolveTint: the person, then the app, then the icon; never an invented colour', () => {
  assert.ok(resolveTint({ enabled: true, palette: blue }));
  assert.equal(resolveTint({ enabled: false, palette: blue }), null, 'the personal switch wins');
  assert.equal(resolveTint({ enabled: false, appearance: { tint: 'custom', color: '#3b82f6' } }), null);
  assert.equal(resolveTint({ enabled: true, appearance: { tint: 'off' }, palette: blue }), null, 'off for this app');
  assert.equal(resolveTint({ enabled: true, palette: null }), null, 'no palette: no tint (no colour from an id hash)');
  assert.equal(resolveTint({ enabled: true }), null);
  assert.equal(resolveTint({ enabled: true, palette: NEUTRAL_PALETTE }), null, 'monochrome icon');
  assert.deepEqual(plain(resolveTint({ enabled: true, appearance: { tint: 'custom', color: '#e8590c' }, palette: blue })), deriveTint('#e8590c'), 'custom beats the icon');
  assert.equal(resolveTint({ enabled: true, appearance: { tint: 'custom', color: 'nope' } }), null);
  assert.equal(resolveTint({ enabled: true, appearance: { tint: 'custom', color: '#808080' } }), null, 'a grey pick has no hue to keep');
  assert.deepEqual(plain(resolveTint({ enabled: true, appearance: { tint: 'auto' }, palette: blue })), deriveTint('#3b82f6'));
});

test('both themes derive for a spread of ordinary icon colours', () => {
  let missing = 0;
  for (let h = 0; h < 360; h += 5) for (const c of [0.06, 0.12, 0.18]) for (const l of [0.4, 0.6, 0.8]) if (!deriveTint(oklchToHex(l, c, h))) missing += 1;
  assert.equal(missing, 0);
});

test('tokenRows reports the contrast each pair was derived for, in both themes', async () => {
  const { tokenRows } = await import('./summary.ts');
  const tint = deriveTint('#3b82f6');
  assert.ok(tint);
  const rows = tokenRows(tint);
  assert.deepEqual(rows.map((r) => r.id), ['accent', 'accentInk', 'accentSolid', 'tintSubtle']);
  for (const r of rows) for (const s of ['light', 'dark'] as const) assert.ok(r.ratio[s] >= r.min, `${r.id} ${s} ${r.ratio[s]}`);
});
