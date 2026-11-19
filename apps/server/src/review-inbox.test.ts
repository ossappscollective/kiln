import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { bootReviews, type ReviewsBoot } from './review-test-helpers.ts';
import { workspaceReviewsSummary } from './services/review-summary.ts';
import { listWorkspaceReviews } from './services/reviews.ts';

type Item = {
  id: string;
  rating: number;
  createdAt: number;
  status: string;
  app: { id: string; name: string; platform: string };
  reply: { status: string };
};
const ids = (body: { reviews: Item[] }) => body.reviews.map((r) => r.id);

/** Two iOS apps and one Android app with 12 reviews between them. */
async function populate(t: ReviewsBoot) {
  const a = await t.addApp('ios', 'Alpha');
  const b = await t.addApp('ios', 'Beta');
  const g = await t.addApp('android', 'Gamma');
  const r = {
    a1: await t.seed(a, 'ios', 1, {
      rating: 1,
      body: 'Crashes on launch',
      territory: 'USA',
      appVersion: '1.0',
    }),
    a2: await t.seed(a, 'ios', 2, {
      rating: 5,
      body: 'Love it 100%',
      territory: 'DEU',
      appVersion: '1.1',
      response: 'Thanks!',
    }),
    a3: await t.seed(a, 'ios', 3, {
      rating: 2,
      body: 'Too slow',
      territory: 'USA',
      appVersion: '1.1',
      status: 'triaged',
    }),
    b4: await t.seed(b, 'ios', 4, { rating: 3, body: 'Fine', territory: 'USA', appVersion: '2.0' }),
    b5: await t.seed(b, 'ios', 5, {
      rating: 1,
      body: 'Cannot log in',
      territory: 'FRA',
      status: 'ignored',
    }),
    g6: await t.seed(g, 'android', 6, {
      rating: 2,
      body: 'Battery drain',
      territory: 'US',
      language: 'en',
      appVersion: '3.1',
    }),
    g7: await t.seed(g, 'android', 7, {
      rating: 4,
      body: 'Good',
      territory: 'DE',
      language: 'de',
      response: 'Danke',
    }),
    g8: await t.seed(g, 'android', 8, {
      rating: 1,
      body: 'Crash again',
      territory: 'US',
      language: 'en',
      appVersion: '3.1',
    }),
  };
  return { a, b, g, r };
}
const get = (t: ReviewsBoot, query: string, cookie = t.owner) =>
  t.call(cookie, 'GET', `/reviews${query}`);

dbTest('inbox: every app of the workspace, newest first, each review with its app', async (db) => {
  const t = await bootReviews(db);
  const { a, g, r } = await populate(t);
  const res = await get(t, '');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.reviews.length, 8);
  assert.deepEqual(ids(res.body), [r.g8, r.g7, r.g6, r.b5, r.b4, r.a3, r.a2, r.a1]);
  assert.equal(res.body.nextCursor, null);
  const first = res.body.reviews[0] as Item;
  assert.deepEqual([first.app.id, first.app.name, first.app.platform], [g, 'Gamma', 'android']);
  assert.equal((res.body.reviews.at(-1) as Item).app.id, a);
  assert.ok(res.body.reviews.every((x: Item) => x.reply.status === 'none'));
});

dbTest('inbox: filters', async (db) => {
  const t = await bootReviews(db);
  const { a, b, g, r } = await populate(t);
  const q = async (query: string) => ids((await get(t, query)).body);
  assert.deepEqual(await q(`?appIds=${a}`), [r.a3, r.a2, r.a1]);
  assert.deepEqual(await q(`?appIds=${a},${g}`), [r.g8, r.g7, r.g6, r.a3, r.a2, r.a1]);
  assert.deepEqual(await q('?store=googleplay'), [r.g8, r.g7, r.g6]);
  assert.deepEqual(await q('?platform=ios'), [r.b5, r.b4, r.a3, r.a2, r.a1]);
  assert.deepEqual(await q(`?platform=android&appIds=${a}`), [], 'an app has one store');
  assert.deepEqual(await q('?rating=1'), [r.g8, r.b5, r.a1]);
  assert.deepEqual(await q('?rating=1,2'), [r.g8, r.g6, r.b5, r.a3, r.a1]);
  assert.deepEqual(await q('?status=new'), [r.g8, r.g7, r.g6, r.b4, r.a2, r.a1]);
  assert.deepEqual(await q('?status=triaged,ignored'), [r.b5, r.a3]);
  assert.deepEqual(await q('?unanswered=true'), [r.g8, r.g6, r.b5, r.b4, r.a3, r.a1]);
  assert.deepEqual(await q('?unanswered=false'), [r.g7, r.a2]);
  assert.deepEqual(await q('?territory=usa'), [r.b4, r.a3, r.a1]);
  assert.deepEqual(await q('?language=de'), [r.g7]);
  assert.deepEqual(await q('?version=1.1'), [r.a3, r.a2]);
  assert.deepEqual(await q('?q=crash'), [r.g8, r.a1]);
  assert.deepEqual(await q('?q=100%25'), [r.a2], 'a percent sign is not a wildcard');
  assert.deepEqual(await q('?q=%25'), [r.a2]);
  assert.deepEqual(await q('?q=_'), []);
  assert.deepEqual(await q('?q=crash&rating=1&unanswered=true&platform=ios'), [r.a1]);
  const times = (await get(t, '')).body.reviews.map((x: Item) => x.createdAt) as number[];
  // Newest first: [g8, g7, g6, b5, b4, a3, a2, a1]; since is inclusive, until exclusive.
  assert.deepEqual(await q(`?since=${times[5]}&until=${times[2]}`), [r.b5, r.b4, r.a3]);
  assert.deepEqual(await q(`?appIds=${b}&rating=3`), [r.b4]);
  assert.deepEqual(await q('?appIds=does-not-exist'), []);
});

dbTest('inbox: assignee me, a member id and unassigned', async (db) => {
  const t = await bootReviews(db);
  const { a, r } = await populate(t);
  const me = await t.userId();
  const mate = await t.addMember('member');
  void mate;
  await db.execute('UPDATE app_reviews SET assignee_user_id = ? WHERE id IN (?, ?)', [
    me,
    r.a1,
    r.g6,
  ]);
  const other = String((await db.query('SELECT id FROM users WHERE id <> ? LIMIT 1', [me]))[0]?.id);
  await db.execute('UPDATE app_reviews SET assignee_user_id = ? WHERE id = ?', [other, r.b4]);
  assert.deepEqual(ids((await get(t, '?assignee=me')).body), [r.g6, r.a1]);
  assert.deepEqual(ids((await get(t, `?assignee=${other}`)).body), [r.b4]);
  assert.equal((await get(t, '?unassigned=true')).body.reviews.length, 5);
  assert.deepEqual(ids((await get(t, `?assignee=me&appIds=${a}`)).body), [r.a1]);
  assert.equal((await get(t, `?assignee=me&unassigned=true`)).status, 400);
});

dbTest(
  'inbox: sorts and keyset paging walk every review once, also with equal timestamps',
  async (db) => {
    const t = await bootReviews(db);
    const { r } = await populate(t);
    // Equal sort keys: ties must break on the id, never skip or repeat.
    await db.execute(
      'UPDATE app_reviews SET created_at = 1700000000000, updated_at = 1700000000000 WHERE id IN (?, ?, ?)',
      [r.a1, r.b4, r.g6],
    );
    for (const sort of ['newest', 'rating', 'updated']) {
      const all = ids((await get(t, `?sort=${sort}&limit=100`)).body);
      assert.equal(new Set(all).size, 8, sort);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: { status: number; body: { reviews: Item[]; nextCursor: string | null } } =
          await get(t, `?sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.reviews.length <= 3);
        seen.push(...ids(res.body));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(seen, all, `paging in ${sort} order`);
    }
    const byRating = (await get(t, '?sort=rating')).body.reviews.map(
      (x: Item) => x.rating,
    ) as number[];
    assert.deepEqual(
      byRating,
      [...byRating].sort((x, y) => x - y),
      'lowest rating first',
    );
    // A cursor belongs to its sort.
    const page = await get(t, '?sort=newest&limit=2');
    assert.equal((await get(t, `?sort=rating&cursor=${page.body.nextCursor}`)).status, 400);
    assert.equal((await get(t, '?cursor=garbage')).status, 400);
  },
);

dbTest('inbox: bad input is a 400 with the field named', async (db) => {
  const t = await bootReviews(db);
  await populate(t);
  for (const [query, path] of [
    ['?rating=6', 'rating'],
    ['?rating=a', 'rating'],
    ['?status=whatever', 'status'],
    ['?sort=oldest', 'sort'],
    ['?limit=0', 'limit'],
    ['?limit=101', 'limit'],
    ['?since=yesterday', 'since'],
    ['?store=amazon', 'store'],
    ['?platform=windows', 'platform'],
    ['?unanswered=maybe', 'unanswered'],
    ['?appIds=a%20b', 'appIds'],
    [`?q=${'x'.repeat(300)}`, 'q'],
  ] as const) {
    const res = await get(t, query);
    assert.equal(res.status, 400, query);
    assert.ok(
      res.body.issues.some((i: { path: string }) => i.path === path),
      `${query}: ${JSON.stringify(res.body.issues)}`,
    );
  }
  assert.equal((await get(t, '?limit=100')).status, 200);
});

dbTest('inbox: workspaces are isolated and non-members get 404', async (db) => {
  const t = await bootReviews(db);
  const { r } = await populate(t);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.call(outsider, 'GET', '/reviews')).status, 404, 'not a member');
  assert.equal((await t.call(outsider, 'GET', '/reviews/summary')).status, 404);
  const mine = await t.call(outsider, 'GET', '/reviews', undefined, 'other');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.reviews, [], 'the other workspace has none of these');
  // Asking for another workspace's app by id finds nothing either.
  assert.ok(r.a1);
  const someApp = String((await db.query('SELECT app_id FROM app_reviews LIMIT 1'))[0]?.app_id);
  const foreign = await t.call(outsider, 'GET', `/reviews?appIds=${someApp}`, undefined, 'other');
  assert.deepEqual(foreign.body.reviews, []);
  const summary = await t.call(outsider, 'GET', '/reviews/summary', undefined, 'other');
  assert.deepEqual(summary.body.apps, []);
  assert.equal(summary.body.totals.total, 0);
  // Viewers may read the inbox.
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'GET', '/reviews')).status, 200);
});

dbTest('inbox: a token limited to some apps sees only those, whatever it asks for', async (db) => {
  const t = await bootReviews(db);
  const { a, b, r } = await populate(t);
  const minted = await t.call(t.owner, 'POST', '/tokens', {
    name: 'T',
    role: 'admin',
    actions: ['reviews.read'],
    appIds: [a],
  });
  assert.equal(minted.status, 201, minted.text);
  const bearer = async (path: string) => {
    const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
      headers: { authorization: `Bearer ${minted.body.token}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        reviews: Item[];
        apps: { app: { id: string } }[];
        totals: { total: number };
      },
    };
  };
  assert.deepEqual(ids((await bearer('/reviews')).body), [r.a3, r.a2, r.a1]);
  assert.deepEqual(ids((await bearer(`/reviews?appIds=${a},${b}`)).body), [r.a3, r.a2, r.a1]);
  assert.deepEqual(ids((await bearer(`/reviews?appIds=${b}`)).body), []);
  const summary = await bearer('/reviews/summary');
  assert.deepEqual(
    summary.body.apps.map((x) => x.app.id),
    [a],
  );
  assert.equal(summary.body.totals.total, 3);
  // A token with no list sees everything.
  const open = await t.call(t.owner, 'POST', '/tokens', {
    name: 'All',
    role: 'admin',
    actions: ['reviews.read'],
  });
  const res = await t.app.request(`/api/workspaces/${t.workspaceId}/reviews`, {
    headers: { authorization: `Bearer ${open.body.token}` },
  });
  assert.equal(((await res.json()) as { reviews: unknown[] }).reviews.length, 8);
  // A token without reviews.read cannot read the inbox.
  const none = await t.call(t.owner, 'POST', '/tokens', {
    name: 'None',
    role: 'admin',
    actions: ['apps.read'],
  });
  const denied = await t.app.request(`/api/workspaces/${t.workspaceId}/reviews`, {
    headers: { authorization: `Bearer ${none.body.token}` },
  });
  assert.equal(denied.status, 403);
});

dbTest('summary: counts per app and totals, with the basis, and no review text', async (db) => {
  const t = await bootReviews(db);
  const { a, b, g, r } = await populate(t);
  await t.addApp('ios', 'Empty');
  const res = await t.call(t.owner, 'GET', '/reviews/summary');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.basis, 'stored_reviews');
  assert.match(res.body.label, /stored review/);
  assert.match(res.body.label, /not store-wide/);
  const by = Object.fromEntries(res.body.apps.map((x: { app: { id: string } }) => [x.app.id, x]));
  // Alpha: 1 star new, 5 star answered, 2 star triaged. Low rating is <= the threshold, ignoring ignored ones.
  assert.deepEqual([by[a].total, by[a].new, by[a].unanswered, by[a].lowRating], [3, 2, 2, 2]);
  assert.equal(by[a].average, 2.67);
  // Beta: 3 star new, 1 star ignored: the ignored one is neither unanswered nor low.
  assert.deepEqual([by[b].total, by[b].new, by[b].unanswered, by[b].lowRating], [2, 1, 1, 0]);
  assert.deepEqual([by[g].total, by[g].new, by[g].unanswered, by[g].lowRating], [3, 3, 2, 2]);
  const oldestOf = async (ids: string[]) =>
    Number(
      (
        await db.query(
          `SELECT MIN(created_at) AS m FROM app_reviews WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        )
      )[0]?.m,
    );
  assert.deepEqual(res.body.totals, {
    total: 8,
    new: 6,
    unanswered: 5,
    unansweredOldestAt: await oldestOf([r.a1, r.a3, r.b4, r.g6, r.g8]),
    lowRating: 4,
    average: 2.38,
  });
  assert.equal(res.body.unansweredMaxRating, 5);
  assert.equal(by[a].unansweredOldestAt, await oldestOf([r.a1, r.a3]));
  assert.equal(
    by[b].unansweredOldestAt,
    await oldestOf([r.b4]),
    'an ignored review is not unanswered',
  );
  const empty = res.body.apps.find((x: { app: { name: string } }) => x.app.name === 'Empty');
  assert.deepEqual([empty.total, empty.average, empty.unansweredOldestAt], [0, null, null]);
  const text = JSON.stringify(res.body);
  for (const word of ['Crashes on launch', 'Battery drain', 'Reviewer', 'Body of review'])
    assert.ok(!text.includes(word), word);
  // The service agrees, and an empty app list matches nothing.
  const none = await workspaceReviewsSummary(db, t.workspaceId, {
    appIds: [],
    lowRatingThreshold: 2,
  });
  assert.equal(none.totals.total, 0);
  assert.equal(none.totals.average, null);
});

dbTest('inbox queries run on the workspace first indexes (SQLite plan)', async (db) => {
  if (db.dialect !== 'sqlite') return;
  const t = await bootReviews(db);
  await populate(t);
  const plan = async (order: string, extra = '') =>
    (
      await db.query(
        `EXPLAIN QUERY PLAN SELECT r.id FROM app_reviews r WHERE r.workspace_id = ?${extra} ORDER BY ${order} LIMIT 51`,
        [t.workspaceId],
      )
    )
      .map((row) => String(row.detail))
      .join(' | ');
  const newest = await plan('r.created_at DESC, r.id DESC');
  assert.match(newest, /app_reviews_ws_created_idx/, newest);
  assert.doesNotMatch(newest, /USE TEMP B-TREE/, newest);
  const updated = await plan('r.updated_at DESC, r.id DESC');
  assert.match(updated, /app_reviews_ws_updated_idx/, updated);
  assert.doesNotMatch(updated, /USE TEMP B-TREE/, updated);
  const rating = await plan('r.rating ASC, r.created_at DESC, r.id DESC');
  assert.match(rating, /app_reviews_ws_rating_idx/, rating);
  // A single app uses the per app index, which also begins with the app.
  const one = (
    await db.query(
      'EXPLAIN QUERY PLAN SELECT id FROM app_reviews WHERE workspace_id = ? AND app_id = ? ORDER BY created_at DESC, id DESC LIMIT 51',
      [t.workspaceId, 'x'],
    )
  )
    .map((row) => String(row.detail))
    .join(' | ');
  assert.match(one, /app_reviews_/, one);
  // The service itself pages without error on the same data.
  const page = await listWorkspaceReviews(db, t.workspaceId, {}, { sort: 'rating', limit: 2 });
  assert.ok(!('error' in page) && page.reviews.length === 2 && page.nextCursor);
});

dbTest(
  'inbox: replies show as status on the cards, with the draft (lists include replyDraft)',
  async (db) => {
    const t = await bootReviews(db);
    const { a, r } = await populate(t);
    await t.call(t.owner, 'PUT', `/apps/${a}/reviews/${r.a1}/reply-draft`, {
      text: 'SECRET-DRAFT-TEXT',
    });
    const res = await get(t, `?appIds=${a}`);
    const card = res.body.reviews.find((x: Item) => x.id === r.a1) as Item & {
      replyDraft?: { text: string } | null;
    };
    assert.equal(card.reply.status, 'draft');
    assert.equal(
      card.replyDraft?.text,
      'SECRET-DRAFT-TEXT',
      'lists include the draft, so a card can show it',
    );
    const other = res.body.reviews.find((x: Item) => x.id === r.a2) as Item & {
      replyDraft?: unknown;
    };
    assert.equal(other.replyDraft, null);
  },
);

dbTest('summary: maxRating narrows the unanswered numbers only, and is checked', async (db) => {
  const t = await bootReviews(db);
  const { a, b, r } = await populate(t);
  const low = await t.call(t.owner, 'GET', '/reviews/summary?maxRating=2');
  assert.equal(low.status, 200, low.text);
  assert.equal(low.body.unansweredMaxRating, 2);
  const by = Object.fromEntries(low.body.apps.map((x: { app: { id: string } }) => [x.app.id, x]));
  assert.equal(by[a].unanswered, 2, 'the 1 and 2 star reviews of Alpha');
  assert.equal(by[b].unanswered, 0, 'Beta has only a 3 star one open');
  assert.equal(by[b].unansweredOldestAt, null);
  assert.equal(low.body.totals.unanswered, 4);
  assert.equal(low.body.totals.total, 8, 'the other numbers do not change');
  for (const bad of ['0', '6', 'x', '1.5'])
    assert.equal(
      (await t.call(t.owner, 'GET', `/reviews/summary?maxRating=${bad}`)).status,
      400,
      bad,
    );

  // The per app summary: the same figure under `unanswered`, with its oldest time and the rating it used.
  const one = await t.call(t.owner, 'GET', `/apps/${a}/reviews/summary`);
  assert.equal(one.status, 200, one.text);
  assert.deepEqual(Object.keys(one.body.unanswered).sort(), ['count', 'maxRating', 'oldestAt']);
  assert.equal(one.body.unanswered.count, 2);
  assert.equal(one.body.unanswered.maxRating, 5);
  const created = Number(
    (await db.query('SELECT created_at FROM app_reviews WHERE id = ?', [r.a1]))[0]?.created_at,
  );
  assert.equal(one.body.unanswered.oldestAt, created);
  assert.equal(
    (await t.call(t.owner, 'GET', `/apps/${a}/reviews/summary?maxRating=1`)).body.unanswered.count,
    1,
  );
  assert.equal(
    (await t.call(t.owner, 'GET', `/apps/${a}/reviews/summary?maxRating=9`)).status,
    400,
  );
  assert.ok(!JSON.stringify(one.body).includes('Crashes on launch'), 'no review text');
});
