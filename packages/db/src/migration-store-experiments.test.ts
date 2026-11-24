import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const EXPERIMENTS = 53;

/** The state of a user who ran the app before migration 53. */
async function upTo52(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < EXPERIMENTS)) {
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
  'migration 53 adds the store experiment tables; data of migrations 1 to 52 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === EXPERIMENTS)?.id, EXPERIMENTS);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo52(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === EXPERIMENTS),
      [EXPERIMENTS],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    assert.deepEqual(await columns(db, 'store_experiments'), [
      'app_id',
      'detail_json',
      'ends_at',
      'item_id',
      'kind',
      'name',
      'raw_state',
      'starts_at',
      'state',
      'synced_at',
      'url',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_experiments_sync'), [
      'app_id',
      'complete',
      'experiment_count',
      'failures',
      'last_attempt_at',
      'last_error',
      'last_synced_at',
      'page_count',
      'warnings_json',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_experiment_notes'), [
      'app_id',
      'created_at',
      'created_by',
      'ended_on',
      'id',
      'kind',
      'listing',
      'name',
      'note',
      'started_on',
      'status',
      'updated_at',
      'url',
      'workspace_id',
    ]);
    for (const table of ['store_experiments', 'store_experiments_sync', 'store_experiment_notes']) {
      assert.ok((await tableIndexes(db, table)).includes(`${table}_workspace_idx`), table);
    }

    const row = (appId: string, kind: string, itemId: string, workspaceId = 'w1') =>
      db.execute(
        `INSERT INTO store_experiments (app_id, kind, item_id, workspace_id, name, state, synced_at)
         VALUES (?, ?, ?, ?, 'Icon test', 'approved', 5)`,
        [appId, kind, itemId, workspaceId],
      );
    await row('a1', 'experiment', 'e1');
    await row('a1', 'custom_page', 'e1');
    await assert.rejects(() => row('a1', 'experiment', 'e1'), 'app_id + kind + item_id is the key');
    await assert.rejects(() => row('a2', 'experiment', 'e1', 'nope'), 'the workspace must exist');
    assert.equal(
      String((await db.query('SELECT detail_json FROM store_experiments LIMIT 1'))[0]?.detail_json),
      '{}',
    );

    await db.execute(
      `INSERT INTO store_experiments_sync (app_id, workspace_id) VALUES ('a1', 'w1')`,
    );
    const [sync] = await db.query(
      'SELECT failures, experiment_count, page_count, complete, warnings_json FROM store_experiments_sync',
    );
    assert.equal(Number(sync?.failures), 0);
    assert.equal(Number(sync?.experiment_count), 0);
    assert.equal(Number(sync?.complete), 1);
    assert.equal(String(sync?.warnings_json), '[]');

    await db.execute(
      `INSERT INTO store_experiment_notes (id, workspace_id, app_id, kind, name, status, created_by, created_at, updated_at)
       VALUES ('n1', 'w1', 'a1', 'experiment', 'Short description', 'planned', 'u1', 1, 1)`,
    );
    assert.equal(String((await db.query('SELECT note FROM store_experiment_notes'))[0]?.note), '');

    assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
  },
);
