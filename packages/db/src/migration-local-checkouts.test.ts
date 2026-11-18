import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';
import type { Database } from './index.ts';

const LOCAL_CHECKOUTS = 13;

/** Applies migrations 1..upTo the way `migrate` does, so a test can put data in an older schema. */
async function migrateUpTo(db: Database, upTo: number): Promise<void> {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id <= upTo)) {
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

async function seed(db: Database) {
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1), ('w2', 'Other', 1)");
  await db.execute(
    "INSERT INTO credentials (id, workspace_id, kind, label, ciphertext, created_at) VALUES ('c1', 'w1', 'github_token', 'GitHub', 'x', 1)",
  );
  await db.execute(
    `INSERT INTO repositories (id, workspace_id, credential_id, owner, repo, default_branch, project_kind, detected_at, detection_json, created_at)
     VALUES ('r1', 'w1', 'c1', 'acme', 'app', 'main', 'fastlane', 5, '{"kind":"fastlane"}', 2),
            ('r2', 'w1', 'c1', 'acme', 'other', 'develop', NULL, NULL, NULL, 3),
            ('r3', 'w2', 'c1', 'acme', 'app', 'main', NULL, NULL, NULL, 4)`,
  );
  await db.execute(
    `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, created_at, updated_at)
     VALUES ('cs1', 'w1', 'r1', 'Update', 'draft', 'user', 'u1', '[]', 6, 6),
            ('cs2', 'w1', 'r1', 'Applied', 'applied', 'user', 'u1', '[]', 7, 7),
            ('cs3', 'w1', 'r2', 'Other', 'draft', 'user', 'u1', '[]', 8, 8)`,
  );
  await db.execute(
    `INSERT INTO repository_listing_targets (id, workspace_id, repository_id, name, app_store_root, created_at, updated_at)
     VALUES ('t1', 'w1', 'r1', 'ios', 'ios/fastlane/metadata', 9, 9)`,
  );
  await db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, repository_id, created_at)
     VALUES ('a1', 'w1', 'Acme', 'ios', 'com.acme.app', 'c1', 'r1', 10)`,
  );
}

dbTest('migration 13 keeps repositories, change sets and listing targets, and their foreign keys', async (db) => {
  assert.ok(migrations.some((m) => m.id === LOCAL_CHECKOUTS), 'the migration exists');
  await migrateUpTo(db, LOCAL_CHECKOUTS - 1);
  await seed(db);
  const before = await db.query('SELECT * FROM repositories ORDER BY id');

  const applied = await migrate(db);
  assert.ok(applied.includes(LOCAL_CHECKOUTS));

  const after = await db.query('SELECT * FROM repositories ORDER BY id');
  assert.deepEqual(after, before, 'every repository row is unchanged');
  const counts = async (table: string) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n);
  assert.equal(await counts('change_sets'), 3);
  assert.equal(await counts('repository_listing_targets'), 1);
  assert.equal(await counts('apps'), 1);
  assert.equal(await counts('credentials'), 1);

  // The children still join to their parents.
  const joined = await db.query(
    `SELECT c.id AS id, r.owner AS owner, r.repo AS repo FROM change_sets c JOIN repositories r ON r.id = c.repository_id ORDER BY c.id`,
  );
  assert.deepEqual(joined, [
    { id: 'cs1', owner: 'acme', repo: 'app' },
    { id: 'cs2', owner: 'acme', repo: 'app' },
    { id: 'cs3', owner: 'acme', repo: 'other' },
  ]);

  if (db.dialect === 'sqlite') {
    assert.deepEqual(await db.query('PRAGMA foreign_key_check'), [], 'no orphan rows');
    assert.deepEqual(await db.query('PRAGMA foreign_keys'), [{ foreign_keys: 1 }]);
    // Foreign keys are still enforced on the rebuilt table.
    await assert.rejects(
      db.execute(
        `INSERT INTO change_sets (id, workspace_id, repository_id, summary, status, created_by_type, created_by_id, files_json, created_at, updated_at)
         VALUES ('bad', 'w1', 'nope', 's', 'draft', 'user', 'u', '[]', 1, 1)`,
      ),
      /foreign key/i,
    );
    await assert.rejects(db.execute("DELETE FROM repositories WHERE id = 'r1'"), /foreign key/i);
  }

  // The unique index is back: the same owner/repo twice in one workspace is refused, in another is fine.
  await assert.rejects(
    db.execute(
      "INSERT INTO repositories (id, workspace_id, credential_id, owner, repo, default_branch, created_at) VALUES ('dup', 'w1', 'c1', 'acme', 'app', 'main', 1)",
    ),
  );
  assert.equal(await counts('repositories'), 3);
});

dbTest('after migration 13 a repository can have no credential, owner or repo, and a checkout row', async (db) => {
  await migrateUpTo(db, LOCAL_CHECKOUTS - 1);
  await seed(db);
  await migrate(db);
  // Two local-only repositories in one workspace: NULLs do not collide in the unique index.
  for (const id of ['l1', 'l2']) {
    await db.execute(
      "INSERT INTO repositories (id, workspace_id, credential_id, owner, repo, default_branch, created_at) VALUES (?, 'w1', NULL, NULL, NULL, 'main', 20)",
      [id],
    );
  }
  await db.execute(
    `INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at)
     VALUES ('l1', 'w1', '/Volumes/dev/a', 'main', 'a', 'u1', 21, 21), ('r1', 'w1', '/Volumes/dev/b', 'main', 'b', 'u1', 21, 21)`,
  );
  // One checkout per repository, one repository per path in a workspace.
  await assert.rejects(
    db.execute(
      "INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at) VALUES ('l1', 'w1', '/x', 'main', 'x', 'u', 1, 1)",
    ),
  );
  await assert.rejects(
    db.execute(
      "INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at) VALUES ('l2', 'w1', '/Volumes/dev/a', 'main', 'a', 'u', 1, 1)",
    ),
  );
  // The same path in another workspace is fine.
  await db.execute("INSERT INTO repositories (id, workspace_id, default_branch, created_at) VALUES ('l3', 'w2', 'main', 22)");
  await db.execute(
    "INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at) VALUES ('l3', 'w2', '/Volumes/dev/a', 'main', 'a', 'u', 1, 1)",
  );
  // A checkout cannot point at a repository that is not there.
  await assert.rejects(
    db.execute(
      "INSERT INTO repository_local_checkouts (repository_id, workspace_id, path, branch, name, created_by, created_at, updated_at) VALUES ('ghost', 'w1', '/g', 'main', 'g', 'u', 1, 1)",
    ),
    /foreign key/i,
  );
});

dbTest('migration 13 runs on an empty repositories table and on a database already at the latest version', async (db) => {
  await migrateUpTo(db, LOCAL_CHECKOUTS - 1);
  assert.ok((await migrate(db)).includes(LOCAL_CHECKOUTS));
  assert.deepEqual(await migrate(db), [], 'a second run applies nothing');
});
