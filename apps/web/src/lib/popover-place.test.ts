import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placePopover } from './popover-place.ts';

const box = (left: number, top: number, width = 100, height = 32) => ({ left, top, right: left + width, bottom: top + height });
const vp = { width: 800, height: 600 };

test('opens below the anchor, lined up with its start edge', () => {
  const p = placePopover({ anchor: box(40, 100), viewport: vp, size: { width: 300, height: 200 } });
  assert.deepEqual([p.placement, p.left, p.top, p.width], ['below', 40, 136, 300]);
  assert.equal(p.maxHeight, 600 - 132 - 4 - 8);
});

test('end alignment lines the right edges up', () => {
  const p = placePopover({ anchor: box(600, 10), viewport: vp, size: { width: 300, height: 100 }, align: 'end' });
  assert.equal(p.left + p.width, 700);
});

test('is clamped to the window sideways instead of being cut off at the edge', () => {
  const right = placePopover({ anchor: box(700, 10), viewport: vp, size: { width: 300, height: 100 } });
  assert.equal(right.left + right.width, 800 - 8);
  const left = placePopover({ anchor: box(0, 10, 20), viewport: vp, size: { width: 300, height: 100 }, align: 'end' });
  assert.equal(left.left, 8);
});

test('is never wider than the window less its margins', () => {
  const p = placePopover({ anchor: box(10, 10), viewport: { width: 360, height: 600 }, size: { width: 520, height: 100 } });
  assert.deepEqual([p.width, p.maxWidth, p.left], [344, 344, 8]);
});

test('flips above when the content does not fit below and there is more room above', () => {
  const p = placePopover({ anchor: box(40, 520), viewport: vp, size: { width: 300, height: 300 } });
  assert.equal(p.placement, 'above');
  assert.equal(p.top + 300, 520 - 4);
  assert.equal(p.maxHeight, 520 - 4 - 8);
});

test('stays below and scrolls inside when neither side has room for all of it', () => {
  const p = placePopover({ anchor: box(40, 100), viewport: { width: 800, height: 400 }, size: { width: 300, height: 900 } });
  assert.equal(p.placement, 'below');
  assert.equal(p.maxHeight, 400 - 132 - 4 - 8);
  const tall = placePopover({ anchor: box(40, 250), viewport: { width: 800, height: 400 }, size: { width: 300, height: 900 } });
  assert.equal(tall.placement, 'above');
  assert.equal(tall.top, 250 - 4 - tall.maxHeight);
});

test('a dropdown can be at least as wide as its field', () => {
  const p = placePopover({ anchor: box(10, 10, 400), viewport: vp, size: { width: 280, height: 100 }, matchAnchorWidth: true });
  assert.equal(p.width, 400);
});

test('a tooltip is centred over its trigger and goes above when it fits there', () => {
  const p = placePopover({ anchor: box(300, 200, 100, 24), viewport: vp, size: { width: 80, height: 30 }, align: 'center', prefer: 'above', gap: 6 });
  assert.equal(p.placement, 'above');
  assert.equal(p.left, 310);
  assert.equal(p.top, 200 - 6 - 30);
});

test('a tooltip with no room above goes below, and stays inside the window', () => {
  const p = placePopover({ anchor: box(0, 4, 20, 24), viewport: vp, size: { width: 120, height: 30 }, align: 'center', prefer: 'above' });
  assert.equal(p.placement, 'below');
  assert.equal(p.left, 8);
});
