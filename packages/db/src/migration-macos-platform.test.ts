import assert from 'node:assert/strict';
import { migrate, migrations } from './index.ts';
import { dbTest } from './testing.ts';

// macOS is a third value of the platform columns (`ios`, `macos`, `android`). Those columns are plain TEXT with no
// CHECK constraint (the apps unique index is (workspace, platform, identifier)), so no migration was needed and the
// table rebuild a CHECK would have forced does not exist. These tests hold that: if a later migration adds a CHECK on
// a platform column, they fail until it admits `macos`.

dbTest('no migration constrains a platform column with a CHECK', async () => {
  for (const migration of migrations) {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      for (const statement of migration.statements(dialect)) {
        assert.ok(
          !/CHECK\s*\([^)]*platform/i.test(statement),
          `migration ${migration.id} has a CHECK on platform`,
        );
      }
    }
  }
});

dbTest(
  'a macOS record sits beside the iOS record with the same bundle id (universal purchase), and everything keyed by platform takes it',
  async (db) => {
    await migrate(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    const app = (id: string, platform: string, identifier: string) =>
      db.execute(
        `INSERT INTO apps (id, workspace_id, name, platform, identifier, store_app_id, credential_id, created_at)
       VALUES (?, 'w1', 'Trail Notes', ?, ?, '1234567890', 'c1', 5)`,
        [id, platform, identifier],
      );
    await app('a-ios', 'ios', 'com.acme.trail');
    await app('a-mac', 'macos', 'com.acme.trail');
    await app('a-and', 'android', 'com.acme.trail');
    // Still one record per workspace, platform and identifier.
    await assert.rejects(app('a-mac2', 'macos', 'com.acme.trail'));
    const rows = await db.query(
      "SELECT id, platform FROM apps WHERE workspace_id = 'w1' ORDER BY id",
    );
    assert.deepEqual(
      rows.map((r) => [r.id, r.platform]),
      [
        ['a-and', 'android'],
        ['a-ios', 'ios'],
        ['a-mac', 'macos'],
      ],
    );

    // The per platform tables: releases, build links, and the claims that keep one store write in flight per app and platform.
    await db.execute(
      "INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, raw_state, synced_at) VALUES ('r1', 'a-mac', 'w1', 'macos', '2.0', '', 'READY_FOR_SALE', 9)",
    );
    await db.execute(
      "INSERT INTO build_links (id, workspace_id, app_id, platform, build_number, repository_id, run_id, head_sha, source, linked_at) VALUES ('l1', 'w1', 'a-mac', 'macos', '77', 'rp', 'run', 'sha', 'manual', 9)",
    );
    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, claimed_by, claim_at) VALUES ('a-mac', 'macos', 'w1', 'pause', 'u1', 9)",
    );
    await db.execute(
      "INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, claimed_by, claim_at) VALUES ('a-ios', 'ios', 'w1', 'pause', 'u1', 9)",
    );
    const [release] = await db.query("SELECT platform FROM app_releases WHERE app_id = 'a-mac'");
    assert.equal(release?.platform, 'macos');
    // Running the migrations again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
