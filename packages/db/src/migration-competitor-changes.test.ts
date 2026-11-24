import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 60;

async function upTo59(db: Database) {
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
  'migration 60 adds the competitor changes table and listing_state; a followed competitor keeps its row',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo59(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    await db.execute(
      "INSERT INTO aso_competitors (id, workspace_id, app_id, store, external_id, country, name, added_by, added_at) VALUES ('c1', 'w1', 'a1', 'app_store', '123', 'us', 'Rival', 'u', 1)",
    );
    assert.deepEqual(
      (await migrate(db)).filter((id) => id === ID),
      [ID],
    );
    assert.ok(
      (await tableColumns(db, 'aso_competitors')).map((c) => c.name).includes('listing_state'),
    );
    const [row] = await db.query('SELECT name, listing_state FROM aso_competitors WHERE id = ?', [
      'c1',
    ]);
    assert.equal(row?.name, 'Rival');
    assert.equal(row?.listing_state, null);
    await db.execute(
      "INSERT INTO aso_competitor_changes (id, workspace_id, competitor_id, app_id, detected_at, kinds, changes) VALUES ('x1', 'w1', 'c1', 'a1', 5, 'icon', '[]')",
    );
    await db.execute("DELETE FROM aso_competitors WHERE id = 'c1'");
    assert.equal(
      (await db.query('SELECT id FROM aso_competitor_changes')).length,
      0,
      'deleted with the competitor',
    );
    assert.deepEqual(await migrate(db), []);
  },
);
