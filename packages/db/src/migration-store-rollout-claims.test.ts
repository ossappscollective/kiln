import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ROLLOUT = 22;

dbTest('migration 22 adds the rollout claims: one row per app and platform, older data untouched', async (db) => {
  assert.ok(migrations.some((m) => m.id === ROLLOUT), 'the migration exists');
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ROLLOUT)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO app_reviews
       (id, workspace_id, app_id, store, store_review_id, rating, body, created_at, updated_at, first_seen_at, fetched_at)
     VALUES ('r1', 'w1', 'a1', 'googleplay', 'gp:1', 2, 'Bad', 10, 10, 20, 20)`,
  );

  const applied = await migrate(db);
  // Later migrations are applied by the same call: only this one is checked here.
  assert.deepEqual(applied.filter((id) => id === ROLLOUT), [ROLLOUT]);
  assert.equal((await db.query('SELECT id FROM app_reviews WHERE id = ?', ['r1'])).length, 1, 'existing data is untouched');
  assert.deepEqual((await tableColumns(db, 'store_rollout_claims')).map((c) => c.name), [
    'action',
    'app_id',
    'claim_at',
    'claimed_by',
    'platform',
    'status',
    'workspace_id',
  ]);

  const claim = (appId: string, platform: string, workspace = 'w1') =>
    db.execute(
      `INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
       VALUES (?, ?, ?, 'halt', 'u1', 30)`,
      [appId, platform, workspace],
    );
  await claim('a1', 'android');
  const [row] = await db.query('SELECT status, claim_at FROM store_rollout_claims WHERE app_id = ?', ['a1']);
  assert.equal(row?.status, 'writing', 'a claim starts as a write in flight');
  assert.equal(Number(row?.claim_at), 30);

  // One write in flight per app and platform: a second claim for the same pair cannot exist.
  await assert.rejects(claim('a1', 'android'));
  await claim('a1', 'ios');
  await claim('a2', 'android');
  // A workspace that does not exist cannot hold a claim.
  await assert.rejects(claim('a3', 'android', 'missing'));

  // The claim is taken with an insert that does nothing when the pair is taken.
  const taken = await db.execute(
    `INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'android', 'w1', 'resume', 'u2', 40) ON CONFLICT (app_id, platform) DO NOTHING`,
  );
  assert.equal(taken, 0);
  assert.equal((await db.query('SELECT action FROM store_rollout_claims WHERE app_id = ? AND platform = ?', ['a1', 'android']))[0]?.action, 'halt');
});
