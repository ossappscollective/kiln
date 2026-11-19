import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnPath, domainOf, indexAt, labelsCollide, niceStep, niceTicks, plot, provisionalIndex, xTickIndexes, type Box } from './analytics-chart.ts';

const box: Box = { width: 340, height: 160, left: 40, right: 12, top: 8, bottom: 24 };

test('nice steps are 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceStep(100, 4), 50);
  assert.equal(niceStep(7, 4), 2);
  assert.equal(niceStep(0.04, 4), 0.01);
  assert.equal(niceStep(0, 4), 1);
  assert.equal(niceStep(Number.NaN, 4), 1);
});

test('ticks cover the data and are clean numbers', () => {
  assert.deepEqual(niceTicks(0, 100), [0, 50, 100]);
  assert.deepEqual(niceTicks(0, 87), [0, 50, 100]);
  assert.deepEqual(niceTicks(0, 0.34, 4), [0, 0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(niceTicks(5, 5), [5, 6]);
});

test('a count axis starts at zero and a rating axis follows the data inside 1 to 5', () => {
  assert.deepEqual(domainOf([120, 480, 300], 'zero'), [0, 600]);
  assert.deepEqual(domainOf([], 'zero'), [0, 1]);
  const [lo, hi] = domainOf([4.1, 4.4], 'tight', [1, 5]);
  assert.ok(lo > 1 && lo <= 4.1);
  assert.ok(hi >= 4.4 && hi < 5);
  assert.deepEqual(domainOf([4.9, 5], 'tight', [1, 5])[1], 5);
  assert.ok(domainOf([1, 1.1], 'tight', [1, 5])[0] >= 1);
});

test('a line is drawn per run: a gap is a gap, never a bridge or a zero', () => {
  const g = plot({ box, count: 7, kind: 'line', domain: 'zero', series: [{ key: 'a', color: 1, values: [10, 20, null, null, 30, 40, null] }] });
  const line = g.lines[0];
  assert.equal(line?.runs.length, 2);
  assert.deepEqual(line?.runs.map((r) => r.points.length), [2, 2]);
  assert.equal(line?.last?.i, 5);
  assert.equal(line?.last?.value, 40);
  assert.deepEqual(g.missing.map((m) => [m.from, m.to]), [[2, 3], [6, 6]]);
  assert.equal(g.bars.length, 0);
  // no point sits on the zero line: missing days have no mark at all
  const ys = line?.runs.flatMap((r) => r.points.map((p) => p.y)) ?? [];
  assert.ok(ys.every((y) => y < g.baseline));
});

test('a day is hatched as missing only when every series of the panel lacks it', () => {
  const g = plot({
    box,
    count: 4,
    kind: 'line',
    domain: 'zero',
    series: [
      { key: 'a', color: 1, values: [1, null, null, 4] },
      { key: 'b', color: 2, values: [1, 2, null, 4] },
    ],
  });
  assert.deepEqual(g.missing.map((m) => [m.from, m.to]), [[2, 2]]);
});

test('an empty panel plots nothing but still has a sound axis', () => {
  const g = plot({ box, count: 3, kind: 'line', domain: 'zero', series: [{ key: 'a', color: 1, values: [null, null, null] }] });
  assert.equal(g.lines[0]?.runs.length, 0);
  assert.equal(g.lines[0]?.last, null);
  assert.deepEqual(g.missing.map((m) => [m.from, m.to]), [[0, 2]]);
  assert.ok(Number.isFinite(g.min) && Number.isFinite(g.max) && g.max > g.min);
});

test('the y scale maps the axis ends to the plot edges and the baseline is zero', () => {
  const g = plot({ box, count: 4, kind: 'columns', domain: 'zero', series: [{ key: 'a', color: 1, values: [10, 20, 30, 50] }] });
  assert.equal(g.min, 0);
  assert.equal(g.max, 60);
  assert.equal(g.y(0), box.top + g.plotH);
  assert.equal(g.y(60), box.top);
  assert.equal(g.baseline, g.y(0));
  assert.equal(g.ticks[0]?.value, 0);
  assert.equal(g.ticks[g.ticks.length - 1]?.value, 60);
});

test('columns are at most 24px thick, start at the baseline and have a rounded data end', () => {
  const few = plot({ box, count: 3, kind: 'columns', domain: 'zero', series: [{ key: 'a', color: 1, values: [10, 20, 30] }] });
  assert.ok(few.bars.every((b) => b.w <= 24));
  const many = plot({ box, count: 90, kind: 'columns', domain: 'zero', series: [{ key: 'a', color: 1, values: Array.from({ length: 90 }, (_, i) => i + 1) }] });
  assert.ok(many.bars.every((b) => b.w >= 1 && b.w <= 24));
  for (const b of few.bars) {
    assert.ok(Math.abs(b.y + b.h - few.baseline) < 1e-6);
    assert.match(b.d, /A/);
  }
});

test('stacked parts are separated by a 2px gap and only the top part is rounded', () => {
  const g = plot({
    box,
    count: 1,
    kind: 'stacked',
    domain: 'zero',
    series: [
      { key: 'first', color: 1, values: [60] },
      { key: 'again', color: 2, values: [40] },
    ],
  });
  assert.equal(g.max, 100);
  const [bottom, top] = g.bars;
  assert.ok(bottom && top);
  assert.ok(Math.abs(bottom.y + bottom.h - g.baseline) < 1e-6);
  const gap = bottom.y - (top.y + top.h);
  assert.ok(Math.abs(gap - 2) < 1e-6, `gap ${gap}`);
  assert.doesNotMatch(bottom.d, /A/);
  assert.match(top.d, /A/);
});

test('a column of zero or a missing day draws no mark', () => {
  const g = plot({ box, count: 3, kind: 'columns', domain: 'zero', series: [{ key: 'a', color: 1, values: [5, 0, null] }] });
  assert.deepEqual(g.bars.map((b) => b.i), [0]);
  assert.deepEqual(g.missing.map((m) => [m.from, m.to]), [[2, 2]]);
});

test('days the store may still change get a wash from the first such day to the end', () => {
  const g = plot({ box, count: 10, kind: 'line', domain: 'zero', provisionalFrom: 7, series: [{ key: 'a', color: 1, values: Array.from({ length: 10 }, (_, i) => i) }] });
  assert.equal(g.provisional?.from, 7);
  assert.equal(g.provisional?.to, 9);
  assert.ok(Math.abs((g.provisional?.x ?? 0) + (g.provisional?.w ?? 0) - (box.width - box.right)) < 1e-6);
  const none = plot({ box, count: 10, kind: 'line', domain: 'zero', provisionalFrom: -1, series: [{ key: 'a', color: 1, values: [1] }] });
  assert.equal(none.provisional, null);
});

test('provisionalIndex finds the first day within the delay of today', () => {
  const dates = ['2026-11-10', '2026-11-14', '2026-11-15', '2026-11-18'];
  assert.equal(provisionalIndex(dates, '2026-11-19', 4), 2);
  assert.equal(provisionalIndex(dates, '2026-11-19', 3), 3);
  assert.equal(provisionalIndex(dates, '2026-11-19', 1), 3);
  assert.equal(provisionalIndex(dates, '2026-11-19', 0), -1);
  assert.equal(provisionalIndex([], '2026-11-19', 3), -1);
});

test('indexAt maps a pointer position to a day, and nothing outside the plot', () => {
  const g = plot({ box, count: 10, kind: 'line', domain: 'zero', series: [{ key: 'a', color: 1, values: Array.from({ length: 10 }, (_, i) => i) }] });
  assert.equal(indexAt(g, box.left - 1), null);
  assert.equal(indexAt(g, box.left), 0);
  assert.equal(indexAt(g, g.xCenter(4)), 4);
  assert.equal(indexAt(g, box.left + g.plotW), 9);
  assert.equal(indexAt(g, box.width + 50), null);
});

test('x labels: first and last always, evenly between, never more than asked', () => {
  assert.deepEqual(xTickIndexes(3, 5), [0, 1, 2]);
  assert.deepEqual(xTickIndexes(0, 5), []);
  const ticks = xTickIndexes(28, 5);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 27);
  assert.ok(ticks.length <= 5);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
});

test('column paths round only the data end', () => {
  assert.equal(columnPath(0, 10, 100, 50, 4, false), 'M0,100V50H10V100Z');
  assert.match(columnPath(0, 10, 100, 50, 4, true), /^M0,100V54A4,4 0 0 1 4,50H6A4,4 0 0 1 10,54V100Z$/);
  // a short column cannot be rounder than it is tall
  assert.match(columnPath(0, 10, 100, 98, 4, true), /A2,2/);
});

test('end labels that would overlap are detected', () => {
  assert.equal(labelsCollide(10, 18), true);
  assert.equal(labelsCollide(10, 40), false);
});
