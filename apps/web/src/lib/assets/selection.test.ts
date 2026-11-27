import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allSelected,
  click,
  isSelected,
  NO_SELECTION,
  prune,
  selectAll,
  selectedInOrder,
  selectionSize,
  selectRange,
  toggle,
} from './selection.ts';

const order = ['a', 'b', 'c', 'd', 'e'];

test('a tick toggles one image and makes it the anchor', () => {
  const one = toggle(NO_SELECTION, 'b');
  assert.deepEqual(one, { keys: ['b'], anchor: 'b' });
  const two = toggle(one, 'd');
  assert.deepEqual(two.keys, ['b', 'd']);
  const off = toggle(two, 'b');
  assert.deepEqual(off, { keys: ['d'], anchor: 'b' });
  assert.equal(selectionSize(off), 1);
  assert.equal(NO_SELECTION.keys.length, 0, 'the empty selection is never changed');
});

test('shift-click ticks every image from the anchor to the one clicked, in either direction', () => {
  const from = toggle(NO_SELECTION, 'b');
  assert.deepEqual(selectedInOrder(selectRange(from, order, 'd'), order), ['b', 'c', 'd']);
  const backwards = toggle(NO_SELECTION, 'd');
  assert.deepEqual(selectedInOrder(selectRange(backwards, order, 'a'), order), [
    'a',
    'b',
    'c',
    'd',
  ]);
  const extended = selectRange(selectRange(from, order, 'c'), order, 'e');
  assert.deepEqual(selectedInOrder(extended, order), ['b', 'c', 'd', 'e'], 'the anchor stays');
  assert.equal(extended.anchor, 'b');
});

test('a range without an anchor, or with an unknown image, is a plain tick or nothing', () => {
  assert.deepEqual(selectRange(NO_SELECTION, order, 'c'), { keys: ['c'], anchor: 'c' });
  const lost = { keys: ['x'], anchor: 'x' };
  assert.deepEqual(selectRange(lost, order, 'c'), { keys: ['x', 'c'], anchor: 'c' });
  assert.equal(selectRange(from('a'), order, 'nope').keys.length, 1);
  function from(key: string) {
    return toggle(NO_SELECTION, key);
  }
});

test('click is a range with Shift and a toggle without', () => {
  const first = click(NO_SELECTION, order, 'a', false);
  assert.deepEqual(click(first, order, 'c', true).keys, ['a', 'b', 'c']);
  assert.deepEqual(click(first, order, 'c', false).keys, ['a', 'c']);
});

test('select all ticks the whole set, and clearing is the empty selection', () => {
  const all = selectAll(order);
  assert.equal(allSelected(all, order), true);
  assert.equal(selectionSize(all), 5);
  assert.equal(allSelected(toggle(all, 'c'), order), false);
  assert.equal(allSelected(NO_SELECTION, []), false, 'an empty set has nothing to select');
  assert.deepEqual(selectAll([]), NO_SELECTION);
  assert.equal(isSelected(all, 'e'), true);
});

test('the keys come back in the order of the set, whatever order they were ticked in', () => {
  const s = toggle(toggle(toggle(NO_SELECTION, 'e'), 'a'), 'c');
  assert.deepEqual(selectedInOrder(s, order), ['a', 'c', 'e']);
});

test('a set that lost images drops them from the selection and keeps the rest (the same object when nothing changed)', () => {
  const s = selectRange(toggle(NO_SELECTION, 'a'), order, 'c');
  assert.equal(prune(s, order), s);
  const pruned = prune(s, ['a', 'c', 'd']);
  assert.deepEqual(pruned.keys, ['a', 'c']);
  assert.equal(pruned.anchor, 'a');
  assert.deepEqual(prune(s, ['c']).anchor, null, 'the anchor is gone with its image');
});
