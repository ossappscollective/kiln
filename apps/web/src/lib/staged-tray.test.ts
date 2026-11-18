import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trayIsFull, trayLine } from './staged-tray.ts';

const base = { items: 0, loading: false, loadFailed: false, availability: 'ready' as const };

test('the tray is full only when something is staged', () => {
  assert.equal(trayIsFull({ items: 0 }), false);
  assert.equal(trayIsFull({ items: 2 }), true);
});

test('a failed load wins over everything, then loading, then the switch', () => {
  assert.deepEqual(trayLine({ ...base, loadFailed: true, availability: 'off' }), { tone: 'bad', text: 'Could not load the staged changes' });
  assert.equal(trayLine({ ...base, loading: true }).text, 'Checking the staged changes…');
  assert.deepEqual(trayLine({ ...base, availability: 'off' }), { tone: 'info', text: 'Nothing staged. Pushing drafts is switched off' });
  assert.equal(trayLine({ ...base, availability: 'role' }).text, 'Nothing staged. Pushing needs the admin or owner role');
  assert.equal(trayLine({ ...base, availability: 'unknown' }).tone, 'info');
});

test('plain empty and ready', () => {
  assert.deepEqual(trayLine(base), { tone: 'neutral', text: 'Nothing staged' });
  assert.deepEqual(trayLine({ ...base, availability: 'loading' }), { tone: 'neutral', text: 'Nothing staged' });
});
