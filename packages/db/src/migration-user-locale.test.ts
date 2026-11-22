import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 51;

/** The state of a user who ran the app before migration 51. */
async function upTo50(db: Database) {
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

dbTest('migration 51 adds a nullable users.locale; existing people keep none', async (db) => {
  assert.equal(migrations.find((m) => m.id === ID)?.id, ID);
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo50(db);
  await db.execute(
    "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'ada@example.com', 'Ada', 1)",
  );

  const applied = await migrate(db);
  assert.deepEqual(
    applied.filter((id) => id === ID),
    [ID],
  );
  assert.ok((await tableColumns(db, 'users')).map((c) => c.name).includes('locale'));

  const [old] = await db.query('SELECT locale FROM users WHERE id = ?', ['u1']);
  assert.equal(old?.locale, null, 'no backfill: an existing person has no language choice');

  await db.execute('UPDATE users SET locale = ? WHERE id = ?', ['fr', 'u1']);
  const [row] = await db.query('SELECT locale FROM users WHERE id = ?', ['u1']);
  assert.equal(row?.locale, 'fr');

  assert.deepEqual(await migrate(db), []);
});
