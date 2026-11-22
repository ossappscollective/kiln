import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeline } from './portfolio.ts';
import { timelineProgress } from './timeline-progress.ts';

test('the progress names the current step, its place and the whole path', () => {
  const steps = timeline('android', 'in_review');
  const p = timelineProgress(steps);
  assert.equal(p.total, steps.length);
  assert.equal(p.current?.state, 'in_review');
  assert.equal(p.index, steps.findIndex((s) => s.state === 'in_review') + 1);
  assert.equal(p.path.split(' › ').length, steps.length);
});

test('no current step: no index', () => {
  const p = timelineProgress(timeline('ios', null));
  assert.equal(p.index, null);
  assert.equal(p.current, null);
});
