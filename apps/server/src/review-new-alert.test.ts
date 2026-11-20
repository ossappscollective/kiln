import assert from 'node:assert/strict';
import test from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { storeReview } from './review-test-helpers.ts';
import { alertCatalog, alertsFromEvent } from './services/alert-catalog.ts';
import { MAX_NEW_REVIEW_EVENTS_PER_SYNC } from './services/review-sync.ts';
import { bootTranslation } from './translation-test-helpers.ts';

/**
 * `review.new` and the alert of the same name (docs/alerts.md, docs/adr/0027-review-feed-and-new-review-alert.md):
 * one event per review that is new in a read, ids, store, platform and rating only; the first read of an app and a
 * big read are ONE grouped event ("N new reviews"). No title, text or name ever reaches an event or an alert.
 */

const TITLE = 'SECRET-TITLE-xyz';
const BODY = 'SECRET-BODY-xyz';
const make = (n: number, rating = 5) =>
  storeReview(
    n,
    { rating, title: `${TITLE}-${n}`, body: `${BODY}-${n}`, authorName: 'Jo Doe' },
    'ios',
  );

const boot = async (db: Parameters<typeof bootTranslation>[0]) => {
  const t = await bootTranslation(db);
  const sync = async () => {
    const res = await t.call(t.owner, 'POST', `/apps/${t.appId}/reviews/sync`);
    assert.equal(res.status, 200, res.text);
    return res.body.sync as { added: number; baseline: boolean };
  };
  const alerts = async () =>
    (await db.query(
      `SELECT type, title, body, count FROM alerts
        WHERE is_test = 0 AND type = 'review.new' ORDER BY first_at, id`,
    )) as { type: string; title: string; body: string; count: number }[];
  return { ...t, sync, alerts };
};

dbTest('the first read of an app is one grouped event and one grouped alert', async (db) => {
  const t = await boot(db);
  t.store.reviews = [make(1), make(2, 1), make(3)];
  const done = await t.sync();
  assert.equal(done.baseline, true);
  const events = await t.events('review.new');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.grouped, true);
  assert.equal(events[0]?.payload.count, 3);
  assert.equal(events[0]?.payload.baseline, true);
  assert.equal(events[0]?.payload.platform, 'ios');
  assert.equal(events[0]?.payload.store, 'appstoreconnect');
  assert.equal(events[0]?.payload.reviewId, undefined);
  const alerts = await t.alerts();
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0]?.title), /^3 new reviews for /);
  assert.match(String(alerts[0]?.body), /first read of this app/);
  // The quiet baseline of the low-rating event is unchanged.
  assert.equal((await t.events('review.new_low_rating')).length, 0);
});

dbTest(
  'later reads raise one event and one alert per new review, once, with ids and the rating only',
  async (db) => {
    const t = await boot(db);
    t.store.reviews = [make(1)];
    await t.sync();
    t.store.reviews = [...t.store.reviews, make(2, 4), make(3, 1)];
    assert.equal((await t.sync()).added, 2);
    let events = await t.events('review.new');
    assert.equal(events.length, 3, 'the grouped first read, then one per new review');
    const single = events.filter((e) => e.payload.grouped !== true);
    assert.equal(single.length, 2);
    assert.deepEqual(single.map((e) => e.payload.rating).sort(), [1, 4]);
    for (const e of single) {
      assert.equal(typeof e.payload.reviewId, 'string');
      assert.deepEqual(
        Object.keys(e.payload).sort(),
        ['appId', 'platform', 'rating', 'reviewId', 'store', 'storeReviewId'],
      );
    }
    // A low rating still raises its own event and alert as before.
    assert.equal((await t.events('review.new_low_rating')).length, 1);
    const alerts = await t.alerts();
    assert.equal(alerts.length, 3, 'the grouped first read and two single alerts');
    assert.ok(alerts.some((a) => /^New 4-star review for /.test(String(a.title))));
    // Reading the same reviews again changes nothing.
    await t.sync();
    events = await t.events('review.new');
    assert.equal(events.length, 3);
    assert.equal((await t.alerts()).length, 3);
    // No title, text or name anywhere: events, alerts, the alert inbox.
    const everything = JSON.stringify([
      events,
      alerts,
      (await t.call(t.owner, 'GET', '/alerts/inbox')).body,
      await db.query('SELECT * FROM alert_deliveries'),
    ]);
    assert.doesNotMatch(everything, /SECRET-(TITLE|BODY)|Jo Doe/);
  },
);

dbTest('more than the limit in one read is grouped, whatever the app history', async (db) => {
  const t = await boot(db);
  t.store.reviews = [make(1)];
  await t.sync();
  const many = Array.from({ length: MAX_NEW_REVIEW_EVENTS_PER_SYNC + 1 }, (_, i) => make(i + 10));
  t.store.reviews = [...t.store.reviews, ...many];
  const done = await t.sync();
  assert.equal(done.baseline, false);
  assert.equal(done.added, MAX_NEW_REVIEW_EVENTS_PER_SYNC + 1);
  const grouped = (await t.events('review.new')).filter((e) => e.payload.grouped === true);
  assert.equal(grouped.length, 2, 'the first read and this one');
  const big = MAX_NEW_REVIEW_EVENTS_PER_SYNC + 1;
  assert.ok(grouped.some((e) => e.payload.count === big && e.payload.baseline === false));
  assert.equal((await t.alerts()).length, 2, 'two reads, two grouped alerts, not 12');
  // Exactly the limit is still one each.
  const exact = Array.from({ length: MAX_NEW_REVIEW_EVENTS_PER_SYNC }, (_, i) => make(i + 100));
  t.store.reviews = [...t.store.reviews, ...exact];
  await t.sync();
  assert.equal((await t.alerts()).length, 2 + MAX_NEW_REVIEW_EVENTS_PER_SYNC);
});

dbTest(
  'the alert type is in the catalog, inbox only by default, and a rule can switch it off',
  async (db) => {
    const t = await boot(db);
    const catalog = (await t.call(t.owner, 'GET', '/alerts/catalog')).body.catalog as {
      id: string;
      scope: string;
      severity: string;
      visible: boolean;
      rule: { enabled: boolean; channels: string[] };
    }[];
    const entry = catalog.find((x) => x.id === 'review.new');
    assert.ok(entry);
    assert.deepEqual(entry.rule.channels, ['in_app']);
    assert.equal(entry.rule.enabled, true);
    assert.equal(entry.scope, 'app');
    assert.equal(entry.severity, 'info');
    assert.equal(entry.visible, true);
    assert.equal(
      (await t.call(t.owner, 'PUT', '/alerts/rules/review.new', { enabled: false })).status,
      200,
    );
    t.store.reviews = [make(1)];
    await t.sync();
    t.store.reviews = [...t.store.reviews, make(2)];
    await t.sync();
    assert.equal((await t.events('review.new')).length, 2, 'still written, for webhooks');
    assert.equal((await t.alerts()).length, 0);
  },
);

test('the text of a single and of a grouped alert holds ids and numbers only', () => {
  const def = alertCatalog.find((d) => d.id === 'review.new');
  assert.ok(def);
  const one = alertsFromEvent({
    type: 'review.new',
    workspaceId: 'w',
    subject: { appId: 'a1' },
    payload: {
      reviewId: 'r1',
      rating: 3,
      store: 'googleplay',
      platform: 'android',
      text: 'leak',
      title: 'leak',
    },
    createdAt: 5,
  })[0];
  assert.ok(one);
  assert.equal(one.def.dedupeKey(one.data), 'review.new:r1');
  assert.doesNotMatch(
    `${one.def.title(one.data)} ${one.def.body(one.data)} ${JSON.stringify(one.data)}`,
    /leak/,
  );
  const group = (createdAt: number) =>
    alertsFromEvent({
      type: 'review.new',
      workspaceId: 'w',
      subject: { appId: 'a1' },
      payload: { grouped: true, count: 12, store: 'googleplay', platform: 'android' },
      createdAt,
    })[0];
  const a = group(10);
  const b = group(20);
  assert.ok(a && b);
  assert.equal(a.def.title(a.data), '12 new reviews for a1');
  assert.notEqual(a.def.dedupeKey(a.data), b.def.dedupeKey(b.data), 'two reads are two alerts');
});
