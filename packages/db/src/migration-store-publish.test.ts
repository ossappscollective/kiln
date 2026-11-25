import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const PUBLISH = 29;

/** The state of a user who ran the app before migration 29, with data in the older tables. */
async function upTo28(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < PUBLISH)) {
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
  'migration 29 adds publish claims; claims, push records and staged rows of migrations 1 to 28 are untouched',
  async (db) => {
    assert.equal(migrations[PUBLISH - 1]?.id, PUBLISH, 'ids are contiguous');
    await upTo28(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO store_release_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'release', 'unknown', 'u1', 30)`,
    );
    await db.execute(
      `INSERT INTO store_draft_pushes (app_id, platform, workspace_id, version_id, version_string, confirm_hash, items, pushed_by, pushed_at, updated_at)
     VALUES ('a1', 'ios', 'w1', 'v1', '2.1', 'h', '{}', 'u1', 5, 5)`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === PUBLISH),
      [PUBLISH],
    );
    assert.equal(
      String((await db.query('SELECT status FROM store_release_claims'))[0]?.status),
      'unknown',
    );
    assert.equal(
      String((await db.query('SELECT version_string FROM store_draft_pushes'))[0]?.version_string),
      '2.1',
    );

    assert.deepEqual(
      (await tableColumns(db, 'store_publish_claims')).map((c) => c.name),
      [
        'action',
        'app_id',
        'claim_at',
        'claimed_by',
        'current_step',
        'platform',
        'status',
        'step_at',
        'steps',
        'workspace_id',
      ], // current_step, step_at and steps came with migration 71
    );
    assert.ok(
      (await tableIndexes(db, 'store_publish_claims')).includes(
        'store_publish_claims_workspace_idx',
      ),
    );

    const claim = (appId: string, platform: string, workspace = 'w1') =>
      db.execute(
        `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
       VALUES (?, ?, ?, 'publish', 'u1', 30)`,
        [appId, platform, workspace],
      );
    await claim('a1', 'ios');
    assert.equal(
      (await db.query('SELECT status FROM store_publish_claims WHERE app_id = ?', ['a1']))[0]
        ?.status,
      'writing',
    );
    await assert.rejects(claim('a1', 'ios'), 'one publish in flight per app and platform');
    await claim('a1', 'macos');
    await assert.rejects(
      claim('a4', 'ios', 'missing'),
      'a workspace that does not exist cannot hold one',
    );
    const taken = await db.execute(
      `INSERT INTO store_publish_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'publish', 'u2', 50) ON CONFLICT (app_id, platform) DO NOTHING`,
    );
    assert.equal(taken, 0);
    // A different table from the release claims: a batch does not collide with a release in flight.
    assert.equal(
      Number((await db.query('SELECT claim_at FROM store_release_claims'))[0]?.claim_at),
      30,
    );
  },
);

dbTest('migration 29 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
