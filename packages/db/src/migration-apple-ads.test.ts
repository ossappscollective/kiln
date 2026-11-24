import assert from 'node:assert/strict';
import { type Database, migrate, migrations } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

const ID = 62;

async function upTo61(db: Database) {
  const t = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at ${t} NOT NULL)`,
  );
  for (const migration of migrations.filter((m) => m.id < ID)) {
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
  (await tableColumns(db, table)).map((c) => c.name).sort();

dbTest(
  'migrations 62 and 63 add the Apple Ads link, sync state and daily metric tables; rows are one per key and day',
  async (db) => {
    assert.equal(migrations.at(-1)?.id, migrations.length, 'ids run 1..n without a gap');
    await upTo61(db);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)");
    assert.deepEqual(
      (await migrate(db)).filter((id) => id >= ID && id <= 63),
      [62, 63],
    );
    assert.deepEqual(await names(db, 'app_ads_links'), [
      'ad_account_id',
      'ad_account_name',
      'adam_id',
      'app_id',
      'created_at',
      'credential_id',
      'currency',
      'linked_by',
      'org_id',
      'timezone',
      'updated_at',
      'verified_at',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'ads_sync'), [
      'app_id',
      'campaigns',
      'complete',
      'failure_streak',
      'last_attempt_at',
      'last_error',
      'last_error_code',
      'last_error_params',
      'last_success_at',
      'range_end',
      'range_start',
      'skipped',
      'warnings',
      'workspace_id',
    ]);
    assert.deepEqual(await names(db, 'ads_campaign_daily'), [
      'app_id',
      'campaign_id',
      'currency',
      'day',
      'fetched_at',
      'impressions',
      'installs',
      'name',
      'spend_micros',
      'status',
      'tap_installs',
      'taps',
      'workspace_id',
    ]);
    assert.ok((await names(db, 'ads_term_daily')).includes('keyword_text'));
    assert.deepEqual(await names(db, 'ads_term_popularity'), [
      'country',
      'fetched_at',
      'genre',
      'period',
      'popularity_100',
      'popularity_5',
      'rank_in_genre',
      'term',
      'term_key',
      'workspace_id',
    ]);
    const campaign =
      "INSERT INTO ads_campaign_daily (workspace_id, app_id, campaign_id, day, name, impressions, spend_micros, currency, fetched_at) VALUES ('w1', 'a1', 'c1', '2026-11-01', 'C', 10, 12500000, 'EUR', 5)";
    await db.execute(campaign);
    await assert.rejects(db.execute(campaign), 'the same campaign and day is one row');
    const term =
      "INSERT INTO ads_term_daily (workspace_id, app_id, campaign_id, kind, term_key, country, day, term, fetched_at) VALUES ('w1', 'a1', 'c1', 'term', 'water', 'us', '2026-11-01', 'Water', 5)";
    await db.execute(term);
    await assert.rejects(db.execute(term), 'the same term, storefront and day is one row');
    await db.execute(term.replace("'us'", "'gb'"));
    const rows = await db.query('SELECT spend_micros FROM ads_campaign_daily');
    assert.equal(Number(rows[0]?.spend_micros), 12_500_000);
    assert.deepEqual(await migrate(db), []);
  },
);
