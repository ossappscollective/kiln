import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoginLimiter } from './limiter.ts';

test('blocks after max failures, then allows again when the window passes', () => {
  let time = 0;
  const limiter = createLoginLimiter({ max: 3, windowMs: 60_000, now: () => time });
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.retryAfter('a@x.io'), 0);
    limiter.fail('a@x.io');
  }
  assert.equal(limiter.retryAfter('a@x.io'), 60);
  time = 30_000;
  assert.equal(limiter.retryAfter('a@x.io'), 30);
  time = 60_000;
  assert.equal(limiter.retryAfter('a@x.io'), 0);
});

test('keys are independent and reset clears one', () => {
  const limiter = createLoginLimiter({ max: 1 });
  limiter.fail('a');
  assert.ok(limiter.retryAfter('a') > 0);
  assert.equal(limiter.retryAfter('b'), 0);
  limiter.reset('a');
  assert.equal(limiter.retryAfter('a'), 0);
});
