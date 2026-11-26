import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 73;

/** The state of a user who ran the app before migration 73, with a row of migration 70 already read. */
async function upTo72(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ID)) {
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
  'migration 73: the date and the run of a CI artifact, kept next to what was read',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    assert.ok(migrations.length >= ID);
    await upTo72(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    await db.execute(
      "INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, build_number, version, package_id, format, read_at) VALUES ('a1', '9', 'w1', 'read', '90', '2.00.1', 'com.acme.app', 'aab', 5)",
    );
    assert.deepEqual(
      (await migrate(db)).filter((id) => id === ID),
      [73],
    );
    const cols = (await tableColumns(db, 'ci_artifact_meta')).map((c) => c.name);
    for (const name of [
      'artifact_name',
      'artifact_created_at',
      'artifact_expires_at',
      'run_id',
      'run_number',
      'branch',
      'head_sha',
      'run_url',
    ])
      assert.ok(cols.includes(name), name);
    // A row read before the migration keeps what it had; the new columns are empty until the artifact is seen again.
    const [old] = await db.query(
      'SELECT build_number, version, artifact_created_at, run_id, run_number FROM ci_artifact_meta WHERE artifact_id = ?',
      ['9'],
    );
    assert.equal(old?.build_number, '90');
    assert.equal(old?.version, '2.00.1');
    assert.equal(old?.artifact_created_at, null);
    assert.equal(old?.run_id, null);
    await db.execute(
      "UPDATE ci_artifact_meta SET artifact_created_at = 1764000000000, run_number = 41, run_id = '77', branch = 'main', head_sha = 'abc1234', run_url = 'https://github.com/o/r/actions/runs/77', artifact_name = 'app-aab' WHERE artifact_id = '9'",
    );
    const [row] = await db.query(
      'SELECT artifact_created_at, run_number, branch FROM ci_artifact_meta WHERE artifact_id = ?',
      ['9'],
    );
    assert.equal(Number(row?.artifact_created_at), 1764000000000);
    assert.equal(Number(row?.run_number), 41);
    assert.equal(row?.branch, 'main');
    assert.deepEqual(await migrate(db), []);
  },
);
