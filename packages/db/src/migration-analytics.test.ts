import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const ANALYTICS = 31;

/** The state of a user who ran the app before migration 31. */
async function upTo30(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ANALYTICS)) {
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

const names = async (db: Database, table: string) =>
  (await tableColumns(db, table)).map((c) => c.name);

dbTest(
  'migration 31 adds the analytics tables; data of migrations 1 to 30 is untouched',
  async (db) => {
    assert.equal(migrations[ANALYTICS - 1]?.id, ANALYTICS, 'ids are contiguous');
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo30(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === ANALYTICS),
      [ANALYTICS],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    assert.deepEqual(await names(db, 'analytics_daily'), [
      'app_id',
      'day',
      'dim_type',
      'dim_value',
      'metric',
      'origin',
      'platform',
      'processing_date',
      'source',
      'updated_at',
      'value_micro',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'analytics_sync_runs'), [
      'app_id',
      'day_from',
      'day_to',
      'error_code',
      'finished_at',
      'id',
      'platform',
      'points_written',
      'reports_read',
      'source',
      'started_at',
      'started_by',
      'status',
      'trigger_kind',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'analytics_report_requests'), [
      'access_type',
      'app_id',
      'apple_request_id',
      'created_at',
      'created_by',
      'id',
      'last_checked_at',
      'last_error_code',
      'status',
      'workspace_id',
    ]);
    assert.deepEqual(
      await names(db, 'analytics_instances'),
      [
        'apple_instance_id',
        'apple_report_id',
        'app_id',
        'error_code',
        'points',
        'processing_date',
        'read_at',
        'report_kind',
        'segments',
        'status',
        'workspace_id',
      ].sort(),
    );
    assert.deepEqual(await names(db, 'analytics_app_config'), [
      'app_id',
      'apple_mode',
      'play_bucket_id',
      'updated_at',
      'updated_by',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'analytics_source_state'), [
      'app_id',
      'last_attempt_at',
      'last_error_code',
      'last_ok_at',
      'newest_day',
      'oldest_day',
      'platform',
      'setup_code',
      'source',
      'updated_at',
      'workspace_id',
    ]);
    assert.ok(
      (await tableIndexes(db, 'analytics_daily')).includes('analytics_daily_workspace_idx'),
    );
    assert.ok(
      (await tableIndexes(db, 'analytics_sync_runs')).includes('analytics_sync_runs_app_idx'),
    );
    assert.ok(
      (await tableIndexes(db, 'analytics_report_requests')).includes(
        'analytics_report_requests_app_idx',
      ),
    );

    // Only numbers and fixed codes live in these tables: no column holds a URL, a token or a report row.
    for (const table of [
      'analytics_daily',
      'analytics_sync_runs',
      'analytics_instances',
      'analytics_source_state',
    ]) {
      for (const name of await names(db, table))
        assert.ok(!/url|token|secret|body|row|text|message/.test(name), `${table}.${name}`);
    }
  },
);

dbTest(
  'analytics_daily: one fact per key, a large value fits, a missing workspace is refused',
  async (db) => {
    await migrate(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    const insert = `INSERT INTO analytics_daily (app_id, platform, source, metric, day, workspace_id, value_micro, updated_at)
                  VALUES (?, 'ios', 'apple_analytics', 'downloads', '2026-11-01', ?, ?, 5)`;
    await db.execute(insert, ['a1', 'w1', 12_000_000_000_000]);
    const row = (
      await db.query(
        'SELECT value_micro, dim_type, dim_value, origin, processing_date FROM analytics_daily',
      )
    )[0];
    assert.equal(Number(row?.value_micro), 12_000_000_000_000, 'above 32 bits');
    assert.equal(String(row?.dim_type), '');
    assert.equal(String(row?.dim_value), '');
    assert.equal(String(row?.origin), 'sync');
    await assert.rejects(db.execute(insert, ['a1', 'w1', 1]), 'the same key twice is a conflict');
    await assert.rejects(
      db.execute(insert, ['a2', 'missing', 1]),
      'a workspace that does not exist cannot hold facts',
    );
    await db.execute(
      `INSERT INTO analytics_daily (app_id, platform, source, metric, day, dim_type, dim_value, workspace_id, value_micro, updated_at)
     VALUES ('a1', 'ios', 'apple_analytics', 'downloads', '2026-11-01', 'territory', 'DE', 'w1', 3, 5)`,
    );
    assert.equal(
      Number((await db.query('SELECT COUNT(*) AS n FROM analytics_daily'))[0]?.n),
      2,
      'a dimension is a separate fact',
    );
  },
);

dbTest('analytics_report_requests: one request per app and access type', async (db) => {
  await migrate(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  const insert = `INSERT INTO analytics_report_requests (id, workspace_id, app_id, apple_request_id, access_type, created_by, created_at)
                  VALUES (?, 'w1', 'a1', 'r', ?, 'u1', 5)`;
  await db.execute(insert, ['q1', 'ONGOING']);
  await db.execute(insert, ['q2', 'ONE_TIME_SNAPSHOT']);
  await assert.rejects(
    db.execute(insert, ['q3', 'ONGOING']),
    'a second ONGOING request for the app is refused',
  );
  assert.equal(
    String(
      (await db.query("SELECT status FROM analytics_report_requests WHERE id = 'q1'"))[0]?.status,
    ),
    'active',
  );
});

dbTest('migration 31 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
