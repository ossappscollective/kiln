import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const RELEASE = 27;

/** The state of a user who ran the app before migration 27, with data in the older tables. */
async function upTo26(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < RELEASE)) {
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
  'migration 27 adds release claims; staged rows, draft pushes and claims of migrations 1 to 26 are untouched',
  async (db) => {
    assert.equal(migrations[RELEASE - 1]?.id, RELEASE, 'ids are contiguous');
    await upTo26(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO staged_changes
       (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
     VALUES ('s1', 'w1', 'a1', 'ios', 'listing_text', 'en-US', 'release_notes', 0, 'local', 'Fixes', 'h1', 'u1', 5, 5)`,
    );
    await db.execute(
      `INSERT INTO store_submit_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'submit', 'unknown', 'u1', 30)`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === RELEASE),
      [RELEASE],
    );
    assert.equal(
      String(
        (await db.query('SELECT value_text FROM staged_changes WHERE id = ?', ['s1']))[0]
          ?.value_text,
      ),
      'Fixes',
    );
    assert.equal(
      String((await db.query('SELECT status FROM store_submit_claims'))[0]?.status),
      'unknown',
    );

    assert.deepEqual(
      (await tableColumns(db, 'store_release_claims')).map((c) => c.name),
      ['action', 'app_id', 'claim_at', 'claimed_by', 'platform', 'status', 'workspace_id'],
    );
    assert.ok(
      (await tableIndexes(db, 'store_release_claims')).includes(
        'store_release_claims_workspace_idx',
      ),
    );

    const claim = (appId: string, platform: string, workspace = 'w1') =>
      db.execute(
        `INSERT INTO store_release_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
       VALUES (?, ?, ?, 'release', 'u1', 30)`,
        [appId, platform, workspace],
      );
    await claim('a1', 'ios');
    assert.equal(
      (await db.query('SELECT status FROM store_release_claims WHERE app_id = ?', ['a1']))[0]
        ?.status,
      'writing',
    );
    await assert.rejects(claim('a1', 'ios'), 'one release in flight per app and platform');
    await claim('a1', 'macos');
    await assert.rejects(
      claim('a4', 'ios', 'missing'),
      'a workspace that does not exist cannot hold one',
    );
    const taken = await db.execute(
      `INSERT INTO store_release_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'ios', 'w1', 'release', 'u2', 50) ON CONFLICT (app_id, platform) DO NOTHING`,
    );
    assert.equal(taken, 0);
    // A different table from the submit claims: a release does not collide with a submit.
    assert.equal(
      Number((await db.query('SELECT claim_at FROM store_submit_claims'))[0]?.claim_at),
      30,
    );

    // The staged table takes the new kind without a change: a version field and a per-language release note.
    await db.execute(
      `INSERT INTO staged_changes
       (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
     VALUES ('s2', 'w1', 'a1', 'ios', 'release_field', '', 'release_type', 0, 'local', 'MANUAL', 'h2', 'u1', 6, 6),
            ('s3', 'w1', 'a2', 'android', 'release_field', 'en-US', 'play_release_notes', 0, 'local', 'Fixes', 'h3', 'u1', 6, 6)`,
    );
    assert.equal(
      String(
        (
          await db.query(
            "SELECT value_text FROM staged_changes WHERE kind = 'release_field' AND app_id = 'a1'",
          )
        )[0]?.value_text,
      ),
      'MANUAL',
    );
    await assert.rejects(
      db.execute(
        `INSERT INTO staged_changes
         (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at)
       VALUES ('s4', 'w1', 'a1', 'ios', 'release_field', '', 'release_type', 0, 'local', 'MANUAL', 'h2', 'u1', 6, 6)`,
      ),
      'one value per field',
    );
  },
);

dbTest('migration 27 on a database that already has it changes nothing', async (db) => {
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
});
