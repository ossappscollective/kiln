import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

dbTest(
  'migration 14 adds outcome_json and publish_claim_at to change_sets and keeps existing rows',
  async (db) => {
    const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
    );
    for (const migration of migrations.filter((m) => m.id <= 13)) {
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
      "INSERT INTO credentials (id, workspace_id, kind, label, ciphertext, created_at) VALUES ('c1', 'w1', 'github_token', 'GitHub', 'x', 1)",
    );
    await db.execute(
      "INSERT INTO repositories (id, workspace_id, credential_id, owner, repo, default_branch, created_at) VALUES ('r1', 'w1', 'c1', 'acme', 'app', 'main', 2)",
    );
    await db.execute(
      `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, created_at, updated_at)
     VALUES ('cs1', 'w1', 'r1', 'Update', 'applied', 'user', 'u1', '[]', 6, 6)`,
    );

    const applied = await migrate(db);
    assert.ok(applied.includes(14), 'migration 14 was applied');

    const [row] = await db.query(
      'SELECT status, outcome_json, publish_claim_at FROM change_sets WHERE id = ?',
      ['cs1'],
    );
    assert.equal(row?.status, 'applied');
    assert.equal(row?.outcome_json, null);
    assert.equal(row?.publish_claim_at, null);

    await db.execute('UPDATE change_sets SET outcome_json = ?, publish_claim_at = ? WHERE id = ?', [
      '{"mode":"local_branch"}',
      123,
      'cs1',
    ]);
    const [after] = await db.query(
      'SELECT outcome_json, publish_claim_at FROM change_sets WHERE id = ?',
      ['cs1'],
    );
    assert.equal(after?.outcome_json, '{"mode":"local_branch"}');
    assert.equal(Number(after?.publish_claim_at), 123);
  },
);
