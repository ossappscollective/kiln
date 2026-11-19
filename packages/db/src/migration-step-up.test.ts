import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const STEP_UP = 33;

/** The state of a user who ran the app before migration 33. */
async function upTo32(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < STEP_UP)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}

const names = async (db: Database, table: string) => (await tableColumns(db, table)).map((c) => c.name);

dbTest('migration 33 adds the step-up tables; data of migrations 1 to 32 is untouched', async (db) => {
  assert.equal(migrations[STEP_UP - 1]?.id, STEP_UP, 'ids are contiguous');
  await upTo32(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  await db.execute("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)");
  await db.execute("INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at) VALUES ('w1', 'reviews.lowRatingThreshold', '3', 1)");

  const applied = await migrate(db);
  assert.deepEqual(applied.filter((id) => id === STEP_UP), [STEP_UP]);
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
  assert.equal(String((await db.query('SELECT value_json FROM workspace_settings'))[0]?.value_json), '3');

  assert.deepEqual(await names(db, 'step_up_credentials'), ['alg', 'created_at', 'credential_id', 'id', 'last_used_at', 'name', 'public_key', 'sign_count', 'transports', 'user_id']);
  assert.deepEqual(await names(db, 'step_up_challenges'), ['action', 'challenge', 'expires_at', 'id', 'purpose', 'session_id', 'target_hash', 'target_id', 'user_id', 'workspace_id']);
  assert.deepEqual(await names(db, 'step_up_grants'), ['action', 'created_at', 'expires_at', 'factor', 'id', 'session_id', 'target_hash', 'target_id', 'used_at', 'user_id', 'workspace_id']);
  assert.deepEqual(await names(db, 'step_up_users'), ['confirmation_hash', 'failed_count', 'locked_until', 'updated_at', 'user_id']);
  assert.ok((await tableIndexes(db, 'step_up_credentials')).includes('step_up_credentials_user_idx'));
  assert.ok((await tableIndexes(db, 'step_up_grants')).includes('step_up_grants_expires_idx'));
});

dbTest('step_up_credentials: a credential id is unique; a user must exist', async (db) => {
  await migrate(db);
  await db.execute("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)");
  const insert = (id: string, credential: string, user = 'u1') =>
    db.execute(
      "INSERT INTO step_up_credentials (id, user_id, credential_id, public_key, alg, name, created_at) VALUES (?, ?, ?, 'k', -7, 'n', 1)",
      [id, user, credential],
    );
  await insert('p1', 'cred-1');
  await assert.rejects(() => insert('p2', 'cred-1'));
  await assert.rejects(() => insert('p3', 'cred-2', 'nobody'));
  assert.equal(Number((await db.query('SELECT sign_count FROM step_up_credentials'))[0]?.sign_count), 0, 'the counter starts at 0');
});

dbTest('migration 33 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
