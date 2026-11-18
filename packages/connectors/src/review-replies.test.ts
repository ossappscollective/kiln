import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { AppStoreReviewsConnector, parseAppleReplyResult } from './appstore-reviews.ts';
import { parsePlayReplyResult, PlayReviewsConnector } from './play-reviews.ts';
import {
  APPLE_REPLY_LIMIT,
  checkReplyText,
  normalizeReplyText,
  PLAY_REPLY_LIMIT,
  ReplyOutcomeUnknownError,
} from './review-types.ts';
import * as rx from './reviews.fixtures.ts';
import * as fx from './store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const appleKey = fx.appleKeyPem();
const googleKey = fx.googleKeyPem();
const APPLE_REVIEW = '00000030-0000-0000-0000-000000000001';
const PLAY_REVIEW = 'gp:AOqpTOE1';
const LIST = `/androidpublisher/v3/applications/${rx.PLAY_PACKAGE}/reviews`;
const PLAY_REPLY = `${LIST}/gp%3AAOqpTOE1:reply`;
const APPLE_POST = '/v1/customerReviewResponses';

function apple(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const fake = new fx.FakeFetch();
  const connector = new AppStoreReviewsConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: appleKey.privateKey },
    appStoreId: rx.APP_ID,
    fetch: options.fetch ?? fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { fake, connector };
}

function play(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'POST', match: '/token', json: fx.googleToken });
  const connector = new PlayReviewsConnector({
    serviceAccount: fx.serviceAccountJson(googleKey.privateKey),
    packageName: rx.PLAY_PACKAGE,
    fetch: options.fetch ?? fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { fake, connector };
}

/** A fetch that never answers but honours the abort signal, like a store that hangs. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    // AbortSignal.timeout does not keep the event loop alive, so something else must.
    const keepAlive = setInterval(() => undefined, 1000);
    init?.signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      reject(error);
    });
  });

// ---------------------------------------------------------------------------------------------
// Validation

test('the limits are the documented one for Google Play and a conservative one for Apple', () => {
  assert.equal(PLAY_REPLY_LIMIT, 350);
  assert.equal(APPLE_REPLY_LIMIT, 5000);
});

test('checkReplyText: empty, control characters, markup, length; a line break is fine', () => {
  assert.equal(checkReplyText('Thanks!', 350).ok, true);
  assert.equal(checkReplyText('Line one\nLine two', 350).ok, true);
  const problem = (value: unknown, limit = 350) => {
    const r = checkReplyText(value, limit);
    return r.ok ? 'ok' : r.problem;
  };
  assert.equal(problem(''), 'empty');
  assert.equal(problem('   \n '), 'empty');
  assert.equal(problem(undefined), 'empty');
  assert.equal(problem(42), 'empty');
  assert.equal(problem('tab\there'), 'control_characters');
  assert.equal(problem('carriage\rreturn'), 'control_characters');
  assert.equal(problem('nul\u0000byte'), 'control_characters');
  assert.equal(problem('escape\u001b[31m'), 'control_characters');
  assert.equal(problem('override ‮ text'), 'control_characters');
  assert.equal(problem('line separator'), 'control_characters');
  assert.equal(problem('<b>bold</b>'), 'markup');
  assert.equal(problem('<script>alert(1)</script>'), 'markup');
  assert.equal(problem('I <3 this app'), 'ok', 'a lone < is text');
  assert.equal(problem('a'.repeat(350)), 'ok');
  assert.equal(problem('a'.repeat(351)), 'too_long');
  assert.equal(problem('a'.repeat(5001), 5000), 'too_long');
});

test('normalizeReplyText turns CRLF into LF and trims', () => {
  assert.equal(normalizeReplyText('  Hi\r\nthere\r\n'), 'Hi\nthere');
  assert.equal(normalizeReplyText('a\rb'), 'a\nb');
});

// ---------------------------------------------------------------------------------------------
// App Store Connect

test('apple: replyToReview posts the JSON:API body once and reads the response resource', async () => {
  const { fake, connector } = apple();
  fake.on({
    method: 'POST',
    match: APPLE_POST,
    status: 201,
    json: {
      data: {
        type: 'customerReviewResponses',
        id: 'resp-new',
        attributes: { responseBody: 'Thanks!', lastModifiedDate: '2026-11-18T04:00:00-08:00', state: 'PENDING_PUBLISH' },
      },
    },
  });
  const result = await connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks!' });
  assert.deepEqual(result, {
    storeResponseId: 'resp-new',
    state: 'PENDING_PUBLISH',
    repliedAt: Date.parse('2026-11-18T04:00:00-08:00'),
  });
  assert.deepEqual(fake.unexpected, []);
  const [call] = fake.calls;
  assert.equal(fake.calls.length, 1);
  assert.equal(call?.method, 'POST');
  assert.ok(call?.headers.get('authorization')?.startsWith('Bearer '));
  assert.equal(call?.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(call?.body ?? '{}'), {
    data: {
      type: 'customerReviewResponses',
      attributes: { responseBody: 'Thanks!' },
      relationships: { review: { data: { type: 'customerReviews', id: APPLE_REVIEW } } },
    },
  });
});

test('apple: an odd 2xx body still counts as sent, and the parser never throws', async () => {
  const { fake, connector } = apple();
  fake.on({ method: 'POST', match: APPLE_POST, status: 201, raw: '<html>created</html>' });
  assert.deepEqual(await connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), {});
  assert.deepEqual(parseAppleReplyResult(null), {});
  assert.deepEqual(parseAppleReplyResult({ data: 'x' }), {});
  assert.deepEqual(parseAppleReplyResult({ data: { id: 7, attributes: { state: 3 } } }), {});
});

test('apple: invalid input never reaches the network', async () => {
  const { fake, connector } = apple();
  for (const text of ['', '   ', 'a'.repeat(APPLE_REPLY_LIMIT + 1), 'bad\u0000text', '<i>x</i>']) {
    await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text }), (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input');
  }
  await assert.rejects(connector.replyToReview({ reviewId: '../customerReviews', text: 'Hi' }), StoreError);
  await assert.rejects(connector.replyToReview({ reviewId: 'a b', text: 'Hi' }), StoreError);
  assert.equal(fake.calls.length, 0);
});

test('apple: a timeout is an unknown outcome and the POST is not repeated', async () => {
  const { connector } = apple({ fetch: hangingFetch, timeoutMs: 20 });
  await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), (e: unknown) => {
    assert.ok(e instanceof ReplyOutcomeUnknownError);
    assert.match(e.message, /not known whether/);
    return true;
  });
  const { fake, connector: second } = apple();
  fake.on({ method: 'POST', match: APPLE_POST, throws: new Error('connection reset') });
  await assert.rejects(second.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), ReplyOutcomeUnknownError);
  assert.equal(fake.calls.length, 1, 'one attempt, no retry');
});

test('apple: a 5xx is an unknown outcome, a 4xx is a refusal that published nothing', async () => {
  const { fake, connector } = apple();
  fake.on({ method: 'POST', match: APPLE_POST, status: 503, json: {} });
  await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), ReplyOutcomeUnknownError);
  assert.equal(fake.calls.length, 1);

  const refused = apple();
  refused.fake.on({
    method: 'POST',
    match: APPLE_POST,
    status: 409,
    json: { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', title: 'Invalid', detail: 'responseBody is too long', source: { pointer: '/data/attributes/responseBody' } }] },
  });
  await assert.rejects(refused.connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), (e: unknown) => {
    assert.ok(e instanceof StoreError && !(e instanceof ReplyOutcomeUnknownError));
    assert.equal(e.status, 409);
    assert.equal(e.details?.[0]?.pointer, '/data/attributes/responseBody');
    return true;
  });
});

test('apple: 403 names the role, 405 is unsupported, 401 is auth, 404 is not_found', async () => {
  const kinds: [number, string][] = [
    [403, 'forbidden'],
    [405, 'unsupported'],
    [401, 'auth'],
    [404, 'not_found'],
  ];
  for (const [status, kind] of kinds) {
    const { fake, connector } = apple();
    fake.on({ method: 'POST', match: APPLE_POST, status, json: { errors: [{ code: 'FORBIDDEN_ERROR', title: 'x' }] } });
    await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, kind, String(status));
      if (status === 403) assert.match(e.message, /Admin/);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  }
});

test('apple: a 429 is not waited out or retried for a write', async () => {
  const { fake, connector } = apple();
  fake.on({ method: 'POST', match: APPLE_POST, status: 429, json: rx.appleErrors.rateLimited, headers: { 'retry-after': '1' } });
  await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), StoreRateLimitError);
  assert.equal(fake.calls.length, 1);
});

test('apple: no error message carries the token or the key', async () => {
  const { fake, connector } = apple();
  fake.on({ method: 'POST', match: APPLE_POST, status: 400, json: { errors: [{ code: 'X', title: 'bad', detail: `see ${appleKey.privateKey}` }] } });
  await assert.rejects(connector.replyToReview({ reviewId: APPLE_REVIEW, text: 'Thanks' }), (e: unknown) => {
    const message = JSON.stringify([(e as Error).message, (e as StoreError).details]);
    assert.ok(!message.includes('BEGIN PRIVATE KEY'));
    assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(message));
    return true;
  });
});

test('apple: deleteReviewResponse sends DELETE to the response resource; 204 is success', async () => {
  const seen: { method?: string; url: string }[] = [];
  const { connector } = apple({
    fetch: async (input, init) => {
      seen.push({ ...(init?.method ? { method: init.method } : {}), url: String(input) });
      return new Response(null, { status: 204 });
    },
  });
  await connector.deleteReviewResponse({ responseId: 'resp-1' });
  assert.deepEqual(seen, [{ method: 'DELETE', url: 'https://api.appstoreconnect.apple.com/v1/customerReviewResponses/resp-1' }]);
  await assert.rejects(connector.deleteReviewResponse({ responseId: '../x' }), StoreError);
  const { fake: other, connector: unknownOutcome } = apple();
  other.on({ method: 'DELETE', match: '/v1/customerReviewResponses/resp-1', throws: new Error('reset') });
  await assert.rejects(unknownOutcome.deleteReviewResponse({ responseId: 'resp-1' }), ReplyOutcomeUnknownError);
  const { fake: gone, connector: missing } = apple();
  gone.on({ method: 'DELETE', match: '/v1/customerReviewResponses/resp-9', status: 404, json: {} });
  await assert.rejects(missing.deleteReviewResponse({ responseId: 'resp-9' }), (e: unknown) => e instanceof StoreError && e.kind === 'not_found');
});

test('apple: getReview reads one review with its response; 404 is undefined; a bad id never reaches a URL', async () => {
  const { fake, connector } = apple();
  fake.on({
    method: 'GET',
    match: `/v1/customerReviews/${APPLE_REVIEW}?include=response`,
    json: {
      data: rx.appleReview(APPLE_REVIEW, 1, '2026-11-17T10:00:00-08:00', { response: 'Sorry' }),
      included: [rx.appleResponse(APPLE_REVIEW, 'Sorry', 'PENDING_PUBLISH')],
    },
  });
  const review = await connector.getReview(APPLE_REVIEW);
  assert.equal(review?.rating, 1);
  assert.equal(review?.developerResponse?.body, 'Sorry');
  assert.equal(review?.developerResponse?.state, 'PENDING_PUBLISH');
  fake.on({ method: 'GET', match: '/v1/customerReviews/gone?include=response', status: 404, json: {} });
  assert.equal(await connector.getReview('gone'), undefined);
  await assert.rejects(connector.getReview('../x'), StoreError);
});

// ---------------------------------------------------------------------------------------------
// Google Play

test('play: replyToReview posts {replyText} to reviews/{id}:reply once and parses lastEdited', async () => {
  const { fake, connector } = play();
  fake.on({
    method: 'POST',
    match: PLAY_REPLY,
    json: { result: { replyText: 'Thanks!', lastEdited: rx.playTimestamp('2026-11-18T12:00:00Z') } },
  });
  const result = await connector.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks!' });
  assert.deepEqual(result, { repliedAt: Date.parse('2026-11-18T12:00:00Z') });
  assert.deepEqual(fake.unexpected, []);
  const call = fake.calls.find((c) => c.url.pathname.endsWith(':reply'));
  assert.equal(call?.method, 'POST');
  assert.deepEqual(JSON.parse(call?.body ?? '{}'), { replyText: 'Thanks!' });
  assert.ok(call?.headers.get('authorization')?.startsWith('Bearer '));
  assert.deepEqual(parsePlayReplyResult(undefined), {});
  assert.deepEqual(parsePlayReplyResult({ result: { lastEdited: 'nope' } }), {});
});

test('play: the 350 character limit and the other input rules are checked before any request', async () => {
  const { fake, connector } = play();
  fake.on({ method: 'POST', match: PLAY_REPLY, json: { result: {} } });
  assert.equal(connector.replyLimit, 350);
  await connector.replyToReview({ reviewId: PLAY_REVIEW, text: 'a'.repeat(350) });
  const before = fake.calls.length;
  for (const text of ['a'.repeat(351), '', '  ', 'x\u0007y', '<b>x</b>']) {
    await assert.rejects(connector.replyToReview({ reviewId: PLAY_REVIEW, text }), (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input');
  }
  await assert.rejects(connector.replyToReview({ reviewId: '../x', text: 'Hi' }), StoreError);
  await assert.rejects(connector.replyToReview({ reviewId: 'a/b', text: 'Hi' }), StoreError);
  assert.equal(fake.calls.length, before, 'nothing was sent');
});

test('play: a timeout or a cut connection is an unknown outcome, and nothing is retried', async () => {
  const { connector } = play({ fetch: (input, init) => (String(input).endsWith('/token') ? tokenOnly.fetch(input, init) : hangingFetch(input, init)), timeoutMs: 20 });
  await assert.rejects(connector.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks' }), ReplyOutcomeUnknownError);
  const { fake, connector: second } = play();
  fake.on({ method: 'POST', match: PLAY_REPLY, throws: new Error('reset') });
  await assert.rejects(second.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks' }), ReplyOutcomeUnknownError);
  assert.equal(fake.calls.filter((c) => c.url.pathname.endsWith(':reply')).length, 1);
});

const tokenOnly = new fx.FakeFetch().on({ method: 'POST', match: '/token', json: fx.googleToken });

test('play: a 5xx is unknown; 400, 403, 404 are refusals; a quota answer is a rate limit error without a wait', async () => {
  const run = async (status: number, json: unknown) => {
    const { fake, connector } = play();
    fake.on({ method: 'POST', match: PLAY_REPLY, status, json });
    const error = await connector.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { error, replies: fake.calls.filter((c) => c.url.pathname.endsWith(':reply')).length };
  };
  const unknown = await run(503, {});
  assert.ok(unknown.error instanceof ReplyOutcomeUnknownError);
  assert.equal(unknown.replies, 1);
  const bad = await run(400, { error: { code: 400, message: 'Bad Reply Request: replyText too long' } });
  assert.ok(bad.error instanceof StoreError && !(bad.error instanceof ReplyOutcomeUnknownError));
  assert.equal((bad.error as StoreError).status, 400);
  const forbidden = await run(403, rx.playErrors.forbidden);
  assert.equal((forbidden.error as StoreError).kind, 'forbidden');
  assert.match((forbidden.error as StoreError).message, /Reply to reviews/);
  const missing = await run(404, { error: { code: 404, message: 'Review not found' } });
  assert.ok(missing.error instanceof StoreError);
  const quota = await run(429, rx.playErrors.quota);
  assert.ok(quota.error instanceof StoreRateLimitError);
  assert.equal(quota.replies, 1, 'not waited out, not retried');
});

test('play: a 401 mints a new token once, then sends; a second 401 is an auth error', async () => {
  const { fake, connector } = play();
  fake.on({ method: 'POST', match: PLAY_REPLY, status: 401, json: {}, times: 1 });
  fake.on({ method: 'POST', match: PLAY_REPLY, json: { result: {} } });
  await connector.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks' });
  assert.equal(fake.calls.filter((c) => c.url.pathname.endsWith(':reply')).length, 2);
  const { fake: bad, connector: failing } = play();
  bad.on({ method: 'POST', match: PLAY_REPLY, status: 401, json: {} });
  await assert.rejects(failing.replyToReview({ reviewId: PLAY_REVIEW, text: 'Thanks' }), (e: unknown) => e instanceof StoreError && e.kind === 'auth');
});
