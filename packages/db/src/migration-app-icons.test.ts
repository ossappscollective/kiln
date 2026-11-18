import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

dbTest('the app icons migration adds app_icons and leaves the data that exists untouched', async (db) => {
  const mine = migrations.find((m) => m.name.startsWith('app icons'));
  assert.ok(mine, 'the migration exists');
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < mine.id)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");

  const applied = await migrate(db);
  assert.ok(applied.includes(mine.id), 'the migration was applied');

  // A look that failed: no image, only the state of the attempts.
  await db.execute(
    "INSERT INTO app_icons (app_id, workspace_id, checked_at, failures, backoff_until, last_error) VALUES ('a1', 'w1', 100, 2, 900, 'It broke')",
  );
  const [failed] = await db.query('SELECT source, data, failures, backoff_until, last_error FROM app_icons WHERE app_id = ?', ['a1']);
  assert.equal(failed?.source, null);
  assert.equal(failed?.data, null);
  assert.equal(Number(failed?.failures), 2);
  assert.equal(Number(failed?.backoff_until), 900);

  // An icon: base64 text, with where it came from.
  await db.execute(
    `INSERT INTO app_icons (app_id, workspace_id, source, source_id, media_type, data, size, width, height, etag, fetched_at, checked_at)
     VALUES ('a2', 'w1', 'repository', 'abc123', 'image/png', 'aGVsbG8=', 5, 512, 512, 'e1', 100, 100)`,
  );
  const [icon] = await db.query('SELECT source, source_id, media_type, data, size, width, failures, backoff_until FROM app_icons WHERE app_id = ?', ['a2']);
  assert.equal(icon?.source, 'repository');
  assert.equal(icon?.data, 'aGVsbG8=');
  assert.equal(Number(icon?.width), 512);
  assert.equal(Number(icon?.failures), 0, 'a new row has no failures');
  assert.equal(icon?.backoff_until, null);

  // One row per app.
  await assert.rejects(
    db.execute("INSERT INTO app_icons (app_id, workspace_id, checked_at) VALUES ('a2', 'w1', 1)"),
    'app_id is the key',
  );

  // Running the migrations again changes nothing.
  assert.deepEqual(await migrate(db), []);
  const [count] = await db.query('SELECT COUNT(*) AS n FROM app_icons');
  assert.equal(Number(count?.n), 2);
});
