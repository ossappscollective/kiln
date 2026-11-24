import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 58;

/** The state of a user who ran the app before migration 58. */
async function upTo57(db: Database) {
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

dbTest(
  'migration 58 adds a nullable apple_vendor_number; a stored Play bucket row keeps its value',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo57(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    await db.execute(
      "INSERT INTO analytics_credential_config (credential_id, workspace_id, play_bucket_id, updated_by, updated_at) VALUES ('c1', 'w1', 'pubsite_prod_rev_123456', 'u', 1)",
    );
    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === ID),
      [ID],
    );
    assert.ok(
      (await tableColumns(db, 'analytics_credential_config'))
        .map((c) => c.name)
        .includes('apple_vendor_number'),
    );
    const [row] = await db.query(
      'SELECT play_bucket_id, apple_vendor_number FROM analytics_credential_config WHERE credential_id = ?',
      ['c1'],
    );
    assert.equal(row?.play_bucket_id, 'pubsite_prod_rev_123456');
    assert.equal(row?.apple_vendor_number, null);
    assert.deepEqual(await migrate(db), []);
  },
);
