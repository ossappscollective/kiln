import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const ID = 52;

/** The state of a workspace that ran the app before migration 52. */
async function upTo51(db: Database) {
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
  'migration 52 adds the chat tables; existing data is untouched and the defaults hold',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === ID)?.id, ID);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo51(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === ID),
      [ID],
    );
    const columns = async (table: string) => (await tableColumns(db, table)).map((c) => c.name);
    assert.ok((await columns('chat_destinations')).includes('ciphertext'));
    assert.ok((await columns('chat_destinations')).includes('url_hint'));
    assert.ok((await columns('chat_routes')).includes('alert_types'));
    assert.ok((await columns('chat_deliveries')).includes('http_status'));
    assert.ok(
      (await tableIndexes(db, 'chat_deliveries')).some((i) =>
        i.includes('chat_deliveries_destination_idx'),
      ),
    );

    await db.execute(
      `INSERT INTO chat_destinations (id, workspace_id, provider, name, ciphertext, url_hint, created_by, created_at, updated_at)
     VALUES ('d1', 'w1', 'slack', 'Releases', 'enc', 'abcd', 'u1', 1, 1)`,
    );
    const [row] = await db.query(
      'SELECT locale, enabled, allow_any_host, digest, digest_hour, timezone FROM chat_destinations WHERE id = ?',
      ['d1'],
    );
    assert.equal(row?.locale, 'en');
    assert.equal(Number(row?.enabled), 1);
    assert.equal(
      Number(row?.allow_any_host),
      0,
      'a host outside the provider domains is never allowed by default',
    );
    assert.equal(row?.digest, 'off');
    assert.equal(Number(row?.digest_hour), 8);
    assert.equal(row?.timezone, 'UTC');

    assert.deepEqual(await migrate(db), []);
  },
);
