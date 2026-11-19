import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const SEARCH_TERMS = 32;

/** The state of a user who ran the app before migration 32. */
async function upTo31(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < SEARCH_TERMS)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}

const names = async (db: Database, table: string) => (await tableColumns(db, table)).map((c) => c.name);

dbTest('migration 32 adds the search term tables; data of migrations 1 to 31 is untouched', async (db) => {
  assert.equal(migrations[SEARCH_TERMS - 1]?.id, SEARCH_TERMS, 'ids are contiguous');
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo31(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO analytics_daily (app_id, platform, source, metric, day, workspace_id, value_micro, updated_at)
     VALUES ('a1', 'ios', 'apple_analytics', 'downloads_first_time', '2026-11-01', 'w1', 5, 5)`,
  );

  const applied = await migrate(db);
  assert.deepEqual(applied.filter((id) => id === SEARCH_TERMS), [SEARCH_TERMS]);
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM analytics_daily'))[0]?.n), 1);

  assert.deepEqual(await names(db, 'play_search_terms'), [
    'app_id', 'conversion_micro', 'country', 'imported_at', 'installs', 'period_from', 'period_to', 'term', 'term_key', 'visitors', 'workspace_id',
  ]);
  assert.deepEqual(await names(db, 'play_search_term_imports'), [
    'app_id', 'imports', 'last_import_at', 'last_period_from', 'last_period_to', 'updated_by', 'workspace_id',
  ]);
  assert.ok((await tableIndexes(db, 'play_search_terms')).includes('play_search_terms_workspace_idx'));
  assert.ok((await tableIndexes(db, 'play_search_term_imports')).includes('play_search_term_imports_workspace_idx'));
});

dbTest('play_search_terms: one row per app, country, period and term; null is not zero; a missing workspace is refused', async (db) => {
  await migrate(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  const insert = `INSERT INTO play_search_terms (app_id, country, period_from, period_to, term_key, workspace_id, term, visitors, installs, imported_at)
                  VALUES ('a1', ?, '2026-11-01', '2026-11-01', ?, ?, 'Coffee Timer', ?, ?, 5)`;
  await db.execute(insert, ['us', 'coffee timer', 'w1', 12_000_000_000, null]);
  const row = (await db.query('SELECT visitors, installs, conversion_micro, term FROM play_search_terms'))[0];
  assert.equal(Number(row?.visitors), 12_000_000_000, 'above 32 bits');
  assert.equal(row?.installs, null, 'a missing column stays null');
  assert.equal(row?.conversion_micro, null);
  await assert.rejects(db.execute(insert, ['us', 'coffee timer', 'w1', 1, 1]), 'the same key twice is a conflict');
  await db.execute(insert, ['de', 'coffee timer', 'w1', 1, 1]);
  await db.execute(insert, ['us', '', 'w1', 1, 1]);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM play_search_terms'))[0]?.n), 3, 'a country and the Other line are separate rows');
  await assert.rejects(db.execute(insert, ['fr', 'x term', 'missing', 1, 1]), 'a workspace that does not exist cannot hold terms');
});

dbTest('migration 32 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
