import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppStoreReviewsConnector,
  parseAppleRateRemaining,
  parseAppleReviews,
  parseAppleSummarizations,
} from './appstore-reviews.ts';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as rx from '../reviews.fixtures.ts';
import * as fx from '../store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();
const FIRST = `${rx.REVIEWS_PATH}?limit=2&sort=-createdDate&include=response`;
const SECOND = `${rx.REVIEWS_PATH}?limit=2&sort=-createdDate&include=response&cursor=AQ.AMt2C-U`;

function setup(options: { pageSize?: number; maxPages?: number; rateLimitReserve?: number } = {}) {
  const fake = new fx.FakeFetch();
  const connector = new AppStoreReviewsConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: rx.APP_ID,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
    pageSize: options.pageSize ?? 2,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.rateLimitReserve !== undefined
      ? { rateLimitReserve: options.rateLimitReserve }
      : {}),
  });
  return { fake, connector };
}

test('listReviews reads newest first with the developer response included, and follows the cursor', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: FIRST, json: rx.applePage1 })
    .on({ method: 'GET', match: SECOND, json: rx.applePage2 });
  const result = await connector.listReviews();
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, undefined);
  assert.deepEqual(fake.unexpected, []);
  assert.deepEqual(
    result.reviews.map((r) => r.rating),
    [1, 5, 3, 2],
  );
  const first = result.reviews[0];
  assert.equal(first?.store, 'appstoreconnect');
  assert.equal(first?.platform, 'ios');
  assert.equal(first?.storeReviewId, '00000030-0000-0000-0000-000000000001');
  assert.equal(first?.title, 'Crashes on launch');
  assert.equal(first?.authorName, 'Pat');
  assert.equal(first?.territory, 'USA');
  assert.equal(first?.createdAt, Date.parse('2026-11-17T10:00:00-08:00'));
  assert.equal(first?.updatedAt, first?.createdAt);
  assert.deepEqual(first?.developerResponse, {
    body: 'Sorry about that, please update to 2.4.1.',
    storeResponseId: 'resp-00000030-0000-0000-0000-000000000001',
    at: Date.parse('2026-11-16T09:00:00-08:00'),
    state: 'PUBLISHED',
  });
  assert.equal(result.reviews[1]?.developerResponse, undefined);
  assert.equal(result.reviews[1]?.territory, 'GBR');
  // Only GETs, all with the bearer token, nothing else.
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
  assert.ok(fake.calls.every((c) => c.headers.get('authorization')?.startsWith('Bearer ')));
});

test('review text is kept as text, never interpreted', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: FIRST, json: rx.applePage1 })
    .on({ method: 'GET', match: SECOND, json: rx.applePage2 });
  const result = await connector.listReviews();
  const last = result.reviews[3];
  assert.equal(last?.title, rx.XSS);
  assert.equal(last?.body, rx.XSS);
  assert.equal(last?.authorName, '<b>Bold</b>');
});

test('limit cuts the read and gives a cursor; the next read continues from it', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: FIRST, json: rx.applePage1 })
    .on({ method: 'GET', match: SECOND, json: rx.applePage2 });
  const part = await connector.listReviews({ limit: 2 });
  assert.equal(part.reviews.length, 2);
  assert.equal(part.complete, false);
  assert.equal(part.nextCursor, 'AQ.AMt2C-U');
  assert.equal(fake.calls.length, 1);
  const rest = await connector.listReviews({ cursor: part.nextCursor as string });
  assert.deepEqual(
    rest.reviews.map((r) => r.rating),
    [3, 2],
  );
  assert.equal(rest.complete, true);
  assert.equal(fake.calls[1]?.url.searchParams.get('cursor'), 'AQ.AMt2C-U');
  assert.equal(fake.calls[1]?.url.searchParams.get('sort'), '-createdDate');
});

test('the page size of a later page shrinks to what the limit still allows (no review is cut off)', async () => {
  const { fake, connector } = setup({ pageSize: 2 });
  fake.on({ method: 'GET', match: FIRST, json: rx.applePage1 });
  fake.on({
    method: 'GET',
    match: `${rx.REVIEWS_PATH}?limit=1&sort=-createdDate&include=response&cursor=AQ.AMt2C-U`,
    json: {
      ...rx.applePage2,
      data: rx.applePage2.data.slice(0, 1),
      links: { next: `${fx.APPLE_BASE}${rx.REVIEWS_PATH}?cursor=NEXT&limit=1` },
    },
  });
  const result = await connector.listReviews({ limit: 3 });
  assert.equal(result.reviews.length, 3);
  assert.equal(result.nextCursor, 'NEXT');
  assert.equal(result.complete, false);
});

test('since stops at the first page with an older review and drops the old ones', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: FIRST, json: rx.applePage1 })
    .on({ method: 'GET', match: SECOND, json: rx.applePage2 });
  const result = await connector.listReviews({ since: Date.parse('2026-11-16T12:00:00Z') });
  assert.deepEqual(
    result.reviews.map((r) => r.rating),
    [1, 5],
  );
  assert.equal(result.complete, true, 'nothing newer can follow on the next page');
  assert.equal(fake.calls.length, 2, 'the page with an older review is read and ends the read');
});

test('the page cap stops a runaway read and says so', async () => {
  const { fake, connector } = setup({ maxPages: 1 });
  fake.on({ method: 'GET', match: FIRST, json: rx.applePage1 });
  const result = await connector.listReviews();
  assert.equal(result.reviews.length, 2);
  assert.equal(result.complete, false);
  assert.equal(result.nextCursor, 'AQ.AMt2C-U');
  assert.match(result.warnings.join(' '), /Stopped after 1 pages/);
});

test('the rate limit header is read, and the read stops early when the budget is nearly spent', async () => {
  assert.equal(parseAppleRateRemaining('user-hour-lim:3500;user-hour-rem:500;'), 500);
  assert.equal(parseAppleRateRemaining('nonsense'), undefined);
  assert.equal(parseAppleRateRemaining(null), undefined);
  const { fake, connector } = setup({ rateLimitReserve: 25 });
  fake.on({
    method: 'GET',
    match: FIRST,
    json: rx.applePage1,
    headers: { 'x-rate-limit': 'user-hour-lim:3500;user-hour-rem:10;' },
  });
  const result = await connector.listReviews();
  assert.equal(result.complete, false);
  assert.equal(result.rateLimitRemaining, 10);
  assert.equal(result.nextCursor, 'AQ.AMt2C-U');
  assert.match(result.warnings.join(' '), /10 requests left this hour/);
  assert.equal(fake.calls.length, 1);
});

test('partial, odd and unknown content never throws; unusable entries are counted', () => {
  const parsed = parseAppleReviews(rx.applePartial);
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0]?.storeReviewId, 'ok-1');
  assert.equal(parsed.reviews[0]?.rating, 4);
  assert.equal(parsed.reviews[0]?.body, '');
  assert.equal(parsed.reviews[0]?.title, undefined);
  assert.equal(parsed.skipped, 5);
  for (const junk of [undefined, null, 5, 'x', [], {}, { data: 'nope' }, { data: [{}] }]) {
    assert.doesNotThrow(() => parseAppleReviews(junk));
  }
  assert.deepEqual(parseAppleReviews(null), { reviews: [], skipped: 0 });
});

test('a response without text, or one that is not linked, is ignored', () => {
  const page = {
    data: [rx.appleReview('r1', 2, '2026-11-01T00:00:00Z', { response: 'x' })],
    included: [
      {
        type: 'customerReviewResponses',
        id: 'resp-r1',
        attributes: { responseBody: '   ', state: 'PUBLISHED' },
      },
      { type: 'other', id: 'resp-r1' },
    ],
  };
  assert.equal(parseAppleReviews(page).reviews[0]?.developerResponse, undefined);
});

test('control characters are removed from the text and very long text is cut', () => {
  const page = {
    data: [
      rx.appleReview('r1', 2, '2026-11-01T00:00:00Z', {
        body: `a\u0000b\u0007c\n${'x'.repeat(30_000)}`,
        title: 'T\u0001',
      }),
    ],
  };
  const [review] = parseAppleReviews(page).reviews;
  assert.equal(review?.title, 'T');
  assert.ok((review?.body.length ?? 0) <= 20_000);
  assert.ok(review?.body.startsWith('abc\nxxx'));
});

test('errors map to StoreError kinds with a safe message; a role problem says so', async () => {
  const cases: [number, unknown, string][] = [
    [403, rx.appleErrors.forbidden, 'forbidden'],
    [404, rx.appleErrors.notFound, 'not_found'],
    [500, {}, 'server'],
    [401, {}, 'auth'],
  ];
  for (const [status, json, kind] of cases) {
    const { fake, connector } = setup();
    fake.on({ method: 'GET', match: FIRST, status, json });
    const error = await connector.listReviews().catch((e) => e);
    assert.ok(error instanceof StoreError, `${status}`);
    assert.equal(error.kind, kind, `${status}`);
    assert.ok(!/PRIVATE KEY/.test(error.message));
  }
});

test('429 is waited out once, then thrown as a rate limit error with a wait time', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: FIRST,
    status: 429,
    json: rx.appleErrors.rateLimited,
    headers: { 'retry-after': '3' },
    times: 1,
  });
  fake.on({ method: 'GET', match: FIRST, json: rx.applePage2 });
  assert.equal((await connector.listReviews({ limit: 2 })).reviews.length, 2);
  const failing = setup();
  failing.fake.on({ method: 'GET', match: FIRST, status: 429, json: rx.appleErrors.rateLimited });
  const error = await failing.connector.listReviews().catch((e) => e);
  assert.ok(error instanceof StoreRateLimitError);
  assert.equal(error.retryAfterSeconds, 60);
});

test('a paging link to another host is not followed (the token is never sent elsewhere)', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: FIRST,
    json: { ...rx.applePage1, links: { next: 'https://evil.example/v1/apps?cursor=x' } },
  });
  const error = await connector.listReviews().catch((e) => e);
  assert.ok(error instanceof StoreError);
  assert.match(error.message, /another host/);
  assert.ok(fake.calls.every((c) => c.url.host === 'api.appstoreconnect.apple.com'));
});

test('a malformed body is an unexpected error, not a crash', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: FIRST, raw: '<html>oops' });
  const error = await connector.listReviews().catch((e) => e);
  assert.ok(error instanceof StoreError);
  assert.equal(error.kind, 'unexpected');
});

test('reading reviews only ever sends GET requests (replies are tested in review-replies.test.ts)', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: FIRST, json: rx.applePage2 });
  await connector.listReviews({ limit: 2 });
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
});

test('the app id must be numeric before it goes into a URL', () => {
  assert.throws(
    () =>
      new AppStoreReviewsConnector({
        credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
        appStoreId: '../apps',
      }),
    StoreError,
  );
});

test('summarizations: one GET with the required platform filter, tolerant parsing', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: `/v1/apps/${rx.APP_ID}/customerReviewSummarizations?filter[platform]=IOS&limit=200`,
    json: rx.appleSummarizations,
  });
  const found = await connector.listSummarizations();
  assert.equal(found.length, 1);
  assert.equal(found[0]?.territory, 'USA');
  assert.match(found[0]?.text ?? '', /crashes after login/);
  assert.deepEqual(parseAppleSummarizations(null), []);
});
