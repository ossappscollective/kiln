import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const RECOVERY = 34;

/** The state of a user who ran the app before migration 34. */
async function upTo33(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < RECOVERY)) {
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
  'migration 34 adds recovery codes and internal sharing; data of migrations 1 to 33 is untouched',
  async (db) => {
    assert.equal(migrations[RECOVERY - 1]?.id, RECOVERY, 'ids are contiguous');
    await upTo33(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
    );
    await db.execute(
      "INSERT INTO step_up_users (user_id, confirmation_hash, failed_count, updated_at) VALUES ('u1', 'scrypt$x', 2, 1)",
    );
    await db.execute(
      "INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at) VALUES ('w1', 'security.stepUp', '{\"mode\":\"hard_actions\"}', 1)",
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === RECOVERY),
      [RECOVERY],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
    assert.equal(
      Number((await db.query('SELECT failed_count FROM step_up_users'))[0]?.failed_count),
      2,
    );
    assert.match(
      String((await db.query('SELECT value_json FROM workspace_settings'))[0]?.value_json),
      /hard_actions/,
    );

    assert.deepEqual(await names(db, 'step_up_recovery_codes'), [
      'code_hash',
      'created_at',
      'id',
      'used_at',
      'user_id',
    ]);
    assert.deepEqual(await names(db, 'play_internal_shares'), [
      'app_id',
      'artifact_id',
      'certificate_fingerprint',
      'created_at',
      'created_by',
      'expires_at',
      'file_kind',
      'file_name',
      'id',
      'package_name',
      'run_id',
      'sha256',
      'size_bytes',
      'url_secret',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'play_internal_share_claims'), [
      'app_id',
      'claim_at',
      'claimed_by',
      'status',
      'workspace_id',
    ]);
    assert.ok(
      (await tableIndexes(db, 'step_up_recovery_codes')).includes(
        'step_up_recovery_codes_user_idx',
      ),
    );
    assert.ok(
      (await tableIndexes(db, 'play_internal_shares')).includes('play_internal_shares_app_idx'),
    );
  },
);

dbTest(
  'recovery codes need a user; one claim per app; a share can lose its link and keep its ids',
  async (db) => {
    await migrate(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
    );
    const code = (id: string, user: string) =>
      db.execute(
        "INSERT INTO step_up_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, 'h', 1)",
        [id, user],
      );
    await code('c1', 'u1');
    await assert.rejects(() => code('c2', 'nobody'));
    assert.equal(
      (await db.query('SELECT used_at FROM step_up_recovery_codes'))[0]?.used_at,
      null,
      'a new code is unused',
    );

    const claim = (workspace = 'w1') =>
      db.execute(
        "INSERT INTO play_internal_share_claims (app_id, workspace_id, status, claimed_by, claim_at) VALUES ('a1', ?, 'writing', 'u1', 1)",
        [workspace],
      );
    await claim();
    await assert.rejects(() => claim(), 'one upload in flight per app');
    await db.execute("DELETE FROM play_internal_share_claims WHERE app_id = 'a1'");
    await assert.rejects(() => claim('nope'));

    await db.execute(
      `INSERT INTO play_internal_shares (id, workspace_id, app_id, artifact_id, package_name, file_kind, size_bytes, sha256, url_secret, created_by, created_at, expires_at)
     VALUES ('s1', 'w1', 'a1', '9', 'com.example.app', 'bundle', 10, 'abc', 'enc', 'u1', 1, 2)`,
    );
    await db.execute("UPDATE play_internal_shares SET url_secret = NULL WHERE id = 's1'");
    assert.equal(
      (await db.query('SELECT url_secret FROM play_internal_shares'))[0]?.url_secret,
      null,
    );
  },
);

dbTest('migration 34 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
