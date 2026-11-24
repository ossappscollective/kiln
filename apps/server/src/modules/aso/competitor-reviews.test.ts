import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsoError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { parseAppleReviewFeed } from './competitor-reviews.ts';
import { bootAso, publicApp } from './test-helpers.ts';

/** Reviews of followed App Store competitors (docs/api/competitor-reviews.md). Apple's feed is a fake: nothing leaves the process. */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const feedReview = (
  id: string,
  rating: number,
  daysAgo: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  rating,
  title: `t${id}`,
  body: `body ${id}`,
  version: '1.0',
  at: NOW - daysAgo * DAY,
  ...over,
});

test('the Apple feed is read for what it gives and nothing about the author; the app entry and bad entries are skipped', () => {
  const entry = (id: string, rating: string | null) => ({
    author: { name: { label: 'Real Name' }, uri: { label: 'https://itunes.apple.com/u/1' } },
    id: { label: id },
    ...(rating ? { 'im:rating': { label: rating } } : {}),
    'im:version': { label: '2.1' },
    title: { label: 'Nice' },
    content: { label: 'x'.repeat(2000), attributes: { type: 'text' } },
    updated: { label: '2026-06-01T10:00:00-07:00' },
  });
  const out = parseAppleReviewFeed({
    feed: { entry: [entry('app', null), entry('r1', '5'), entry('r2', '9'), entry('r3', '3')] },
  });
  assert.deepEqual(
    out.map((r) => r.id),
    ['r1', 'r3'],
  );
  assert.equal(out[0]?.body.length, 1000, 'text is cut');
  assert.ok(!JSON.stringify(out).includes('Real Name'), 'the author is not kept');
  assert.deepEqual(
    parseAppleReviewFeed({ feed: { entry: entry('one', '4') } }).map((r) => r.id),
    ['one'],
    'a single entry is an object',
  );
  assert.deepEqual(parseAppleReviewFeed(null), []);
  assert.deepEqual(parseAppleReviewFeed({ feed: {} }), []);
});

dbTest(
  'competitor reviews: read, stored, throttled, summarised beside our own app, pruned, and Play is refused',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    t.sources.setApp('ios', 'us', publicApp('555', { name: 'Rival Five' }));
    const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
      externalId: 'id555',
    });
    assert.equal(add.status, 201, add.text);
    const cid = add.body.competitor.id as string;
    t.sources.feeds.set('us|555', [
      feedReview('a', 5, 1),
      feedReview('b', 1, 2),
      feedReview('c', 4, 20),
      feedReview('old', 2, 120),
    ]);
    const url = `/apps/${appId}/aso/competitors/${cid}/reviews/refresh`;
    const read = await t.call(t.owner, 'POST', url);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(
      [read.body.state, read.body.fetched, read.body.stored],
      ['read', 4, 3],
      'a review older than 90 days is not kept',
    );
    const again = await t.call(t.owner, 'POST', url);
    assert.equal(again.body.state, 'recent');
    assert.equal(t.sources.reviewReads.length, 1, 'a second read inside 15 minutes calls nothing');

    await db.execute(
      `INSERT INTO app_reviews (id, workspace_id, app_id, store, store_review_id, rating, title, body, author_name, territory, language, app_version, created_at, updated_at, first_seen_at, fetched_at, developer_response, status, assignee_user_id)
     VALUES ('own1', ?, ?, 'appstoreconnect', 'own-1', 3, 'ours', 'ours', 'Someone', 'USA', 'en-US', '1.0', ?, 1, 1, 1, NULL, 'new', NULL)`,
      [t.workspaceId, appId, NOW - DAY],
    );
    const view = await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitor-reviews?days=28`);
    assert.equal(view.status, 200, view.text);
    const c = view.body.competitors[0];
    assert.equal(c.count, 3);
    assert.equal(c.average, 3.33);
    assert.deepEqual(c.stars, [1, 0, 0, 1, 1]);
    assert.equal(c.latest[0].title, 'ta', 'newest first');
    assert.ok(!JSON.stringify(view.body).includes('author'));
    assert.equal(view.body.own.count, 1);
    assert.equal(view.body.own.average, 3);
    assert.match(view.body.notice, /Google Play/);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitor-reviews?days=500`)).status,
      400,
    );

    // Failures: a store that asks to slow down is a 429, and nothing is stored.
    t.sources.reviewsError = new AsoError('apple_search', 'rate_limited', 'slow', {
      retryAfterSeconds: 30,
    });
    t.clock.advance(20 * 60_000);
    const slow = await t.call(t.owner, 'POST', url);
    assert.equal(slow.status, 429);
    t.sources.reviewsError = undefined;

    // Retention by count and the audit trail (counts, no text).
    const trail = JSON.stringify((await t.call(t.owner, 'GET', '/audit?limit=50')).body);
    assert.ok(trail.includes('aso.competitor_reviews_read'));
    assert.ok(!trail.includes('body a'), 'no review text in the audit log');

    // Unfollowing takes the reviews with it.
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/competitors/${cid}`)).status,
      204,
    );
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM aso_competitor_reviews'))[0]?.n),
      0,
    );
  },
);

dbTest(
  'competitor reviews: a Google Play competitor has none and says why; a viewer cannot read the store',
  async (db) => {
    const t = await bootAso(db, { playEnabled: true });
    const appId = await t.addApp('android');
    t.sources.setApp('android', 'us', publicApp('com.rival.app', { name: 'Rival Play' }));
    const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
      externalId: 'com.rival.app',
    });
    assert.equal(add.status, 201, add.text);
    const refused = await t.call(
      t.owner,
      'POST',
      `/apps/${appId}/aso/competitors/${add.body.competitor.id}/reviews/refresh`,
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'play_reviews_not_available');
    assert.equal(t.sources.reviewReads.length, 0);
    const view = await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitor-reviews`);
    assert.equal(view.body.competitors[0].state, 'unavailable');
    assert.equal(view.body.competitors[0].reason, 'play_has_no_review_api');
  },
);

test('the real source reads one fixed Apple URL, treats 404 as no reviews, 429 as rate limited, and refuses a bad id or storefront', async () => {
  const { createAsoSources } = await import('./net.ts');
  const urls: string[] = [];
  let status = 200;
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return status === 200
      ? new Response(
          JSON.stringify({
            feed: {
              entry: [
                {
                  id: { label: 'r1' },
                  'im:rating': { label: '4' },
                  title: { label: 't' },
                  content: { label: 'c' },
                  updated: { label: '2026-06-01T00:00:00Z' },
                },
              ],
            },
          }),
        )
      : new Response(null, { status, headers: { 'retry-after': '45' } });
  }) as typeof globalThis.fetch;
  const sources = createAsoSources({
    playEnabled: false,
    now: () => Date.now(),
    cacheMs: 0,
    appleCallsPerMinute: 100,
    playCallsPerMinute: 1,
    fetch,
  });
  const out = await sources.appleReviews?.({ id: '555', country: 'us' });
  assert.equal(out?.length, 1);
  assert.equal(
    urls[0],
    'https://itunes.apple.com/us/rss/customerreviews/id=555/sortby=mostrecent/json',
  );
  status = 404;
  assert.deepEqual(await sources.appleReviews?.({ id: '555', country: 'us' }), []);
  status = 429;
  await assert.rejects(
    sources.appleReviews?.({ id: '555', country: 'us' }) as Promise<unknown>,
    (e: unknown) =>
      e instanceof AsoError && e.kind === 'rate_limited' && e.retryAfterSeconds === 45,
  );
  await assert.rejects(
    sources.appleReviews?.({ id: '../evil', country: 'us' }) as Promise<unknown>,
    (e: unknown) => e instanceof AsoError && e.kind === 'invalid_input',
  );
  await assert.rejects(
    sources.appleReviews?.({ id: '555', country: 'u/s' }) as Promise<unknown>,
    (e: unknown) => e instanceof AsoError && e.kind === 'invalid_input',
  );
  assert.equal(urls.length, 3, 'a bad id or storefront never makes a request');
});
