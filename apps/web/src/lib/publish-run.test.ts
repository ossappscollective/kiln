import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  elapsedText,
  failureDetail,
  minutesOf,
  PUBLISH_WAIT_LIMIT_MS,
  PublishWaitError,
  withWaitLimit,
} from './publish-run.ts';

test('a request that never answers ends with a PublishWaitError after the limit, and is aborted', async () => {
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    withWaitLimit((s) => {
      signal = s;
      return new Promise<never>(() => undefined);
    }, 30),
    (error: unknown) => error instanceof PublishWaitError && error.limitMs === 30,
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(signal?.aborted, true, 'the request is let go of');
});

test('an answer inside the limit is passed on, and the limit does not fire later', async () => {
  let signal: AbortSignal | undefined;
  const out = await withWaitLimit(async (s) => {
    signal = s;
    return 'done';
  }, 20);
  assert.equal(out, 'done');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal?.aborted, false, 'a finished request is never aborted');
});

test('an error inside the limit is the error of the request, not a wait error', async () => {
  const failure = new ApiError(502, 'draft_partial', 'x');
  await assert.rejects(
    withWaitLimit(() => Promise.reject(failure), 50),
    (error: unknown) => error === failure,
  );
});

test('the default limit is longer than the longest the server can take for a push and a submit', () => {
  // The server gives up on a step after 8 minutes; a push (4 min + 1 min check) and a submit (2 min) are inside it.
  assert.ok(PUBLISH_WAIT_LIMIT_MS >= 8 * 60_000);
  assert.equal(minutesOf(PUBLISH_WAIT_LIMIT_MS), 20);
});

test('the elapsed time reads as minutes and seconds', () => {
  assert.equal(elapsedText(0), '0:00');
  assert.equal(elapsedText(9_999), '0:09');
  assert.equal(elapsedText(125_000), '2:05');
  assert.equal(elapsedText(75 * 60_000), '75:00');
  assert.equal(elapsedText(-5), '0:00');
});

test('the failure detail is the status and the code of the server, nothing else', () => {
  assert.equal(
    failureDetail(new ApiError(502, 'draft_partial', 'Some text from a store')),
    'HTTP 502 draft_partial',
  );
  assert.equal(failureDetail(new ApiError(500, 'weird code with spaces!', 'm')), 'HTTP 500');
  assert.equal(failureDetail(new Error('boom')), null);
});
