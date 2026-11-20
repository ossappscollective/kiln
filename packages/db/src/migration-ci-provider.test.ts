import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const CI_PROVIDER = 46;

/** The state of a user who ran the app before migration 46. */
async function upTo45(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < CI_PROVIDER)) {
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

const insertRun = (db: Database, id: string, extra: string[] = []) =>
  db.execute(
    `INSERT INTO workflow_runs (id, workspace_id, repository_id, run_id, workflow, status, started_at, run_updated_at, synced_at${extra.length ? ', provider' : ''})
     VALUES (?, 'w1', 'r1', ?, 'ios.yml', 'completed', 1, 1, 1${extra.length ? ', ?' : ''})`,
    [id, id, ...extra],
  );

dbTest(
  'migration 46 adds the provider of a stored CI run: existing runs are GitHub runs, data of migrations 1 to 45 is untouched',
  async (db) => {
    assert.equal(migrations.find((m) => m.id === CI_PROVIDER)?.id, CI_PROVIDER);
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo45(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await insertRun(db, 'old');

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === CI_PROVIDER),
      [CI_PROVIDER],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');

    const provider = (await tableColumns(db, 'workflow_runs')).find((c) => c.name === 'provider');
    assert.ok(provider, 'the column exists');
    assert.equal(
      String((await db.query("SELECT provider FROM workflow_runs WHERE id = 'old'"))[0]?.provider),
      'github',
    );

    // A new row without a provider (older code) is GitHub's; one with a provider keeps it.
    await insertRun(db, 'plain');
    await insertRun(db, 'eas', ['eas-workflows']);
    const rows = await db.query('SELECT id, provider FROM workflow_runs ORDER BY id');
    assert.deepEqual(
      rows.map((r) => [String(r.id), String(r.provider)]),
      [
        ['eas', 'eas-workflows'],
        ['old', 'github'],
        ['plain', 'github'],
      ],
    );

    // Running again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
