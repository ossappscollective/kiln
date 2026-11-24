import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const TIMELINE = 57;

/** The state of a user who ran the app before migration 57. */
async function upTo56(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < TIMELINE)) {
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

dbTest('migration 57 adds the timeline events table; earlier data is untouched', async (db) => {
  assert.equal(migrations.find((m) => m.id === TIMELINE)?.id, TIMELINE);
  await upTo56(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  const applied = await migrate(db);
  assert.deepEqual(
    applied.filter((id) => id === TIMELINE),
    [TIMELINE],
  );
  assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
  assert.deepEqual((await tableColumns(db, 'timeline_events')).map((c) => c.name).sort(), [
    'app_id',
    'created_at',
    'created_by',
    'day',
    'id',
    'kind',
    'note',
    'title',
    'updated_at',
    'workspace_id',
  ]);
  const indexes = await tableIndexes(db, 'timeline_events');
  assert.ok(indexes.includes('timeline_events_app_idx'));
  assert.ok(indexes.includes('timeline_events_workspace_idx'));
  const insert = (workspaceId: string) =>
    db.execute(
      `INSERT INTO timeline_events (id, workspace_id, app_id, kind, day, title, created_by, created_at, updated_at)
       VALUES ('e1', ?, 'a1', 'press', '2026-03-01', 'Featured', 'u1', 1, 1)`,
      [workspaceId],
    );
  await assert.rejects(() => insert('nope'), 'the workspace must exist');
  await insert('w1');
  assert.equal(String((await db.query('SELECT note FROM timeline_events'))[0]?.note), '');
  assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
});
