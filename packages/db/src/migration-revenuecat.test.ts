import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const REVENUECAT = 48;

/** The state of a user who ran the app before migration 48. */
async function upTo47(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < REVENUECAT)) {
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
  'migration 48 adds the RevenueCat link and the cached configuration; data of migrations 1 to 47 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === REVENUECAT)?.id, REVENUECAT);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo47(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === REVENUECAT),
      [REVENUECAT],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    const names = async (table: string) =>
      (await tableColumns(db, table)).map((c) => c.name).sort();
    assert.deepEqual(await names('app_revenuecat_links'), [
      'app_id',
      'created_at',
      'credential_id',
      'linked_by',
      'project_id',
      'project_name',
      'rc_app_id',
      'rc_app_name',
      'rc_app_type',
      'rc_identifier',
      'updated_at',
      'verified_at',
      'workspace_id',
    ]);
    assert.deepEqual(await names('revenuecat_products'), [
      'app_id',
      'display_name',
      'duration',
      'fetched_at',
      'grace_period',
      'product_type',
      'raw_state',
      'rc_product_id',
      'state',
      'store_identifier',
      'trial_duration',
      'workspace_id',
    ]);
    assert.deepEqual(await names('revenuecat_entitlements'), [
      'app_id',
      'display_name',
      'entitlement_id',
      'fetched_at',
      'lookup_key',
      'product_ids_json',
      'project_product_count',
      'raw_state',
      'state',
      'workspace_id',
    ]);
    assert.deepEqual(await names('revenuecat_offerings'), [
      'app_id',
      'display_name',
      'fetched_at',
      'is_current',
      'lookup_key',
      'offering_id',
      'packages_json',
      'raw_state',
      'state',
      'workspace_id',
    ]);
    assert.deepEqual(await names('revenuecat_sync'), [
      'app_id',
      'complete',
      'credential_id',
      'failures',
      'last_attempt_at',
      'last_error',
      'last_synced_at',
      'other_app_product_count',
      'product_count',
      'project_id',
      'warnings_json',
      'workspace_id',
    ]);
    for (const [table, index] of [
      ['app_revenuecat_links', 'app_revenuecat_links_workspace_idx'],
      ['app_revenuecat_links', 'app_revenuecat_links_credential_idx'],
      ['revenuecat_products', 'revenuecat_products_workspace_idx'],
      ['revenuecat_entitlements', 'revenuecat_entitlements_workspace_idx'],
      ['revenuecat_offerings', 'revenuecat_offerings_workspace_idx'],
      ['revenuecat_sync', 'revenuecat_sync_workspace_idx'],
    ] as const) {
      assert.ok((await tableIndexes(db, table)).includes(index), index);
    }

    // One row per product of an app; the workspace must exist; the defaults hold.
    const insert = (appId: string, productId: string, workspaceId = 'w1') =>
      db.execute(
        `INSERT INTO revenuecat_products (app_id, rc_product_id, workspace_id, store_identifier, product_type, state, fetched_at)
         VALUES (?, ?, ?, 'pro_monthly', 'subscription', 'active', 5)`,
        [appId, productId, workspaceId],
      );
    await insert('a1', 'prod1');
    await insert('a2', 'prod1');
    await assert.rejects(
      () => insert('a1', 'prod1'),
      'app_id and rc_product_id are the primary key',
    );
    await assert.rejects(() => insert('a3', 'prod1', 'nope'), 'the workspace must exist');
    await db.execute("INSERT INTO revenuecat_sync (app_id, workspace_id) VALUES ('a1', 'w1')");
    const [sync] = await db.query(
      'SELECT failures, complete, warnings_json FROM revenuecat_sync WHERE app_id = ?',
      ['a1'],
    );
    assert.equal(Number(sync?.failures), 0);
    assert.equal(Number(sync?.complete), 1);
    assert.equal(String(sync?.warnings_json), '[]');

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
