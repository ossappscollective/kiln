import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest, tableIndexes } from './testing.ts';

const REPLIES = 21;

dbTest(
  'migration 21 adds review reply drafts and templates, keeps reviews, and cascades',
  async (db) => {
    assert.ok(
      migrations.some((m) => m.id === REPLIES),
      'the migration exists',
    );
    const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
    );
    for (const migration of migrations.filter((m) => m.id < REPLIES)) {
      await db.transaction(async (tx) => {
        for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
        await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          1,
        ]);
      });
    }
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO app_reviews
       (id, workspace_id, app_id, store, store_review_id, rating, body, created_at, updated_at, first_seen_at, fetched_at)
     VALUES ('r1', 'w1', 'a1', 'googleplay', 'gp:1', 2, 'Bad', 10, 10, 20, 20)`,
    );

    const applied = await migrate(db);
    assert.ok(applied.includes(REPLIES));
    assert.equal(
      (await db.query('SELECT id FROM app_reviews WHERE id = ?', ['r1'])).length,
      1,
      'existing reviews are untouched',
    );

    const draft = (id: string, reviewId: string) =>
      db.execute(
        `INSERT INTO review_reply_drafts
         (id, workspace_id, app_id, review_id, store, text, text_hash, created_by, updated_by, created_at, updated_at)
       VALUES (?, 'w1', 'a1', ?, 'googleplay', 'Thanks', 'abc', 'u1', 'u1', 30, 30)`,
        [id, reviewId],
      );
    await draft('d1', 'r1');
    const [row] = await db.query(
      'SELECT status, error_code, evidence, sent_at, sent_by, claim_at, store_response_id FROM review_reply_drafts WHERE id = ?',
      ['d1'],
    );
    assert.equal(row?.status, 'draft', 'a reply starts as a draft');
    for (const column of [
      'error_code',
      'evidence',
      'sent_at',
      'sent_by',
      'claim_at',
      'store_response_id',
    ]) {
      assert.equal(row?.[column], null, column);
    }

    // One row per review; a review that does not exist cannot have a draft.
    await assert.rejects(draft('d2', 'r1'));
    await assert.rejects(draft('d3', 'missing'));

    // Deleting the review deletes its draft (retention pruning, deleting an app).
    await db.execute('DELETE FROM app_reviews WHERE id = ?', ['r1']);
    assert.equal(
      (await db.query('SELECT id FROM review_reply_drafts')).length,
      0,
      'no orphan draft',
    );

    await db.execute(
      `INSERT INTO review_reply_templates (id, workspace_id, name, body, created_by, created_at, updated_at)
     VALUES ('t1', 'w1', 'Thanks', 'Hi {{author}}', 'u1', 1, 1)`,
    );
    assert.equal(
      (await db.query('SELECT id FROM review_reply_templates WHERE workspace_id = ?', ['w1']))
        .length,
      1,
    );

    const indexes = await tableIndexes(db, 'app_reviews');
    for (const name of [
      'app_reviews_ws_created_idx',
      'app_reviews_ws_updated_idx',
      'app_reviews_ws_rating_idx',
    ]) {
      assert.ok(indexes.includes(name), `${name} exists`);
    }
  },
);
