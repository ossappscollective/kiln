import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const ID = 72;

/** The state of a user who ran the app before migration 72. */
async function upTo71(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ID)) {
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

dbTest('migration 72: the last batch publishes of an app, one row per run', async (db) => {
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  assert.ok(migrations.length >= ID);
  await upTo71(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
  assert.deepEqual(
    (await migrate(db)).filter((id) => id === ID),
    [72],
  );
  const cols = (await tableColumns(db, 'store_publish_runs')).map((c) => c.name);
  for (const name of [
    'id',
    'workspace_id',
    'app_id',
    'platform',
    'started_at',
    'finished_at',
    'outcome',
    'steps',
    'results',
    'by_user',
    'dismissed_at',
    'dismissed_by',
  ])
    assert.ok(cols.includes(name), name);
  assert.ok((await tableIndexes(db, 'store_publish_runs')).includes('store_publish_runs_app_idx'));
  await db.execute(
    `INSERT INTO store_publish_runs (id, workspace_id, app_id, platform, started_at, finished_at, outcome, steps, results)
     VALUES ('r1', 'w1', 'a1', 'android', 5, 9, 'failed', '["push_draft"]', '[]')`,
  );
  const [row] = await db.query('SELECT outcome, by_user, dismissed_at FROM store_publish_runs');
  assert.equal(row?.outcome, 'failed');
  assert.equal(row?.by_user, null);
  assert.equal(row?.dismissed_at, null);
});
