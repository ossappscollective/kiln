import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 59;

/** The state of a user who ran the app before migration 59. */
async function upTo58(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ID)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}

dbTest('migration 59 adds the competitor reviews table and reviews_checked_at; a followed competitor keeps its row', async (db) => {
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo58(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
  await db.execute(
    "INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at) VALUES ('c1', 'w1', 'a1', 'app_store', '123', 'us', 'Rival', 'u', 1)",
  );
  assert.deepEqual((await migrate(db)).filter((id) => id === ID), [ID]);
  assert.ok((await tableColumns(db, 'aso_competitors')).map((c) => c.name).includes('reviews_checked_at'));
  const [row] = await db.query('SELECT name, reviews_checked_at FROM aso_competitors WHERE id = ?', ['c1']);
  assert.equal(row?.name, 'Rival');
  assert.equal(row?.reviews_checked_at, null);
  await db.execute(
    "INSERT INTO aso_competitor_reviews (id, workspace_id, competitor_id, app_id, country, store_review_id, rating, title, body, reviewed_at, fetched_at) VALUES ('r1', 'w1', 'c1', 'a1', 'us', 'x1', 5, 't', 'b', 1, 1)",
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO aso_competitor_reviews (id, workspace_id, competitor_id, app_id, country, store_review_id, rating, title, body, reviewed_at, fetched_at) VALUES ('r2', 'w1', 'c1', 'a1', 'us', 'x1', 4, 't', 'b', 1, 1)",
    ),
    'one row per competitor and feed id',
  );
  assert.deepEqual(await migrate(db), []);
});
