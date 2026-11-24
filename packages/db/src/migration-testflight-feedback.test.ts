import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const TESTFLIGHT = 54;

/** The state of a user who ran the app before migration 54. */
async function upTo53(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < TESTFLIGHT)) {
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

const columns = async (db: Database, table: string) =>
  (await tableColumns(db, table)).map((c) => c.name).sort();

dbTest(
  'migration 54 adds the TestFlight feedback tables; data of migrations 1 to 53 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === TESTFLIGHT)?.id, TESTFLIGHT);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo53(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === TESTFLIGHT),
      [TESTFLIGHT],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    assert.deepEqual(await columns(db, 'testflight_feedback'), [
      'app_id',
      'app_uptime_ms',
      'apple_id',
      'architecture',
      'assignee_user_id',
      'battery_percent',
      'build_id',
      'build_number',
      'bundle_id',
      'comment',
      'connection_type',
      'crash_log',
      'crash_log_state',
      'crash_log_truncated',
      'created_at',
      'device_family',
      'device_model',
      'disk_free_bytes',
      'disk_total_bytes',
      'fetched_at',
      'first_seen_at',
      'id',
      'internal_note',
      'kind',
      'locale',
      'os_version',
      'paired_watch',
      'platform',
      'screen_height',
      'screen_width',
      'screenshots_json',
      'signature',
      'status',
      'status_changed_at',
      'status_changed_by',
      'symbolicated',
      'tester_email',
      'tester_key',
      'time_zone',
      'version',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'testflight_sync'), [
      'app_id',
      'complete',
      'crash_count',
      'failures',
      'feedback_count',
      'last_attempt_at',
      'last_error',
      'last_synced_at',
      'warnings_json',
      'workspace_id',
    ]);
    for (const table of ['testflight_feedback', 'testflight_sync']) {
      assert.ok((await tableIndexes(db, table)).includes(`${table}_workspace_idx`), table);
    }
    assert.ok(
      (await tableIndexes(db, 'testflight_feedback')).includes('testflight_feedback_apple_idx'),
    );

    const row = (id: string, appId: string, appleId: string, workspaceId = 'w1') =>
      db.execute(
        `INSERT INTO testflight_feedback (id, workspace_id, app_id, apple_id, kind, created_at, first_seen_at, fetched_at)
         VALUES (?, ?, ?, ?, 'feedback', 5, 6, 7)`,
        [id, workspaceId, appId, appleId],
      );
    await row('r1', 'a1', 'x');
    await row('r2', 'a2', 'x');
    await assert.rejects(() => row('r3', 'a1', 'x'), 'app_id + apple_id is unique');
    await assert.rejects(() => row('r4', 'a3', 'y', 'nope'), 'the workspace must exist');
    const [r] = await db.query(
      'SELECT status, comment, screenshots_json, crash_log_state, crash_log_truncated FROM testflight_feedback WHERE id = ?',
      ['r1'],
    );
    assert.equal(String(r?.status), 'new');
    assert.equal(String(r?.comment), '');
    assert.equal(String(r?.screenshots_json), '[]');
    assert.equal(String(r?.crash_log_state), 'none');
    assert.equal(Number(r?.crash_log_truncated), 0);

    await db.execute(`INSERT INTO testflight_sync (app_id, workspace_id) VALUES ('a1', 'w1')`);
    const [sync] = await db.query(
      'SELECT failures, feedback_count, crash_count, complete, warnings_json FROM testflight_sync',
    );
    assert.equal(Number(sync?.failures), 0);
    assert.equal(Number(sync?.feedback_count), 0);
    assert.equal(Number(sync?.complete), 1);
    assert.equal(String(sync?.warnings_json), '[]');

    assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
  },
);
