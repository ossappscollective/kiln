import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const PRICES = 66;

async function upTo65(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < PRICES)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}
const columns = async (db: Database, table: string) => (await tableColumns(db, table)).map((c) => c.name).sort();

dbTest('migration 66 adds the staged price changes and the price claim; older data is untouched', async (db) => {
  assert.equal(migrations.find((m) => m.id === PRICES)?.id, PRICES);
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo65(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  const applied = await migrate(db);
  assert.deepEqual(applied.filter((id) => id === PRICES), [PRICES]);
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
  assert.deepEqual(await columns(db, 'staged_price_changes'), [
    'app_id', 'created_at', 'created_by', 'id', 'payload_json', 'plan_id', 'product_id', 'store', 'synced_at', 'updated_at', 'value_hash', 'workspace_id',
  ]);
  assert.deepEqual(await columns(db, 'store_price_claims'), ['app_id', 'claim_at', 'claimed_by', 'status', 'workspace_id']);
  assert.ok((await tableIndexes(db, 'staged_price_changes')).includes('staged_price_changes_slot_idx'));
  const row = ['p1', 'w1', 'a1', 'pro', '', 'googleplay', '{}', 'h', 1, 'u1', 1, 1];
  const insert = 'INSERT INTO staged_price_changes (id, workspace_id, app_id, product_id, plan_id, store, payload_json, value_hash, synced_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  await db.execute(insert, row);
  await assert.rejects(db.execute(insert, ['p2', ...row.slice(1)]), 'one staged row per product and plan');
  assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
});
