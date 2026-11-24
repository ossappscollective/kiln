import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 67;

/** The state of a user who ran the app before migration 67. */
async function upTo66(db: Database) {
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

dbTest('migrations 67 to 69: the review policy and the competitor review schedule; a followed competitor keeps its row', async (db) => {
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo66(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
  await db.execute(
    "INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at) VALUES ('c1', 'w1', 'a1', 'app_store', '123', 'us', 'Rival', 'u', 1)",
  );
  assert.deepEqual((await migrate(db)).filter((id) => id >= 67), [67, 68, 69]);
  const cols = (await tableColumns(db, 'aso_competitors')).map((c) => c.name);
  for (const name of ['review_schedule', 'review_weekday', 'review_schedule_at', 'reviews_last_seen_id', 'reviews_new_count', 'reviews_failures', 'reviews_backoff_until', 'reviews_last_error', 'reviews_attempt_at'])
    assert.ok(cols.includes(name), name);
  const [row] = await db.query('SELECT name, review_schedule, reviews_new_count, reviews_failures FROM aso_competitors WHERE id = ?', ['c1']);
  assert.equal(row?.name, 'Rival');
  assert.equal(row?.review_schedule, null, 'follows the app');
  assert.equal(Number(row?.reviews_new_count), 0);
  assert.equal(Number(row?.reviews_failures), 0);

  await db.execute("INSERT INTO ai_app_review_policy (app_id, workspace_id, updated_by, updated_at) VALUES ('a1', 'w1', 'u', 1)");
  const [policy] = await db.query('SELECT own_reviews, competitor_reviews, detail, redact FROM ai_app_review_policy WHERE app_id = ?', ['a1']);
  assert.equal(policy?.own_reviews, null);
  assert.equal(policy?.detail, 'text');
  assert.equal(Number(policy?.redact), 1);
  await assert.rejects(db.execute("INSERT INTO ai_app_review_policy (app_id, workspace_id, updated_by, updated_at) VALUES ('a1', 'w1', 'u', 2)"), 'one row per app');

  await db.execute("INSERT INTO competitor_review_schedules (app_id, workspace_id, updated_by, updated_at) VALUES ('a1', 'w1', 'u', 1)");
  const [sched] = await db.query('SELECT mode, paused, max_competitors, max_reviews FROM competitor_review_schedules WHERE app_id = ?', ['a1']);
  assert.equal(sched?.mode, 'off');
  assert.equal(Number(sched?.paused), 0);
  assert.equal(Number(sched?.max_competitors), 5);
  assert.equal(Number(sched?.max_reviews), 20);
  assert.deepEqual(await migrate(db), []);
});

dbTest('migration 69 repairs a database that applied the first shape of migration 68 (no review_schedule_at)', async (db) => {
  await migrate(db);
  // The state such a database is in: 68 recorded, 69 not yet, and the column missing.
  await db.execute('ALTER TABLE aso_competitors DROP COLUMN review_schedule_at');
  await db.execute('DELETE FROM schema_migrations WHERE id = 69');
  const before = (await tableColumns(db, 'aso_competitors')).map((c) => c.name);
  assert.ok(!before.includes('review_schedule_at'));
  assert.deepEqual((await migrate(db)).filter((id) => id >= 67), [69]);
  const after = (await tableColumns(db, 'aso_competitors')).map((c) => c.name);
  assert.ok(after.includes('review_schedule_at'));
});
