import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  type ListReviewsOptions,
  type ListReviewsResult,
  StoreError,
  StoreRateLimitError,
  type StoreReview,
  type StoreReviewConnector,
} from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import type { Database } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createScheduler } from './scheduler.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { queueReviewSyncs, reviewUpkeep } from './services/review-schedule.ts';
import {
  createReviewSyncHandler,
  REVIEW_SYNC_QUEUE,
  type ReviewConnectorFactory,
  type ReviewConnectorInput,
  type ReviewsContext,
  syncReviews,
} from './services/review-sync.ts';
import {
  deleteReviewData,
  escapeLike,
  pruneReviews,
  purgeOrphanReviewRows,
} from './services/reviews.ts';

// Everything here runs against fakes: no store, and not the iTunes lookup, is ever contacted.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });
const PLAY_SECRET = JSON.stringify({
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: PEM,
});
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** A reviews connector that answers from a table, remembers what it was asked, and can fail. */
class FakeReviews implements StoreReviewConnector {
  readonly store: 'appstoreconnect' | 'googleplay';
  readonly platform: Platform;
  reviews: StoreReview[] = [];
  error: unknown;
  complete = true;
  nextCursor: string | undefined;
  warnings: string[] = [];
  calls: ListReviewsOptions[] = [];
  constructor(platform: Platform) {
    this.platform = platform;
    this.store = platform === 'ios' ? 'appstoreconnect' : 'googleplay';
  }
  async listReviews(options: ListReviewsOptions = {}): Promise<ListReviewsResult> {
    this.calls.push(options);
    if (this.error) throw this.error;
    return {
      reviews: this.reviews,
      ...(this.nextCursor ? { nextCursor: this.nextCursor } : {}),
      complete: this.complete,
      warnings: this.warnings,
      skipped: 0,
    };
  }
}

const review = (
  n: number,
  over: Partial<StoreReview> = {},
  platform: Platform = 'ios',
): StoreReview => ({
  store: platform === 'ios' ? 'appstoreconnect' : 'googleplay',
  platform,
  storeReviewId: `rev-${n}`,
  rating: 5,
  title: `Title ${n}`,
  body: `Body of review ${n}`,
  authorName: `Reviewer ${n}`,
  territory: 'USA',
  createdAt: 1_700_000_000_000 + n * 1000,
  updatedAt: 1_700_000_000_000 + n * 1000,
  ...over,
});

type ReviewDeps = NonNullable<Parameters<typeof import('./app.ts').createApp>[0]['reviews']>;

async function boot(db: Database, reviews: ReviewDeps = {}) {
  const stores = { ios: new FakeReviews('ios'), android: new FakeReviews('android') };
  const built: ReviewConnectorInput[] = [];
  const factory: ReviewConnectorFactory = (input) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const masterKey = randomBytes(32);
  let clock = Date.now();
  const t = await bootRepoApp(db, undefined, {
    masterKey,
    now: () => ++clock,
    reviews: { connectorFactory: factory, ratingFetcher: null, ...reviews },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addIos = async () => {
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: 'com.acme.app',
      credentialId: iosCredential,
      name: 'Acme',
    });
    const id = res.body.app.id as string;
    await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
    return id;
  };
  const addAndroid = async () => {
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform: 'android',
      identifier: 'com.acme.app',
      credentialId: playCredential,
    });
    return res.body.app.id as string;
  };
  const ctx = (overrides: Partial<ReviewsContext> = {}): ReviewsContext => ({
    db,
    masterKey,
    now: () => ++clock,
    connectorFactory: factory,
    ratingFetcher: null,
    timeoutMs: 5_000,
    ...overrides,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  const events = async (type?: string) =>
    (await t.call(t.owner, 'GET', `/events?since=0&limit=200${type ? `&type=${type}` : ''}`)).body
      .events as {
      type: string;
      payload: Record<string, unknown>;
      subject: Record<string, unknown>;
    }[];
  const noLeaks = () => {
    for (const text of t.texts) {
      assert.ok(!text.includes(KEY_LINE), 'a credential leaked');
      assert.ok(!text.includes('bot@proj.iam.gserviceaccount.com'), 'a credential leaked');
    }
  };
  return {
    ...t,
    stores,
    built,
    iosCredential,
    playCredential,
    addIos,
    addAndroid,
    ctx,
    advance,
    events,
    noLeaks,
  };
}

const path = (id: string, rest = '') => `/apps/${id}/reviews${rest}`;

// ---------------------------------------------------------------------------------------------
// Rights and isolation

dbTest(
  'rights: everyone reads, members sync and triage, viewers do neither, non-members get 404',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.reviews = [review(1)];
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');

    assert.equal((await t.call(t.owner, 'POST', path(id, '/sync'))).status, 200);
    const first = (await t.call(viewer, 'GET', path(id))).body.reviews[0].id as string;

    for (const cookie of [viewer, member, admin]) {
      assert.equal((await t.call(cookie, 'GET', path(id))).status, 200);
      assert.equal((await t.call(cookie, 'GET', path(id, '/summary'))).status, 200);
    }
    assert.equal((await t.call(viewer, 'POST', path(id, '/sync'))).status, 403);
    assert.equal(
      (await t.call(viewer, 'PATCH', path(id, `/${first}`), { status: 'triaged' })).status,
      403,
    );
    assert.equal((await t.call(member, 'POST', path(id, '/sync'))).status, 200);
    assert.equal(
      (await t.call(member, 'PATCH', path(id, `/${first}`), { status: 'triaged' })).status,
      200,
    );
    assert.equal(
      (await t.call(admin, 'PATCH', path(id, `/${first}`), { status: 'ignored' })).status,
      200,
    );

    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    const calls: [string, string, unknown?][] = [
      ['GET', path(id)],
      ['GET', path(id, '/summary')],
      ['POST', path(id, '/sync')],
      ['PATCH', path(id, `/${first}`), { status: 'triaged' }],
    ];
    for (const [method, p, body] of calls) {
      const res = await t.call(outsider, method, p, body);
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.deepEqual(res.body, { error: 'not_found' });
      // Nor does the id of one workspace's app exist in another, even for its owner.
      assert.equal(
        (await t.call(outsider, method, p, body, 'other')).status,
        404,
        `${method} ${p} in other`,
      );
    }
    assert.equal((await t.call(t.owner, 'GET', path('no-such-app'))).status, 404);
    assert.equal(
      (await t.call(t.owner, 'GET', path(id), undefined, 'no-such-workspace')).status,
      404,
    );
    t.noLeaks();
  },
);

dbTest(
  'replying is off by default: the reply routes answer 409 reply_disabled and no store is called',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.reviews = [review(1)];
    await t.call(t.owner, 'POST', path(id, '/sync'));
    const rid = (await t.call(t.owner, 'GET', path(id))).body.reviews[0].id as string;
    const calls = t.built.length;
    for (const [method, p, body] of [
      ['PUT', path(id, `/${rid}/reply-draft`), { text: 'Thanks' }],
      ['POST', path(id, `/${rid}/reply`), { confirmHash: 'a'.repeat(64) }],
      ['DELETE', path(id, `/${rid}/reply-draft`)],
    ] as const) {
      const res = await t.call(t.owner, method, p, body);
      assert.equal(res.status, 409, `${method} ${p}`);
      assert.equal(res.body.error, 'reply_disabled');
      assert.match(res.body.message, /MRM_REVIEW_REPLY_ENABLED/);
    }
    // Routes that do not exist stay 404 or 405.
    for (const [method, p] of [
      ['PUT', path(id, `/${rid}/response`)],
      ['POST', path(id, `/${rid}/respond`)],
      ['DELETE', path(id, `/${rid}`)],
    ] as const) {
      const res = await t.call(t.owner, method, p, { body: 'hello' });
      assert.ok(res.status === 404 || res.status === 405, `${method} ${p} gave ${res.status}`);
    }
    assert.equal(t.built.length, calls, 'no connector was built');
    // The sync connector has no write method: the writing one is a separate interface.
    assert.deepEqual(Object.getOwnPropertyNames(FakeReviews.prototype).sort(), [
      'constructor',
      'listReviews',
    ]);
  },
);

// ---------------------------------------------------------------------------------------------
// Sync: idempotent, incremental, edits, responses

dbTest(
  'sync stores reviews, is idempotent, and applies edits and developer responses',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.reviews = [
      review(1),
      review(2, { rating: 1 }),
      review(3, { rating: 3, body: '' }),
    ];

    const first = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(first.status, 200);
    assert.equal(first.body.sync.fetched, 3);
    assert.equal(first.body.sync.added, 3);
    assert.equal(first.body.sync.baseline, true);
    assert.equal(first.body.state.store, 'appstoreconnect');
    assert.ok(first.body.state.lastSuccessAt > 0);
    assert.equal(t.built[0]?.storeAppId, '1234567890');
    assert.equal(t.built[0]?.identifier, 'com.acme.app');

    const again = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(again.body.sync.added, 0);
    assert.equal(again.body.sync.updated, 0);
    assert.equal(again.body.sync.baseline, false);
    const [counted] = await db.query('SELECT COUNT(*) AS n FROM app_reviews WHERE app_id = ?', [
      id,
    ]);
    assert.equal(Number(counted?.n), 3);

    // The second read asks for what is newer than the last success, with an overlap.
    const asked = t.stores.ios.calls.at(-1);
    assert.ok(asked?.since !== undefined && asked.since < Number(again.body.state.lastSuccessAt));

    // An edit and a new developer response are applied; a triage choice survives the sync.
    const rid = (await t.call(t.owner, 'GET', path(id, '?sort=rating'))).body.reviews[0]
      .id as string;
    await t.call(t.owner, 'PATCH', path(id, `/${rid}`), {
      status: 'triaged',
      internalNote: 'keep me',
    });
    t.stores.ios.reviews = [
      review(1),
      review(2, {
        rating: 2,
        body: 'Edited text',
        updatedAt: 1_700_000_900_000,
        developerResponse: { body: 'Thanks', at: 1_700_000_950_000, state: 'PUBLISHED' },
      }),
      review(3, { rating: 3, body: '' }),
    ];
    const edit = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(edit.body.sync.updated, 1);
    assert.equal(edit.body.sync.responses, 1);
    const row = (await t.call(t.owner, 'GET', path(id, '?rating=2'))).body.reviews[0];
    assert.equal(row.body, 'Edited text');
    assert.equal(row.rating, 2);
    assert.deepEqual(row.developerResponse, {
      body: 'Thanks',
      at: 1_700_000_950_000,
      state: 'PUBLISHED',
    });
    assert.equal(row.status, 'triaged');
    assert.equal(row.internalNote, 'keep me');
    assert.equal(
      row.createdAt,
      1_700_000_002_000,
      'the creation time is the store’s, an edit does not move it',
    );

    // A response that goes away is removed too.
    t.stores.ios.reviews = [
      review(2, { rating: 2, body: 'Edited text', updatedAt: 1_700_000_900_000 }),
    ];
    assert.equal((await t.call(t.owner, 'POST', path(id, '/sync'))).body.sync.responses, 1);
    assert.equal(
      (await t.call(t.owner, 'GET', path(id, '?rating=2'))).body.reviews[0].developerResponse,
      null,
    );
    t.noLeaks();
  },
);

dbTest('an unfinished App Store read continues from its cursor and says so', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.reviews = [review(1)];
  t.stores.ios.complete = false;
  t.stores.ios.nextCursor = 'CURSOR-1';
  const first = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(first.body.sync.complete, false);
  assert.equal(first.body.state.moreToRead, true);
  t.stores.ios.complete = true;
  t.stores.ios.nextCursor = undefined;
  await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(t.stores.ios.calls.at(-1)?.cursor, 'CURSOR-1');
  const done = await t.call(t.owner, 'GET', path(id, '/summary'));
  assert.equal(done.body.sync.moreToRead, false);
});

dbTest(
  'Google Play: a previous read older than seven days is reported as a gap, never hidden',
  async (db) => {
    const t = await boot(db);
    const id = await t.addAndroid();
    t.stores.android.reviews = [review(1, {}, 'android')];
    const ctx = t.ctx();
    const first = await syncReviews(
      ctx,
      { workspaceId: t.workspaceId, id },
      { type: 'user', id: 'u' },
    );
    assert.ok(first.ok);
    assert.equal(first.ok && first.sync.gap, null);
    // Play ignores `since`: the whole window is read every time.
    assert.equal(t.stores.android.calls[0]?.since, undefined);

    t.advance(8 * DAY);
    t.stores.android.reviews = [review(2, {}, 'android')];
    const late = await syncReviews(
      ctx,
      { workspaceId: t.workspaceId, id },
      { type: 'user', id: 'u' },
    );
    assert.ok(late.ok);
    assert.ok(late.ok && late.sync.gap !== null);
    assert.ok(late.ok && late.sync.warnings[0]?.startsWith('Gap:'));
    assert.ok(late.ok && late.state.lastGapAt !== null);

    // A read soon after has no gap, and the earlier one stays on record.
    t.advance(HOUR);
    const soon = await syncReviews(
      ctx,
      { workspaceId: t.workspaceId, id },
      { type: 'user', id: 'u' },
    );
    assert.ok(soon.ok && soon.sync.gap === null && soon.state.lastGapAt !== null);
  },
);

// ---------------------------------------------------------------------------------------------
// Failures, events

dbTest(
  'a failed read is kept, backs off, and raises review.sync_failed once per streak',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.error = new StoreError(
      'appstoreconnect',
      'forbidden',
      'The key may not read reviews.',
      403,
    );

    const one = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(one.status, 422);
    assert.equal(one.body.error, 'store_forbidden');
    const two = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(two.status, 422);
    const state = (await t.call(t.owner, 'GET', path(id, '/summary'))).body.sync;
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(state.lastError, 'The key may not read reviews.');
    assert.ok(state.backoffUntil > state.lastAttemptAt);
    assert.equal((await t.events('review.sync_failed')).length, 1, 'once per streak');

    // A success ends the streak; the next failure is a new one.
    t.stores.ios.error = undefined;
    t.stores.ios.reviews = [review(1)];
    assert.equal((await t.call(t.owner, 'POST', path(id, '/sync'))).status, 200);
    const ok = (await t.call(t.owner, 'GET', path(id, '/summary'))).body.sync;
    assert.equal(ok.consecutiveFailures, 0);
    assert.equal(ok.lastError, null);
    assert.equal(ok.backoffUntil, null);
    t.stores.ios.error = new StoreError('appstoreconnect', 'server', 'Apple had a problem.', 503);
    assert.equal((await t.call(t.owner, 'POST', path(id, '/sync'))).status, 502);
    const failed = await t.events('review.sync_failed');
    assert.equal(failed.length, 2);
    assert.deepEqual(Object.keys(failed[0]?.payload ?? {}).sort(), [
      'appId',
      'code',
      'failures',
      'store',
      'transient',
    ]);
    t.noLeaks();
  },
);

dbTest('store rate limits, timeouts and surprises are mapped and never thrown', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.error = new StoreRateLimitError('appstoreconnect', 120);
  const limited = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '120');
  t.stores.ios.error = new Error(`boom ${KEY_LINE}`);
  const odd = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(odd.status, 502);
  assert.equal(odd.body.error, 'sync_failed');
  assert.ok(!odd.text.includes('boom'), 'the text of an unknown error is not echoed');
  // A connector that never answers hits the timeout and the failure is returned, not thrown.
  t.stores.ios.error = undefined;
  t.stores.ios.listReviews = () => new Promise<ListReviewsResult>(() => {});
  const late = await syncReviews(
    t.ctx({ timeoutMs: 30 }),
    { workspaceId: t.workspaceId, id },
    { type: 'user', id: 'u' },
  );
  assert.ok(!late.ok);
  assert.equal(!late.ok && late.status, 504);
  assert.equal(!late.ok && late.body.error, 'timeout');
});

dbTest('a read of an app that is not ready says what to do', async (db) => {
  const t = await boot(db);
  const res = await t.call(t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.acme.new',
    credentialId: t.iosCredential,
  });
  const id = res.body.app.id as string;
  const out = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(out.status, 422);
  assert.equal(out.body.error, 'app_not_synced');
  assert.equal(t.stores.ios.calls.length, 0);
});

dbTest(
  'low rating events: ids and rating only, once per review, quiet on the first read',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.reviews = [
      review(1, { rating: 1, body: 'SECRET-BODY-1', authorName: 'SECRET-NAME-1' }),
      review(2),
    ];
    await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(
      (await t.events('review.new_low_rating')).length,
      0,
      'the first read is a baseline',
    );

    t.stores.ios.reviews = [
      review(3, { rating: 2, body: 'SECRET-BODY-3', authorName: 'SECRET-NAME-3' }),
      review(4, { rating: 3 }),
      review(1, { rating: 1, body: 'SECRET-BODY-1', authorName: 'SECRET-NAME-1' }),
      review(2),
    ];
    const second = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(second.body.sync.lowRatingEvents, 1);
    const low = await t.events('review.new_low_rating');
    assert.equal(low.length, 1);
    assert.deepEqual(Object.keys(low[0]?.payload ?? {}).sort(), [
      'appId',
      'rating',
      'reviewId',
      'source',
      'store',
      'storeReviewId',
      'threshold',
    ]);
    assert.equal(low[0]?.payload.rating, 2);
    assert.equal(low[0]?.payload.source, 'new');
    assert.equal(low[0]?.payload.threshold, 2);
    assert.deepEqual(low[0]?.subject, { appId: id });

    // The same data again: no second event. An edit down to the threshold is one.
    await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal((await t.events('review.new_low_rating')).length, 1);
    t.stores.ios.reviews = [
      review(3, { rating: 2, body: 'SECRET-BODY-3', authorName: 'SECRET-NAME-3' }),
      review(4, { rating: 2, updatedAt: 1_800_000_000_000 }),
      review(1, { rating: 1, body: 'SECRET-BODY-1', authorName: 'SECRET-NAME-1' }),
    ];
    await t.call(t.owner, 'POST', path(id, '/sync'));
    const all = await t.events('review.new_low_rating');
    assert.equal(all.length, 2);
    assert.equal(all[1]?.payload.source, 'edited');

    // No text and no names in events, the audit log or any webhook-bound payload.
    const audit = await db.query('SELECT detail FROM audit_events');
    const stored = await db.query('SELECT payload FROM events');
    for (const row of [...audit, ...stored]) {
      const text = String(row.detail ?? row.payload);
      assert.ok(!text.includes('SECRET-BODY') && !text.includes('SECRET-NAME'), text);
    }
  },
);

// ---------------------------------------------------------------------------------------------
// List, filters, summary

dbTest('list: filters, escaped search, sorting, paging and validation', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  const rows: StoreReview[] = [];
  for (let n = 1; n <= 12; n++) {
    rows.push(
      review(n, {
        rating: ((n - 1) % 5) + 1,
        body: n === 3 ? 'Costs 100% too much_really' : n === 4 ? 'plain 100 text' : `Body ${n}`,
        territory: n % 2 ? 'USA' : 'DEU',
        language: n % 2 ? 'en' : 'de',
        ...(n > 10 ? { developerResponse: { body: 'We hear you' } } : {}),
      }),
    );
  }
  t.stores.ios.reviews = rows;
  await t.call(t.owner, 'POST', path(id, '/sync'));

  const get = async (query: string) => {
    const res = await t.call(t.owner, 'GET', path(id, query ? `?${query}` : ''));
    assert.equal(res.status, 200, query);
    return res.body as {
      reviews: { rating: number; body: string; storeReviewId: string }[];
      nextCursor: string | null;
    };
  };
  assert.equal((await get('')).reviews.length, 12);
  assert.deepEqual(
    (await get('')).reviews.map((r) => r.storeReviewId).slice(0, 3),
    ['rev-12', 'rev-11', 'rev-10'],
    'newest first',
  );
  assert.deepEqual(
    [...new Set((await get('rating=1,2')).reviews.map((r) => r.rating))].sort(),
    [1, 2],
  );
  assert.equal((await get('rating=5&rating=4')).reviews.length, 4);
  assert.equal((await get('territory=DEU')).reviews.length, 6);
  assert.equal((await get('language=de')).reviews.length, 6);
  assert.equal((await get('hasResponse=true')).reviews.length, 2);
  assert.equal((await get('hasResponse=false')).reviews.length, 10);
  assert.equal((await get('status=new')).reviews.length, 12);
  assert.equal((await get('status=triaged')).reviews.length, 0);
  assert.equal((await get('store=googleplay')).reviews.length, 0);
  assert.equal((await get('platform=ios')).reviews.length, 12);
  assert.equal((await get(`since=${1_700_000_010_000}`)).reviews.length, 3);
  assert.equal((await get(`until=${1_700_000_003_000}`)).reviews.length, 2);
  // `%` and `_` in a search are literal text.
  assert.deepEqual(
    (await get(`q=${encodeURIComponent('100%')}`)).reviews.map((r) => r.storeReviewId),
    ['rev-3'],
  );
  assert.deepEqual(
    (await get(`q=${encodeURIComponent('too much_real')}`)).reviews.map((r) => r.storeReviewId),
    ['rev-3'],
  );
  assert.equal((await get(`q=${encodeURIComponent('%')}`)).reviews.length, 1);
  assert.equal((await get(`q=${encodeURIComponent('_')}`)).reviews.length, 1);
  assert.equal(escapeLike('a%b_c!d'), 'a!%b!_c!!d');

  // Lowest rating first, then newest.
  const byRating = (await get('sort=rating&limit=4')).reviews;
  assert.deepEqual(
    byRating.map((r) => r.rating),
    [1, 1, 1, 2],
  );

  // Paging with a cursor visits every review exactly once, for each sort.
  for (const sort of ['newest', 'rating', 'updated']) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await get(
        `sort=${sort}&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.reviews.map((r) => r.storeReviewId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 12, sort);
    assert.equal(new Set(seen).size, 12, sort);
  }
  // A cursor belongs to its sort.
  const page = await get('limit=2');
  assert.equal(
    (
      await t.call(
        t.owner,
        'GET',
        path(id, `?sort=rating&cursor=${encodeURIComponent(page.nextCursor ?? '')}`),
      )
    ).status,
    400,
  );

  // The page size is capped, and bad input is a 400 with the parameter named.
  assert.equal((await t.call(t.owner, 'GET', path(id, '?limit=101'))).status, 400);
  for (const bad of [
    'rating=0',
    'rating=6',
    'rating=a',
    'sort=oldest',
    'status=done',
    'hasResponse=maybe',
    'since=-1',
    'until=x',
    'limit=0',
    'cursor=!!!',
    'store=amazon',
    'territory=%3Cb%3E',
  ]) {
    const res = await t.call(t.owner, 'GET', path(id, `?${bad}`));
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error, 'invalid_request', bad);
  }
  t.noLeaks();
});

dbTest(
  'summary: always says what its numbers are from, and shows the store-wide rating separately',
  async (db) => {
    const t = await boot(db, {
      ratingFetcher: async () => ({
        appStoreId: '1234567890',
        country: 'US',
        averageRating: 4.5,
        ratingCount: 1200,
        currentVersionAverage: 4.1,
        currentVersionCount: 80,
      }),
    });
    const id = await t.addIos();
    const empty = await t.call(t.owner, 'GET', path(id, '/summary'));
    assert.equal(empty.status, 200);
    assert.equal(empty.body.stored.basis, 'stored_reviews');
    assert.equal(empty.body.stored.count, 0);
    assert.equal(empty.body.stored.average, null);
    assert.deepEqual(empty.body.stored.histogram, [0, 0, 0, 0, 0]);
    assert.match(empty.body.stored.label, /stored review/);
    assert.deepEqual(empty.body.storeWide, []);
    assert.equal(empty.body.lowRatingThreshold, 2);

    const now = Date.now();
    t.stores.ios.reviews = [
      review(1, { rating: 5, appVersion: '2.0', createdAt: now - 1000 }),
      review(2, { rating: 4, appVersion: '2.0', createdAt: now - 2000 }),
      review(3, { rating: 1, appVersion: '1.9', createdAt: now - 8 * DAY }),
    ];
    const synced = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(synced.body.sync.ratingSummary, 'stored');
    const summary = (await t.call(t.owner, 'GET', path(id, '/summary?weeks=4'))).body;
    assert.equal(summary.stored.count, 3);
    assert.equal(summary.stored.average, 3.33);
    assert.deepEqual(summary.stored.histogram, [1, 0, 0, 1, 1]);
    assert.match(summary.stored.label, /^From 3 stored reviews/);
    assert.equal(summary.stored.weeks.length, 4);
    assert.equal(
      summary.stored.weeks.reduce((s: number, w: { count: number }) => s + w.count, 0),
      3,
    );
    assert.deepEqual(summary.stored.byVersion.map((v: { version: string }) => v.version).sort(), [
      '1.9',
      '2.0',
    ]);
    assert.equal(summary.storeWide.length, 1);
    assert.equal(summary.storeWide[0].basis, 'store_wide');
    assert.equal(summary.storeWide[0].average, 4.5);
    assert.equal(summary.storeWide[0].ratingCount, 1200);
    assert.equal(summary.storeWide[0].territory, 'US');
    assert.match(summary.storeWide[0].label, /Store-wide/);
    assert.deepEqual(summary.byStatus, { new: 3, triaged: 0, replied_in_console: 0, ignored: 0 });
    assert.equal((await t.call(t.owner, 'GET', path(id, '/summary?weeks=0'))).status, 400);
    assert.equal((await t.call(t.owner, 'GET', path(id, '/summary?weeks=53'))).status, 400);

    // The same figures again are not stored twice.
    const again = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(again.body.sync.ratingSummary, 'unchanged');
    const [summaries] = await db.query(
      'SELECT COUNT(*) AS n FROM app_rating_summaries WHERE app_id = ?',
      [id],
    );
    assert.equal(Number(summaries?.n), 1);
  },
);

dbTest('a store-wide rating that cannot be read never fails the sync', async (db) => {
  const t = await boot(db, {
    ratingFetcher: async () => {
      throw new Error('lookup down');
    },
  });
  const id = await t.addIos();
  t.stores.ios.reviews = [review(1)];
  const res = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(res.status, 200);
  assert.equal(res.body.sync.ratingSummary, 'unavailable');
  assert.equal((await t.call(t.owner, 'GET', path(id))).body.reviews.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Triage

dbTest(
  'triage: status, assignee and note are internal, validated and audited without text',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    t.stores.ios.reviews = [review(1, { body: 'REVIEW-TEXT-XYZ' })];
    await t.call(t.owner, 'POST', path(id, '/sync'));
    const rid = (await t.call(t.owner, 'GET', path(id))).body.reviews[0].id as string;
    const member = await t.addMember('member');
    const memberId = 'user-member-' + t.workspaceId;

    const done = await t.call(member, 'PATCH', path(id, `/${rid}`), {
      status: 'replied_in_console',
      assigneeUserId: memberId,
      internalNote: 'NOTE-TEXT-ABC',
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.review.status, 'replied_in_console');
    assert.equal(done.body.review.assigneeUserId, memberId);
    assert.equal(done.body.review.internalNote, 'NOTE-TEXT-ABC');
    assert.equal(done.body.review.statusChangedBy, memberId);
    assert.ok(done.body.review.statusChangedAt > 0);
    assert.equal(t.stores.ios.calls.length, 1, 'triage never touches the store');

    // Clearing, and a no-op that changes nothing and is not audited.
    const cleared = await t.call(t.owner, 'PATCH', path(id, `/${rid}`), {
      assigneeUserId: null,
      internalNote: '   ',
    });
    assert.equal(cleared.body.review.assigneeUserId, null);
    assert.equal(cleared.body.review.internalNote, null);
    const before = (
      await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'review.triage'")
    )[0]?.n;
    assert.equal(
      (await t.call(t.owner, 'PATCH', path(id, `/${rid}`), { status: 'replied_in_console' }))
        .status,
      200,
    );
    assert.equal(
      (await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'review.triage'"))[0]
        ?.n,
      before,
    );

    const filtered = await t.call(t.owner, 'GET', path(id, '?status=replied_in_console'));
    assert.equal(filtered.body.reviews.length, 1);
    assert.equal(
      (await t.call(t.owner, 'GET', path(id, '/summary'))).body.byStatus.replied_in_console,
      1,
    );

    // Validation.
    const bad: unknown[] = [
      {},
      { status: 'done' },
      { status: 'new', extra: 1 },
      { internalNote: 'x'.repeat(2001) },
      { assigneeUserId: '' },
    ];
    for (const body of bad)
      assert.equal(
        (await t.call(t.owner, 'PATCH', path(id, `/${rid}`), body)).status,
        400,
        JSON.stringify(body),
      );
    const stranger = await t.call(t.owner, 'PATCH', path(id, `/${rid}`), {
      assigneeUserId: 'not-a-member',
    });
    assert.equal(stranger.status, 422);
    assert.equal(stranger.body.error, 'assignee_not_member');
    assert.equal(
      (await t.call(t.owner, 'PATCH', path(id, '/no-such-review'), { status: 'new' })).status,
      404,
    );

    // The audit trail names what changed and never the note or the review text.
    const audit = await db.query(
      "SELECT detail, target_id FROM audit_events WHERE action = 'review.triage'",
    );
    assert.ok(audit.length >= 2);
    for (const row of audit) {
      const text = String(row.detail);
      assert.ok(!text.includes('NOTE-TEXT') && !text.includes('REVIEW-TEXT'), text);
      assert.equal(row.target_id, rid);
    }
    t.noLeaks();
  },
);

// ---------------------------------------------------------------------------------------------
// Rate limit, background job, one read at a time

dbTest('sync is rate limited per workspace like the app sync, and can run as a job', async (db) => {
  const limiter = createTestLimiter({ limit: 2 });
  const t = await boot(db, { limiter });
  const id = await t.addIos();
  t.stores.ios.reviews = [review(1)];
  assert.equal((await t.call(t.owner, 'POST', path(id, '/sync'))).status, 200);
  const queued = await t.call(t.owner, 'POST', path(id, '/sync?background=true'));
  assert.equal(queued.status, 202);
  assert.equal(typeof queued.body.jobId, 'string');
  const limited = await t.call(t.owner, 'POST', path(id, '/sync'));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // An unknown app costs no slot.
  assert.equal((await t.call(t.owner, 'POST', path('nope', '/sync'))).status, 404);

  // The job runs the same sync and never throws, even for an app that is gone.
  const jobs = await db.query('SELECT payload FROM jobs WHERE queue = ?', [REVIEW_SYNC_QUEUE]);
  assert.equal(jobs.length, 1);
  const handler = createReviewSyncHandler(t.ctx());
  t.stores.ios.reviews = [review(1), review(2)];
  await handler(JSON.parse(String(jobs[0]?.payload)), {} as never);
  assert.equal((await t.call(t.owner, 'GET', path(id))).body.reviews.length, 2);
  await handler({ workspaceId: t.workspaceId, appId: 'gone', requestedBy: 'x' }, {} as never);
  await handler('not a payload', {} as never);
});

dbTest(
  'two reads of one app at once: the second is refused; a credential is read one request at a time',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = t.stores.ios.listReviews.bind(t.stores.ios);
    t.stores.ios.listReviews = async (o) => {
      await gate;
      return original(o);
    };
    t.stores.ios.reviews = [review(1)];
    const first = t.call(t.owner, 'POST', path(id, '/sync'));
    await new Promise((r) => setTimeout(r, 20));
    const second = await t.call(t.owner, 'POST', path(id, '/sync'));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'sync_in_progress');
    release();
    assert.equal((await first).status, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// Data protection: deletion, retention, orphans

dbTest('deleting an app removes its reviews, sync state and rating snapshots', async (db) => {
  const t = await boot(db, {
    ratingFetcher: async () => ({
      appStoreId: '1234567890',
      country: 'US',
      averageRating: 4,
      ratingCount: 10,
    }),
  });
  const id = await t.addIos();
  const other = await t.addAndroid();
  t.stores.ios.reviews = [review(1), review(2)];
  t.stores.android.reviews = [review(9, {}, 'android')];
  await t.call(t.owner, 'POST', path(id, '/sync'));
  await t.call(t.owner, 'POST', path(other, '/sync'));
  const count = async (table: string, app: string) =>
    Number((await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`, [app]))[0]?.n);
  assert.equal(await count('app_reviews', id), 2);
  assert.equal(await count('review_sync_state', id), 1);
  assert.equal(await count('app_rating_summaries', id), 1);

  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${id}`)).status, 204);
  for (const table of ['app_reviews', 'review_sync_state', 'app_rating_summaries']) {
    assert.equal(await count(table, id), 0, table);
  }
  assert.equal(await count('app_reviews', other), 1, 'another app keeps its reviews');
});

dbTest(
  'retention deletes old reviews a bounded number at a time, and 0 keeps everything',
  async (db) => {
    const t = await boot(db);
    const id = await t.addIos();
    const now = Date.now();
    t.stores.ios.reviews = Array.from({ length: 6 }, (_, i) =>
      review(i + 1, { createdAt: now - (400 + i) * DAY, updatedAt: now - (400 + i) * DAY }),
    );
    t.stores.ios.reviews.push(review(7, { createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY }));
    await t.call(t.owner, 'POST', path(id, '/sync'));
    const total = async () =>
      Number((await db.query('SELECT COUNT(*) AS n FROM app_reviews'))[0]?.n);
    assert.equal(await total(), 7);

    assert.deepEqual(await reviewUpkeep(db, { now, retentionDays: 0 }), { pruned: 0, orphans: 0 });
    assert.equal(await total(), 7);
    assert.equal(
      (await reviewUpkeep(db, { now, retentionDays: 365, maxRows: 4 })).pruned,
      4,
      'bounded',
    );
    assert.equal(await total(), 3);
    assert.equal((await reviewUpkeep(db, { now, retentionDays: 365, maxRows: 4 })).pruned, 2);
    assert.equal(await total(), 1);
    assert.equal(await pruneReviews(db, now - 365 * DAY, 10), 0);
  },
);

dbTest('rows of an app that no longer exists are purged', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  t.stores.ios.reviews = [review(1)];
  await t.call(t.owner, 'POST', path(id, '/sync'));
  await db.execute('DELETE FROM apps WHERE id = ?', [id]);
  assert.ok((await purgeOrphanReviewRows(db)) >= 1);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM app_reviews'))[0]?.n), 0);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM review_sync_state'))[0]?.n), 0);
  await deleteReviewData(db, t.workspaceId, id);
});

// ---------------------------------------------------------------------------------------------
// The scheduler

dbTest(
  'scheduler queues review reads: due apps only, spaced, bounded, once, never throwing',
  async (db) => {
    const t = await boot(db);
    const ios = await t.addIos();
    const android = await t.addAndroid();
    const unready = (
      await t.call(t.owner, 'POST', '/apps', {
        platform: 'ios',
        identifier: 'com.acme.two',
        credentialId: t.iosCredential,
      })
    ).body.app.id as string;
    const NOW = 1_900_000_000_000;
    const queued = async () =>
      (
        await db.query('SELECT payload, run_at FROM jobs WHERE queue = ? ORDER BY run_at', [
          REVIEW_SYNC_QUEUE,
        ])
      ).map((j) => ({
        appId: (JSON.parse(String(j.payload)) as { appId: string }).appId,
        runAt: Number(j.run_at),
      }));

    const first = await queueReviewSyncs(db, { now: NOW, intervalMs: 6 * HOUR, jitter: () => 0 });
    assert.equal(first.queued, 2);
    assert.equal(first.skipped.notReady, 1);
    const jobs = await queued();
    assert.deepEqual(jobs.map((j) => j.appId).sort(), [android, ios].sort());
    assert.ok(!jobs.some((j) => j.appId === unready));
    assert.equal(jobs[1]!.runAt - jobs[0]!.runAt, 5_000, 'spaced');

    // Already queued: not queued twice.
    assert.equal(
      (await queueReviewSyncs(db, { now: NOW, intervalMs: 6 * HOUR, jitter: () => 0 })).skipped
        .alreadyQueued,
      2,
    );

    // Recently tried and backing off are skipped; due again after the interval.
    await db.execute("UPDATE jobs SET status = 'done'");
    await db.execute(
      `INSERT INTO review_sync_state (app_id, store, workspace_id, last_attempt_at, backoff_until, consecutive_failures)
     VALUES (?, 'appstoreconnect', ?, ?, NULL, 0), (?, 'googleplay', ?, ?, ?, 1)`,
      [ios, t.workspaceId, NOW - HOUR, android, t.workspaceId, NOW - 7 * HOUR, NOW + 2 * HOUR],
    );
    const gated = await queueReviewSyncs(db, { now: NOW, intervalMs: 6 * HOUR, jitter: () => 0 });
    assert.equal(gated.queued, 0);
    assert.equal(gated.skipped.recent, 1);
    assert.equal(gated.skipped.backoff, 1);
    assert.equal(
      (await queueReviewSyncs(db, { now: NOW + 3 * HOUR, intervalMs: 6 * HOUR, jitter: () => 0 }))
        .queued,
      1,
      'the backoff is over, the other one is due',
    );

    // Caps and the shared rate limit.
    await db.execute("UPDATE jobs SET status = 'done'");
    await db.execute('DELETE FROM review_sync_state');
    assert.equal(
      (await queueReviewSyncs(db, { now: NOW, intervalMs: HOUR, perTick: 1, jitter: () => 0 }))
        .queued,
      1,
    );
    await db.execute("UPDATE jobs SET status = 'done'");
    const limited = await queueReviewSyncs(db, {
      now: NOW,
      intervalMs: HOUR,
      limiter: { take: () => 30 },
      jitter: () => 0,
    });
    assert.equal(limited.queued, 0);
    assert.equal(limited.skipped.rateLimited, 2);

    // Through the scheduler: off by default, on with an interval, and a failure is reported, not thrown.
    await db.execute("UPDATE jobs SET status = 'done'");
    const quiet = await createScheduler({ db, now: () => NOW, tickMs: 60_000 }).tick();
    assert.equal(quiet.reviews, undefined);
    const on = await createScheduler({
      db,
      now: () => NOW,
      reviewSyncIntervalMs: 6 * HOUR,
      jitter: () => 0,
    }).tick();
    assert.equal(on.reviews?.queued, 2);
    const errors: string[] = [];
    await db.execute('DROP TABLE review_sync_state');
    const broken = await createScheduler({
      db,
      now: () => NOW + DAY,
      reviewSyncIntervalMs: 6 * HOUR,
      onError: (m) => errors.push(m),
    }).tick();
    assert.equal(broken.reviews, undefined);
    assert.deepEqual(errors, ['scheduled review reads failed']);
  },
);

dbTest('scheduler upkeep prunes old reviews at most once an hour', async (db) => {
  const t = await boot(db);
  const id = await t.addIos();
  const NOW = Date.now();
  t.stores.ios.reviews = [
    review(1, { createdAt: NOW - 500 * DAY, updatedAt: NOW - 500 * DAY }),
    review(2, { createdAt: NOW, updatedAt: NOW }),
  ];
  await t.call(t.owner, 'POST', path(id, '/sync'));
  let clock = NOW;
  const scheduler = createScheduler({ db, now: () => clock, reviewRetentionDays: 365 });
  assert.equal((await scheduler.tick()).reviewUpkeep?.pruned, 1);
  clock += 10 * 60_000;
  assert.equal((await scheduler.tick()).reviewUpkeep, undefined, 'not again within the hour');
  clock += HOUR;
  assert.equal((await scheduler.tick()).reviewUpkeep?.pruned, 0);
  // Without the option nothing is pruned.
  assert.equal((await createScheduler({ db, now: () => NOW }).tick()).reviewUpkeep, undefined);
});
