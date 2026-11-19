import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const STAGED = 23;

/** Brings the database to the state a user who ran the app before migration 23 has, with data in older tables. */
async function upTo22(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < STAGED)) {
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
  'migration 23 adds staged changes and draft claims; data of migrations 1 to 22 is untouched',
  async (db) => {
    assert.equal(migrations.length >= STAGED, true);
    assert.equal(migrations[STAGED - 1]?.id, STAGED, 'ids are contiguous');
    await upTo22(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    // Rows of the tables an earlier agent's features own: they must survive, byte for byte.
    await db.execute(
      `INSERT INTO app_reviews
       (id, workspace_id, app_id, store, store_review_id, rating, body, created_at, updated_at, first_seen_at, fetched_at)
     VALUES ('r1', 'w1', 'a1', 'googleplay', 'gp:1', 2, 'Bad', 10, 10, 20, 20)`,
    );
    await db.execute(
      `INSERT INTO store_rollout_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'android', 'w1', 'halt', 'u1', 30)`,
    );

    const applied = await migrate(db);
    // Later migrations are applied by the same call: only this one is checked here.
    assert.deepEqual(
      applied.filter((id) => id === STAGED),
      [STAGED],
    );
    assert.equal((await db.query('SELECT id FROM app_reviews WHERE id = ?', ['r1'])).length, 1);
    assert.equal(
      String((await db.query('SELECT action FROM store_rollout_claims'))[0]?.action),
      'halt',
    );

    assert.deepEqual(
      (await tableColumns(db, 'staged_changes')).map((c) => c.name),
      [
        'app_id',
        'asset_alpha',
        'asset_bytes',
        'asset_commit',
        'asset_format',
        'asset_height',
        'asset_path',
        'asset_width',
        'created_at',
        'created_by',
        'id',
        'kind',
        'locale',
        'ordinal',
        'platform',
        'pushed_at',
        'pushed_hash',
        'source',
        'target',
        'updated_at',
        'value_hash',
        'value_text',
        'workspace_id',
      ],
    );
    assert.deepEqual(
      (await tableColumns(db, 'store_draft_claims')).map((c) => c.name),
      ['action', 'app_id', 'claim_at', 'claimed_by', 'platform', 'status', 'workspace_id'],
    );
    const indexes = (await tableIndexes(db, 'staged_changes')).map((i) =>
      typeof i === 'string' ? i : (i as { name: string }).name,
    );
    assert.ok(indexes.includes('staged_changes_slot_idx'));

    const text = (id: string, locale: string, field: string, value = 'x', ws = 'w1') =>
      db.execute(
        `INSERT INTO staged_changes
         (id, workspace_id, app_id, platform, kind, locale, target, source, value_text, value_hash, created_by, created_at, updated_at)
       VALUES (?, ?, 'a1', 'ios', 'listing_text', ?, ?, 'local', ?, 'h', 'u1', 5, 5)`,
        [id, ws, locale, field, value],
      );
    await text('s1', 'en-US', 'description');
    const [row] = await db.query(
      'SELECT ordinal, pushed_at, pushed_hash FROM staged_changes WHERE id = ?',
      ['s1'],
    );
    assert.equal(Number(row?.ordinal), 0, 'a text sits at ordinal 0');
    assert.equal(row?.pushed_at, null, 'never pushed until a push says so');
    // One row per app, kind, locale, target and place: staging the same field again replaces, it never doubles.
    await assert.rejects(text('s2', 'en-US', 'description'));
    await text('s3', 'de-DE', 'description');
    // A set of graphics is one row per file, in order.
    const file = (id: string, ordinal: number) =>
      db.execute(
        `INSERT INTO staged_changes
         (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_hash, asset_path, asset_commit,
          asset_bytes, asset_width, asset_height, asset_format, asset_alpha, created_by, created_at, updated_at)
       VALUES (?, 'w1', 'a1', 'ios', 'asset', 'en-US', 'screenshot:iphone_6_5', ?, 'repo', 'oid', 'shots/1.png', 'c', 10, 1242, 2688, 'png', 0, 'u1', 5, 5)`,
        [id, ordinal],
      );
    await file('f1', 0);
    await file('f2', 1);
    await assert.rejects(file('f3', 1));
    // A workspace that does not exist cannot hold rows.
    await assert.rejects(text('s9', 'fr-FR', 'description', 'x', 'missing'));

    const claim = (appId: string, platform: string, workspace = 'w1') =>
      db.execute(
        `INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
       VALUES (?, ?, ?, 'push', 'u1', 30)`,
        [appId, platform, workspace],
      );
    await claim('a1', 'android');
    assert.equal(
      String((await db.query('SELECT status FROM store_draft_claims'))[0]?.status),
      'writing',
    );
    await assert.rejects(claim('a1', 'android'), 'one write in flight per app and platform');
    await claim('a1', 'ios');
    await assert.rejects(claim('a3', 'android', 'missing'));
    // The draft claims are their own table: a rollout write and a draft write do not share a row.
    assert.equal((await db.query('SELECT app_id FROM store_rollout_claims')).length, 1);
    const taken = await db.execute(
      `INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, claimed_by, claim_at)
     VALUES ('a1', 'android', 'w1', 'push', 'u2', 40) ON CONFLICT (app_id, platform) DO NOTHING`,
    );
    assert.equal(taken, 0);
  },
);

dbTest(
  'migration 23 runs once: a second migrate applies nothing, and a database that has it is left as it is',
  async (db) => {
    await migrate(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      `INSERT INTO staged_changes
       (id, workspace_id, app_id, platform, kind, locale, target, source, value_text, value_hash, created_by, created_at, updated_at)
     VALUES ('s1', 'w1', 'a1', 'android', 'listing_text', 'en-US', 'title', 'local', 'Hi', 'h', 'u1', 5, 5)`,
    );
    assert.deepEqual(await migrate(db), []);
    assert.equal((await db.query('SELECT id FROM staged_changes')).length, 1);
  },
);
