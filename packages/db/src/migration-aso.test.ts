import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const ASO = 25;

/** The state of a user who ran the app before migration 25, with data in older tables. */
async function upTo24(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ASO)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        1,
      ]);
    });
  }
}

dbTest('migration 25 adds the ASO tables; data of migrations 1 to 24 is untouched', async (db) => {
  assert.equal(migrations[ASO - 1]?.id, ASO, 'ids are contiguous');
  await upTo24(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'submit', 'unknown', 'u1', 30)`,
  );

  const applied = await migrate(db);
  assert.deepEqual(
    applied.filter((id) => id === ASO),
    [ASO],
  );
  assert.equal(
    String((await db.query('SELECT status FROM store_submit_claims'))[0]?.status),
    'unknown',
  );
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

  assert.deepEqual(
    (await tableColumns(db, 'aso_keywords')).map((c) => c.name),
    [
      'app_id',
      'country',
      'created_at',
      'created_by',
      'id',
      'last_checked_at',
      'last_error',
      'last_rank_pos',
      'last_state',
      'last_total',
      'locale',
      'notes',
      'platform',
      'prev_rank_pos',
      'prev_state',
      'priority',
      'tag',
      'term',
      'term_key',
      'updated_at',
      'workspace_id',
    ],
  );
  assert.deepEqual(
    (await tableColumns(db, 'aso_rank_checks')).map((c) => c.name),
    [
      'app_id',
      'checked_at',
      'id',
      'keyword_id',
      'rank_pos',
      'source',
      'top_results',
      'total',
      'workspace_id',
    ],
  );
  assert.deepEqual(
    (await tableColumns(db, 'aso_competitors')).map((c) => c.name),
    [
      'added_at',
      'added_by',
      'app_id',
      'country',
      'external_id',
      'id',
      'last_checked_at',
      'last_error',
      'last_state',
      'listing_state',
      'name',
      'reviews_checked_at',
      'store',
      'workspace_id',
    ],
  );
  assert.deepEqual(
    (await tableColumns(db, 'aso_competitor_snapshots')).map((c) => c.name),
    [
      'app_id',
      'changes',
      'checked_at',
      'competitor_id',
      'currency',
      'description_excerpt',
      'description_hash',
      'id',
      'kind',
      'media_hash',
      'price',
      'rating_count',
      'rating_milli',
      'screenshot_count',
      'subtitle',
      'text_hash',
      'title',
      'version',
      'workspace_id',
    ],
  );
  assert.deepEqual(
    (await tableColumns(db, 'aso_app_state')).map((c) => c.name),
    [
      'app_id',
      'backoff_until',
      'claimed_at',
      'claimed_by',
      'consecutive_failures',
      'last_attempt_at',
      'last_error',
      'last_result',
      'last_success_at',
      'workspace_id',
    ],
  );
  for (const [table, index] of [
    ['aso_keywords', 'aso_keywords_unique_idx'],
    ['aso_keywords', 'aso_keywords_workspace_idx'],
    ['aso_rank_checks', 'aso_rank_checks_keyword_idx'],
    ['aso_competitors', 'aso_competitors_unique_idx'],
    ['aso_competitor_snapshots', 'aso_competitor_snapshots_competitor_idx'],
    ['aso_app_state', 'aso_app_state_workspace_idx'],
  ] as const) {
    assert.ok((await tableIndexes(db, table)).includes(index), `${index} on ${table}`);
  }

  const keyword = (
    id: string,
    over: { country?: string; locale?: string; key?: string; workspace?: string } = {},
  ) =>
    db.execute(
      `INSERT INTO aso_keywords (id, workspace_id, app_id, platform, country, locale, term, term_key, created_by, created_at, updated_at)
       VALUES (?, ?, 'a1', 'ios', ?, ?, 'Habit Tracker', ?, 'u1', 5, 5)`,
      [
        id,
        over.workspace ?? 'w1',
        over.country ?? 'us',
        over.locale ?? 'en-US',
        over.key ?? 'habit tracker',
      ],
    );
  await keyword('k1');
  const [row] = await db.query(
    'SELECT priority, last_state, last_rank_pos FROM aso_keywords WHERE id = ?',
    ['k1'],
  );
  assert.equal(Number(row?.priority), 2, 'priority defaults to normal');
  assert.equal(row?.last_state, null);
  // One keyword per app, storefront, locale and normalized term; the same term in another market is fine.
  await assert.rejects(keyword('k2'));
  await keyword('k3', { country: 'de', locale: 'de-DE' });
  await keyword('k4', { locale: 'en-GB' });
  await assert.rejects(keyword('k5', { key: 'x', workspace: 'missing' }));

  // A rank check may have no rank (not in the results); it belongs to its keyword and goes with it.
  const check = (id: string, rank: number | null) =>
    db.execute(
      `INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, rank_pos, total, source, top_results)
       VALUES (?, 'w1', 'k1', 'a1', 10, ?, 50, 'apple_search', '[{"id":"1","name":"One"}]')`,
      [id, rank],
    );
  await check('c1', 7);
  await check('c2', null);
  assert.equal(
    (await db.query('SELECT rank_pos FROM aso_rank_checks WHERE id = ?', ['c2']))[0]?.rank_pos,
    null,
  );
  await assert.rejects(
    db.execute(
      `INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, total, source) VALUES ('c3', 'w1', 'nope', 'a1', 1, 1, 'apple_search')`,
    ),
  );
  await db.execute("DELETE FROM aso_keywords WHERE id = 'k1'");
  assert.equal(
    (await db.query('SELECT id FROM aso_rank_checks')).length,
    0,
    'deleting a keyword deletes its checks',
  );

  const competitor = (id: string, externalId: string, country = 'us') =>
    db.execute(
      `INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at)
       VALUES (?, 'w1', 'a1', 'app_store', ?, ?, 'Rival', 'u1', 5)`,
      [id, externalId, country],
    );
  await competitor('r1', '1500000002');
  await assert.rejects(competitor('r2', '1500000002'));
  await competitor('r3', '1500000002', 'de');
  await db.execute(
    `INSERT INTO aso_competitor_snapshots (id, workspace_id, competitor_id, app_id, checked_at, kind, text_hash, rating_milli, changes)
     VALUES ('s1', 'w1', 'r1', 'a1', 10, 'first', ?, 4500, NULL)`,
    ['a'.repeat(64)],
  );
  assert.equal(
    Number((await db.query('SELECT rating_milli FROM aso_competitor_snapshots'))[0]?.rating_milli),
    4500,
  );
  await db.execute("DELETE FROM aso_competitors WHERE id = 'r1'");
  assert.equal(
    (await db.query('SELECT id FROM aso_competitor_snapshots')).length,
    0,
    'deleting a competitor deletes its snapshots',
  );

  await db.execute("INSERT INTO aso_app_state (app_id, workspace_id) VALUES ('a1', 'w1')");
  const [state] = await db.query('SELECT consecutive_failures, claimed_at FROM aso_app_state');
  assert.equal(Number(state?.consecutive_failures), 0);
  assert.equal(state?.claimed_at, null);
  await assert.rejects(
    db.execute("INSERT INTO aso_app_state (app_id, workspace_id) VALUES ('a1', 'w1')"),
    'one state row per app',
  );
});

dbTest('migration 25 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
