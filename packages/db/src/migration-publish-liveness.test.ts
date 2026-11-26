import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 74;

/** The state of a user who ran the app before migration 74, with a batch publish claim in flight. */
async function upTo73(db: Database) {
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
  'migration 74: a publish claim gains its owning process, a heartbeat, a detail line and the count of done steps; old claims keep working',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    assert.ok(migrations.length >= ID);
    await upTo73(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    await db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at, steps, current_step, step_at)
       VALUES ('a1', 'ios', 'w1', 'publish', 'writing', 'u1', 30, '["push_draft"]', 'push_draft', 31)`,
    );
    assert.deepEqual(
      (await migrate(db)).filter((id) => id === ID),
      [74],
    );
    const cols = (await tableColumns(db, 'store_publish_claims')).map((c) => c.name);
    for (const name of ['instance_id', 'heartbeat_at', 'detail', 'detail_at', 'steps_done'])
      assert.ok(cols.includes(name), name);
    const [old] = await db.query(
      'SELECT claim_at, step_at, instance_id, heartbeat_at, detail, detail_at, steps_done FROM store_publish_claims WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(Number(old?.claim_at), 30);
    assert.equal(Number(old?.step_at), 31);
    for (const name of ['instance_id', 'heartbeat_at', 'detail', 'detail_at', 'steps_done'])
      assert.equal(old?.[name], null, name);
    await db.execute(
      `UPDATE store_publish_claims SET instance_id = 'boot-1', heartbeat_at = 50, detail = ?, detail_at = 51, steps_done = 1 WHERE app_id = 'a1'`,
      ['{"phase":"uploading","done":1,"total":2}'],
    );
    const [now] = await db.query(
      'SELECT instance_id, heartbeat_at, detail, detail_at, steps_done FROM store_publish_claims WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(now?.instance_id, 'boot-1');
    assert.equal(Number(now?.heartbeat_at), 50);
    assert.equal(now?.detail, '{"phase":"uploading","done":1,"total":2}');
    assert.equal(Number(now?.detail_at), 51);
    assert.equal(Number(now?.steps_done), 1);
  },
);
