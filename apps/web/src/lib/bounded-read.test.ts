import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { settle } from './bounded-read.ts';

/** A read always ends, so the `loading` / `busy` flag of a screen that wraps it in `settle` is always reset (docs/adr/0066-assets-step-bounded-reads.md). */

const never = <T>() => new Promise<T>(() => undefined);
const opts = (ms = 20) => ({ ms, timeoutMessage: 'Took too long.' });

test('a request that is never answered ends as a timeout with a retryable ApiError, and the request is aborted', async () => {
  let aborted = false;
  const out = await settle((signal) => {
    signal.addEventListener('abort', () => (aborted = true));
    return never();
  }, opts());
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.timedOut, true);
    assert.ok(out.error instanceof ApiError);
    assert.equal((out.error as ApiError).code, 'client_timeout');
    assert.equal((out.error as ApiError).message, 'Took too long.');
  }
  assert.equal(aborted, true);
});

test('an error is returned as a value, not thrown, so the flag can be reset after it', async () => {
  let loading = true;
  const out = await settle(() => Promise.reject(new ApiError(409, 'metadata_locked', 'Locked.')), opts(1000));
  loading = false;
  assert.equal(loading, false);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.timedOut, false);
    assert.equal((out.error as ApiError).code, 'metadata_locked');
  }
});

test('a request that throws before it returns a promise is an error value too', async () => {
  const out = await settle(() => {
    throw new Error('boom');
  }, opts(1000));
  assert.equal(out.ok, false);
});

test('an answer in time is the value; a late answer after the limit is dropped', async () => {
  const fast = await settle(() => Promise.resolve(7), opts(1000));
  assert.deepEqual(fast, { ok: true, value: 7 });
  const late = await settle(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 60)), opts(10));
  assert.equal(late.ok, false);
  await new Promise((r) => setTimeout(r, 80));
});

test('the loading flag pattern used by the Assets step never stays on, whatever the request does', async () => {
  const runs: ((s: AbortSignal) => Promise<number>)[] = [() => Promise.resolve(1), () => Promise.reject(new ApiError(500, 'error', 'x')), () => never()];
  for (const run of runs) {
    let loading = true;
    await settle(run, opts());
    loading = false;
    assert.equal(loading, false);
  }
});
