import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { createReadCache } from './read-cache.ts';
import { rateLimitedMessage } from './staged.ts';

const base = { workspaceId: 'w', group: 'store' };

test('two readers of one key share one request, and the answer is kept for a minute', async () => {
  let t = 0;
  const cache = createReadCache(() => t);
  let calls = 0;
  const load = async () => ++calls;
  const [a, b] = await Promise.all([
    cache.read({ ...base, key: 'k', load }),
    cache.read({ ...base, key: 'k', load }),
  ]);
  assert.deepEqual([a, b, calls], [1, 1, 1]);
  t = 30_000;
  assert.equal(await cache.read({ ...base, key: 'k', load }), 1);
  t = 61_000;
  assert.equal(await cache.read({ ...base, key: 'k', load }), 2);
  assert.equal(await cache.read({ ...base, key: 'k', load, force: true }), 3);
});

test('after a 429 nothing is sent until the wait is over, and the error carries the time left', async () => {
  let t = 0;
  const cache = createReadCache(() => t);
  let calls = 0;
  const limited = async () => {
    calls += 1;
    throw new ApiError(429, 'rate_limited', 'x', 100);
  };
  await assert.rejects(cache.read({ ...base, key: 'a', load: limited }), ApiError);
  t = 40_000;
  await assert.rejects(
    cache.read({ ...base, key: 'b', load: limited, force: true }),
    (e: unknown) => e instanceof ApiError && e.retryAfter === 60,
  );
  assert.equal(calls, 1);
  assert.equal(cache.pausedFor('w', 'store'), 60);
  assert.equal(cache.pausedFor('w', 'repo'), 0);
  t = 101_000;
  await assert.rejects(cache.read({ ...base, key: 'a', load: limited }), ApiError);
  assert.equal(calls, 2);
});

test('other failures are not kept, and forget drops what was read', async () => {
  const cache = createReadCache(() => 0);
  let calls = 0;
  await assert.rejects(
    cache.read({
      ...base,
      key: 'k',
      load: async () => {
        calls += 1;
        throw new Error('x');
      },
    }),
  );
  assert.equal(await cache.read({ ...base, key: 'k', load: async () => ++calls }), 2);
  cache.forget('w', 'k');
  assert.equal(await cache.read({ ...base, key: 'k', load: async () => ++calls }), 3);
});

test('the rate limit is worded in plain words, never as "repository reads"', () => {
  assert.equal(
    rateLimitedMessage(583),
    'The repository is being read too often. Try again in 10 minutes.',
  );
  assert.equal(
    rateLimitedMessage(undefined),
    'The repository is being read too often. Try again in 1 minute.',
  );
  assert.ok(!/repository reads/i.test(rateLimitedMessage(30)));
});
