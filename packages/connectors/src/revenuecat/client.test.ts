import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRevenueCatClient, normalizeRevenueCatOrigin, REVENUECAT_API_ORIGIN, revenueCatErrorKind } from './client.ts';
import { RevenueCatError } from './errors.ts';
import { type Answer, errorBody, fakeFetch, KEY, list, PROJECT_ID } from './revenuecat.fixtures.ts';

const client = (f: ReturnType<typeof fakeFetch>, extra: Partial<Parameters<typeof createRevenueCatClient>[0]> = {}) =>
  createRevenueCatClient({ apiKey: KEY, fetch: f.fetch, ...extra });

async function failure(run: () => Promise<unknown>): Promise<RevenueCatError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof RevenueCatError, String(error));
    return error;
  }
  assert.fail('expected a RevenueCatError');
}

test('a request is a GET with the bearer key, below /v2, with no redirect followed', async () => {
  const f = fakeFetch(() => ({ body: list([]) }));
  await client(f).get(`/projects/${PROJECT_ID}/apps`, { limit: 5, expand: undefined });
  const [call] = f.calls;
  assert.equal(call?.url, `${REVENUECAT_API_ORIGIN}/v2/projects/${PROJECT_ID}/apps?limit=5`);
  assert.equal(call?.init.method, 'GET');
  assert.equal((call?.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.equal(call?.init.redirect, 'manual');
  assert.equal(call?.init.body, undefined);
});

test('a key with a space or a line break, or none, is refused before any request', () => {
  for (const apiKey of ['', '  ', 'sk_a b', 'sk_a\nb']) {
    assert.throws(() => createRevenueCatClient({ apiKey }), (e: unknown) => e instanceof RevenueCatError && e.kind === 'auth');
  }
});

test('the origin must be an http(s) origin without credentials, query or fragment', () => {
  assert.equal(normalizeRevenueCatOrigin(undefined), REVENUECAT_API_ORIGIN);
  assert.equal(normalizeRevenueCatOrigin('https://proxy.example.com/rc/'), 'https://proxy.example.com/rc');
  for (const bad of ['ftp://x.example', 'https://u:p@x.example', 'https://x.example?q=1', 'nope']) {
    assert.throws(() => normalizeRevenueCatOrigin(bad), (e: unknown) => e instanceof RevenueCatError && e.kind === 'invalid_input');
  }
});

test('a path that could point the key elsewhere is refused', async () => {
  const f = fakeFetch(() => ({ body: {} }));
  for (const path of ['projects', '/a/../b', '//evil.example/x', '/a?b=1', '/a b']) {
    assert.equal((await failure(() => client(f).get(path))).kind, 'invalid_input');
  }
  assert.equal(f.calls.length, 0);
});

test('status and the documented error type decide the kind; the text of RevenueCat and the key never reach the message', async () => {
  const cases: [number, string | undefined, string][] = [
    [401, 'authentication_error', 'auth'],
    [403, 'authorization_error', 'forbidden'],
    [404, 'resource_missing', 'not_found'],
    [429, 'rate_limit_error', 'rate_limited'],
    [400, undefined, 'invalid_input'],
    [401, undefined, 'auth'],
    [403, undefined, 'forbidden'],
    [404, undefined, 'not_found'],
    [500, undefined, 'server'],
    [503, undefined, 'server'],
    [423, undefined, 'unexpected'],
    // The type wins when it is one of the four documented values.
    [400, 'authentication_error', 'auth'],
  ];
  for (const [status, type, kind] of cases) {
    assert.equal(revenueCatErrorKind(status, type), kind, `${status} ${type}`);
    const f = fakeFetch(() => ({ status, body: type ? errorBody(type) : { message: `leak ${KEY}` } }));
    const error = await failure(() => client(f).get('/projects'));
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(KEY), 'no key in a message');
    assert.ok(!error.message.includes('Secret detail'), 'no RevenueCat text in a message');
    assert.ok(!error.message.includes(PROJECT_ID), 'no id in a message');
  }
});

test('a 429 carries the seconds to wait: Retry-After, else backoff_ms, else a minute', async () => {
  const one = async (answer: Answer) => (await failure(() => client(fakeFetch(() => answer)).get('/projects'))).retryAfterSeconds;
  assert.equal(await one({ status: 429, headers: { 'retry-after': '7' }, body: errorBody('rate_limit_error') }), 7);
  assert.equal(await one({ status: 429, body: { ...errorBody('rate_limit_error'), backoff_ms: 2500 } }), 3);
  assert.equal(await one({ status: 429, body: errorBody('rate_limit_error') }), 60);
  assert.equal(await one({ status: 429, headers: { 'retry-after': '999999' }, body: {} }), 3600);
});

test('nothing is retried: one 429 is one request', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '1' }, body: {} }));
  await failure(() => client(f).list('/projects'));
  assert.equal(f.calls.length, 1);
});

test('a redirect is not followed and is not an answer; non-JSON and a non-object are unexpected', async () => {
  for (const answer of [
    { status: 302, headers: { location: 'https://evil.example/' }, body: {} },
    { text: '<html>' },
    { text: '[1,2]' },
  ] as Answer[]) {
    const f = fakeFetch(() => answer);
    assert.equal((await failure(() => client(f).get('/projects'))).kind, 'unexpected');
    assert.equal(f.calls.length, 1, 'no second request to the redirect target');
  }
});

test('an answer over the size cap is refused, by its declared length and by what actually arrives', async () => {
  const declared = fakeFetch(() => ({ text: '{}', headers: { 'content-length': '999999999' } }));
  assert.equal((await failure(() => client(declared, { maxResponseBytes: 1000 }).get('/projects'))).kind, 'unexpected');
  const big = fakeFetch(() => ({ text: JSON.stringify({ items: ['x'.repeat(5000)] }) }));
  const error = await failure(() => client(big, { maxResponseBytes: 1000 }).get('/projects'));
  assert.equal(error.kind, 'unexpected');
  assert.match(error.message, /too large/);
});

test('a network failure and a timeout are network errors; the text of the failure is dropped', async () => {
  const down = fakeFetch(() => new Error(`connect ECONNREFUSED https://api.revenuecat.com ${KEY}`));
  const e1 = await failure(() => client(down).get('/projects'));
  assert.equal(e1.kind, 'network');
  assert.equal(e1.timedOut, false);
  assert.ok(!e1.message.includes('ECONNREFUSED') && !e1.message.includes(KEY));
  const slow: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const e2 = await failure(() => createRevenueCatClient({ apiKey: KEY, fetch: slow, timeoutMs: 20 }).get('/projects'));
  assert.equal(e2.kind, 'network');
  assert.equal(e2.timedOut, true);
});

test('a list follows starting_after with the id of the last item, 100 at a time, and never the next_page URL', async () => {
  const f = fakeFetch((call) => {
    const after = call.query.get('starting_after');
    if (after === null) return { body: list([{ id: 'a' }, { id: 'b' }], 'https://evil.example/v2/x?starting_after=b') };
    if (after === 'b') return { body: list([{ id: 'c' }]) };
    return { status: 500 };
  });
  const got = await client(f).list('/projects');
  assert.deepEqual(got.items, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(got.complete, true);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.url.startsWith(REVENUECAT_API_ORIGIN)));
  assert.equal(f.calls[0]?.query.get('limit'), '100');
});

test('a list stops at the page cap and says it is incomplete; a next page without an id to continue from is not followed', async () => {
  const f = fakeFetch((call) => ({ body: list([{ id: `p${call.query.get('starting_after') ?? '0'}x` }], '/next') }));
  const capped = await client(f).list('/projects', {}, { maxPages: 3 });
  assert.equal(capped.complete, false);
  assert.equal(f.calls.length, 3);
  const noId = fakeFetch(() => ({ body: list([{ name: 'no id' }], '/next') }));
  assert.equal((await client(noId).list('/projects')).complete, false);
  assert.equal(noId.calls.length, 1);
  const notAList = fakeFetch(() => ({ body: { object: 'list' } }));
  assert.equal((await failure(() => client(notAList).list('/projects'))).kind, 'unexpected');
});

test('the request budget stops a paginated read before a 429 instead of after it', async () => {
  const f = fakeFetch((call) => ({ body: list([{ id: `i${call.query.get('starting_after') ?? ''}` }], '/next') }));
  const c = client(f, { maxRequests: 2 });
  const got = await c.list('/projects');
  assert.equal(got.complete, false);
  assert.equal(f.calls.length, 2);
  assert.equal(c.canRequest(), false);
  assert.equal((await failure(() => c.get('/projects'))).kind, 'rate_limited');
  assert.equal(f.calls.length, 2, 'no request past the budget');
});

test('the rate limit headers of an answer stop a paginated read when the minute is used up', async () => {
  const f = fakeFetch((call) => ({
    body: list([{ id: `i${call.query.get('starting_after') ?? ''}` }], '/next'),
    headers: { 'revenuecat-rate-limit-current-usage': '59', 'revenuecat-rate-limit-current-limit': '60' },
  }));
  const c = client(f);
  assert.equal((await c.list('/projects')).complete, false);
  assert.equal(f.calls.length, 1);
  assert.equal(c.canRequest(), false);
});
