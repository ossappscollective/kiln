import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

const SETTINGS = 20;

dbTest(
  'migration 20 adds settings, review translations and translation usage and keeps existing data',
  async (db) => {
    assert.ok(
      migrations.some((m) => m.id === SETTINGS),
      'the migration exists',
    );
    const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
    );
    for (const migration of migrations.filter((m) => m.id < SETTINGS)) {
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
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w2', 'Other', 1)");

    const applied = await migrate(db);
    assert.ok(applied.includes(SETTINGS));
    assert.equal(
      (await db.query('SELECT id FROM workspaces')).length,
      2,
      'existing data is untouched',
    );

    // Settings: one row per workspace and key.
    const setting = (workspace: string, key: string) =>
      db.execute(
        'INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)',
        [workspace, key, '2', 5, 'u1'],
      );
    await setting('w1', 'reviews.lowRatingThreshold');
    await assert.rejects(setting('w1', 'reviews.lowRatingThreshold'));
    await setting('w2', 'reviews.lowRatingThreshold');
    await assert.rejects(
      setting('nobody', 'reviews.lowRatingThreshold'),
      'the workspace must exist',
    );

    // A translation is unique per review, field, target, provider and source text.
    const translation = (id: string, hash: string) =>
      db.execute(
        `INSERT INTO review_translations
         (id, workspace_id, app_id, review_id, field, target_lang, provider, source_hash, translated_text, detected_source, created_at)
       VALUES (?, 'w1', 'a1', 'r1', 'body', 'en', 'google', ?, 'Nice', NULL, 7)`,
        [id, hash],
      );
    await translation('t1', 'h1');
    await assert.rejects(translation('t2', 'h1'));
    await translation('t3', 'h2');
    const [row] = await db.query(
      'SELECT detected_source, created_at FROM review_translations WHERE id = ?',
      ['t1'],
    );
    assert.equal(row?.detected_source, null);
    assert.equal(Number(row?.created_at), 7);

    // Usage: one row per workspace and day, counting from zero.
    await db.execute(
      "INSERT INTO translation_usage (workspace_id, day) VALUES ('w1', '2026-11-18')",
    );
    await assert.rejects(
      db.execute("INSERT INTO translation_usage (workspace_id, day) VALUES ('w1', '2026-11-18')"),
    );
    const [usage] = await db.query("SELECT chars FROM translation_usage WHERE workspace_id = 'w1'");
    assert.equal(Number(usage?.chars), 0);
  },
);
