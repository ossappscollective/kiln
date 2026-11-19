import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const SIGNALS = 28;

/** The state of a user who ran the app before migration 28, with runs and releases in the older tables. */
async function upTo27(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < SIGNALS)) {
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

const run = (db: Database, id: string, appId: string | null, runId: string, startedAt = 100) =>
  db.execute(
    `INSERT INTO workflow_runs (id, workspace_id, repository_id, app_id, run_id, workflow, status, started_at, run_updated_at, synced_at)
     VALUES (?, 'w1', 'r1', ?, ?, 'ios.yml', 'completed', ?, ?, ?)`,
    [id, appId, runId, startedAt, startedAt, startedAt],
  );

dbTest(
  'migration 28 links existing runs to their app, backfills the step time and adds the new tables; older rows are untouched',
  async (db) => {
    assert.equal(migrations[SIGNALS - 1]?.id, SIGNALS, 'ids are contiguous');
    await upTo27(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
     VALUES ('a1', 'w1', 'Acme', 'ios', 'com.acme.app', 'c', 1)`,
    );
    await run(db, 'row1', 'a1', '1001', 100);
    await run(db, 'row2', null, '1002', 200);
    await run(db, 'row3', 'gone', '1003', 300);
    await db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, store_updated_at, synced_at)
     VALUES ('rel1', 'a1', 'w1', 'ios', '2.4.0', '', '412', 'draft', 'PREPARE_FOR_SUBMISSION', 5, 777)`,
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === SIGNALS),
      [SIGNALS],
    );

    // Data migration: the single app column became a link; a run without an app and a run of a deleted app got none.
    const links = await db.query(
      'SELECT run_ref, app_id, workspace_id, created_at FROM ci_run_apps ORDER BY run_ref',
    );
    assert.deepEqual(
      links.map((l) => [
        String(l.run_ref),
        String(l.app_id),
        String(l.workspace_id),
        Number(l.created_at),
      ]),
      [['row1', 'a1', 'w1', 100]],
    );
    // The old column is kept, untouched.
    assert.equal(
      String((await db.query("SELECT app_id FROM workflow_runs WHERE id = 'row1'"))[0]?.app_id),
      'a1',
    );
    assert.equal(
      (await db.query("SELECT app_id FROM workflow_runs WHERE id = 'row3'"))[0]?.app_id,
      'gone',
    );
    // The clock of a release starts at the last sync, never at an invented earlier time.
    const release = (
      await db.query(
        "SELECT status_since, synced_at, build, raw_state FROM app_releases WHERE id = 'rel1'",
      )
    )[0];
    assert.equal(Number(release?.status_since), 777);
    assert.equal(String(release?.build), '412');
    assert.equal(String(release?.raw_state), 'PREPARE_FOR_SUBMISSION');

    assert.deepEqual(
      (await tableColumns(db, 'ci_run_apps')).map((c) => c.name),
      ['app_id', 'created_at', 'run_ref', 'workspace_id'],
    );
    assert.ok((await tableIndexes(db, 'ci_run_apps')).includes('ci_run_apps_app_idx'));
    assert.deepEqual(
      (await tableColumns(db, 'app_builds')).map((c) => c.name),
      [
        'app_id',
        'build_number',
        'expired',
        'first_seen_at',
        'last_seen_at',
        'platform',
        'processing_state',
        'raw_state',
        'store_id',
        'uploaded_at',
        'version',
        'workspace_id',
      ],
    );
    assert.deepEqual(
      (await tableColumns(db, 'release_stall_reminders')).map((c) => c.name),
      [
        'app_id',
        'episode_key',
        'first_sent_at',
        'last_sent_at',
        'platform',
        'sent_count',
        'step',
        'workspace_id',
      ],
    );
    assert.deepEqual(
      (await tableColumns(db, 'review_unanswered_reminders')).map((c) => c.name),
      ['last_count', 'last_oldest_at', 'last_sent_at', 'workspace_id'],
    );

    // A run links to several apps; the same pair twice is refused; deleting the run deletes its links.
    const link = (runRef: string, appId: string) =>
      db.execute(
        "INSERT INTO ci_run_apps (run_ref, app_id, workspace_id, created_at) VALUES (?, ?, 'w1', 1)",
        [runRef, appId],
      );
    await link('row2', 'a1');
    await link('row2', 'a2');
    await assert.rejects(link('row2', 'a2'), 'one link per run and app');
    await assert.rejects(link('missing', 'a1'), 'a link needs its run');
    await db.execute("DELETE FROM workflow_runs WHERE id = 'row2'");
    assert.equal(
      Number(
        (await db.query("SELECT COUNT(*) AS n FROM ci_run_apps WHERE run_ref = 'row2'"))[0]?.n,
      ),
      0,
    );

    // One reminder row per app and platform, one digest row per workspace.
    const stall = (episode: string) =>
      db.execute(
        `INSERT INTO release_stall_reminders (app_id, platform, workspace_id, episode_key, step, first_sent_at, last_sent_at)
       VALUES ('a1', 'ios', 'w1', ?, 'draft', 5, 5)`,
        [episode],
      );
    await stall('draft:2.4.0');
    await assert.rejects(stall('draft:2.5.0'));
    await db.execute(
      "INSERT INTO review_unanswered_reminders (workspace_id, last_sent_at, last_count) VALUES ('w1', 5, 3)",
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO review_unanswered_reminders (workspace_id, last_sent_at, last_count) VALUES ('w1', 6, 4)",
      ),
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO review_unanswered_reminders (workspace_id, last_sent_at, last_count) VALUES ('nope', 6, 4)",
      ),
    );

    // Builds: unique per app, platform and build number.
    const build = (n: string) =>
      db.execute(
        `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, processing_state, first_seen_at, last_seen_at)
       VALUES ('a1', 'ios', ?, 'w1', 'processed', 1, 1)`,
        [n],
      );
    await build('412');
    await build('413');
    await assert.rejects(build('412'));

    // Running the migrations again changes nothing.
    assert.deepEqual(await migrate(db), []);
  },
);
