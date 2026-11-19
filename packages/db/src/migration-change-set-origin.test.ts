import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

dbTest(
  'migration 17 adds origin_json to change_sets: old rows read NULL, new rows keep their JSON',
  async (db) => {
    const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
    );
    for (const migration of migrations.filter((m) => m.id <= 16)) {
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
    // A draft, a change set applied as a local commit and one that failed with a branch: all made before the column existed.
    for (const [id, status, outcome] of [
      ['cs1', 'draft', null],
      ['cs2', 'applied', '{"mode":"local_branch"}'],
      ['cs3', 'failed', null],
    ] as const) {
      await db.execute(
        `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, outcome_json, created_at, updated_at)
       VALUES (?, 'w1', 'r1', 'Update', ?, 'user', 'u1', '[]', ?, 6, 6)`,
        [id, status, outcome],
      );
    }

    const applied = await migrate(db);
    assert.ok(applied.includes(17), 'migration 17 was applied');

    const rows = await db.query(
      'SELECT id, status, outcome_json, origin_json FROM change_sets ORDER BY id',
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ['draft', 'applied', 'failed'],
    );
    assert.ok(
      rows.every((r) => r.origin_json === null),
      'an old row has no origin: it cannot be recomputed',
    );
    assert.equal(rows[1]?.outcome_json, '{"mode":"local_branch"}');

    const origin = JSON.stringify({ v: 1, source: 'store_pull', appId: 'a1', channel: 'live' });
    await db.execute('UPDATE change_sets SET origin_json = ? WHERE id = ?', [origin, 'cs1']);
    const [after] = await db.query('SELECT origin_json FROM change_sets WHERE id = ?', ['cs1']);
    assert.equal(after?.origin_json, origin);
  },
);
