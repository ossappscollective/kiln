import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

dbTest('the listing attempts migration adds listing_attempt_at and listing_failures and keeps existing rows', async (db) => {
  const mine = migrations.find((m) => m.name.startsWith('listing read attempts'));
  assert.ok(mine, 'the migration exists');
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < mine.id)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  // An app listing status and a snapshot that exist before the upgrade.
  await db.execute(
    `INSERT INTO app_listing_status (app_id, workspace_id, listing_read_at, listing_error, repo_read_at, repo_ref)
     VALUES ('a1', 'w1', 100, 'It broke', 90, 'abc')`,
  );
  await db.execute(
    `INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, observed_at)
     VALUES ('s1', 'w1', 'a1', 'ios', 'en-US', 'name', 'live', 'Coffee', 'h', 'store', 100)`,
  );

  const applied = await migrate(db);
  assert.ok(applied.includes(mine.id), 'the migration was applied');

  const [row] = await db.query(
    'SELECT listing_read_at, listing_error, repo_ref, listing_attempt_at, listing_failures, listing_warnings FROM app_listing_status WHERE app_id = ?',
    ['a1'],
  );
  assert.equal(Number(row?.listing_read_at), 100, 'existing values are kept');
  assert.equal(row?.listing_error, 'It broke');
  assert.equal(row?.repo_ref, 'abc');
  assert.equal(row?.listing_attempt_at, null, 'an old row has no attempt: the app is simply due');
  assert.equal(row?.listing_warnings ?? null, null);
  assert.equal(Number(row?.listing_failures), 0);

  await db.execute('UPDATE app_listing_status SET listing_attempt_at = ?, listing_failures = ? WHERE app_id = ?', [500, 3, 'a1']);
  const [after] = await db.query('SELECT listing_attempt_at, listing_failures FROM app_listing_status WHERE app_id = ?', ['a1']);
  assert.equal(Number(after?.listing_attempt_at), 500);
  assert.equal(Number(after?.listing_failures), 3);

  // A new row without the columns gets the default.
  await db.execute("INSERT INTO app_listing_status (app_id, workspace_id) VALUES ('a2', 'w1')");
  const [fresh] = await db.query('SELECT listing_attempt_at, listing_failures FROM app_listing_status WHERE app_id = ?', ['a2']);
  assert.equal(fresh?.listing_attempt_at, null);
  assert.equal(Number(fresh?.listing_failures), 0);

  const [snapshot] = await db.query('SELECT value FROM listing_snapshots WHERE id = ?', ['s1']);
  assert.equal(snapshot?.value, 'Coffee', 'the snapshots are untouched: sections need no migration');
});
