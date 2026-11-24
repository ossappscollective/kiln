import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootAso, OWN_IOS_ID, slowDown } from './test-helpers.ts';

/** The keyword estimates (docs/adr/0057-keyword-estimates.md). The store is a fake: nothing is contacted. */

type Boot = Awaited<ReturnType<typeof bootAso>>;
const est = async (t: Boot, appId: string) =>
  (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keyword-estimates`)).body;

async function setup(t: Boot, terms = ['water reminder']) {
  const appId = await t.addApp('ios');
  const ids = ['101', '102', '103', '104', '105', OWN_IOS_ID];
  for (const term of terms) {
    t.sources.setResults('ios', 'us', term, ids);
    t.sources.hintLists.set(`us|${term}`, [term, `${term} app`, `${term} tracker`]);
  }
  for (const [i, id] of ids.entries()) {
    t.sources.ratingCounts.set(id, 1000 * (i + 1));
    t.sources.names.set(id, i % 2 === 0 ? 'Water reminder pro' : 'Other');
  }
  assert.equal(
    (
      await t.addKeywords(
        appId,
        terms.map((term) => ({ term })),
      )
    ).status,
    201,
  );
  return appId;
}

dbTest(
  'a refresh stores the public signals once a day and the estimate shows its inputs, never a bare number',
  async (db) => {
    const t = await bootAso(db);
    const appId = await setup(t);
    assert.equal(
      (await est(t, appId)).estimates[0].estimate.popularity.score,
      null,
      'nothing read yet: no estimate, not 0',
    );
    const r = await t.refresh(appId);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.result.signals, { due: 1, checked: 1, failed: 0 });
    const body = await est(t, appId);
    assert.equal(body.model, 'v1');
    const e = body.estimates[0].estimate;
    assert.equal(e.popularity.origin, 'public_signals');
    assert.equal(e.popularity.confidence, 'medium');
    assert.deepEqual(
      e.popularity.reasons.map((x: { code: string }) => x.code),
      ['hints_position', 'results_demand'],
    );
    assert.ok(e.difficulty.score !== null && e.difficulty.reasons.length >= 2);
    assert.equal(e.difficulty.confidence, 'low', 'six rated apps: below the ten of a medium');
    assert.deepEqual(e.hints, ['water reminder', 'water reminder app', 'water reminder tracker']);
    assert.equal(e.top.length, 6);
    assert.ok(e.signalsAt > 0);
    assert.equal(t.sources.hintCalls.length, 1);
    await t.refresh(appId);
    assert.equal(
      t.sources.hintCalls.length,
      1,
      'the same term and storefront on the same day is read once',
    );
    const rows = await db.query('SELECT model, signals FROM aso_keyword_signals');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, 'v1');
    assert.ok(
      !String(rows[0]?.signals).includes('description'),
      'a compact row: ids, names and counts only',
    );

    const detail = (
      await t.call(
        t.owner,
        'GET',
        `/apps/${appId}/aso/keywords/${body.estimates[0].keywordId}/estimate`,
      )
    ).body;
    assert.equal(detail.trend.length, 1);
    assert.equal(detail.keyword.term, 'water reminder');
  },
);

dbTest(
  'at most N terms per refresh, a limit stops the hints without failing the refresh, a storefront without an id is not asked',
  async (db) => {
    const t = await bootAso(db, { limits: { maxSignalTerms: 2 } });
    const appId = await setup(t, ['aa one', 'bb two', 'cc three']);
    assert.equal((await t.addKeywords(appId, [{ term: 'zz', country: 'zz' }])).status, 201);
    const r = await t.refresh(appId);
    assert.equal(r.body.result.signals.checked, 2);
    assert.equal(t.sources.hintCalls.length, 2);
    assert.ok(!t.sources.hintCalls.some((c) => c.country === 'zz'));
    assert.equal(
      (await t.refresh(appId)).body.result.signals.checked,
      1,
      'the third on the next refresh (queued)',
    );
  },
);

dbTest('a rate limit on the hints is later, not a failed refresh', async (db) => {
  const t = await bootAso(db);
  const appId = await setup(t);
  t.sources.hintsError = slowDown(45, false);
  const r = await t.refresh(appId);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.deferred, true);
  assert.equal(r.body.result.stoppedBecause, 'rate_limit');
  assert.equal(r.body.result.retryAfterSeconds, 45);
  assert.equal(r.body.result.keywords.checked, 1, 'the rank check still happened');
  t.sources.hintsError = undefined;
  assert.equal((await t.refresh(appId)).body.result.signals.checked, 1);
});

dbTest(
  'suggestions are the stored hints minus what is tracked; reading needs aso.read; unknown ids are 404',
  async (db) => {
    const t = await bootAso(db);
    const appId = await setup(t);
    await t.refresh(appId);
    const viewer = await t.addMember('viewer');
    const s = await t.call(viewer, 'GET', `/apps/${appId}/aso/keyword-suggestions`);
    assert.equal(s.status, 200);
    assert.deepEqual(
      s.body.suggestions.map((x: { term: string }) => x.term),
      ['water reminder app', 'water reminder tracker'],
    );
    assert.deepEqual(s.body.suggestions[0].from, ['water reminder']);
    assert.equal(s.body.suggestions[0].locale, 'en-US');
    assert.equal((await t.addKeywords(appId, [{ term: 'water reminder app' }])).status, 201);
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keyword-suggestions?country=us`)).body
        .suggestions.length,
      1,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keyword-suggestions?country=USA`)).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords/nope/estimate`)).status,
      404,
    );
    assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/keyword-estimates`)).status, 200);
  },
);

dbTest(
  'Google Play: no estimate without the team’s own search terms, then one from them, labelled as own data',
  async (db) => {
    const t = await bootAso(db, { playEnabled: true });
    const appId = await t.addApp('android');
    t.sources.setResults('android', 'us', 'water reminder', ['x.y']);
    assert.equal((await t.addKeywords(appId, [{ term: 'water reminder' }])).status, 201);
    await t.refresh(appId);
    assert.equal(t.sources.hintCalls.length, 0, 'no hints for Google Play');
    assert.equal((await db.query('SELECT 1 FROM aso_keyword_signals')).length, 0);
    let e = (await est(t, appId)).estimates[0].estimate;
    assert.equal(e.popularity.score, null);
    assert.equal(e.popularity.reasons[0].code, 'play_needs_own_data');
    assert.equal(e.difficulty.reasons[0].code, 'play_no_competition_data');
    await db.execute(
      `INSERT INTO play_search_terms (app_id, country, period_from, period_to, term_key, workspace_id, term, visitors, installs, conversion_micro, imported_at)
     VALUES (?, '', '2026-05-01', '2026-05-30', 'water reminder', ?, 'water reminder', 400, 40, 100000, 1)`,
      [appId, t.workspaceId],
    );
    e = (await est(t, appId)).estimates[0].estimate;
    assert.equal(e.popularity.origin, 'own_data');
    assert.equal(e.popularity.reasons[0].code, 'own_visitors');
    assert.equal(e.popularity.reasons[0].params.days, 30);
    assert.equal(e.popularity.confidence, 'medium');
  },
);

dbTest('deleting the keyword prunes its signals on the next refresh', async (db) => {
  const t = await bootAso(db);
  const appId = await setup(t, ['one term', 'two term']);
  await t.refresh(appId);
  assert.equal((await db.query('SELECT 1 FROM aso_keyword_signals')).length, 2);
  const list = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/keywords`)).body.keywords;
  const gone = list.find((k: { term: string }) => k.term === 'two term');
  await t.call(t.owner, 'DELETE', `/apps/${appId}/aso/keywords/${gone.id}`);
  await t.refresh(appId);
  assert.deepEqual(
    (await db.query('SELECT term FROM aso_keyword_signals')).map((r) => r.term),
    ['one term'],
  );
});
