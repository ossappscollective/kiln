import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { dbTest } from '@mrm/db/testing';
import { zip } from '../../../packages/connectors/src/play-search-terms.fixtures.ts';
import { type AnalyticsBoot, bootAnalytics } from './modules/analytics/test-helpers.ts';
import { createTestLimiter } from './services/credential-tests.ts';

// Everything here runs against fakes: no store is contacted. The terms are invented.

const enc = (text: string) => new TextEncoder().encode(text);
const csv = (rows: string[][]) => `${rows.map((r) => r.join(',')).join('\n')}\n`;
const HEADER = [
  'Date',
  'Package name',
  'Traffic source',
  'Search term',
  'Store listing acquisitions',
  'Store listing visitors',
  'Store listing conversion rate',
];

/** Two days of terms; `bump` changes one number (a corrected file). */
const termsCsv = (t: AnalyticsBoot, bump = 0) =>
  csv([
    HEADER,
    [
      t.day(5),
      'com.acme.app1',
      'Google Play search',
      'coffee timer',
      String(5 + bump),
      '40',
      '0.125',
    ],
    [t.day(5), 'com.acme.app1', 'Google Play search', 'brew guide', '2', '30', '0.0667'],
    [t.day(5), 'com.acme.app1', 'Google Play search', 'Other', '3', '90', '0.0333'],
    [t.day(5), 'com.acme.app1', 'Google Play explore', '', '4', '70', '0.057'],
    [t.day(4), 'com.acme.app1', 'Google Play search', 'coffee timer', '6', '44', '0.136'],
    [t.day(4), 'com.acme.app1', 'Google Play search', 'espresso app', '0', '12', '0'],
  ]);

const path = (appId: string, kind: 'preview' | 'import', query = '') =>
  `/apps/${appId}/analytics/search-terms/import${kind === 'preview' ? '/preview' : ''}${query}`;
const imp = (appId: string, hash: string, query = '') =>
  path(appId, 'import', `?confirmHash=${hash}${query}`);
const total = async (t: AnalyticsBoot) =>
  Number((await t.rows('SELECT COUNT(*) AS n FROM play_search_terms'))[0]?.n);

async function seedListing(
  t: AnalyticsBoot,
  appId: string,
  fields: Record<string, string>,
  locale = 'en-US',
) {
  let n = 0;
  for (const [field, value] of Object.entries(fields)) {
    n += 1;
    await t.db.execute(
      `INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, source_ref, observed_at)
       VALUES (?, ?, ?, 'android', ?, ?, 'live', ?, ?, 'store', '1.0', ?)`,
      [
        `snap-${locale}-${field}`,
        t.workspaceId,
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
  'importing needs analytics.manage; every role reads; outsiders see nothing; an iOS app has no search terms',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const ios = await t.addApp('ios');
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    const admin = await t.addMember('admin');
    const file = enc(termsCsv(t));
    for (const cookie of [viewer, member]) {
      assert.equal((await t.upload(cookie, path(appId, 'preview'), file)).status, 403);
      assert.equal((await t.upload(cookie, imp(appId, 'a'.repeat(64)), file)).status, 403);
    }
    for (const cookie of [viewer, member, admin, t.owner])
      assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/aso/search-terms`)).status, 200);
    assert.equal((await t.call('', 'GET', `/apps/${appId}/aso/search-terms`)).status, 401);
    assert.equal((await t.upload(admin, path(appId, 'preview'), file)).status, 200);
    assert.equal((await t.upload(t.owner, path('missing', 'preview'), file)).status, 404);

    const refused = await t.upload(t.owner, path(ios, 'preview'), file);
    assert.deepEqual([refused.status, refused.body.error], [422, 'import_not_supported']);
    const read = await t.call(t.owner, 'GET', `/apps/${ios}/aso/search-terms`);
    assert.deepEqual([read.status, read.body.error], [422, 'not_google_play_app']);
    assert.equal(await total(t), 0);
  },
);

dbTest(
  'a token imports only when it names analytics.manage; an app restricted token stays inside its apps',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const a1 = await t.addApp('android');
    const a2 = await t.addApp('android');
    const file = enc(termsCsv(t));
    const plain = await t.makeToken({ role: 'admin' });
    assert.equal((await t.bearer(plain, 'POST', path(a1, 'preview'), file)).status, 403);
    assert.equal(
      (await t.bearer(plain, 'GET', `/apps/${a1}/aso/search-terms`)).status,
      200,
      'reading is a default token right',
    );
    const restricted = await t.makeToken({
      role: 'admin',
      actions: ['analytics.manage', 'aso.read'],
      appIds: [a1],
    });
    assert.equal((await t.bearer(restricted, 'POST', path(a1, 'preview'), file)).status, 200);
    assert.equal((await t.bearer(restricted, 'POST', path(a2, 'preview'), file)).status, 404);
    assert.equal((await t.bearer(restricted, 'GET', `/apps/${a2}/aso/search-terms`)).status, 404);
    assert.equal(
      (await t.bearer(restricted, 'GET', `/apps/${a2}/aso/rank-vs-downloads`)).status,
      404,
    );
  },
);

dbTest(
  'preview stores nothing; the confirm needs the previewed file; the same file again writes nothing; a correction replaces',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const file = enc(termsCsv(t));
    const shown = await t.upload(t.owner, path(appId, 'preview'), file);
    assert.equal(shown.status, 200, shown.text);
    assert.match(shown.body.confirmHash, /^[0-9a-f]{64}$/);
    const plan = shown.body.plan;
    assert.deepEqual(
      [plan.report.kind, plan.platform, plan.hasDates, plan.rows, plan.terms, plan.days],
      ['play_search_terms', 'android', true, 5, 3, 2],
    );
    assert.deepEqual([plan.dateFrom, plan.dateTo], [t.day(5), t.day(4)]);
    assert.deepEqual(plan.stats, {
      rowsRead: 6,
      rowsUsed: 5,
      rowsUnreadable: 0,
      rowsFiltered: 1,
      rowsOther: 1,
    });
    assert.deepEqual(plan.totals, { visitors: 216, installs: 16 });
    assert.deepEqual(plan.other, { visitors: 90, installs: 3 });
    assert.equal(plan.top[0].term, 'coffee timer');
    assert.deepEqual([plan.top[0].visitors, plan.top[0].installs], [84, 11]);
    assert.equal(await total(t), 0, 'a preview stores nothing');

    assert.equal(
      (await t.upload(t.owner, path(appId, 'import', '?confirmHash=nope'), file)).status,
      400,
    );
    const other = await t.upload(t.owner, imp(appId, shown.body.confirmHash), enc(termsCsv(t, 1)));
    assert.deepEqual([other.status, other.body.error], [409, 'confirm_mismatch']);
    assert.equal(await total(t), 0);

    const done = await t.upload(t.owner, imp(appId, shown.body.confirmHash), file);
    assert.equal(done.status, 201, done.text);
    assert.deepEqual(done.body.imported, {
      rows: 5,
      written: 5,
      unchanged: 0,
      dateFrom: t.day(5),
      dateTo: t.day(4),
    });
    assert.equal(await total(t), 5);
    const state = (
      await t.rows('SELECT imports, last_period_from, last_period_to FROM play_search_term_imports')
    )[0];
    assert.deepEqual([Number(state?.imports), String(state?.last_period_from)], [1, t.day(5)]);

    const again = await t.upload(t.owner, imp(appId, shown.body.confirmHash), file);
    assert.equal(again.status, 201);
    assert.deepEqual(
      [again.body.imported.written, again.body.imported.unchanged],
      [0, 5],
      'the same file twice stores nothing new',
    );
    assert.equal(
      Number((await t.rows('SELECT imports FROM play_search_term_imports'))[0]?.imports),
      2,
    );

    const fixed = enc(termsCsv(t, 1));
    const p2 = await t.upload(t.owner, path(appId, 'preview'), fixed);
    assert.notEqual(p2.body.confirmHash, shown.body.confirmHash, 'the hash covers the numbers');
    const c2 = await t.upload(t.owner, imp(appId, p2.body.confirmHash), fixed);
    assert.deepEqual([c2.body.imported.written, c2.body.imported.unchanged], [1, 4]);
    assert.equal(await total(t), 5);
    assert.equal(
      Number(
        (
          await t.rows(
            "SELECT installs FROM play_search_terms WHERE term_key = 'coffee timer' AND period_from = ?",
            [t.day(5)],
          )
        )[0]?.installs,
      ),
      6,
    );
    // The Other line is a row of its own with no term.
    const other2 = (
      await t.rows("SELECT term, visitors, installs FROM play_search_terms WHERE term_key = ''")
    )[0];
    assert.deepEqual(
      [String(other2?.term), Number(other2?.visitors), Number(other2?.installs)],
      ['', 90, 3],
    );
  },
);

dbTest(
  'the audit trail, the events and the jobs hold counts and ids, never a term, a row or the file name',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const file = enc(termsCsv(t));
    const shown = await t.upload(
      t.owner,
      path(appId, 'preview', '?fileName=secret-name.csv'),
      file,
    );
    await t.upload(t.owner, imp(appId, shown.body.confirmHash, '&fileName=secret-name.csv'), file);
    const audit = (await t.auditActions()).filter(
      (a) => a.action === 'analytics.search_terms_import',
    );
    assert.equal(audit.length, 1);
    const detail = JSON.parse(audit[0]?.detail ?? '{}');
    assert.deepEqual(Object.keys(detail).sort(), [
      'countries',
      'dateFrom',
      'dateTo',
      'files',
      'rows',
      'terms',
      'written',
    ]);
    assert.deepEqual([detail.rows, detail.written, detail.terms], [5, 5, 3]);
    const everything = JSON.stringify({
      audit: await db.query('SELECT action, target_type, target_id, detail FROM audit_events'),
      events: await db.query('SELECT type, payload FROM events'),
      jobs: await db.query('SELECT queue, payload FROM jobs'),
      runs: await db.query('SELECT * FROM analytics_sync_runs'),
    });
    for (const word of ['coffee', 'brew', 'espresso', 'secret-name'])
      assert.ok(!everything.includes(word), word);
    // Errors carry a fixed sentence, not the file's text.
    const bad = await t.upload(
      t.owner,
      path(appId, 'preview'),
      enc(
        csv([
          ['Date', 'coffee column'],
          ['2026-01-01', 'brew'],
        ]),
      ),
    );
    assert.equal(bad.status, 422);
    assert.ok(!bad.text.includes('coffee') && !bad.text.includes('brew'));
  },
);

dbTest(
  'a file with no date column needs the period; zip and gzip and UTF-16 are read; bad files are fixed codes',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const undated = enc(
      csv([
        ['Search term', 'Country/region', 'Store listing visitors', 'Store listing acquisitions'],
        ['coffee timer', 'US', '120', '15'],
        ['coffee timer', 'DE', '30', '2'],
      ]),
    );
    const missing = await t.upload(t.owner, path(appId, 'preview'), undated);
    assert.deepEqual([missing.status, missing.body.error], [422, 'period_required']);
    const half = await t.upload(t.owner, path(appId, 'preview', `?from=${t.day(30)}`), undated);
    assert.equal(half.status, 400, 'from without to');
    const backwards = await t.upload(
      t.owner,
      path(appId, 'preview', `?from=${t.day(1)}&to=${t.day(30)}`),
      undated,
    );
    assert.deepEqual([backwards.status, backwards.body.error], [422, 'period_required']);
    const q = `?from=${t.day(30)}&to=${t.day(3)}`;
    const shown = await t.upload(t.owner, path(appId, 'preview', q), undated);
    assert.equal(shown.status, 200, shown.text);
    assert.deepEqual(
      [shown.body.plan.hasDates, shown.body.plan.period, shown.body.plan.countries],
      [false, { from: t.day(30), to: t.day(3) }, ['de', 'us']],
    );
    assert.equal(
      (await t.upload(t.owner, imp(appId, shown.body.confirmHash, q.replace('?', '&')), undated))
        .status,
      201,
    );
    assert.equal(
      (await t.upload(t.owner, imp(appId, shown.body.confirmHash), undated)).body.error,
      'period_required',
      'the period is part of the file: it must be sent again',
    );

    const plain = termsCsv(t);
    const viaZip = await t.upload(
      t.owner,
      path(appId, 'preview'),
      zip([
        { name: 'store_performance_com.acme.app1_202611_traffic_source.csv', data: enc(plain) },
      ]),
    );
    assert.equal(viaZip.status, 200, viaZip.text);
    assert.equal(viaZip.body.plan.rows, 5);
    const viaGz = await t.upload(
      t.owner,
      path(appId, 'preview'),
      new Uint8Array(gzipSync(Buffer.from(plain))),
    );
    assert.equal(viaGz.status, 200);
    assert.equal(
      viaGz.body.confirmHash,
      viaZip.body.confirmHash,
      'one table, one hash, whatever it was packed in',
    );

    const code = async (body: Uint8Array) =>
      (await t.upload(t.owner, path(appId, 'preview'), body)).body.error;
    assert.equal(
      await code(
        enc(
          csv([
            ['Date', 'Counts'],
            ['2026-01-01', '1'],
          ]),
        ),
      ),
      'missing_columns',
    );
    assert.equal(await code(enc(csv([HEADER]))), 'no_rows');
    assert.equal(await code(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), 'bad_zip');
    assert.equal(await code(new Uint8Array([0x1f, 0x8b, 1, 2])), 'bad_gzip');
    assert.equal((await t.upload(t.owner, path(appId, 'preview'), '')).status, 400);
    const huge = await t.upload(
      t.owner,
      path(appId, 'preview'),
      new Uint8Array(10 * 1024 * 1024 + 2048),
    );
    assert.equal(huge.status, 413);
  },
);

dbTest(
  'the top terms of a period: sums, order, tracked keywords, listing text, hints, countries, freshness',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    await t.upload(
      t.owner,
      imp(
        appId,
        (await t.upload(t.owner, path(appId, 'preview'), enc(termsCsv(t)))).body.confirmHash,
      ),
      enc(termsCsv(t)),
    );
    const empty = await t.call(
      t.owner,
      'GET',
      `/apps/${await t.addApp('android')}/aso/search-terms`,
    );
    assert.deepEqual([empty.body.imported, empty.body.stored, empty.body.terms], [null, null, []]);

    await seedListing(t, appId, {
      title: 'Coffee Timer: brew',
      short_description: 'A simple timer',
      full_description: 'Time every cup.',
    });
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
      keywords: [
        { term: 'coffee timer', country: 'us', locale: 'en-US' },
        { term: 'brew guide', country: 'de', locale: 'en-US' },
      ],
    });

    const res = await t.call(t.owner, 'GET', `/apps/${appId}/aso/search-terms`);
    assert.equal(res.status, 200, res.text);
    const v = res.body;
    assert.deepEqual(
      [v.from, v.to, v.sort, v.locale, v.listingLocale],
      [t.day(5), t.day(4), 'installs', 'en-US', 'en-US'],
    );
    assert.deepEqual(v.stored, { from: t.day(5), to: t.day(4), countries: [], rows: 5 });
    assert.equal(v.imported.imports, 1);
    assert.equal(typeof v.imported.at, 'number');
    assert.deepEqual(
      v.terms.map((x: { term: string }) => x.term),
      ['coffee timer', 'brew guide', 'espresso app'],
    );
    const [coffee, brew, espresso] = v.terms;
    assert.deepEqual([coffee.visitors, coffee.installs, coffee.conversion], [84, 11, 11 / 84]);
    assert.equal(coffee.trackedKeywordId !== null, true);
    assert.deepEqual(coffee.trackedCountries, ['us']);
    assert.equal(coffee.listing, 'in_listing');
    assert.equal(coffee.hint, null);
    assert.equal(brew.listing, 'partly', 'brew is in the title, guide is not');
    assert.equal(brew.hint, 'add_to_listing');
    assert.deepEqual(brew.trackedCountries, ['de']);
    assert.equal(espresso.listing, 'not_in_listing');
    assert.equal(espresso.hint, null, 'no installs, no hint');
    assert.deepEqual(v.other, { visitors: 90, installs: 3 });
    assert.deepEqual(v.totals, { visitors: 216, installs: 16 });
    assert.ok(v.notes.some((n: { code: string }) => n.code === 'not_search_volume'));
    assert.ok(v.notes.some((n: { code: string }) => n.code === 'other_grouped'));
    assert.ok(!v.notes.some((n: { code: string }) => n.code === 'no_listing_text'));

    // Sort, limit, a shorter period, and a language with no stored text.
    const byVisitors = (
      await t.call(t.owner, 'GET', `/apps/${appId}/aso/search-terms?sort=visitors&limit=1`)
    ).body;
    assert.deepEqual(
      byVisitors.terms.map((x: { term: string }) => x.term),
      ['coffee timer'],
    );
    assert.equal(byVisitors.termCount, 3);
    const oneDay = (
      await t.call(
        t.owner,
        'GET',
        `/apps/${appId}/aso/search-terms?from=${t.day(4)}&to=${t.day(4)}`,
      )
    ).body;
    assert.deepEqual(
      oneDay.terms.map((x: { term: string }) => x.term),
      ['coffee timer', 'espresso app'],
    );
    assert.deepEqual(oneDay.terms[0].installs, 6);
    const german = (await t.call(t.owner, 'GET', `/apps/${appId}/aso/search-terms?locale=de-DE`))
      .body;
    assert.equal(german.listingLocale, null);
    assert.ok(german.terms.every((x: { listing: string }) => x.listing === 'unknown'));
    assert.ok(german.notes.some((n: { code: string }) => n.code === 'no_listing_text'));

    for (const query of [
      'from=2026-13-01',
      'country=usa',
      'sort=name',
      'limit=0',
      'limit=500',
      `from=${t.day(1)}&to=${t.day(9)}`,
      'locale=x',
      'to=soon',
    ]) {
      assert.equal(
        (await t.call(t.owner, 'GET', `/apps/${appId}/aso/search-terms?${query}`)).status,
        400,
        query,
      );
    }
  },
);

dbTest(
  'terms of a file with countries: a country view leaves out rows with no country; a period file is not counted next to day rows',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const send = async (body: string, query = '') => {
      const f = enc(body);
      const shown = await t.upload(t.owner, path(appId, 'preview', query), f);
      assert.equal(shown.status, 200, shown.text);
      const done = await t.upload(
        t.owner,
        imp(appId, shown.body.confirmHash, query.replace('?', '&')),
        f,
      );
      assert.equal(done.status, 201, done.text);
      return done.body.imported;
    };
    await send(
      csv([
        ['Search term', 'Country/region', 'Store listing visitors', 'Store listing acquisitions'],
        ['coffee timer', 'US', '100', '10'],
        ['coffee timer', 'DE', '50', '2'],
        ['brew guide', 'US', '10', '1'],
      ]),
      `?from=${t.day(30)}&to=${t.day(10)}`,
    );
    await send(
      csv([
        ['Date', 'Search term', 'Store listing visitors', 'Store listing acquisitions'],
        [t.day(20), 'coffee timer', '1', '1'],
      ]),
    );
    const view = (
      await t.call(
        t.owner,
        'GET',
        `/apps/${appId}/aso/search-terms?from=${t.day(40)}&to=${t.day(1)}`,
      )
    ).body;
    assert.deepEqual(view.stored.countries, ['de', 'us']);
    assert.deepEqual(
      view.terms.find((x: { term: string }) => x.term === 'coffee timer').visitors,
      151,
      'the day row has no country and the period rows have one: all three are counted',
    );
    const us = (
      await t.call(
        t.owner,
        'GET',
        `/apps/${appId}/aso/search-terms?country=us&from=${t.day(40)}&to=${t.day(1)}`,
      )
    ).body;
    assert.deepEqual(
      us.terms.map((x: { term: string; visitors: number }) => [x.term, x.visitors]),
      [
        ['coffee timer', 100],
        ['brew guide', 10],
      ],
    );
    assert.equal(us.country, 'us');
    const noEcho = await t.call(t.owner, 'GET', `/apps/${appId}/aso/search-terms?country=fr`);
    assert.deepEqual(noEcho.body.terms, []);
  },
);

dbTest('deleting the app deletes its search terms', async (db) => {
  const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
  const appId = await t.addApp('android');
  const f = enc(termsCsv(t));
  await t.upload(
    t.owner,
    imp(appId, (await t.upload(t.owner, path(appId, 'preview'), f)).body.confirmHash),
    f,
  );
  assert.equal(await total(t), 5);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  assert.equal(await total(t), 0);
  assert.equal(
    Number((await t.rows('SELECT COUNT(*) AS n FROM play_search_term_imports'))[0]?.n),
    0,
  );
});

// Rank versus downloads: the same database, no store.

const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);

async function track(t: AnalyticsBoot, appId: string, terms: string[], country = 'us') {
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/aso/keywords`, {
    keywords: terms.map((term) => ({ term, country, locale: 'en-US' })),
  });
  assert.equal(res.status, 201, res.text);
  const rows = await t.rows('SELECT id, term FROM aso_keywords WHERE app_id = ?', [appId]);
  return new Map(rows.map((r) => [String(r.term), String(r.id)]));
}

/** One check per day for the days from `first` to `last` (days ago); the rank is given by day ago. */
async function seedChecks(
  t: AnalyticsBoot,
  appId: string,
  keywordId: string,
  first: number,
  last: number,
  rank: (ago: number) => number | null,
) {
  for (let ago = first; ago >= last; ago--) {
    const at = rank(ago);
    await t.db.execute(
      `INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, rank_pos, total, source) VALUES (?, ?, ?, ?, ?, ?, 50, 'play_public')`,
      [`chk-${keywordId}-${ago}`, t.workspaceId, keywordId, appId, noon(t.day(ago)), at],
    );
  }
}

async function seedDownloads(
  t: AnalyticsBoot,
  appId: string,
  platform: 'android' | 'ios',
  metric: string,
  first: number,
  last: number,
  value: (ago: number) => number,
) {
  const source = platform === 'android' ? 'play_reports' : 'apple_analytics';
  for (let ago = first; ago >= last; ago--) {
    await t.db.execute(
      `INSERT INTO analytics_daily (app_id, platform, source, metric, day, dim_type, dim_value, workspace_id, value_micro, processing_date, origin, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, 'sync', 1)`,
      [
        appId,
        platform,
        source,
        metric,
        t.day(ago),
        t.workspaceId,
        value(ago) * 1_000_000,
        t.day(0),
      ],
    );
  }
}

const rvd = (t: AnalyticsBoot, appId: string, query = '', cookie = t.owner) =>
  t.call(cookie, 'GET', `/apps/${appId}/aso/rank-vs-downloads${query}`);

dbTest(
  'rank versus downloads: the query is checked, every role reads, an unknown keyword or another platform is refused',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const viewer = await t.addMember('viewer');
    const ids = await track(t, appId, ['coffee timer']);
    assert.equal((await rvd(t, appId, '', viewer)).status, 200);
    assert.equal((await rvd(t, appId, '', '')).status, 401);
    assert.equal((await rvd(t, 'missing')).status, 404);
    for (const q of [
      'platform=ios',
      'country=usa',
      'keywords=nope',
      `keywords=${ids.get('coffee timer')},x`,
      `from=${t.day(1)}&to=${t.day(5)}`,
      'from=soon',
      'to=2026-02-30',
      'from=2020-01-01&to=2026-01-01',
      'keywords=a,b,c,d,e,f,g,h,i',
    ]) {
      assert.equal((await rvd(t, appId, `?${q}`)).status, 400, q);
    }
    const ok = await rvd(
      t,
      appId,
      `?platform=android&country=US&keywords=${ids.get('coffee timer')}`,
    );
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(
      [ok.body.platform, ok.body.country, ok.body.selected],
      ['android', 'us', [ids.get('coffee timer')]],
    );
  },
);

dbTest(
  'rank versus downloads: says plainly what is missing before it draws anything',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    const none = await rvd(t, appId);
    assert.equal(none.body.enough, false);
    assert.deepEqual([none.body.keywords, none.body.available, none.body.country], [[], [], null]);

    const ids = await track(t, appId, ['coffee timer']);
    const id = ids.get('coffee timer') as string;
    assert.equal(
      (await rvd(t, appId)).body.missing,
      'turn_on_analytics',
      'the missing downloads are said first',
    );
    await t.enable();
    assert.equal((await rvd(t, appId)).body.missing, 'no_downloads');
    await seedDownloads(t, appId, 'android', 'installs_user', 30, 1, () => 10);
    assert.equal((await rvd(t, appId)).body.missing, 'no_rank_checks');
    await db.execute('DELETE FROM analytics_daily');
    await seedChecks(t, appId, id, 30, 1, () => 12);
    const on = (await rvd(t, appId)).body;
    assert.deepEqual([on.enough, on.missing, on.downloads], [false, 'no_downloads', null]);
    assert.deepEqual(on.coverage, { rankDays: 30, downloadDays: 0, minDays: 14 });
    assert.ok(
      (await rvd(t, appId)).body.notes.some(
        (n: { code: string }) => n.code === 'correlation_not_proof',
      ),
    );
  },
);

dbTest(
  'rank versus downloads: aligned days, a marker at the big move, and the week before against the week after',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    await t.enable();
    const ids = await track(t, appId, ['coffee timer', 'brew guide', 'unchecked words']);
    const coffee = ids.get('coffee timer') as string;
    const brew = ids.get('brew guide') as string;
    await seedChecks(t, appId, coffee, 40, 1, (ago) => (ago >= 20 ? 30 : 5));
    await seedChecks(t, appId, brew, 40, 1, () => 8);
    await seedDownloads(t, appId, 'android', 'installs_user', 40, 1, (ago) =>
      ago >= 19 ? 10 : 20,
    );

    const res = await rvd(t, appId, `?from=${t.day(40)}&to=${t.day(1)}`);
    assert.equal(res.status, 200, res.text);
    const v = res.body;
    assert.deepEqual(
      [v.from, v.to, v.days.length, v.days[0], v.days[39]],
      [t.day(40), t.day(1), 40, t.day(40), t.day(1)],
    );
    assert.equal(v.country, 'us');
    assert.deepEqual(
      v.available.map((k: { term: string; checks: number }) => [k.term, k.checks]),
      [
        ['brew guide', 40],
        ['coffee timer', 40],
        ['unchecked words', 0],
      ],
    );
    assert.deepEqual(
      v.selected.sort(),
      [brew, coffee].sort(),
      'by default the checked keywords, not the empty one',
    );
    assert.equal(v.downloads.metric, 'installs_user');
    assert.deepEqual(
      [
        v.downloads.source,
        v.downloads.delayDays,
        v.downloads.values.length,
        v.downloads.values[0],
        v.downloads.values[39],
      ],
      ['play', 7, 40, 10, 20],
    );
    assert.equal(v.downloads.settledThrough, t.day(7));
    assert.deepEqual(v.coverage, { rankDays: 40, downloadDays: 40, minDays: 14 });
    assert.equal(v.enough, true);
    assert.equal(v.missing, null);
    assert.equal(v.threshold, 5, 'the rank move threshold setting is the default');

    assert.equal(v.markers.length, 1);
    const marker = v.markers[0];
    assert.deepEqual(
      [marker.keywordId, marker.day, marker.previousDay, marker.from, marker.to, marker.delta],
      [coffee, t.day(19), t.day(20), 30, 5, 25],
    );
    assert.equal(v.comparisons.length, 1);
    const c = v.comparisons[0];
    assert.equal(c.status, 'ok');
    assert.deepEqual(
      [c.before.days, c.before.perDay, c.after.days, c.after.perDay, c.changePercent],
      [7, 10, 7, 20, 100],
    );
    assert.deepEqual(
      [c.before.from, c.before.to, c.after.from, c.after.to],
      [t.day(26), t.day(20), t.day(18), t.day(12)],
    );
    assert.ok(
      v.notes.some(
        (n: { code: string; message: string }) =>
          n.code === 'correlation_not_proof' && /correlation/i.test(n.message),
      ),
    );
    assert.ok(v.notes.some((n: { code: string }) => n.code === 'downloads_delay'));

    // Chosen keywords narrow the view; a lower threshold in the settings finds a smaller move.
    const only = (await rvd(t, appId, `?from=${t.day(40)}&to=${t.day(1)}&keywords=${brew}`)).body;
    assert.deepEqual([only.selected, only.markers, only.comparisons], [[brew], [], []]);
    // No second store is asked: nothing here touched a connector.
    assert.deepEqual(t.built, []);
  },
);

dbTest(
  'rank versus downloads: a move too near today waits for settled days; fewer than 14 days hides the comparison',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('android');
    await t.enable();
    const ids = await track(t, appId, ['coffee timer']);
    const id = ids.get('coffee timer') as string;
    await seedChecks(t, appId, id, 30, 1, (ago) => (ago >= 5 ? 30 : 4));
    await seedDownloads(t, appId, 'android', 'installs_user', 30, 1, () => 10);
    const near = (await rvd(t, appId)).body;
    assert.equal(near.enough, true);
    assert.equal(near.markers.length, 1);
    assert.equal(near.comparisons[0].status, 'waiting');
    assert.equal(near.comparisons[0].changePercent, null);
    assert.ok(typeof near.comparisons[0].settledNeededThrough === 'string');

    const short = (await rvd(t, appId, `?from=${t.day(9)}&to=${t.day(1)}`)).body;
    assert.equal(short.enough, false);
    assert.equal(short.missing, null, 'there is data, only too little of it');
    assert.deepEqual(short.coverage, { rankDays: 9, downloadDays: 9, minDays: 14 });
    assert.deepEqual(short.comparisons, []);
  },
);

dbTest(
  'rank versus downloads: iOS reads first-time downloads, else units, and says which; another storefront is its own view',
  async (db) => {
    const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 10_000 }) });
    const appId = await t.addApp('ios');
    await t.enable();
    const us = await track(t, appId, ['coffee timer'], 'us');
    await track(t, appId, ['kaffee timer', 'kaffee uhr'], 'de');
    await seedChecks(t, appId, us.get('coffee timer') as string, 30, 1, () => 3);
    await seedDownloads(t, appId, 'ios', 'sales_units', 30, 1, () => 9);
    const units = (await rvd(t, appId, '?country=us')).body;
    assert.equal(units.downloads.metric, 'sales_units');
    assert.match(units.downloads.label, /not first-time/);
    await seedDownloads(t, appId, 'ios', 'downloads_first_time', 30, 1, () => 7);
    const first = (await rvd(t, appId, '?country=us')).body;
    assert.deepEqual(
      [first.downloads.metric, first.downloads.delayDays, first.downloads.values[89]],
      ['downloads_first_time', 2, 7],
    );
    assert.deepEqual(
      first.available.map((k: { term: string }) => k.term),
      ['coffee timer'],
    );
    assert.deepEqual(first.countries, ['de', 'us']);
    const busiest = (await rvd(t, appId)).body;
    assert.equal(
      busiest.country,
      'de',
      'with no storefront the one with the most tracked keywords',
    );
    assert.deepEqual(busiest.selected, [], 'its keywords have no checks');
    assert.equal(busiest.missing, 'no_rank_checks');
  },
);
