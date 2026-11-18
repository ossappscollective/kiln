import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

const REVIEWS = 19;

dbTest('migration 19 adds the reviews tables and keeps existing data', async (db) => {
  assert.ok(migrations.some((m) => m.id === REVIEWS), 'the migration exists');
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < REVIEWS)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
     VALUES ('a1', 'w1', 'Coffee', 'ios', 'com.acme.coffee', 'c1', 2)`,
  );

  const applied = await migrate(db);
  assert.ok(applied.includes(REVIEWS));
  assert.equal((await db.query('SELECT id FROM apps WHERE id = ?', ['a1'])).length, 1, 'existing data is untouched');

  const insert = (id: string, storeReviewId: string) =>
    db.execute(
      `INSERT INTO app_reviews
         (id, workspace_id, app_id, store, store_review_id, rating, body, created_at, updated_at, first_seen_at, fetched_at)
       VALUES (?, 'w1', 'a1', 'appstoreconnect', ?, 4, 'Nice', 10, 10, 20, 20)`,
      [id, storeReviewId],
    );
  await insert('r1', 'store-1');
  const [row] = await db.query(
    'SELECT status, assignee_user_id, internal_note, developer_response, low_rating_notified_at FROM app_reviews WHERE id = ?',
    ['r1'],
  );
  assert.equal(row?.status, 'new', 'a review starts as new');
  assert.equal(row?.assignee_user_id, null);
  assert.equal(row?.internal_note, null);
  assert.equal(row?.developer_response, null);
  assert.equal(row?.low_rating_notified_at, null);

  // The store's id is unique per app: the same review cannot be stored twice, another app can have it.
  await assert.rejects(insert('r2', 'store-1'));
  await db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
     VALUES ('a2', 'w1', 'Coffee Android', 'android', 'com.acme.coffee', 'c2', 2)`,
  );
  await db.execute(
    `INSERT INTO app_reviews
       (id, workspace_id, app_id, store, store_review_id, rating, body, created_at, updated_at, first_seen_at, fetched_at)
     VALUES ('r3', 'w1', 'a2', 'googleplay', 'store-1', 5, '', 10, 10, 20, 20)`,
  );

  // The sync state is one row per app and store.
  const state = () =>
    db.execute("INSERT INTO review_sync_state (app_id, store, workspace_id) VALUES ('a1', 'appstoreconnect', 'w1')");
  await state();
  await assert.rejects(state());
  const [sync] = await db.query('SELECT consecutive_failures, cursor, last_success_at FROM review_sync_state WHERE app_id = ?', ['a1']);
  assert.equal(Number(sync?.consecutive_failures), 0);
  assert.equal(sync?.cursor, null);
  assert.equal(sync?.last_success_at, null);

  await db.execute(
    `INSERT INTO app_rating_summaries (id, workspace_id, app_id, store, territory, average_milli, rating_count, observed_at)
     VALUES ('s1', 'w1', 'a1', 'appstoreconnect', 'US', 4523, 12873, 30)`,
  );
  const [summary] = await db.query('SELECT average_milli, current_count FROM app_rating_summaries WHERE id = ?', ['s1']);
  assert.equal(Number(summary?.average_milli), 4523);
  assert.equal(summary?.current_count, null);
});
