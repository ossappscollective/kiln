import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCollapsed, parseCollapsed, railApplies, saveCollapsed, sidebarStorageKey } from './sidebar-state.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('parseCollapsed reads only the two stored values', () => {
  assert.equal(parseCollapsed('1'), true);
  assert.equal(parseCollapsed('0'), false);
  assert.equal(parseCollapsed('yes'), null);
  assert.equal(parseCollapsed(null), null);
});

test('the choice is kept per person', () => {
  const s = memory();
  saveCollapsed('u1', true, s);
  assert.equal(loadCollapsed('u1', false, s), true);
  assert.equal(loadCollapsed('u2', false, s), false);
  assert.notEqual(sidebarStorageKey('u1'), sidebarStorageKey('u2'));
});

test('a store that throws falls back and never throws', () => {
  const bad = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  assert.equal(loadCollapsed('u1', false, bad), false);
  assert.equal(loadCollapsed('u1', true, bad), true);
  assert.doesNotThrow(() => saveCollapsed('u1', true, bad));
  assert.equal(loadCollapsed('u1', false, null), false);
});

test('the rail applies only on a wide screen', () => {
  assert.equal(railApplies(true, true), true);
  assert.equal(railApplies(true, false), false);
  assert.equal(railApplies(false, true), false);
});
