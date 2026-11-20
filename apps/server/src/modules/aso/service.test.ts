import assert from 'node:assert/strict';
import { AsoError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import {
  bootAso,
  OWN_IOS_ID,
  OWN_PLAY_ID,
  publicApp,
  slowDown,
  unavailable,
} from './test-helpers.ts';
import { createAsoRefreshHandler } from './service.ts';

/**
 * Keyword tracking, rank checks, competitors and the refresh (docs/api/aso.md). The store is a fake: no
 * request ever leaves the process.
 */

const ids = (n: number, ownAt: number) =>
  Array.from({ length: n }, (_, i) => (i + 1 === ownAt ? OWN_IOS_ID : `r${i + 1}`));

// ----- keywords -------------------------------------------------------------------------------------

dbTest(
  'keywords: added in bulk, each judged on its own, listed, changed and deleted',
  async (db) => {
    const t = await bootAso(db, { limits: { maxKeywordsPerApp: 4 } });
    const appId = await t.addApp('ios');
    const res = await t.addKeywords(appId, [
      { term: 'Water  Reminder', tag: 'core', priority: 3 },
      { term: 'water-reminder' },
      { term: '' },
      { term: 'habit tracker', country: 'de' },
      { term: 'drink log', country: 'zz1' },
      { term: 'one' },
      { term: 'two' },
      { term: 'three' },
    ]);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(
      res.body.results.map((r: { status: string }) => r.status),
      ['created', 'exists', 'invalid', 'created', 'invalid', 'created', 'created', 'limit'],
    );
    assert.deepEqual(res.body.summary, { created: 4, exists: 1, invalid: 2, limit: 1 });
    assert.equal(res.body.results[0].keyword.term, 'Water Reminder');
    assert.equal(res.body.results[0].keyword.country, 'us');
    assert.match(res.body.results[3].keyword.locale, /^de/);
    assert.equal(
      res.body.results[1].keyword.id,
      res.body.results[0].keyword.id,
      'the same keyword, not a copy',
    );

    const list = await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`);
    assert.equal(list.status, 200);
    assert.equal(list.body.keywords.length, 4);
    assert.equal(list.body.limits.maxKeywordsPerApp, 4);
    assert.equal(list.body.keywords[0].state, null, 'never checked');
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords?country=de`)).body.keywords.length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords?tag=core`)).body.keywords.length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords?country=zz1`)).status,
      400,
    );

    const id = res.body.results[0].keyword.id as string;
    const patched = await t.call(t.owner, 'PATCH', `/apps/${appId}/aso/keywords/${id}`, {
      priority: 1,
      tag: null,
      notes: 'a note',
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.keyword.priority, 1);
    assert.equal(patched.body.keyword.tag, null);
    assert.equal(patched.body.keyword.notes, 'a note');
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/apps/${appId}/aso/keywords/${id}`, {})).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/apps/${appId}/aso/keywords/${id}`, { priority: 9 })).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/apps/${appId}/aso/keywords/${id}`, { term: 'other' }))
        .status,
      400,
      'the term is not changeable',
    );
    assert.equal(
      (await t.call(t.owner, 'PATCH', `/apps/${appId}/aso/keywords/nope`, { priority: 2 })).status,
      404,
    );

    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/keywords/${id}`)).status,
      204,
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/keywords/${id}`)).status,
      404,
    );
    assert.equal((await t.call(t.owner, 'GET', `/apps/nope/aso/keywords`)).status, 404);
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, { keywords: [] })).status,
      400,
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
          keywords: [{ term: 'x', extra: 1 }],
        })
      ).status,
      400,
      'strict',
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
          keywords: Array.from({ length: 51 }, (_, i) => ({ term: `k${i}` })),
        })
      ).status,
      400,
    );

    // A full app still takes nothing; after a delete there is room again.
    const again = await t.addKeywords(appId, [{ term: 'five' }]);
    assert.equal(again.status, 201);
    assert.equal((await t.addKeywords(appId, [{ term: 'six' }])).status, 200, 'nothing created');
  },
);

dbTest('keywords: who may do what, and another workspace sees nothing', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  // A viewer reads (like reviews and listings) and changes nothing.
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/keywords`)).status, 200);
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/summary`)).status, 200);
  assert.equal((await t.call(viewer, 'GET', '/aso/config')).status, 200);
  assert.equal((await t.addKeywords(appId, [{ term: 'a b' }], viewer)).status, 403);
  assert.equal((await t.refresh(appId, '', viewer)).status, 403);
  assert.equal(
    (await t.call(viewer, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' })).status,
    403,
  );
  assert.equal((await t.call(viewer, 'POST', '/aso/refresh')).status, 403);
  assert.equal((await t.addKeywords(appId, [{ term: 'member term' }], member)).status, 201);
  assert.equal((await t.call(member, 'GET', `/apps/${appId}/aso/keywords`)).status, 200);
  assert.equal((await t.addKeywords(appId, [{ term: 'admin term' }], admin)).status, 201);

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal(
    (await t.call(outsider, 'GET', `/apps/${appId}/aso/keywords`, undefined, 'other')).status,
    404,
    'an app of another workspace',
  );
  assert.equal(
    (await t.call(outsider, 'GET', `/apps/${appId}/aso/keywords`)).status,
    404,
    'not a member of this workspace',
  );
});

dbTest('audit and events carry ids and counts, never a keyword or a store text', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  await t.addKeywords(appId, [{ term: 'zebra tracker', notes: 'secret plan' }]);
  t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 12));
  t.sources.setApp(
    'ios',
    'us',
    publicApp('555', { name: 'Rival Five', description: 'A unique rival sentence.' }),
  );
  assert.equal(
    (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' })).status,
    201,
  );
  assert.equal((await t.refresh(appId)).status, 200);
  t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 2));
  t.sources.setApp(
    'ios',
    'us',
    publicApp('555', {
      name: 'Rival Five Plus',
      version: '2.0',
      description: 'A unique rival sentence.',
    }),
  );
  assert.equal((await t.refresh(appId)).status, 200);
  const trail = (await t.trail()).toLowerCase();
  for (const secret of ['zebra', 'secret plan', 'rival five', 'unique rival'])
    assert.equal(trail.includes(secret), false, `${secret} must not be in audit, events or jobs`);
  assert.ok((await t.events('aso.rank_changed')).length > 0);
  assert.ok((await t.events('aso.competitor_changed')).length > 0);
  const audit = await db.query("SELECT action FROM audit_events WHERE action LIKE 'aso.%'");
  assert.deepEqual([...new Set(audit.map((r) => String(r.action)))].sort(), [
    'aso.competitor_add',
    'aso.keyword_add',
    'aso.refresh',
  ]);
});

// ----- the refresh ----------------------------------------------------------------------------------

dbTest(
  'refresh: ranks are stored, the first check is quiet, a big move raises aso.rank_changed',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    await t.addKeywords(appId, [{ term: 'zebra tracker' }, { term: 'giraffe log' }]);
    t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 12));
    t.sources.setResults('ios', 'us', 'giraffe log', ids(20, 0));

    const first = await t.refresh(appId);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(
      { due: 2, checked: 2, ranked: 1, notRanked: 1, failed: 0 },
      {
        due: first.body.result.keywords.due,
        checked: first.body.result.keywords.checked,
        ranked: first.body.result.keywords.ranked,
        notRanked: first.body.result.keywords.notRanked,
        failed: first.body.result.keywords.failed,
      },
    );
    assert.equal(first.body.result.deferred, false);
    assert.equal(first.body.state.consecutiveFailures, 0);
    assert.ok(first.body.state.lastSuccessAt);
    assert.equal(
      (await t.events('aso.rank_changed')).length,
      0,
      'the first check never raises an event',
    );
    const kw = async (term: string) =>
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords.find(
        (k: { term: string }) => k.term === term,
      );
    assert.deepEqual(
      {
        s: (await kw('zebra tracker')).state,
        r: (await kw('zebra tracker')).rank,
        n: (await kw('zebra tracker')).total,
      },
      { s: 'ranked', r: 12, n: 20 },
    );
    assert.deepEqual(
      { s: (await kw('giraffe log')).state, r: (await kw('giraffe log')).rank },
      { s: 'not_ranked', r: null },
    );

    // 12 -> 8: four places, under the default threshold of 5.
    t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 8));
    await t.refresh(appId);
    assert.equal((await t.events('aso.rank_changed')).length, 0);
    assert.equal((await kw('zebra tracker')).change.kind, 'up');

    // 8 -> 2: six places. And the other keyword enters the top ten.
    t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 2));
    t.sources.setResults('ios', 'us', 'giraffe log', ids(20, 5));
    await t.refresh(appId);
    const moved = await t.events('aso.rank_changed');
    assert.equal(moved.length, 2);
    const up = moved.find((e) => e.payload.change === 'up');
    assert.deepEqual(
      {
        from: up?.payload.from,
        to: up?.payload.to,
        delta: up?.payload.delta,
        threshold: up?.payload.threshold,
      },
      { from: 8, to: 2, delta: 6, threshold: 5 },
    );
    assert.equal(moved.find((e) => e.payload.change === 'entered')?.payload.to, 5);
    assert.equal(up?.subject.appId, appId);
    assert.deepEqual(Object.keys(up?.payload ?? {}).sort(), [
      'appId',
      'change',
      'country',
      'delta',
      'from',
      'keywordId',
      'locale',
      'platform',
      'threshold',
      'to',
    ]);

    // Entering far down the list is not news (position 40 of 50).
    t.sources.setResults('ios', 'us', 'giraffe log', ids(50, 0));
    await t.refresh(appId); // dropped from 5: news
    assert.equal(
      (await t.events('aso.rank_changed')).filter((e) => e.payload.change === 'dropped').length,
      1,
    );
    t.sources.setResults('ios', 'us', 'giraffe log', ids(50, 40));
    await t.refresh(appId);
    assert.equal(
      (await t.events('aso.rank_changed')).filter((e) => e.payload.change === 'entered').length,
      1,
      'entering at 40 raised nothing',
    );

    // The workspace setting decides what a big move is.
    assert.equal(
      (await t.call(t.owner, 'PUT', '/settings', { 'aso.rankMoveThreshold': 2 })).status,
      200,
    );
    t.sources.setResults('ios', 'us', 'zebra tracker', ids(20, 4));
    await t.refresh(appId);
    const last = (await t.events('aso.rank_changed')).filter((e) => e.payload.change === 'down');
    assert.equal(last.length, 1);
    assert.equal(last[0]?.payload.threshold, 2);

    const history = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/aso/keywords/${(await kw('zebra tracker')).id}/history`,
    );
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.body.checks.map((c: { rank: number }) => c.rank),
      [12, 8, 2, 2, 2, 4],
    );
    assert.equal(history.body.trend.latest, 4);
    assert.equal(
      (
        await t.call(
          t.owner,
          'GET',
          `/apps/${appId}/aso/keywords/${(await kw('zebra tracker')).id}/history?limit=2`,
        )
      ).body.checks.length,
      2,
    );
    assert.equal(
      (
        await t.call(
          t.owner,
          'GET',
          `/apps/${appId}/aso/keywords/${(await kw('zebra tracker')).id}/history?limit=0`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords/nope/history`)).status,
      404,
    );

    const summary = await t.call(t.owner, 'GET', `/apps/${appId}/aso/summary`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.keywords.total, 2);
    assert.equal(summary.body.keywords.ranked, 2);
  },
);

dbTest(
  'refresh: stops at the cap, checks the oldest first, and leaves the rest due',
  async (db) => {
    const t = await bootAso(db, { limits: { maxChecksPerRun: 2 } });
    const appId = await t.addApp('ios');
    for (const term of ['k one', 'k two', 'k three', 'k four']) {
      await t.addKeywords(appId, [{ term }]);
      t.sources.setResults('ios', 'us', term, ids(5, 1));
    }
    const a = await t.refresh(appId);
    assert.deepEqual(
      {
        due: a.body.result.keywords.due,
        checked: a.body.result.keywords.checked,
        deferred: a.body.result.deferred,
        why: a.body.result.stoppedBecause,
      },
      { due: 4, checked: 2, deferred: true, why: 'cap' },
    );
    await t.refresh(appId);
    assert.deepEqual(
      t.sources.searches.map((s) => s.term),
      ['k one', 'k two', 'k three', 'k four'],
      'the second run starts with the ones never checked',
    );
    assert.equal(
      t.sources.searches.every((s) => s.limit === 50),
      true,
      'the rank depth is the limit',
    );
  },
);

dbTest(
  'refresh: our own rate limit means later, a store 429 is a failure with a backoff',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    await t.addKeywords(appId, [{ term: 'k one' }, { term: 'k two' }]);
    t.sources.setResults('ios', 'us', 'k one', ids(5, 1));
    t.sources.setResults('ios', 'us', 'k two', ids(5, 2));

    t.sources.searchError = slowDown(30, false);
    const later = await t.refresh(appId);
    assert.equal(later.status, 200, later.text);
    assert.deepEqual(
      {
        d: later.body.result.deferred,
        why: later.body.result.stoppedBecause,
        retry: later.body.result.retryAfterSeconds,
        errors: later.body.result.errors,
      },
      { d: true, why: 'rate_limit', retry: 30, errors: [] },
    );
    assert.equal(later.body.state.consecutiveFailures, 0, 'not a failure');

    t.sources.searchError = slowDown(30, true);
    const refused = await t.refresh(appId);
    assert.equal(refused.status, 502);
    assert.equal(refused.body.error, 'refresh_failed');
    assert.deepEqual(refused.body.result.errors, ['rate_limited']);
    const state = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/summary`)).body.state;
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.lastError, 'rate_limited');
    assert.ok(state.backoffUntil > state.lastAttemptAt, 'a backoff is set');

    t.sources.searchError = undefined;
    const ok = await t.refresh(appId);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.state.consecutiveFailures, 0);
    assert.equal(ok.body.state.backoffUntil, null);
    assert.equal(ok.body.state.lastError, null);
  },
);

dbTest(
  'refresh: an unavailable source never becomes "not ranked", and a changed layout stops the run',
  async (db) => {
    const t = await bootAso(db, { playEnabled: true });
    const appId = await t.addApp('android');
    await t.addKeywords(appId, [{ term: 'k one' }, { term: 'k two' }]);
    t.sources.setResults('android', 'us', 'k one', ['x', OWN_PLAY_ID]);
    t.sources.setResults('android', 'us', 'k two', ['x', 'y']);
    assert.equal((await t.refresh(appId)).status, 200);
    const list = async () =>
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords as {
        term: string;
        state: string | null;
        rank: number | null;
        error: string | null;
      }[];
    assert.deepEqual(
      (await list()).map((k) => [k.term, k.state, k.rank]),
      [
        ['k one', 'ranked', 2],
        ['k two', 'not_ranked', null],
      ],
    );

    t.sources.searchError = unavailable('layout_changed');
    const broken = await t.refresh(appId);
    assert.equal(broken.status, 502);
    assert.equal(broken.body.result.stoppedBecause, 'unavailable');
    assert.equal(t.sources.searches.length, 3, 'it stopped at the first unavailable answer');
    const after = await list();
    assert.deepEqual(
      after.map((k) => [k.state, k.rank]),
      [
        ['ranked', 2],
        ['not_ranked', null],
      ],
      'what was known stays',
    );
    assert.ok(after.some((k) => k.error === 'unavailable_layout_changed'));
    assert.equal((await t.events('aso.rank_changed')).length, 0);
    assert.equal(
      JSON.stringify(broken.body).includes('play.google.com'),
      false,
      'no address in the error',
    );

    t.sources.searchError = undefined;
    assert.equal((await t.refresh(appId)).status, 200);
    assert.equal(
      (await list()).every((k) => k.error === null),
      true,
      'a success clears the error',
    );
  },
);

dbTest('refresh: three transient failures in a row stop the run', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  for (const term of ['a one', 'b two', 'c three', 'd four', 'e five'])
    await t.addKeywords(appId, [{ term }]);
  t.sources.searchError = new AsoError(
    'apple_search',
    'server',
    'The store answered with an error.',
    { status: 503 },
  );
  const res = await t.refresh(appId);
  assert.equal(res.status, 502);
  assert.equal(res.body.result.stoppedBecause, 'errors');
  assert.equal(res.body.result.keywords.failed, 3);
  assert.equal(t.sources.searches.length, 3);
});

dbTest(
  'refresh: one at a time per app, and a stale claim of another process is taken over',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    await t.addKeywords(appId, [{ term: 'k one' }]);
    t.sources.setResults('ios', 'us', 'k one', ids(5, 1));
    let release: () => void = () => undefined;
    t.sources.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = t.refresh(appId);
    for (let i = 0; i < 200 && t.sources.searches.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(t.sources.searches.length, 1, 'the first refresh is in flight');
    const second = await t.refresh(appId);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'refresh_in_progress');
    release();
    assert.equal((await first).status, 200);
    t.sources.gate = undefined;

    // Another process holds the claim.
    await db.execute('UPDATE aso_app_state SET claimed_at = ?, claimed_by = ? WHERE app_id = ?', [
      t.clock.now(),
      'other-process',
      appId,
    ]);
    assert.equal((await t.refresh(appId)).status, 409);
    t.clock.advance(16 * 60_000);
    assert.equal((await t.refresh(appId)).status, 200, 'the claim expired');
    const [row] = await db.query('SELECT claimed_at FROM aso_app_state WHERE app_id = ?', [appId]);
    assert.equal(row?.claimed_at, null, 'released at the end');
  },
);

dbTest(
  'refresh in the background is a job, and the handler runs it; refreshing everything is an admin call',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    const quiet = await t.addApp('ios', 'Quiet');
    await t.addKeywords(appId, [{ term: 'k one' }]);
    t.sources.setResults('ios', 'us', 'k one', ids(5, 3));
    const member = await t.addMember('member');
    const queued = await t.refresh(appId, '?background=true', member);
    assert.equal(queued.status, 202);
    assert.ok(queued.body.jobId);
    assert.equal(t.sources.searches.length, 0, 'nothing ran yet');
    const [job] = await db.query("SELECT payload FROM jobs WHERE queue = 'aso.refresh'");
    const payload = JSON.parse(String(job?.payload));
    assert.deepEqual(Object.keys(payload).sort(), [
      'appId',
      'force',
      'requestedBy',
      'scope',
      'workspaceId',
    ]);
    await createAsoRefreshHandler(t.ctx())(payload, {} as never);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords[0].rank,
      3,
    );
    // A payload that is not ours does nothing.
    await createAsoRefreshHandler(t.ctx())({ nonsense: true }, {} as never);
    await createAsoRefreshHandler(t.ctx())(null, {} as never);

    assert.equal(
      (await t.call(member, 'POST', '/aso/refresh')).status,
      403,
      'a member may refresh an app, not all of them',
    );
    await db.execute("DELETE FROM jobs WHERE queue = 'aso.refresh'");
    const all = await t.call(t.owner, 'POST', '/aso/refresh');
    assert.equal(all.status, 202, all.text);
    assert.equal(all.body.queued, 1, 'only the app that has something to look at');
    const again = await t.call(t.owner, 'POST', '/aso/refresh');
    assert.deepEqual({ q: again.body.queued, s: again.body.skipped.alreadyQueued }, { q: 0, s: 1 });
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${quiet}/aso/refresh?scope=nope`)).status,
      400,
    );
    const audit = await db.query(
      "SELECT detail FROM audit_events WHERE action = 'aso.refresh_all'",
    );
    assert.equal(audit.length, 2);
  },
);

// ----- Google Play ----------------------------------------------------------------------------------

dbTest(
  'Google Play is off by default: keywords can be kept, nothing is read, and the answer says why',
  async (db) => {
    const t = await bootAso(db);
    const droid = await t.addApp('android');
    assert.equal((await t.addKeywords(droid, [{ term: 'play term' }])).status, 201);
    const refused = await t.refresh(droid);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'play_unofficial_disabled');
    assert.match(refused.body.message, /MRM_ASO_PLAY_UNOFFICIAL_ENABLED/);
    const comp = await t.call(t.owner, 'POST', `/apps/${droid}/aso/competitors`, {
      externalId: 'com.rival.app',
    });
    assert.equal(comp.status, 409);
    assert.equal(comp.body.error, 'play_unofficial_disabled');
    assert.equal((await t.refresh(droid, '?background=true')).status, 409);
    assert.equal(t.sources.searches.length + t.sources.lookups.length, 0, 'not one request');

    const config = await t.call(t.owner, 'GET', '/aso/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.play.enabled, false);
    assert.equal(config.body.play.unofficial, true);
    assert.match(config.body.play.notice, /terms of service/i);
    assert.equal(config.body.apple.enabled, true);
    assert.equal(config.body.rankMoveThreshold, 5);
    assert.equal(config.body.limits.maxKeywordsPerApp, 50);
    assert.equal(config.body.schedule.intervalMinutes, 0);
  },
);

dbTest(
  'Google Play when the operator switched it on: ranks by package name, competitors by package name',
  async (db) => {
    const t = await bootAso(db, { playEnabled: true });
    const droid = await t.addApp('android');
    await t.addKeywords(droid, [{ term: 'play term' }]);
    t.sources.setResults('android', 'us', 'play term', ['com.other.one', OWN_PLAY_ID]);
    const done = await t.refresh(droid);
    assert.equal(done.status, 200, done.text);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${droid}/aso/keywords`)).body.keywords[0].rank,
      2,
    );

    t.sources.setApp('android', 'us', publicApp('com.rival.app', { name: 'Rival Droid' }));
    const comp = await t.call(t.owner, 'POST', `/apps/${droid}/aso/competitors`, {
      externalId: 'https://play.google.com/store/apps/details?id=com.rival.app&hl=en',
    });
    assert.equal(comp.status, 201, comp.text);
    assert.equal(comp.body.competitor.store, 'google_play');
    assert.equal(comp.body.competitor.externalId, 'com.rival.app');
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${droid}/aso/competitors`, { externalId: OWN_PLAY_ID }))
        .status,
      422,
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${droid}/aso/competitors`, { externalId: '123456' }))
        .status,
      422,
      'an App Store id is not a package name',
    );
  },
);

// ----- competitors ----------------------------------------------------------------------------------

dbTest(
  'competitors: followed after one lookup, checked, snapshots only on a change or a heartbeat',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    t.sources.setApp('ios', 'us', publicApp('555', { name: 'Rival Five' }));
    const add = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
      externalId: 'id555',
    });
    assert.equal(add.status, 201, add.text);
    const cid = add.body.competitor.id as string;
    assert.deepEqual(
      {
        ext: add.body.competitor.externalId,
        name: add.body.competitor.name,
        store: add.body.competitor.store,
        kind: add.body.competitor.latest.kind,
      },
      { ext: '555', name: 'Rival Five', store: 'app_store', kind: 'first' },
    );
    assert.equal(add.body.competitor.latest.rating, 4.5);
    assert.equal(t.sources.lookups.length, 1);

    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
          externalId: 'https://apps.apple.com/us/app/rival/id555',
        })
      ).body.error,
      'already_followed',
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: OWN_IOS_ID }))
        .body.error,
      'own_app',
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '999' })).body
        .error,
      'not_found',
    );
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: 'abc' })).body
        .error,
      'invalid_external_id',
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
          externalId: '556',
          country: 'zz1',
        })
      ).body.error,
      'invalid_country',
    );
    assert.equal(
      (
        await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
          externalId: '556',
          extra: true,
        })
      ).status,
      400,
    );
    t.sources.lookupError = new AsoError('apple_search', 'server', 'x', { status: 500 });
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '557' }))
        .status,
      502,
    );
    t.sources.lookupError = undefined;

    const snapshots = async () =>
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitors/${cid}/history`)).body;
    const check = async () =>
      (await t.refresh(appId, '?scope=competitors')).body.result.competitors as {
        changed: number;
        checked: number;
      };

    assert.deepEqual(await check(), { due: 1, checked: 1, changed: 0, notFound: 0, failed: 0 });
    assert.equal((await snapshots()).snapshots.length, 1, 'nothing changed: nothing stored');

    // Only the rating count drifts: stored as a change, but not worth an event.
    t.sources.setApp('ios', 'us', publicApp('555', { name: 'Rival Five', ratingCount: 1200 }));
    assert.equal((await check()).changed, 1);
    assert.equal((await t.events('aso.competitor_changed')).length, 0);

    // A new version is.
    t.sources.setApp(
      'ios',
      'us',
      publicApp('555', { name: 'Rival Five', ratingCount: 1200, version: '1.1.0' }),
    );
    assert.equal((await check()).changed, 1);
    const events = await t.events('aso.competitor_changed');
    assert.equal(events.length, 1);
    assert.deepEqual(
      {
        fields: events[0]?.payload.fields,
        store: events[0]?.payload.store,
        country: events[0]?.payload.country,
      },
      { fields: ['version'], store: 'app_store', country: 'us' },
    );
    const hist = await snapshots();
    assert.deepEqual(
      hist.snapshots.map((s: { kind: string }) => s.kind),
      ['change', 'change', 'first'],
    );
    assert.deepEqual(hist.diff.changes, [{ field: 'version', from: '1.0.0', to: '1.1.0' }]);
    assert.equal(hist.diff.to, hist.snapshots[0].id);
    assert.equal(hist.diff.from, hist.snapshots[1].id);

    // A quiet competitor still shows it was looked at, once a week.
    assert.equal((await check()).changed, 0);
    assert.equal((await snapshots()).snapshots.length, 3);
    t.clock.advance(8 * 24 * 60 * 60_000);
    assert.equal((await check()).changed, 0);
    assert.equal((await snapshots()).snapshots[0].kind, 'heartbeat');

    // The store no longer has it.
    t.sources.apps.clear();
    const gone = await t.refresh(appId, '?scope=competitors');
    assert.equal(gone.body.result.competitors.notFound, 1);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitors`)).body.competitors[0].state,
      'not_found',
    );
    assert.equal((await snapshots()).snapshots.length, 4);

    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/competitors/${cid}`)).status,
      204,
    );
    assert.equal(
      (await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/competitors/${cid}`)).status,
      404,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitors/${cid}/history`)).status,
      404,
    );
    assert.equal((await db.query('SELECT id FROM aso_competitor_snapshots')).length, 0);
  },
);

dbTest('competitors: a followed list has a limit', async (db) => {
  const t = await bootAso(db, { limits: { maxCompetitorsPerApp: 1 } });
  const appId = await t.addApp('ios');
  t.sources.setApp('ios', 'us', publicApp('555'));
  t.sources.setApp('ios', 'us', publicApp('556'));
  assert.equal(
    (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' })).status,
    201,
  );
  const over = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
    externalId: '556',
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'limit_reached');
  // The same app in another storefront is a different competitor.
  t.sources.setApp('ios', 'de', publicApp('555'));
  assert.equal(
    (
      await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
        externalId: '555',
        country: 'de',
      })
    ).body.error,
    'limit_reached',
  );
});

dbTest('lookups are rate limited per workspace and the answer says when to retry', async (db) => {
  const t = await bootAso(db, { limiterLimit: 10 });
  const appId = await t.addApp('ios');
  let last = 0;
  for (let i = 0; i < 12 && last !== 429; i++) {
    const res = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, {
      externalId: String(700 + i),
    });
    last = res.status;
    if (res.status === 429) {
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(res.body.error, 'rate_limited');
    }
  }
  assert.equal(last, 429);
});

// ----- what is worked out from what is stored ------------------------------------------------------

async function seedListing(
  db: import('@mrm/db').Database,
  workspaceId: string,
  appId: string,
  locale: string,
  fields: Record<string, string>,
) {
  let n = 0;
  for (const [field, value] of Object.entries(fields)) {
    n += 1;
    await db.execute(
      `INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, source_ref, observed_at)
       VALUES (?, ?, ?, 'ios', ?, ?, 'live', ?, ?, 'store', '1.0', ?)`,
      [
        `snap-${locale}-${field}`,
        workspaceId,
        appId,
        locale,
        field,
        value,
        `hash-${field}-${n}`,
        1000 + n,
      ],
    );
  }
}

dbTest(
  'fit, ideas, gaps, suggestions and markets are worked out from what is stored; no store is read',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    await seedListing(db, t.workspaceId, appId, 'en-US', {
      name: 'Hydro Buddy',
      subtitle: 'Water reminder and tracker',
      keywords: 'hydration,drink log',
      description: 'Stay hydrated with gentle reminders.',
    });
    await t.addKeywords(appId, [
      { term: 'water reminder' },
      { term: 'hydration' },
      { term: 'bedtime notes' },
      { term: 'water reminder', country: 'de' },
    ]);
    const calls = () => t.sources.searches.length + t.sources.lookups.length;

    const fit = await t.call(t.owner, 'GET', `/apps/${appId}/aso/fit`);
    assert.equal(fit.status, 200, fit.text);
    const en = fit.body.locales.find((l: { locale: string }) => l.locale === 'en-US');
    assert.equal(en.listingLocale, 'en-US');
    assert.equal(en.keywords, 3);
    const status = Object.fromEntries(
      en.fit.keywords.map((k: { term: string; status: string }) => [k.term, k.status]),
    );
    assert.deepEqual(status, {
      'water reminder': 'strong',
      hydration: 'covered',
      'bedtime notes': 'missing',
    });
    assert.equal(en.fit.gaps[0].term, 'bedtime notes');
    assert.ok(en.fit.keywordField.bytes > 0);
    assert.deepEqual(fit.body.indexedFields.slice().sort(), ['keywords', 'subtitle', 'title']);
    assert.ok(fit.body.assumptions.length > 0);
    const de = fit.body.locales.find((l: { locale: string }) => l.locale.startsWith('de'));
    assert.equal(de.listingLocale, null, 'no German listing is stored');
    assert.equal(de.fit, null);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/fit?locale=en-US`)).body.locales.length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/fit?locale=%25%25`)).status,
      400,
    );

    t.sources.setApp(
      'ios',
      'us',
      publicApp('601', { name: 'Sleep Tracker Pro', description: 'Sleep tracker for nights.' }),
    );
    t.sources.setApp(
      'ios',
      'us',
      publicApp('602', { name: 'Sleep Tracker Lite', description: 'Sleep tracker, lite.' }),
    );
    t.sources.setApp(
      'ios',
      'us',
      publicApp('702', { name: 'Rival Seven Two', description: 'Bedtime notes for you.' }),
    );
    for (const id of ['601', '602', '702'])
      assert.equal(
        (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: id }))
          .status,
        201,
      );

    const ideas = await t.call(t.owner, 'GET', `/apps/${appId}/aso/ideas?locale=en-US`);
    assert.equal(ideas.status, 200, ideas.text);
    assert.deepEqual(ideas.body.basedOn, { ownListing: true, competitors: 3 });
    const idea = ideas.body.ideas.find((i: { term: string }) => i.term === 'sleep tracker');
    assert.ok(idea, JSON.stringify(ideas.body.ideas));
    assert.ok(idea.occurrences >= 2 && idea.sources >= 2 && idea.localScore > 0);
    assert.equal(
      ideas.body.ideas.some((i: { term: string }) => i.term === 'water reminder'),
      false,
      'tracked terms are not suggested',
    );
    assert.match(ideas.body.notes[0], /not a search volume/i);
    assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/aso/ideas?limit=0`)).status, 400);

    const gaps = await t.call(t.owner, 'GET', `/apps/${appId}/aso/gaps?locale=en-US`);
    assert.equal(gaps.status, 200);
    const terms = gaps.body.gaps.map((g: { term: string }) => g.term);
    assert.ok(terms.includes('sleep tracker'), terms.join());
    assert.ok(terms.includes('bedtime notes'), terms.join());
    assert.equal(gaps.body.competitors, 3);

    // Suggestions: from the stored top results of the newest check of each keyword.
    t.sources.names.set('701', 'Rival Seven One');
    t.sources.setResults('ios', 'us', 'water reminder', ['701', '702', OWN_IOS_ID, '703']);
    t.sources.setResults('ios', 'us', 'hydration', ['701', '703', '702']);
    t.sources.setResults('ios', 'us', 'bedtime notes', ['704']);
    assert.equal((await t.refresh(appId, '?scope=keywords')).status, 200);
    const sug = await t.call(t.owner, 'GET', `/apps/${appId}/aso/suggestions`);
    assert.equal(sug.status, 200, sug.text);
    const byId = Object.fromEntries(
      sug.body.suggestions.map((s: { externalId: string }) => [s.externalId, s]),
    );
    assert.ok(byId['701'] && byId['703'], 'two apps appear for two keywords');
    assert.equal(byId['702'], undefined, 'already followed');
    assert.equal(byId[OWN_IOS_ID], undefined, 'not the own app');
    assert.equal(byId['704'], undefined, 'one keyword only');
    assert.equal(byId['701'].name, 'Rival Seven One');
    assert.equal(byId['701'].country, 'us');
    assert.equal(byId['701'].keywordCount, 2);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/suggestions?minKeywords=3`)).body
        .suggestions.length,
      0,
    );

    const markets = await t.call(t.owner, 'GET', `/apps/${appId}/aso/markets`);
    const water = markets.body.terms.find((m: { key: string }) => m.key === 'water reminder');
    assert.deepEqual(water.markets.map((m: { country: string }) => m.country).sort(), ['de', 'us']);
    assert.equal(water.bestRank, 3);

    const before = calls();
    for (const path of ['fit', 'ideas', 'gaps', 'suggestions', 'markets', 'summary'])
      assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/aso/${path}`)).status, 200, path);
    assert.equal(calls(), before, 'the views read the database only');
  },
);

dbTest(
  'coach: ranked next steps from what is stored, and the fit view carries the listing text',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    const empty = await t.call(t.owner, 'GET', `/apps/${appId}/aso/coach`);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(
      empty.body.actions.map((a: { kind: string }) => a.kind),
      ['track_keywords'],
    );
    assert.deepEqual(empty.body.actions[0].link, { to: 'keywords_add', label: 'Add keywords' });
    assert.equal(empty.body.basedOn.keywords, 0);

    await seedListing(db, t.workspaceId, appId, 'en-US', {
      name: 'Hydro Buddy',
      subtitle: 'Water reminder',
      keywords: 'hydration, drink log',
    });
    await t.addKeywords(appId, [{ term: 'water reminder' }, { term: 'bedtime notes' }]);
    const unchecked = await t.call(t.owner, 'GET', `/apps/${appId}/aso/coach`);
    assert.equal(unchecked.body.actions[0].kind, 'check_ranks', 'nothing was checked yet');

    t.sources.setApp('ios', 'us', publicApp('701', { name: 'Rival Seven One' }));
    assert.equal(
      (await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '701' }))
        .status,
      201,
    );
    t.sources.setResults('ios', 'us', 'water reminder', ['701', OWN_IOS_ID]);
    t.sources.setResults('ios', 'us', 'bedtime notes', ['701', '702']);
    assert.equal((await t.refresh(appId, '?scope=keywords')).status, 200);

    const before = t.sources.searches.length + t.sources.lookups.length;
    const coach = await t.call(t.owner, 'GET', `/apps/${appId}/aso/coach`);
    assert.equal(coach.status, 200, coach.text);
    assert.equal(
      t.sources.searches.length + t.sources.lookups.length,
      before,
      'the coach reads the database only',
    );
    const kinds = coach.body.actions.map((a: { kind: string }) => a.kind);
    assert.equal(kinds.includes('check_ranks'), false);
    assert.ok(kinds.indexOf('not_in_listing') < kinds.indexOf('competitor_above'), kinds.join());
    const missing = coach.body.actions.find((a: { kind: string }) => a.kind === 'not_in_listing');
    assert.deepEqual(missing.items, ['bedtime notes (en-US)']);
    assert.deepEqual(missing.link, {
      to: 'listing',
      locale: 'en-US',
      label: 'Open en-US in the listing',
    });
    const above = coach.body.actions.find((a: { kind: string }) => a.kind === 'competitor_above');
    assert.deepEqual(above.items.slice().sort(), [
      'Rival Seven One is 1 for bedtime notes; you are not in the results',
      'Rival Seven One is 1 for water reminder; you are 2',
    ]);
    assert.deepEqual(
      coach.body.actions.map((a: { position: number }) => a.position),
      coach.body.actions.map((_: unknown, i: number) => i + 1),
    );
    assert.equal(coach.body.basedOn.competitors, 1);

    const fit = await t.call(t.owner, 'GET', `/apps/${appId}/aso/fit?locale=en-US`);
    assert.deepEqual(fit.body.locales[0].fields, {
      title: 'Hydro Buddy',
      subtitle: 'Water reminder',
      keywords: 'hydration, drink log',
    });

    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/coach`)).status, 200);
    assert.equal((await t.call(t.owner, 'GET', `/apps/nope/aso/coach`)).status, 404);
  },
);

dbTest(
  'listing keywords: the stored text of every locale, read from the database only, and a coach step for set keywords that are not tracked',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    const none = await t.call(t.owner, 'GET', `/apps/${appId}/aso/listing-keywords`);
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.body.locales, []);

    await seedListing(db, t.workspaceId, appId, 'en-US', {
      name: 'Hydro Buddy',
      subtitle: 'Water reminder',
      keywords: 'hydration, drink log',
      description: 'A long text the store does not search.',
    });
    await seedListing(db, t.workspaceId, appId, 'de-DE', {
      name: 'Wasser Buddy',
      keywords: 'trinken',
    });
    const calls = () => t.sources.searches.length + t.sources.lookups.length;
    const before = calls();
    const res = await t.call(t.owner, 'GET', `/apps/${appId}/aso/listing-keywords`);
    assert.equal(res.status, 200, res.text);
    assert.equal(calls(), before, 'the view reads the database only');
    assert.deepEqual(
      res.body.locales.map((l: { locale: string }) => l.locale),
      ['de-DE', 'en-US'],
    );
    const en = res.body.locales.find((l: { locale: string }) => l.locale === 'en-US');
    assert.deepEqual(
      en.fields,
      { title: 'Hydro Buddy', subtitle: 'Water reminder', keywords: 'hydration, drink log' },
      'no description for the App Store',
    );
    assert.deepEqual(res.body.indexedFields, ['title', 'subtitle', 'keywords']);

    await t.addKeywords(appId, [{ term: 'hydration' }]);
    const coach = await t.call(t.owner, 'GET', `/apps/${appId}/aso/coach`);
    const step = coach.body.actions.find(
      (a: { kind: string }) => a.kind === 'untracked_set_keywords',
    );
    assert.equal(step.title, '2 set keywords are not tracked');
    assert.deepEqual(step.items.slice().sort(), ['de-DE (DE): trinken', 'en-US (US): drink log']);
    assert.deepEqual(step.link, {
      to: 'listing_keywords',
      locale: step.link.locale,
      label: 'See them in the listing',
    });
    assert.ok(['en-US', 'de-DE'].includes(step.link.locale));

    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/listing-keywords`)).status, 200);
    assert.equal((await t.call(t.owner, 'GET', `/apps/nope/aso/listing-keywords`)).status, 404);
  },
);

dbTest('deleting an app deletes what ASO holds for it', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  await t.addKeywords(appId, [{ term: 'k one' }]);
  t.sources.setResults('ios', 'us', 'k one', ids(5, 1));
  t.sources.setApp('ios', 'us', publicApp('555'));
  await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' });
  assert.equal((await t.refresh(appId)).status, 200);
  for (const table of [
    'aso_keywords',
    'aso_rank_checks',
    'aso_competitors',
    'aso_competitor_snapshots',
    'aso_app_state',
  ]) {
    assert.ok((await db.query(`SELECT 1 FROM ${table}`)).length > 0, `${table} has rows`);
  }
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  for (const table of [
    'aso_keywords',
    'aso_rank_checks',
    'aso_competitors',
    'aso_competitor_snapshots',
    'aso_app_state',
  ]) {
    assert.equal((await db.query(`SELECT 1 FROM ${table}`)).length, 0, `${table} is empty`);
  }
});
