import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLimit } from './concurrency.ts';

test('mapLimit keeps the order, runs at most the limit at once and is faster than one by one', async () => {
  let running = 0;
  let peak = 0;
  const started = Date.now();
  const out = await mapLimit([30, 10, 20, 5, 15, 25], 3, async (ms) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, ms));
    running -= 1;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 10, 30, 50]);
  assert.equal(peak, 3);
  assert.ok(Date.now() - started < 105, 'the sum of the delays is 105 ms when run one by one');
});

test('mapLimit throws the first failure and starts nothing new after it', async () => {
  const seen: number[] = [];
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
      seen.push(n);
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
  assert.deepEqual(seen, [1, 2]);
});
