import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const MAIL = 35;
const TOTP = 36;

/** The state of a user who ran the app before migration 35. */
async function upTo34(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < MAIL)) {
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
  'migrations 35 and 36 add the mail and two-factor tables; earlier data is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === MAIL)?.id, MAIL);
    assert.equal(migrations.find((m) => m.id === TOTP)?.id, TOTP);
    await upTo34(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
    );

    const applied = await migrate(db);
    assert.ok(applied.includes(MAIL) && applied.includes(TOTP));
    assert.equal(String((await db.query('SELECT email FROM users'))[0]?.email), 'a@x.io');

    assert.deepEqual(await names(db, 'instance_settings'), [
      'key',
      'updated_at',
      'updated_by',
      'value_enc',
    ]);
    assert.deepEqual(await names(db, 'user_mail'), [
      'created_at',
      'email',
      'user_id',
      'verified_at',
    ]);
    assert.deepEqual(await names(db, 'mail_codes'), [
      'action',
      'attempts',
      'binding',
      'code_mac',
      'created_at',
      'email',
      'expires_at',
      'id',
      'purpose',
      'target_hash',
      'target_id',
      'used_at',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'user_totp'), [
      'confirmed_at',
      'created_at',
      'last_step',
      'secret_enc',
      'user_id',
    ]);
    assert.deepEqual(await names(db, 'login_challenges'), [
      'attempts',
      'created_at',
      'expires_at',
      'id',
      'kind',
      'user_id',
    ]);
    assert.ok((await tableIndexes(db, 'mail_codes')).includes('mail_codes_user_idx'));
    assert.ok((await tableIndexes(db, 'mail_codes')).includes('mail_codes_workspace_idx'));
    assert.ok(
      (await tableIndexes(db, 'login_challenges')).includes('login_challenges_expires_idx'),
    );
  },
);

dbTest('a user has one TOTP secret and one mail address; a code needs its user', async (db) => {
  await migrate(db);
  await db.execute(
    "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
  );
  await db.execute(
    "INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_step, created_at) VALUES ('u1', 'enc', NULL, 0, 1)",
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_step, created_at) VALUES ('u1', 'enc2', NULL, 0, 2)",
    ),
  );
  await db.execute(
    "INSERT INTO user_mail (user_id, email, verified_at, created_at) VALUES ('u1', 'a@x.io', NULL, 1)",
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO user_mail (user_id, email, verified_at, created_at) VALUES ('u1', 'b@x.io', NULL, 2)",
    ),
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO mail_codes (id, user_id, purpose, email, code_mac, attempts, created_at, expires_at) VALUES ('m1', 'nobody', 'step_up', 'a@x.io', 'mac', 0, 1, 2)",
    ),
  );
  await db.execute(
    "INSERT INTO mail_codes (id, user_id, purpose, email, code_mac, attempts, created_at, expires_at) VALUES ('m1', 'u1', 'step_up', 'a@x.io', 'mac', 0, 1, 2)",
  );
  await db.execute(
    "INSERT INTO instance_settings (key, value_enc, updated_at, updated_by) VALUES ('mail.smtp', 'enc', 1, 'u1')",
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO instance_settings (key, value_enc, updated_at, updated_by) VALUES ('mail.smtp', 'enc', 2, 'u1')",
    ),
  );
});
