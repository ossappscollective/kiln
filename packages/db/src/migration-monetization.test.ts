import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const MONETIZATION = 45;

/** The state of a user who ran the app before migration 45. */
async function upTo44(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < MONETIZATION)) {
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

const columns = async (db: Database, table: string) =>
  (await tableColumns(db, table)).map((c) => c.name).sort();

dbTest(
  'migration 45 adds the in-app product tables; data of migrations 1 to 44 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === MONETIZATION)?.id, MONETIZATION);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo44(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === MONETIZATION),
      [MONETIZATION],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    assert.deepEqual(await columns(db, 'store_products'), [
      'app_id',
      'availability_json',
      'base_territory',
      'detail_json',
      'group_name',
      'kind',
      'period',
      'product_id',
      'raw_hash',
      'raw_state',
      'reference_name',
      'state',
      'store_ref',
      'synced_at',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_product_localizations'), [
      'app_id',
      'description',
      'locale',
      'name',
      'product_id',
      'store_ref',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_product_prices'), [
      'amount',
      'app_id',
      'currency',
      'plan_id',
      'product_id',
      'territory',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_product_sync'), [
      'app_id',
      'complete',
      'failures',
      'last_attempt_at',
      'last_error',
      'last_synced_at',
      'product_count',
      'warnings_json',
      'workspace_id',
    ]);
    assert.deepEqual(await columns(db, 'store_product_claims'), [
      'app_id',
      'claim_at',
      'claimed_by',
      'product_id',
      'status',
      'workspace_id',
    ]);
    for (const table of [
      'store_products',
      'store_product_localizations',
      'store_product_prices',
      'store_product_sync',
      'store_product_claims',
    ]) {
      assert.ok((await tableIndexes(db, table)).includes(`${table}_workspace_idx`), table);
    }

    const product = (appId: string, productId: string, workspaceId = 'w1') =>
      db.execute(
        `INSERT INTO store_products (app_id, product_id, workspace_id, kind, reference_name, state, raw_hash, synced_at)
         VALUES (?, ?, ?, 'subscription', 'Pro', 'active', 'h', 5)`,
        [appId, productId, workspaceId],
      );
    await product('a1', 'pro.monthly');
    await product('a2', 'pro.monthly');
    await assert.rejects(() => product('a1', 'pro.monthly'), 'app_id + product_id is the key');
    await assert.rejects(() => product('a3', 'pro.monthly', 'nope'), 'the workspace must exist');

    const localization = (locale: string) =>
      db.execute(
        `INSERT INTO store_product_localizations (app_id, product_id, locale, workspace_id, name, description)
         VALUES ('a1', 'pro.monthly', ?, 'w1', 'Pro', 'All features')`,
        [locale],
      );
    await localization('en-US');
    await localization('de-DE');
    await assert.rejects(() => localization('en-US'), 'one row per locale');

    const price = (planId: string, territory: string) =>
      db.execute(
        `INSERT INTO store_product_prices (app_id, product_id, plan_id, territory, workspace_id, currency, amount)
         VALUES ('a1', 'pro.monthly', ?, ?, 'w1', 'USD', '499')`,
        [planId, territory],
      );
    await price('', 'USA');
    await price('', 'DEU');
    await price('yearly', 'USA');
    await assert.rejects(() => price('', 'USA'), 'one price per plan and territory');
    const defaulted = await db.query(
      `SELECT plan_id FROM store_product_prices WHERE territory = 'DEU'`,
    );
    assert.equal(String(defaulted[0]?.plan_id), '');

    await db.execute(
      `INSERT INTO store_product_sync (app_id, workspace_id) VALUES ('a1', 'w1')`,
    );
    const sync = (await db.query('SELECT failures, product_count, complete, warnings_json FROM store_product_sync'))[0];
    assert.equal(Number(sync?.failures), 0);
    assert.equal(Number(sync?.product_count), 0);
    assert.equal(Number(sync?.complete), 1);
    assert.equal(String(sync?.warnings_json), '[]');
    await assert.rejects(
      () => db.execute(`INSERT INTO store_product_sync (app_id, workspace_id) VALUES ('a1', 'w1')`),
      'one status row per app',
    );

    await db.execute(
      `INSERT INTO store_product_claims (app_id, workspace_id, product_id, claimed_by, claim_at)
       VALUES ('a1', 'w1', 'pro.monthly', 'u1', 5)`,
    );
    assert.equal(
      String((await db.query('SELECT status FROM store_product_claims'))[0]?.status),
      'writing',
    );
    await assert.rejects(
      () =>
        db.execute(
          `INSERT INTO store_product_claims (app_id, workspace_id, product_id, claimed_by, claim_at)
           VALUES ('a1', 'w1', 'other', 'u2', 6)`,
        ),
      'one write in flight per app',
    );

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
