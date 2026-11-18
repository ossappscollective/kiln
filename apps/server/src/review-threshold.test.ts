import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { storeReview } from './review-test-helpers.ts';
import { bootTranslation } from './translation-test-helpers.ts';

/**
 * Semantics of `reviews.lowRatingThreshold` (docs/api/reviews.md): a review raises
 * `review.new_low_rating` at most once, when it is first seen low or when its rating changes to a
 * low one. Raising the threshold never re-sends events for reviews already stored; lowering it
 * only narrows what is new.
 */

dbTest('the threshold is a workspace setting and changes only what is new from then on', async (db) => {
  const t = await bootTranslation(db);
  const r = (n: number, rating: number) => storeReview(n, { rating }, 'ios');
  const sync = async () => {
    const res = await t.call(t.owner, 'POST', `/apps/${t.appId}/reviews/sync`);
    assert.equal(res.status, 200, res.text);
    return res.body.sync as { lowRatingEvents: number; lowRatingThreshold: number; added: number };
  };
  const ids = async () => (await t.events('review.new_low_rating')).map((e) => String(e.payload.storeReviewId)).sort();

  // The first read is the quiet baseline: no events, whatever the ratings.
  t.store.reviews = [r(1, 5), r(2, 3), r(3, 1)];
  assert.equal((await sync()).lowRatingEvents, 0);

  // Default threshold 2: a new 3 star review is not low, a new 2 star one is.
  t.store.reviews = [...t.store.reviews, r(4, 3), r(5, 2)];
  let done = await sync();
  assert.equal(done.lowRatingThreshold, 2);
  assert.deepEqual(await ids(), ['rev-5']);

  // Raised to 3: the 3 star reviews stored earlier come back from the store but do NOT raise events.
  assert.equal((await t.put(t.owner, { 'reviews.lowRatingThreshold': 3 })).status, 200);
  done = await sync();
  assert.equal(done.lowRatingEvents, 0);
  assert.deepEqual(await ids(), ['rev-5']);
  // A review first seen from now on is judged by the new threshold.
  t.store.reviews = [...t.store.reviews, r(6, 3)];
  done = await sync();
  assert.equal(done.lowRatingThreshold, 3);
  assert.deepEqual(await ids(), ['rev-5', 'rev-6']);
  // So is a review whose rating changes: rev-4 (3 stars, stored before) is edited to 3 stars -> still no event, edited to 2 stars -> event.
  t.store.reviews = t.store.reviews.map((x) => (x.storeReviewId === 'rev-4' ? { ...x, rating: 2, updatedAt: x.updatedAt + 1 } : x));
  await sync();
  assert.deepEqual(await ids(), ['rev-4', 'rev-5', 'rev-6']);
  const edited = (await t.events('review.new_low_rating')).find((e) => e.payload.storeReviewId === 'rev-4');
  assert.equal(edited?.payload.source, 'edited');
  assert.equal(edited?.payload.threshold, 3);

  // Lowered to 1: it only narrows. A new 2 star review is silent, a new 1 star review is not.
  assert.equal((await t.put(t.owner, { 'reviews.lowRatingThreshold': 1 })).status, 200);
  t.store.reviews = [...t.store.reviews, r(7, 2), r(8, 1)];
  await sync();
  assert.deepEqual(await ids(), ['rev-4', 'rev-5', 'rev-6', 'rev-8']);
  // And nothing is ever sent twice for one review, however often it comes back.
  await sync();
  await sync();
  assert.deepEqual(await ids(), ['rev-4', 'rev-5', 'rev-6', 'rev-8']);

  // A reset goes back to the default (2).
  await t.put(t.owner, { 'reviews.lowRatingThreshold': null });
  assert.equal((await sync()).lowRatingThreshold, 2);
});

dbTest('the summary and the sync use the workspace threshold, per workspace', async (db) => {
  const t = await bootTranslation(db);
  const summary = async () => (await t.call(t.owner, 'GET', `/apps/${t.appId}/reviews/summary`)).body.lowRatingThreshold;
  assert.equal(await summary(), 2);
  await t.put(t.owner, { 'reviews.lowRatingThreshold': 4 });
  assert.equal(await summary(), 4);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.call(outsider, 'GET', '/settings', undefined, 'other')).body.values['reviews.lowRatingThreshold'], 2);
});
