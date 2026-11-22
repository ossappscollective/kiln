import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const RATINGS = 56;

/** The state of a user who ran the app before migration 56. */
async function upTo55(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < RATINGS)) {
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

dbTest('migration 56 adds the ratings history; data of earlier migrations is untouched', async (db) => {
  assert.equal(migrations.find((m) => m.id === RATINGS)?.id, RATINGS);
  await upTo55(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

  const applied = await migrate(db);
  assert.deepEqual(
    applied.filter((id) => id === RATINGS),
    [RATINGS],
  );
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

  assert.deepEqual((await tableColumns(db, 'app_rating_days')).map((c) => c.name).sort(), [
    'app_id',
    'average_milli',
    'day',
    'observed_at',
    'rating_count',
    'star1',
    'star2',
    'star3',
    'star4',
    'star5',
    'store',
    'territory',
    'version',
    'workspace_id',
  ]);
  assert.ok((await tableIndexes(db, 'app_rating_days')).includes('app_rating_days_workspace_idx'));

  // One row per app, store, country and day.
  const insert = (average: number) =>
    db.execute(
      `INSERT INTO app_rating_days (workspace_id, app_id, store, territory, day, average_milli, rating_count, observed_at)
       VALUES ('w1', 'a1', 'appstoreconnect', 'US', '2026-11-20', ?, 10, 5)`,
      [average],
    );
  await insert(4500);
  await assert.rejects(insert(4400));
});
