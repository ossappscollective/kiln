import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const BLOBS = 26;

async function upTo25(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < BLOBS)) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements(tx.dialect)) await tx.execute(statement);
      await tx.execute('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [migration.id, migration.name, 1]);
    });
  }
}

dbTest('migration 26 adds staged asset blobs; staged rows and drafts of migrations 1 to 25 are untouched', async (db) => {
  assert.equal(migrations[BLOBS - 1]?.id, BLOBS, 'ids are contiguous');
  await upTo25(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
  // A set staged from the repository before this migration: it must survive byte for byte and keep working by reference.
  await db.execute(
    `INSERT INTO staged_changes
       (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit,
        asset_bytes, asset_width, asset_height, asset_format, asset_alpha, created_by, created_at, updated_at)
     VALUES ('f1', 'w1', 'a1', 'ios', 'asset', 'en-US', 'screenshot:iphone_6_5', 0, 'repo', 'oid1', 'shots/1.png', 'c', 10, 1242, 2688, 'png', 0, 'u1', 5, 5)`,
  );

  const applied = await migrate(db);
  assert.deepEqual(applied.filter((id) => id === BLOBS), [BLOBS]);
  const [kept] = await db.query('SELECT source, value_hash, asset_path FROM staged_changes WHERE id = ?', ['f1']);
  assert.equal(kept?.source, 'repo');
  assert.equal(kept?.value_hash, 'oid1');
  assert.equal(kept?.asset_path, 'shots/1.png');

  assert.deepEqual((await tableColumns(db, 'staged_asset_blobs')).map((c) => c.name), [
    'app_id',
    'created_at',
    'created_by',
    'data',
    'id',
    'media_type',
    'oid',
    'sha256',
    'size',
    'workspace_id',
  ]);
  const indexes = (await tableIndexes(db, 'staged_asset_blobs')).map((i) => (typeof i === 'string' ? i : (i as { name: string }).name));
  assert.ok(indexes.includes('staged_asset_blobs_oid_idx'));

  const blob = (id: string, oid: string, ws = 'w1', app = 'a1') =>
    db.execute(
      `INSERT INTO staged_asset_blobs (id, workspace_id, app_id, oid, sha256, size, media_type, data, created_by, created_at)
       VALUES (?, ?, ?, ?, 'sha', 5, 'image/png', 'aGVsbG8=', 'u1', 9)`,
      [id, ws, app, oid],
    );
  await blob('b1', 'oid2');
  const [row] = await db.query('SELECT data, size, media_type FROM staged_asset_blobs WHERE id = ?', ['b1']);
  assert.equal(row?.data, 'aGVsbG8=');
  assert.equal(Number(row?.size), 5);
  // The same bytes of one app are kept once; another app may hold the same bytes; a missing workspace holds none.
  await assert.rejects(blob('b2', 'oid2'));
  await blob('b3', 'oid2', 'w1', 'a2');
  await assert.rejects(blob('b4', 'oid9', 'missing'));
  // Running the migrations again changes nothing.
  assert.deepEqual(await migrate(db), []);
});
