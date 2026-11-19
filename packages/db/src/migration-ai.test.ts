import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const AI = 30;

/** The state of a user who ran the app before migration 30, with data in older tables. */
async function upTo29(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < AI)) {
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
  'migration 30 adds the AI usage and suggestion tables; rows of migrations 1 to 29 are untouched',
  async (db) => {
    assert.equal(migrations[AI - 1]?.id, AI, 'ids are contiguous');
    await upTo29(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'publish', 'u1', 30)`,
    );
    await db.execute(
      `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at, updated_by) VALUES ('w1', 'translation.enabled', 'true', 1, 'u1')`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === AI),
      [AI],
    );
    assert.equal(
      String((await db.query('SELECT status FROM store_publish_claims'))[0]?.status),
      'writing',
    );
    assert.equal(
      String((await db.query('SELECT value_json FROM workspace_settings'))[0]?.value_json),
      'true',
    );

    assert.deepEqual(
      (await tableColumns(db, 'ai_usage')).map((c) => c.name),
      [
        'app_id',
        'created_at',
        'created_by',
        'error_code',
        'finished_at',
        'id',
        'input_tokens',
        'model',
        'output_tokens',
        'provider',
        'reserved_tokens',
        'status',
        'task',
        'task_version',
        'workspace_id',
      ],
    );
    assert.deepEqual(
      (await tableColumns(db, 'ai_suggestions')).map((c) => c.name),
      [
        'accepted',
        'app_id',
        'created_at',
        'created_by',
        'decided_at',
        'decided_by',
        'id',
        'input_hash',
        'input_tokens',
        'kind',
        'model',
        'output_tokens',
        'proposal',
        'provider',
        'scope',
        'status',
        'task',
        'task_version',
        'workspace_id',
      ],
    );
    assert.ok((await tableIndexes(db, 'ai_usage')).includes('ai_usage_workspace_idx'));
    assert.ok((await tableIndexes(db, 'ai_suggestions')).includes('ai_suggestions_app_idx'));

    // No column of either table is a place for prompts or model text: usage has counts only.
    const usageColumns = (await tableColumns(db, 'ai_usage')).map((c) => c.name);
    for (const name of usageColumns)
      assert.ok(!/prompt|text|output$|message|body/.test(name.replace('output_tokens', '')), name);

    await db.execute(
      `INSERT INTO ai_usage (id, workspace_id, task, task_version, provider, model, created_by, created_at)
     VALUES ('u1', 'w1', 'keyword_ideas', 1, 'anthropic', 'm', 'user', 5)`,
    );
    const row = (
      await db.query('SELECT status, reserved_tokens, input_tokens, output_tokens FROM ai_usage')
    )[0];
    assert.equal(String(row?.status), 'reserved');
    assert.equal(Number(row?.reserved_tokens), 0);
    await assert.rejects(
      db.execute(
        `INSERT INTO ai_usage (id, workspace_id, task, task_version, provider, model, created_by, created_at)
       VALUES ('u2', 'missing', 'keyword_ideas', 1, 'anthropic', 'm', 'user', 5)`,
      ),
      'a workspace that does not exist cannot hold usage',
    );
    await db.execute(
      `INSERT INTO ai_suggestions (id, workspace_id, app_id, task, task_version, kind, provider, model, scope, proposal, input_hash, created_by, created_at)
     VALUES ('s1', 'w1', 'a1', 'keyword_ideas', 1, 'keywords', 'anthropic', 'm', '{}', '{}', 'h', 'user', 5)`,
    );
    assert.equal(
      String((await db.query('SELECT status FROM ai_suggestions'))[0]?.status),
      'proposed',
    );
  },
);

dbTest('migration 30 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
