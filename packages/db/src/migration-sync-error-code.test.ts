import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const CODE = 50;

/** The state of a user who ran the app before migration 50. */
async function upTo49(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < CODE)) {
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
  'migration 50 adds the code and parameters of the sync failure note; an old note keeps its English text',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === CODE)?.id, CODE);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo49(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at, last_sync_error)
       VALUES ('a1', 'w1', 'App', 'ios', 'com.acme.app', 'c1', 1, 'The store did not answer in time. Try again.')`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === CODE),
      [CODE],
    );
    const columns = (await tableColumns(db, 'apps')).map((c) => c.name);
    assert.ok(columns.includes('last_sync_error_code'));
    assert.ok(columns.includes('last_sync_error_params'));

    // The old row is untouched: its English text stays, and it has no code (the web app shows the text).
    const [old] = await db.query(
      'SELECT last_sync_error, last_sync_error_code, last_sync_error_params FROM apps WHERE id = ?',
      ['a1'],
    );
    assert.equal(old?.last_sync_error, 'The store did not answer in time. Try again.');
    assert.equal(old?.last_sync_error_code, null);
    assert.equal(old?.last_sync_error_params, null);

    // A new note carries both.
    await db.execute(
      'UPDATE apps SET last_sync_error_code = ?, last_sync_error_params = ? WHERE id = ?',
      ['store.google.noAccessPackage', '{"package":"com.acme.app"}', 'a1'],
    );
    const [row] = await db.query('SELECT last_sync_error_code, last_sync_error_params FROM apps WHERE id = ?', ['a1']);
    assert.equal(row?.last_sync_error_code, 'store.google.noAccessPackage');
    assert.equal(row?.last_sync_error_params, '{"package":"com.acme.app"}');

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
