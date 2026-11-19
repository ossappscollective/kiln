import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointAnchor, pointBox } from './virtual-anchor.ts';

const host = (left: number, top: number) => ({
  getBoundingClientRect: () => ({ left, top }) as DOMRect,
});

test('the point sits at an offset from the host', () => {
  assert.deepEqual(pointBox(host(100, 50), 12, 8), {
    left: 112,
    right: 112,
    top: 58,
    bottom: 58,
    width: 0,
    height: 0,
    x: 112,
    y: 58,
  });
});

test('the anchor measures its host again each time, so a scrolled page does not leave it behind', () => {
  let top = 50;
  const moving = { getBoundingClientRect: () => ({ left: 10, top }) as DOMRect };
  const anchor = pointAnchor(moving, 0, 8);
  assert.equal(anchor.getBoundingClientRect().top, 58);
  top = -20;
  assert.equal(anchor.getBoundingClientRect().top, -12);
});
