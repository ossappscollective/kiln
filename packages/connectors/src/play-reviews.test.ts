import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from './errors.ts';
import { PLAY_REVIEW_WINDOW_MS, parsePlayReview, parsePlayReviews, parsePlayTimestamp, PlayReviewsConnector } from './play-reviews.ts';
import * as rx from './reviews.fixtures.ts';
import * as fx from './store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.googleKeyPem();
const LIST = `/androidpublisher/v3/applications/${rx.PLAY_PACKAGE}/reviews`;

function setup(options: { pageSize?: number; maxPages?: number } = {}) {
  const fake = new fx.FakeFetch();
  fake.on({ method: 'POST', match: '/token', json: fx.googleToken });
  const connector = new PlayReviewsConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: rx.PLAY_PACKAGE,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
    pageSize: options.pageSize ?? 2,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
  return { fake, connector };
}

test('the window of Google is one week', () => {
  assert.equal(PLAY_REVIEW_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('listReviews pages by token and normalizes reviews', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${LIST}?maxResults=2`, json: rx.playPage1 })
    .on({ method: 'GET', match: `${LIST}?maxResults=2&token=TOKEN-2`, json: rx.playPage2 });
  const result = await connector.listReviews();
  assert.deepEqual(fake.unexpected, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.reviews.map((r) => r.rating), [1, 5, 3]);
  const first = result.reviews[0];
  assert.equal(first?.store, 'googleplay');
  assert.equal(first?.platform, 'android');
  assert.equal(first?.storeReviewId, 'gp:AOqpTOE1');
  assert.equal(first?.authorName, 'Sam');
  assert.equal(first?.title, 'Broken', 'title and body come as one string separated by a tab');
  assert.equal(first?.body, 'The app crashes when I open the camera.');
  assert.equal(first?.language, 'en_US');
  assert.equal(first?.appVersion, '2.4.0');
  assert.equal(first?.buildNumber, '240');
  assert.equal(first?.device, 'klte');
  assert.equal(first?.territory, undefined, 'Google Play has no territory');
  assert.equal(first?.createdAt, Date.parse('2026-11-17T10:00:00Z'));
  assert.equal(first?.updatedAt, first?.createdAt, 'no creation time exists: the modification time is both');
  assert.deepEqual(first?.developerResponse, { body: 'Thanks, a fix is coming.', at: Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(result.reviews[1]?.title, undefined);
  assert.equal(result.reviews[1]?.buildNumber, '239');
  assert.equal(result.reviews[2]?.body, rx.XSS, 'kept as text');
  assert.ok(fake.calls.filter((c) => c.url.pathname.endsWith('/reviews')).every((c) => c.method === 'GET'));
});

test('maxResults never exceeds 100 and since drops older reviews', async () => {
  const { fake, connector } = (() => {
    const fake = new fx.FakeFetch();
    fake.on({ method: 'POST', match: '/token', json: fx.googleToken });
    const connector = new PlayReviewsConnector({
      serviceAccount: fx.serviceAccountJson(key.privateKey),
      packageName: rx.PLAY_PACKAGE,
      fetch: fake.fetch,
      now: () => T0,
      pageSize: 5000,
    });
    return { fake, connector };
  })();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=100`, json: { reviews: [...rx.playPage1.reviews, ...rx.playPage2.reviews] } });
  const result = await connector.listReviews({ limit: 1000, since: Date.parse('2026-11-16T12:00:00Z') });
  assert.deepEqual(result.reviews.map((r) => r.storeReviewId), ['gp:AOqpTOE1']);
});

test('the page cap and the limit stop the read and say so, with no cursor offered', async () => {
  const { fake, connector } = setup({ maxPages: 1 });
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, json: rx.playPage1 });
  const result = await connector.listReviews();
  assert.equal(result.complete, false);
  assert.equal(result.nextCursor, undefined);
  assert.match(result.warnings.join(' '), /Stopped after 1 pages/);
  assert.equal(fake.calls.filter((c) => c.method === 'GET').length, 1);
});

test('translationLanguage is passed on, the translation is kept apart from the original', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2&translationLanguage=en`, json: { reviews: [rx.playTranslated] } });
  const result = await connector.listReviews({ translationLanguage: 'en' });
  const [review] = result.reviews;
  assert.equal(review?.title, 'Lent');
  assert.equal(review?.body, 'L’application est lente');
  assert.equal(review?.translatedBody, 'The app is slow');
  // A language that is not a code is not sent.
  const other = setup();
  other.fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, json: {} });
  await other.connector.listReviews({ translationLanguage: 'en&token=x' });
  assert.deepEqual(other.fake.unexpected, []);
});

test('an empty answer is an empty list', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, json: {} });
  const result = await connector.listReviews();
  assert.deepEqual(result.reviews, []);
  assert.equal(result.complete, true);
});

test('partial, odd and unknown content never throws; unusable entries are counted', () => {
  const parsed = parsePlayReviews(rx.playPartial);
  assert.deepEqual(parsed.reviews.map((r) => r.storeReviewId), ['ok']);
  assert.equal(parsed.skipped, 6);
  assert.equal(parsed.reviews[0]?.rating, 4);
  assert.equal(parsed.reviews[0]?.createdAt, 1731900000 * 1000);
  assert.equal(parsed.reviews[0]?.authorName, undefined);
  assert.equal(parsed.reviews[0]?.appVersion, undefined);
  for (const junk of [undefined, null, 7, 'x', [], {}, { reviews: 'nope' }, { reviews: [null, 1, 'x', {}] }]) {
    assert.doesNotThrow(() => parsePlayReviews(junk));
  }
  assert.equal(parsePlayReview(null), undefined);
});

test('timestamps: seconds is a string, nanos refine it, junk is rejected', () => {
  assert.equal(parsePlayTimestamp({ seconds: '1731900000', nanos: 5_000_000 }), 1731900000005);
  assert.equal(parsePlayTimestamp({ seconds: 1731900000 }), 1731900000000);
  assert.equal(parsePlayTimestamp({ seconds: 'soon' }), undefined);
  assert.equal(parsePlayTimestamp({ seconds: '-5' }), undefined);
  assert.equal(parsePlayTimestamp('2026-11-18'), undefined);
  assert.equal(parsePlayTimestamp(undefined), undefined);
});

test('with several comments the newest user comment and the newest developer comment win', () => {
  const review = {
    reviewId: 'multi',
    authorName: 'X',
    comments: [
      { userComment: { text: 'old', starRating: 1, lastModified: { seconds: '100' } } },
      { developerComment: { text: 'reply 1', lastModified: { seconds: '150' } } },
      { userComment: { text: 'edited', starRating: 4, lastModified: { seconds: '200' } } },
      { developerComment: { text: 'reply 2', lastModified: { seconds: '250' } } },
    ],
  };
  const parsed = parsePlayReview(review);
  assert.equal(parsed?.rating, 4);
  assert.equal(parsed?.body, 'edited');
  assert.equal(parsed?.updatedAt, 200_000);
  assert.equal(parsed?.developerResponse?.body, 'reply 2');
});

test('a review id and a version code that look odd are kept or dropped safely', () => {
  const parsed = parsePlayReview({
    reviewId: 'r',
    comments: [{ userComment: { text: 'x', starRating: '5', lastModified: { seconds: '1' }, appVersionCode: 'abc', device: '' } }],
  });
  assert.equal(parsed?.rating, 5);
  assert.equal(parsed?.buildNumber, undefined);
  assert.equal(parsed?.device, undefined);
});

test('errors map to StoreError kinds; quota is a rate limit error', async () => {
  const cases: [number, unknown, string][] = [
    [403, rx.playErrors.forbidden, 'forbidden'],
    [404, rx.playErrors.notFound, 'not_found'],
    [500, {}, 'server'],
  ];
  for (const [status, json, kind] of cases) {
    const { fake, connector } = setup();
    fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, status, json });
    const error = await connector.listReviews().catch((e) => e);
    assert.ok(error instanceof StoreError, `${status}`);
    assert.equal(error.kind, kind, `${status}`);
    assert.ok(!error.message.includes(fx.ACCESS_TOKEN));
    assert.ok(!error.message.includes('PRIVATE KEY'));
  }
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, status: 429, json: rx.playErrors.quota });
  const error = await connector.listReviews().catch((e) => e);
  assert.ok(error instanceof StoreRateLimitError);
  assert.equal(error.store, 'googleplay');
});

test('a 401 mints a new token once and retries', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, status: 401, json: {}, times: 1 });
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, json: rx.playPage2 });
  const result = await connector.listReviews();
  assert.equal(result.reviews.length, 1);
  assert.equal(fake.calls.filter((c) => c.url.pathname === '/token').length, 2);
});

test('reviews.get reads one review; a missing one is undefined; an unsafe id never reaches a URL', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}/gp%3AAOqpTOE2`, json: rx.playPage1.reviews[1] });
  fake.on({ method: 'GET', match: `${LIST}/gone`, status: 404, json: rx.playErrors.notFound });
  assert.equal((await connector.getReview('gp:AOqpTOE2'))?.rating, 5);
  assert.equal(await connector.getReview('gone'), undefined);
  await assert.rejects(connector.getReview('../x'), StoreError);
});

test('only GET requests go to the reviews API: there is no reply call', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${LIST}?maxResults=2`, json: rx.playPage2 });
  await connector.listReviews();
  assert.ok(fake.calls.filter((c) => c.url.pathname.includes('/reviews')).every((c) => c.method === 'GET'));
  assert.ok(!('reply' in connector));
});

test('the package name is checked before it goes into a URL', () => {
  assert.throws(
    () => new PlayReviewsConnector({ serviceAccount: fx.serviceAccountJson(key.privateKey), packageName: 'com/../x' }),
    StoreError,
  );
});
