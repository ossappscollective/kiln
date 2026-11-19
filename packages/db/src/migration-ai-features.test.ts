import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const CONTEXT = 40;
const CLASSES = 41;

/** The state of a user who ran the app before migration 40. */
async function upTo39(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < CONTEXT)) {
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

dbTest(
  'migrations 40 and 41 add the AI app context and the review classifications; older rows are untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === CONTEXT)?.id, CONTEXT);
    assert.equal(migrations.find((m) => m.id === CLASSES)?.id, CLASSES);
    await upTo39(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES ('w1', 'ai.enabled', 'true', 1, 'u1')`,
    );
    await db.execute(
      `INSERT INTO ai_usage (id, workspace_id, task, task_version, provider, model, created_by, created_at) VALUES ('r1', 'w1', 'keyword_ideas', 1, 'anthropic', 'm', 'u1', 5)`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === CONTEXT || id === CLASSES),
      [CONTEXT, CLASSES],
    );
    assert.equal(
      String((await db.query('SELECT value_json FROM workspace_settings'))[0]?.value_json),
      'true',
    );
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM ai_usage'))[0]?.n), 1);

    assert.deepEqual(
      (await tableColumns(db, 'ai_app_context')).map((c) => c.name),
      ['app_id', 'context', 'updated_at', 'updated_by', 'workspace_id'],
    );
    assert.ok((await tableIndexes(db, 'ai_app_context')).includes('ai_app_context_workspace_idx'));
    assert.deepEqual(
      (await tableColumns(db, 'review_classifications')).map((c) => c.name),
      [
        'app_id',
        'created_at',
        'language',
        'model',
        'needs_reply',
        'provider',
        'review_id',
        'sentiment',
        'severity',
        'task_version',
        'text_hash',
        'topics',
        'workspace_id',
      ],
    );
    assert.ok(
      (await tableIndexes(db, 'review_classifications')).includes('review_classifications_app_idx'),
    );

    await db.execute(
      `INSERT INTO ai_app_context (app_id, workspace_id, context, updated_by, updated_at) VALUES ('a1', 'w1', '{}', 'u1', 9)`,
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO ai_app_context (app_id, workspace_id, context, updated_by, updated_at) VALUES ('a1', 'w1', '{}', 'u1', 9)`,
      ),
      'one row per app',
    );
    await db.execute(
      `INSERT INTO review_classifications (review_id, workspace_id, app_id, task_version, text_hash, topics, sentiment, severity, language, needs_reply, provider, model, created_at)
     VALUES ('rv1', 'w1', 'a1', 1, 'abc', '["crash"]', 'negative', 'high', 'en', 1, 'anthropic', 'm', 9)`,
    );
    assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
  },
);
