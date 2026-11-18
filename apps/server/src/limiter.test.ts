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

test('attempt counts before the work, so concurrent attempts cannot exceed max', async () => {
  const limiter = createLoginLimiter({ max: 3 });
  const results = await Promise.all(
    Array.from({ length: 50 }, async () => {
      const wait = limiter.attempt('a@x.io');
      if (wait > 0) return 'blocked';
      await new Promise((r) => setTimeout(r, 5)); // the slow password check
      return 'ran';
    }),
  );
  assert.equal(results.filter((r) => r === 'ran').length, 3);
  assert.equal(results.filter((r) => r === 'blocked').length, 47);
});

test('reset and refund give attempts back', () => {
  const limiter = createLoginLimiter({ max: 2 });
  assert.equal(limiter.attempt('k'), 0);
  assert.equal(limiter.attempt('k'), 0);
  assert.ok(limiter.attempt('k') > 0);
  limiter.refund('k');
  assert.equal(limiter.attempt('k'), 0);
  limiter.reset('k');
  assert.equal(limiter.attempt('k'), 0);
  assert.equal(limiter.attempt('k'), 0);
});

test('a flood of new keys, past the default size, does not lift a lockout', () => {
  const limiter = createLoginLimiter({ max: 2 });
  limiter.fail('victim');
  limiter.fail('victim');
  assert.ok(limiter.retryAfter('victim') > 0);
  for (let i = 0; i < 10_001; i++) limiter.attempt(`noise-${i}`);
  assert.ok(limiter.retryAfter('victim') > 0, 'the lockout survived 10,001 other keys');
});

test('when every entry is locked out, only the oldest is evicted', () => {
  const limiter = createLoginLimiter({ max: 1, maxKeys: 3 });
  for (const key of ['a', 'b', 'c']) limiter.attempt(key);
  limiter.attempt('d');
  assert.equal(limiter.retryAfter('a'), 0, 'the oldest went');
  for (const key of ['b', 'c', 'd']) assert.ok(limiter.retryAfter(key) > 0, key);
});

test('expired entries are dropped before anything live is evicted', () => {
  let time = 0;
  const limiter = createLoginLimiter({ max: 1, maxKeys: 2, windowMs: 1_000, now: () => time });
  limiter.attempt('old');
  time = 900;
  limiter.attempt('live');
  time = 1_100; // 'old' has expired, 'live' has not
  limiter.attempt('new');
  assert.ok(limiter.retryAfter('live') > 0);
  assert.ok(limiter.retryAfter('new') > 0);
});
