import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const METRICS = 49;

/** The state of a user who ran the app before migration 49. */
async function upTo48(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < METRICS)) {
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
  'migration 49 adds the cached RevenueCat metrics; data of migrations 1 to 48 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === METRICS)?.id, METRICS);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo48(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(`INSERT INTO revenuecat_sync (app_id, workspace_id) VALUES ('a0', 'w1')`);

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === METRICS),
      [METRICS],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
    assert.equal((await db.query('SELECT app_id FROM revenuecat_sync')).length, 1);

    assert.deepEqual((await tableColumns(db, 'revenuecat_metrics')).map((c) => c.name).sort(), [
      'app_id',
      'currency',
      'failures',
      'fetched_at',
      'last_attempt_at',
      'last_error',
      'metrics_json',
      'project_id',
      'workspace_id',
    ]);
    assert.ok(
      (await tableIndexes(db, 'revenuecat_metrics')).includes('revenuecat_metrics_workspace_idx'),
    );

    // One row per app record; the workspace must exist; the defaults hold and a read that never succeeded has no time.
    await db.execute(
      "INSERT INTO revenuecat_metrics (app_id, workspace_id, project_id) VALUES ('a1', 'w1', 'proj1')",
    );
    await assert.rejects(
      () =>
        db.execute(
          "INSERT INTO revenuecat_metrics (app_id, workspace_id, project_id) VALUES ('a1', 'w1', 'proj1')",
        ),
      'app_id is the primary key',
    );
    await assert.rejects(
      () =>
        db.execute(
          "INSERT INTO revenuecat_metrics (app_id, workspace_id, project_id) VALUES ('a2', 'nope', 'proj1')",
        ),
      'the workspace must exist',
    );
    const [row] = await db.query(
      'SELECT metrics_json, failures, fetched_at, currency FROM revenuecat_metrics WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(String(row?.metrics_json), '[]');
    assert.equal(Number(row?.failures), 0);
    assert.equal(row?.fetched_at, null);
    assert.equal(row?.currency, null);

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
