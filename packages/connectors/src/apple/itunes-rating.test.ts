import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as rx from '../reviews.fixtures.ts';
import { fetchRatingSummary, ITUNES_LOOKUP_URL, parseRatingSummary } from './itunes-rating.ts';

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

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'text/javascript' } });

test('one GET to the fixed host with a numeric id and a two letter country, no credential, no redirects', async () => {
  const { fetch, seen } = fakeFetch(() => json(rx.itunesLookup));
  const summary = await fetchRatingSummary({ appStoreId: rx.APP_ID, country: 'US', fetch });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, `${ITUNES_LOOKUP_URL}?id=${rx.APP_ID}&country=us`);
  assert.equal(new URL(seen[0]?.url ?? '').protocol, 'https:');
  assert.equal(new URL(seen[0]?.url ?? '').host, 'itunes.apple.com');
  assert.equal(seen[0]?.init?.method, 'GET');
  assert.equal(seen[0]?.init?.redirect, 'error');
  assert.equal(new Headers(seen[0]?.init?.headers).get('authorization'), null);
  assert.deepEqual(summary, {
    appStoreId: rx.APP_ID,
    country: 'US',
    averageRating: 4.523,
    ratingCount: 12873,
    currentVersionAverage: 4.1,
    currentVersionCount: 210,
  });
});

test('nothing from outside can change where the request goes', async () => {
  const { fetch, seen } = fakeFetch(() => json(rx.itunesLookup));
  for (const [appStoreId, country] of [
    ['123/../../evil', 'us'],
    ['123&country=de', 'us'],
    ['', 'us'],
    ['123', 'usa'],
    ['123', 'u/'],
    ['123', ''],
  ] as const) {
    await assert.rejects(
      fetchRatingSummary({ appStoreId, country, fetch }),
      StoreError,
      `${appStoreId} ${country}`,
    );
  }
  assert.equal(seen.length, 0);
});

test('no result, no rating, junk and unknown fields give no summary and never throw', () => {
  assert.equal(parseRatingSummary({ resultCount: 0, results: [] }, '1', 'us'), undefined);
  assert.equal(
    parseRatingSummary({ results: [{ trackId: 1, trackName: 'New app' }] }, '1', 'us'),
    undefined,
  );
  assert.equal(
    parseRatingSummary(
      { results: [{ trackId: 1, averageUserRating: 9, userRatingCount: -3 }] },
      '1',
      'us',
    ),
    undefined,
  );
  assert.equal(
    parseRatingSummary(
      { results: [{ averageUserRating: '4.5', userRatingCount: '10' }] },
      '1',
      'us',
    ),
    undefined,
  );
  for (const junk of [undefined, null, 1, 'x', [], {}, { results: 'x' }, { results: [null, 3] }]) {
    assert.doesNotThrow(() => parseRatingSummary(junk, '1', 'us'));
  }
  assert.deepEqual(
    parseRatingSummary({ results: [{ averageUserRating: 4, userRatingCount: 3 }] }, '1', 'de'),
    {
      appStoreId: '1',
      country: 'DE',
      averageRating: 4,
      ratingCount: 3,
    },
  );
});

test('errors: network, timeout, status, rate limit, too much data, bad JSON', async () => {
  const cases: [() => Response | Promise<Response>, RegExp, string?][] = [
    [() => new Response('x', { status: 500 }), /HTTP 500/, 'server'],
    [() => new Response('x', { status: 404 }), /HTTP 404/, 'unexpected'],
    [() => new Response('not json'), /could not be read/, 'unexpected'],
    [() => new Response('x'.repeat(2000)), /more data than expected/, 'unexpected'],
  ];
  for (const [respond, message, kind] of cases) {
    const { fetch } = fakeFetch(respond);
    const error = await fetchRatingSummary({
      appStoreId: '1',
      country: 'us',
      fetch,
      maxBytes: 1000,
    }).catch((e) => e);
    assert.ok(error instanceof StoreError);
    assert.match(error.message, message);
    assert.equal(error.kind, kind);
  }
  const limited = await fetchRatingSummary({
    appStoreId: '1',
    country: 'us',
    fetch: fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }))
      .fetch,
  }).catch((e) => e);
  assert.ok(limited instanceof StoreRateLimitError);
  assert.equal(limited.retryAfterSeconds, 30);
  const down = await fetchRatingSummary({
    appStoreId: '1',
    country: 'us',
    fetch: async () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.1:443');
    },
  }).catch((e) => e);
  assert.ok(down instanceof StoreError);
  assert.equal(down.kind, 'network');
  assert.ok(!down.message.includes('10.0.0.1'), 'the underlying message is not shown');
  // AbortSignal.timeout does not keep the event loop alive; a real socket does. Stand in for it.
  const keepAlive = setTimeout(() => undefined, 2000);
  const slow = await fetchRatingSummary({
    appStoreId: '1',
    country: 'us',
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  }).catch((e) => e);
  clearTimeout(keepAlive);
  assert.ok(slow instanceof StoreError);
  assert.match(slow.message, /timed out/);
});
