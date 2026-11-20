import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const EAS_STATUS = 47;

/** The state of a user who ran the app before migration 47. */
async function upTo46(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < EAS_STATUS)) {
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
  'migration 47 adds the EAS build and submission snapshots; data of migrations 1 to 46 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === EAS_STATUS)?.id, EAS_STATUS);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo46(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === EAS_STATUS),
      [EAS_STATUS],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    const names = async (table: string) => (await tableColumns(db, table)).map((c) => c.name).sort();
    assert.deepEqual(await names('eas_builds'), [
      'app_build_version',
      'app_id',
      'app_identifier',
      'app_version',
      'build_id',
      'build_profile',
      'channel',
      'completed_at',
      'created_at',
      'distribution',
      'error_code',
      'error_message',
      'expires_at',
      'fetched_at',
      'git_commit_hash',
      'git_commit_message',
      'has_artifact',
      'platform',
      'raw_status',
      'runtime_version',
      'sdk_version',
      'simulator',
      'status',
      'updated_at',
      'workspace_id',
    ]);
    assert.deepEqual(await names('eas_submissions'), [
      'app_id',
      'build_id',
      'completed_at',
      'created_at',
      'error_code',
      'error_message',
      'fetched_at',
      'platform',
      'raw_status',
      'release_status',
      'status',
      'submission_id',
      'target_identifier',
      'track',
      'workspace_id',
    ]);
    assert.deepEqual(await names('eas_status_sync'), [
      'app_id',
      'backoff_until',
      'builds_truncated',
      'consecutive_failures',
      'credential_id',
      'last_attempt_at',
      'last_error',
      'last_success_at',
      'project_id',
      'submissions_truncated',
      'workspace_id',
    ]);
    for (const [table, index] of [
      ['eas_builds', 'eas_builds_app_idx'],
      ['eas_builds', 'eas_builds_workspace_idx'],
      ['eas_submissions', 'eas_submissions_app_idx'],
      ['eas_submissions', 'eas_submissions_workspace_idx'],
      ['eas_status_sync', 'eas_status_sync_workspace_idx'],
    ] as const) {
      assert.ok((await tableIndexes(db, table)).includes(index), index);
    }

    // One row per build of an app; the workspace must exist; the defaults hold.
    const insert = (appId: string, buildId: string, workspaceId = 'w1') =>
      db.execute(
        `INSERT INTO eas_builds (app_id, build_id, workspace_id, platform, status, fetched_at) VALUES (?, ?, ?, 'ios', 'finished', 5)`,
        [appId, buildId, workspaceId],
      );
    await insert('a1', 'b1');
    await insert('a2', 'b1');
    await assert.rejects(() => insert('a1', 'b1'), 'app_id and build_id are the primary key');
    await assert.rejects(() => insert('a3', 'b1', 'nope'), 'the workspace must exist');
    const [row] = await db.query('SELECT has_artifact FROM eas_builds WHERE app_id = ?', ['a1']);
    assert.equal(Number(row?.has_artifact), 0);
    await db.execute(
      "INSERT INTO eas_status_sync (app_id, workspace_id) VALUES ('a1', 'w1')",
    );
    const [sync] = await db.query('SELECT consecutive_failures FROM eas_status_sync WHERE app_id = ?', ['a1']);
    assert.equal(Number(sync?.consecutive_failures), 0);

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
