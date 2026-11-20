import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns, tableIndexes } from './testing.ts';

const FIRST = 37;
const SECOND = 38;

/** The state of a user who ran the app before migration 37. */
async function upTo36(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < FIRST)) {
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

const names = async (db: Database, table: string) =>
  (await tableColumns(db, table)).map((c) => c.name);

dbTest(
  'migrations 37 and 38 add the alert tables; data of the earlier migrations is untouched',
  async (db) => {
    assert.equal(migrations[FIRST - 1]?.id, FIRST, 'ids are contiguous');
    assert.equal(migrations[SECOND - 1]?.id, SECOND);
    await upTo36(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
    );
    await db.execute(
      "INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at) VALUES ('w1', 'reviews.lowRatingThreshold', '3', 1)",
    );

    const applied = await migrate(db);
    assert.deepEqual(
      applied.filter((id) => id === FIRST || id === SECOND),
      [FIRST, SECOND],
    );
    assert.equal(String((await db.query('SELECT name FROM workspaces'))[0]?.name), 'Acme');
    assert.equal(
      String((await db.query('SELECT value_json FROM workspace_settings'))[0]?.value_json),
      '3',
    );

    assert.deepEqual(await names(db, 'alert_workspace_rules'), [
      'alert_type',
      'channels',
      'enabled',
      'max_per_hour',
      'params',
      'updated_at',
      'updated_by',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_user_settings'), [
      'digest',
      'digest_hour',
      'last_digest_at',
      'min_severity',
      'quiet_end',
      'quiet_start',
      'timezone',
      'updated_at',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_preferences'), [
      'alert_type',
      'app_id',
      'channels',
      'updated_at',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_mutes'), [
      'alert_type',
      'app_id',
      'created_at',
      'id',
      'until',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alerts'), [
      'app_id',
      'body',
      'count',
      'data',
      'dedupe_key',
      'first_at',
      'id',
      'is_test',
      'last_at',
      'resolved_at',
      'severity',
      'title',
      'type',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_inbox'), [
      'alert_id',
      'created_at',
      'desktop',
      'read_at',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_deliveries'), [
      'alert_id',
      'attempts',
      'body',
      'channel',
      'created_at',
      'delivered_at',
      'event_id',
      'html',
      'id',
      'kind',
      'outcome',
      'status',
      'subject',
      'updated_at',
      'user_id',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'alert_conditions'), [
      'active',
      'alert_id',
      'app_id',
      'dedupe_key',
      'first_seen_at',
      'last_seen_at',
      'raised_at',
      'type',
      'workspace_id',
    ]);
    assert.ok((await tableIndexes(db, 'alerts')).includes('alerts_key_idx'));
    assert.ok((await tableIndexes(db, 'alert_inbox')).includes('alert_inbox_user_idx'));
    assert.ok(
      (await tableIndexes(db, 'alert_deliveries')).includes('alert_deliveries_workspace_idx'),
    );
    assert.ok((await tableIndexes(db, 'alert_mutes')).includes('alert_mutes_user_idx'));
  },
);

dbTest(
  'alert tables: a rule, a choice and an inbox row are unique per key; defaults match the code',
  async (db) => {
    await migrate(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1)");
    await db.execute(
      "INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@x.io', 'A', 1)",
    );
    const rule = () =>
      db.execute(
        "INSERT INTO alert_workspace_rules (workspace_id, alert_type, channels, updated_by, updated_at) VALUES ('w1', 'release.rejected', '[]', 'u1', 1)",
      );
    await rule();
    await assert.rejects(rule());
    assert.equal(
      Number((await db.query('SELECT enabled FROM alert_workspace_rules'))[0]?.enabled),
      1,
      'on by default',
    );

    await db.execute(
      "INSERT INTO alert_user_settings (workspace_id, user_id, updated_at) VALUES ('w1', 'u1', 1)",
    );
    const s = (
      await db.query('SELECT min_severity, digest, digest_hour FROM alert_user_settings')
    )[0];
    assert.deepEqual([s?.min_severity, s?.digest, Number(s?.digest_hour)], ['info', 'off', 8]);

    const pref = () =>
      db.execute(
        "INSERT INTO alert_preferences (workspace_id, user_id, alert_type, channels, updated_at) VALUES ('w1', 'u1', 'release.live', '[]', 1)",
      );
    await pref();
    await assert.rejects(
      pref(),
      'the app id defaults to the empty string, so "all apps" is unique too',
    );

    await db.execute(
      "INSERT INTO alerts (id, workspace_id, type, severity, dedupe_key, title, body, data, first_at, last_at) VALUES ('a1', 'w1', 't', 'info', 'k', 'T', 'B', '{}', 1, 1)",
    );
    assert.equal(Number((await db.query('SELECT count FROM alerts'))[0]?.count), 1);
    await db.execute(
      "INSERT INTO alert_inbox (alert_id, user_id, workspace_id, created_at) VALUES ('a1', 'u1', 'w1', 1)",
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO alert_inbox (alert_id, user_id, workspace_id, created_at) VALUES ('a1', 'u1', 'w1', 2)",
      ),
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO alert_inbox (alert_id, user_id, workspace_id, created_at) VALUES ('nope', 'u1', 'w1', 2)",
      ),
      'an inbox row needs its alert',
    );
    await assert.rejects(
      db.execute(
        "INSERT INTO alert_mutes (id, workspace_id, user_id, created_at) VALUES ('m1', 'w1', 'ghost', 1)",
      ),
      'a mute needs its person',
    );
  },
);
