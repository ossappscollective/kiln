import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const SUBMIT = 24;

/** The state of a user who ran the app before migration 24, with data in the older tables. */
async function upTo23(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < SUBMIT)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}

dbTest('migration 24 adds draft push records and submit claims; data of migrations 1 to 23 is untouched', async (db) => {
  assert.equal(migrations[SUBMIT - 1]?.id, SUBMIT, 'ids are contiguous');
  await upTo23(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute(
    `INSERT INTO staged_changes
       (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
     VALUES ('s1', 'w1', 'a1', 'ios', 'listing_text', 'en-US', 'description', 0, 'local', 'Hello', 'h1', 'u1', 5, 5)`,
  );
  await db.execute(
    `INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'push_draft', 'unknown', 'u1', 30)`,
  );

  const applied = await migrate(db);
  assert.deepEqual(applied.filter((id) => id === SUBMIT), [SUBMIT]);
  assert.equal(String((await db.query('SELECT value_text FROM staged_changes WHERE id = ?', ['s1']))[0]?.value_text), 'Hello');
  assert.equal(String((await db.query('SELECT status FROM store_draft_claims'))[0]?.status), 'unknown');

  assert.deepEqual((await tableColumns(db, 'store_draft_pushes')).map((c) => c.name), [
    'app_id',
    'confirm_hash',
    'items',
    'platform',
    'pushed_at',
    'pushed_by',
    'updated_at',
    'version_id',
    'version_string',
    'workspace_id',
  ]);
  assert.deepEqual((await tableColumns(db, 'store_submit_claims')).map((c) => c.name), [
    'action',
    'app_id',
    'claim_at',
    'claimed_by',
    'platform',
    'status',
    'workspace_id',
  ]);
  assert.ok((await tableIndexes(db, 'store_draft_pushes')).includes('store_draft_pushes_workspace_idx'));
  assert.ok((await tableIndexes(db, 'store_submit_claims')).includes('store_submit_claims_workspace_idx'));

  const push = (appId: string, platform: string, workspace = 'w1') =>
    db.execute(
      `INSERT INTO store_draft_pushes (app_id, platform, workspace_id, version_id, version_string, confirm_hash, items, pushed_by, pushed_at, updated_at)
       VALUES (?, ?, ?, 'v1', '2.1', ?, '{"v":1,"text":[],"assets":[]}', 'u1', 40, 40)`,
      [appId, platform, workspace, 'a'.repeat(64)],
    );
  await push('a1', 'ios');
  const [row] = await db.query('SELECT version_id, pushed_at, items FROM store_draft_pushes WHERE app_id = ?', ['a1']);
  assert.equal(row?.version_id, 'v1');
  assert.equal(Number(row?.pushed_at), 40);
  assert.deepEqual(JSON.parse(String(row?.items)), { v: 1, text: [], assets: [] });
  // One record per app and platform; a workspace that does not exist cannot hold one.
  await assert.rejects(push('a1', 'ios'));
  await push('a1', 'android');
  await assert.rejects(push('a2', 'ios', 'missing'));
  // A Google Play record has no version.
  await db.execute(
    `INSERT INTO store_draft_pushes (app_id, platform, workspace_id, confirm_hash, items, pushed_by, pushed_at, updated_at)
     VALUES ('a3', 'android', 'w1', ?, '{}', 'u1', 1, 1)`,
    ['b'.repeat(64)],
  );
  assert.equal((await db.query('SELECT version_id FROM store_draft_pushes WHERE app_id = ?', ['a3']))[0]?.version_id, null);

  const claim = (appId: string, platform: string, workspace = 'w1') =>
    db.execute(
      `INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
       VALUES (?, ?, ?, 'submit', 'u1', 30)`,
      [appId, platform, workspace],
    );
  await claim('a1', 'ios');
  assert.equal((await db.query('SELECT status FROM store_submit_claims WHERE app_id = ?', ['a1']))[0]?.status, 'writing');
  await assert.rejects(claim('a1', 'ios'), 'one submit in flight per app and platform');
  await claim('a1', 'android');
  await assert.rejects(claim('a4', 'ios', 'missing'));
  const taken = await db.execute(
    `INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'submit', 'u2', 50) ON CONFLICT (app_id, platform) DO NOTHING`,
  );
  assert.equal(taken, 0);
  // The draft claims are a different table: a submit does not collide with a push.
  assert.equal((await db.query('SELECT claim_at FROM store_draft_claims'))[0]?.claim_at, 30);
});

dbTest('migration 24 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
