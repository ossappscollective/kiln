import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 70;

/** The state of a user who ran the app before migration 70. */
async function upTo69(db: Database) {
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
  'migration 70: the build numbers read from CI artifacts, one row per app and artifact',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    assert.ok(migrations.length >= ID);
    await upTo69(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    assert.deepEqual(
      (await migrate(db)).filter((id) => id >= ID),
      [70],
    );
    const cols = (await tableColumns(db, 'ci_artifact_meta')).map((c) => c.name);
    for (const name of [
      'app_id',
      'artifact_id',
      'workspace_id',
      'status',
      'build_number',
      'version',
      'package_id',
      'format',
      'read_at',
    ])
      assert.ok(cols.includes(name), name);

    await db.execute(
      "INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, build_number, version, package_id, format, read_at) VALUES ('a1', '9', 'w1', 'read', '167', '1.26.2', 'com.acme.app', 'apk', 5)",
    );
    await db.execute(
      "INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, read_at) VALUES ('a1', '10', 'w1', 'unreadable', 6)",
    );
    const rows = await db.query(
      'SELECT artifact_id, status, build_number, format FROM ci_artifact_meta WHERE app_id = ? ORDER BY artifact_id',
      ['a1'],
    );
    assert.deepEqual(
      rows.map((r) => [r.artifact_id, r.status, r.build_number, r.format]),
      [
        ['10', 'unreadable', null, null],
        ['9', 'read', '167', 'apk'],
      ],
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, read_at) VALUES ('a1', '9', 'w1', 'read', 7)",
      ),
      'one row per app and artifact',
    );
    // The same artifact id of another app is another row.
    await db.execute(
      "INSERT INTO ci_artifact_meta (app_id, artifact_id, workspace_id, status, read_at) VALUES ('a2', '9', 'w1', 'unreadable', 7)",
    );
    assert.deepEqual(await migrate(db), []);
  },
);
