import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appSectionDefs } from './app-scope.ts';
import { shortcutFor } from './reviews/reviews.ts';
import {
  appChords,
  CHORD_LEADER,
  CHORD_TIMEOUT_MS,
  chordHint,
  idleChord,
  isTypingTarget,
  reservedKeys,
  shortcutRegistry,
  stepShortcut,
  workspaceChords,
} from './shortcuts.ts';

const press = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  typing: false,
  ...extra,
});

test('chord keys are unique in each context and the leader is not a chord key', () => {
  for (const chords of [appChords, workspaceChords]) {
    const keys = chords.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.includes(CHORD_LEADER));
    assert.ok(chords.every((c) => /^[a-z]$/.test(c.key)));
  }
});

test('every app chord names a real app section, and every section has one', () => {
  const ids = appSectionDefs.map((s) => s.id as string);
  for (const c of appChords) assert.ok(ids.includes(c.target), c.target);
  for (const id of ids)
    assert.ok(
      appChords.some((c) => c.target === id),
      id,
    );
});

test('the leader and the modifier combinations do not clash with the reviews keys', () => {
  assert.ok(!reservedKeys.includes(CHORD_LEADER));
  assert.equal(shortcutFor({ key: CHORD_LEADER, typing: false }), null);
  // The reviews inbox ignores any key with a modifier held, so Cmd or Ctrl + K and + digits are free.
  assert.equal(shortcutFor({ key: 'k', typing: false, metaKey: true }), null);
  assert.equal(shortcutFor({ key: 'k', typing: false, ctrlKey: true }), null);
  assert.equal(shortcutFor({ key: '1', typing: false, ctrlKey: true }), null);
  // The letters after g that the reviews use are only read after g, so a lone press stays the reviews'.
  assert.deepEqual(stepShortcut(idleChord, press('r'), 0, 'app').action, null);
  assert.equal(shortcutFor({ key: 'r', typing: false }), 'reply');
});

test('Cmd or Ctrl + K opens the switcher and Cmd or Ctrl + 1 to 9 jump', () => {
  const k = stepShortcut(idleChord, press('k', { metaKey: true }), 0, 'app');
  assert.deepEqual(k.action, { type: 'open-switcher' });
  assert.equal(k.consume, true);
  assert.deepEqual(stepShortcut(idleChord, press('K', { ctrlKey: true }), 0, 'workspace').action, {
    type: 'open-switcher',
  });
  assert.deepEqual(stepShortcut(idleChord, press('3', { ctrlKey: true }), 0, 'workspace').action, {
    type: 'jump-app',
    index: 2,
  });
  assert.deepEqual(stepShortcut(idleChord, press('9', { metaKey: true }), 0, 'app').action, {
    type: 'jump-app',
    index: 8,
  });
  assert.equal(stepShortcut(idleChord, press('0', { metaKey: true }), 0, 'app').action, null);
  assert.equal(
    stepShortcut(idleChord, press('k', { metaKey: true, shiftKey: true }), 0, 'app').action,
    null,
  );
  assert.equal(
    stepShortcut(idleChord, press('k', { metaKey: true, altKey: true }), 0, 'app').action,
    null,
  );
});

test('g then a letter goes to the section of the context', () => {
  const first = stepShortcut(idleChord, press('g'), 1000, 'app');
  assert.deepEqual(first.action, { type: 'pending' });
  assert.equal(first.consume, false);
  const second = stepShortcut(first.state, press('l'), 1200, 'app');
  assert.deepEqual(second.action, { type: 'go', target: 'listing' });
  assert.equal(second.consume, true);
  assert.deepEqual(second.state, idleChord);
  const ws = stepShortcut(
    stepShortcut(idleChord, press('g'), 0, 'workspace').state,
    press('a'),
    10,
    'workspace',
  );
  assert.deepEqual(ws.action, { type: 'go', target: 'portfolio' });
  // g then r goes to releases; the reviews reply key is consumed so it does not also open a reply.
  const r = stepShortcut(
    stepShortcut(idleChord, press('g'), 0, 'app').state,
    press('r'),
    10,
    'app',
  );
  assert.deepEqual(r.action, { type: 'go', target: 'releases' });
  assert.equal(r.consume, true);
});

test('a chord times out, is cancelled by Escape or by a key that is not a chord', () => {
  const pending = stepShortcut(idleChord, press('g'), 0, 'app').state;
  assert.equal(stepShortcut(pending, press('d'), CHORD_TIMEOUT_MS + 1, 'app').action, null);
  const esc = stepShortcut(pending, press('Escape'), 10, 'app');
  assert.deepEqual(esc.action, { type: 'cancel' });
  assert.deepEqual(esc.state, idleChord);
  const other = stepShortcut(pending, press('j'), 10, 'app');
  assert.deepEqual(other.action, { type: 'cancel' });
  assert.equal(other.consume, false);
  // Shift alone does not break a chord; a shifted letter is not a chord.
  assert.deepEqual(stepShortcut(pending, press('Shift'), 5, 'app').state, pending);
  assert.deepEqual(stepShortcut(pending, press('D', { shiftKey: true }), 10, 'app').action, {
    type: 'cancel',
  });
});

test('nothing fires while typing, in a dialog, with alt, or on a held key', () => {
  assert.equal(stepShortcut(idleChord, press('g', { typing: true }), 0, 'app').action, null);
  const pending = stepShortcut(idleChord, press('g'), 0, 'app').state;
  assert.equal(stepShortcut(pending, press('d', { typing: true }), 5, 'app').action, null);
  assert.equal(stepShortcut(idleChord, press('g', { dialogOpen: true }), 0, 'app').action, null);
  assert.equal(stepShortcut(idleChord, press('g', { altKey: true }), 0, 'app').action, null);
  assert.equal(stepShortcut(idleChord, press('g', { repeat: true }), 0, 'app').action, null);
  assert.equal(
    stepShortcut(idleChord, press('k', { metaKey: true, dialogOpen: true }), 0, 'app').action,
    null,
  );
  // A modifier combination still works from a field.
  assert.deepEqual(
    stepShortcut(idleChord, press('k', { metaKey: true, typing: true }), 0, 'app').action,
    { type: 'open-switcher' },
  );
});

test('isTypingTarget knows fields and editable text', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({}), false);
});

test('chordHint and the registry come from the same tables', () => {
  assert.equal(chordHint('app', 'dashboard'), 'g d');
  assert.equal(chordHint('workspace', 'portfolio'), 'g a');
  assert.equal(chordHint('app', 'nothing'), null);
  const reg = shortcutRegistry('app', 'Cmd');
  assert.ok(reg.some((s) => s.keys === 'Cmd K'));
  assert.equal(reg.filter((s) => s.group === 'Go to').length, appChords.length);
  assert.ok(reg.some((s) => s.group === 'Reviews' && s.keys === 'r'));
});

test('Cmd or Ctrl + B toggles the left panel, but not while typing', () => {
  const b = stepShortcut(idleChord, press('b', { ctrlKey: true }), 0, 'app');
  assert.deepEqual(b.action, { type: 'toggle-sidebar' });
  assert.equal(b.consume, true);
  assert.equal(
    stepShortcut(idleChord, press('b', { ctrlKey: true, typing: true }), 0, 'app').action,
    null,
  );
  assert.equal(stepShortcut(idleChord, press('b'), 0, 'app').action, null);
});
