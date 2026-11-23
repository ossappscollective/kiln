import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const INSIGHTS = 55;

/** The state of a user who ran the app before migration 55. */
async function upTo54(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < INSIGHTS)) {
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

dbTest('migration 55 adds the dismissed Insights cards; earlier data is untouched', async (db) => {
  assert.equal(migrations.find((m) => m.id === INSIGHTS)?.id, INSIGHTS);
  assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
  await upTo54(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

  assert.deepEqual(
    (await migrate(db)).filter((id) => id === INSIGHTS),
    [INSIGHTS],
  );
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
  assert.deepEqual((await tableColumns(db, 'insight_dismissals')).map((c) => c.name).sort(), [
    'app_id',
    'card_id',
    'dismissed_at',
    'dismissed_by',
    'fingerprint',
    'workspace_id',
  ]);
  assert.ok((await tableIndexes(db, 'insight_dismissals')).includes('insight_dismissals_workspace_idx'));

  const row = (app: string, card: string, workspace = 'w1') =>
    db.execute(
      'INSERT INTO insight_dismissals (app_id, card_id, workspace_id, fingerprint, dismissed_at) VALUES (?, ?, ?, ?, 5)',
      [app, card, workspace, 'up:10'],
    );
  await row('a1', 'visibility');
  await row('a1', 'localize:de');
  await row('a2', 'visibility');
  await assert.rejects(() => row('a1', 'visibility'), 'one row per app and card');
  await assert.rejects(() => row('a3', 'visibility', 'nope'), 'the workspace must exist');

  assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
});
