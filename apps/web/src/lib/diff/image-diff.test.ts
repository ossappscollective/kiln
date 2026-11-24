import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasSize, changedRatio, clampPercent, dimensionsText, pairByPosition, pairState, percentText, sameShape } from './image-diff.ts';

test('pair state: changed, new, removed, none', () => {
  const img = { url: '/api/x' };
  assert.equal(pairState({ before: img, after: img }), 'changed');
  assert.equal(pairState({ before: null, after: img }), 'new');
  assert.equal(pairState({ before: img, after: null }), 'removed');
  assert.equal(pairState({ before: { url: null }, after: { url: '' } }), 'none');
});

test('pairing by position leaves the longer side new or removed', () => {
  const s = (n: number) => ({ url: `/u/${n}` });
  const pairs = pairByPosition([s(1), s(2), s(3)], [s(4)], (p) => `Image ${p}`);
  assert.deepEqual(pairs.map((p) => [p.key, p.title, pairState(p)]), [['1', 'Image 1', 'changed'], ['2', 'Image 2', 'removed'], ['3', 'Image 3', 'removed']]);
});

test('canvas is capped at 512 and never zero', () => {
  assert.deepEqual(canvasSize(1242, 2688), { width: 237, height: 512 });
  assert.deepEqual(canvasSize(100, 50), { width: 100, height: 50 });
  assert.deepEqual(canvasSize(0, 0), { width: 1, height: 1 });
});

test('same shape tolerates 1% in the ratio only', () => {
  assert.equal(sameShape({ width: 1000, height: 2000 }, { width: 500, height: 1000 }), true);
  assert.equal(sameShape({ width: 1000, height: 2000 }, { width: 1000, height: 1500 }), false);
  assert.equal(sameShape({ width: 0, height: 5 }, { width: 1, height: 5 }), false);
});

test('changed ratio counts pixels over the tolerance', () => {
  const a = new Uint8ClampedArray([0, 0, 0, 255, 10, 10, 10, 255, 200, 0, 0, 255, 0, 0, 0, 255]);
  const b = new Uint8ClampedArray([0, 0, 0, 255, 12, 10, 10, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  assert.equal(changedRatio(a, b), 0.25);
  assert.equal(changedRatio(a, a), 0);
  assert.equal(changedRatio(a, new Uint8ClampedArray(4)), null);
  assert.equal(changedRatio([], []), null);
  assert.equal(percentText(0), 0);
  assert.equal(percentText(0.001), 1);
  assert.equal(percentText(0.25), 25);
});

test('small helpers', () => {
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent(Number.NaN), 50);
  assert.equal(dimensionsText({ width: 1242, height: 2688 }), '1242 × 2688 px');
  assert.equal(dimensionsText({ width: null, height: 5 }), '');
});
