import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 71;

/** The state of a user who ran the app before migration 71, with a batch publish claim in flight. */
async function upTo70(db: Database) {
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
  'migration 71: a publish claim gains its steps, the running step and a heartbeat; old claims keep working',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    assert.ok(migrations.length >= ID);
    await upTo70(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    await db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
       VALUES ('a1', 'android', 'w1', 'publish', 'writing', 'u1', 30)`,
    );
    assert.deepEqual(
      (await migrate(db)).filter((id) => id === ID),
      [71],
    );
    const cols = (await tableColumns(db, 'store_publish_claims')).map((c) => c.name);
    for (const name of ['steps', 'current_step', 'step_at']) assert.ok(cols.includes(name), name);
    const [old] = await db.query(
      'SELECT claim_at, steps, current_step, step_at FROM store_publish_claims WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(Number(old?.claim_at), 30);
    assert.equal(old?.steps, null);
    assert.equal(old?.current_step, null);
    assert.equal(old?.step_at, null);
    await db.execute(
      "UPDATE store_publish_claims SET steps = ?, current_step = 'push_draft', step_at = 40 WHERE app_id = 'a1'",
      ['["push_draft","submit"]'],
    );
    const [now] = await db.query(
      'SELECT steps, current_step, step_at FROM store_publish_claims WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(now?.steps, '["push_draft","submit"]');
    assert.equal(now?.current_step, 'push_draft');
    assert.equal(Number(now?.step_at), 40);
  },
);
