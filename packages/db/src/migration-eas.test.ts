import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const EAS = 44;

/** The state of a user who ran the app before migration 44. */
async function upTo43(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < EAS)) {
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
  'migration 44 adds the EAS link of an app; data of migrations 1 to 43 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === EAS)?.id, EAS);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo43(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === EAS),
      [EAS],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    assert.deepEqual((await tableColumns(db, 'app_expo_links')).map((c) => c.name).sort(), [
      'account_name',
      'app_id',
      'created_at',
      'credential_id',
      'linked_by',
      'project_id',
      'project_name',
      'slug',
      'updated_at',
      'verified_at',
      'workspace_id',
    ]);
    const indexes = await tableIndexes(db, 'app_expo_links');
    for (const name of [
      'app_expo_links_workspace_idx',
      'app_expo_links_project_idx',
      'app_expo_links_credential_idx',
    ]) {
      assert.ok(indexes.includes(name), name);
    }

    // One row per app; the workspace must exist; the same project may be linked by two app records.
    const insert = (appId: string, workspaceId: string, projectId: string) =>
      db.execute(
        `INSERT INTO app_expo_links (app_id, workspace_id, credential_id, project_id, account_name, slug, project_name, verified_at, linked_by, created_at, updated_at)
         VALUES (?, ?, 'c1', ?, 'acme', 'trail', 'Trail', 5, 'u1', 5, 5)`,
        [appId, workspaceId, projectId],
      );
    await insert('a1', 'w1', 'p1');
    await insert('a2', 'w1', 'p1');
    await assert.rejects(() => insert('a1', 'w1', 'p2'), 'app_id is the primary key');
    await assert.rejects(() => insert('a3', 'nope', 'p1'), 'the workspace must exist');
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM app_expo_links'))[0]?.n), 2);

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
