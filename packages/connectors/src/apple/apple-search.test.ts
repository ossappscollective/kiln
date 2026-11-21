import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPLE_OWN_ID, appleLookupReply, appleSearchReply } from '../aso.fixtures.ts';
import { AsoError } from '../aso-common.ts';
import {
  appleSearchUrl,
  lookupApple,
  parseAppleApps,
  rankIn,
  searchApple,
} from './apple-search.ts';

type Seen = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return respond();
    },
  };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'text/javascript', ...headers },
  });

const failure = async (run: () => Promise<unknown>): Promise<AsoError> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof AsoError, String(error));
    return error;
  }
  assert.fail('expected an AsoError');
};

test('a search is one GET to the fixed host with the documented parameters, no credential, no redirects', async () => {
  const { fetch, seen } = fakeFetch(() => json(appleSearchReply));
  const result = await searchApple({
    term: 'habit tracker & goals',
    country: 'DE',
    limit: 25,
    fetch,
  });
  assert.equal(seen.length, 1);
  const url = new URL(seen[0]?.url ?? '');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'itunes.apple.com');
  assert.equal(url.pathname, '/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    term: 'habit tracker & goals',
    country: 'de',
    media: 'software',
    entity: 'software',
    limit: '25',
  });
  assert.equal(seen[0]?.init?.method, 'GET');
  assert.equal(seen[0]?.init?.redirect, 'manual');
  const headers = new Headers(seen[0]?.init?.headers);
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.match(headers.get('user-agent') ?? '', /kiln/);
  assert.ok(seen[0]?.init?.signal, 'a timeout is set');
  assert.deepEqual(result.ids, [
    '1500000002',
    '1500000001',
    '1500000007',
    '1500000003',
    '1500000004',
  ]);
  assert.equal(result.total, 5);
  assert.equal(result.limit, 25);
});

test("the default limit is Apple's documented 50, and lang is passed when asked", () => {
  assert.match(appleSearchUrl({ term: 'x', country: 'us' }), /&limit=50$/);
  assert.match(
    appleSearchUrl({ term: 'x', country: 'US', limit: 200, lang: 'ja_jp' }),
    /limit=200&lang=ja_jp$/,
  );
});

test('rankIn is the position, or null', () => {
  const ids = ['10', '20', '30'];
  assert.equal(rankIn(ids, '10'), 1);
  assert.equal(rankIn(ids, '30'), 3);
  assert.equal(rankIn(ids, '99'), null);
  assert.equal(rankIn([], '1'), null);
});

test('the apps are parsed with what Apple sent, and the optional parts may be missing', () => {
  const apps = parseAppleApps(appleSearchReply);
  assert.equal(apps.length, 5);
  const first = apps[0];
  assert.equal(first?.trackId, '1500000002');
  assert.equal(first?.name, 'Habit App 2');
  assert.equal(first?.bundleId, 'com.example.habit2');
  assert.equal(first?.price, 'Free');
  assert.equal(first?.ratingMilli, 4100);
  assert.equal(first?.ratingCount, 2000);
  assert.equal(first?.screenshotUrls.length, 3);
  assert.match(first?.iconUrl ?? '', /mzstatic\.com/);
  assert.equal(apps[2]?.name, 'Café & Goals');
  // The bare minimum is an id.
  const bare = parseAppleApps({
    results: [
      { trackId: 5 },
      { trackId: 5 },
      { nope: true },
      { trackId: 6, kind: 'song' },
      { trackId: 7, wrapperType: 'track', kind: 'feature-movie' },
      { trackId: 8, trackName: 'Eight', averageUserRating: 9, userRatingCount: -4 },
    ],
  });
  assert.deepEqual(
    bare.map((a) => a.trackId),
    ['5', '8'],
  );
  assert.equal(bare[1]?.ratingMilli, undefined);
  assert.equal(bare[1]?.ratingCount, undefined);
});

test('a reply without a result list is unexpected, and says nothing about the term', async () => {
  for (const reply of [{ errorMessage: 'x' }, [], 'text', null]) {
    const { fetch } = fakeFetch(() => json(reply));
    const error = await failure(() => searchApple({ term: 'secret term', country: 'us', fetch }));
    assert.equal(error.kind, 'unexpected');
    assert.equal(error.message.includes('secret'), false);
  }
  const { fetch } = fakeFetch(() => new Response('<html>', { status: 200 }));
  assert.equal(
    (await failure(() => searchApple({ term: 'x', country: 'us', fetch }))).kind,
    'unexpected',
  );
});

test('statuses: 429 and 403 are a rate limit with Retry-After, 5xx is server, the rest unexpected', async () => {
  const run = (status: number, headers: Record<string, string> = {}) => {
    const { fetch } = fakeFetch(() => new Response('', { status, headers }));
    return failure(() => searchApple({ term: 'x', country: 'us', fetch }));
  };
  const limited = await run(429, { 'retry-after': '120' });
  assert.deepEqual(
    [limited.kind, limited.retryAfterSeconds, limited.status],
    ['rate_limited', 120, 429],
  );
  assert.equal((await run(403)).retryAfterSeconds, 60);
  assert.equal((await run(503)).kind, 'server');
  assert.equal((await run(404)).kind, 'unexpected');
  const redirect = await run(302, { location: 'https://evil.example/' });
  assert.equal(redirect.kind, 'unexpected', 'a redirect is not followed');
});

test('network failures and timeouts are typed, without the term or the address', async () => {
  const boom = async (error: Error) => {
    const { fetch } = fakeFetch(() => {
      throw error;
    });
    return failure(() => searchApple({ term: 'private words', country: 'us', fetch }));
  };
  const network = await boom(new TypeError('connect ECONNREFUSED 10.0.0.1:443 private words'));
  assert.equal(network.kind, 'network');
  assert.equal(/10\.0|private/.test(network.message), false);
  assert.equal(
    (await boom(Object.assign(new Error('x'), { name: 'TimeoutError' }))).kind,
    'timeout',
  );
  assert.equal(
    (await boom(Object.assign(new Error('x'), { name: 'TooLargeError' }))).kind,
    'too_large',
  );
});

test('a body above the cap is too large, never a cut reply', async () => {
  const big = `{"results":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`;
  const { fetch } = fakeFetch(() => new Response(big, { status: 200 }));
  assert.equal(
    (await failure(() => searchApple({ term: 'x', country: 'us', fetch }))).kind,
    'too_large',
  );
});

test('input is checked before any request', async () => {
  const { fetch, seen } = fakeFetch(() => json(appleSearchReply));
  for (const bad of [
    { term: '', country: 'us' },
    { term: '   ', country: 'us' },
    { term: 'x'.repeat(201), country: 'us' },
    { term: 'x', country: 'usa' },
    { term: 'x', country: 'u1' },
    { term: 'x', country: 'us', limit: 0 },
    { term: 'x', country: 'us', limit: 201 },
    { term: 'x', country: 'us', limit: 1.5 },
  ]) {
    assert.equal(
      (await failure(() => searchApple({ ...bad, fetch }))).kind,
      'invalid_input',
      JSON.stringify(bad),
    );
  }
  assert.equal(seen.length, 0);
});

test('a lookup is one GET by id and country, and finds the app or nothing', async () => {
  const { fetch, seen } = fakeFetch(() => json(appleLookupReply));
  const found = await lookupApple({ id: APPLE_OWN_ID, country: 'GB', fetch });
  assert.equal(seen[0]?.url, `https://itunes.apple.com/lookup?id=${APPLE_OWN_ID}&country=gb`);
  assert.equal(found?.trackId, APPLE_OWN_ID);
  assert.equal(found?.name, 'Habit App 1');
  const empty = fakeFetch(() => json({ resultCount: 0, results: [] }));
  assert.equal(await lookupApple({ id: '42', country: 'us', fetch: empty.fetch }), undefined);
  for (const id of ['', 'abc', '12;13', '1'.repeat(21)]) {
    assert.equal(
      (await failure(() => lookupApple({ id, country: 'us', fetch }))).kind,
      'invalid_input',
      id,
    );
  }
});
