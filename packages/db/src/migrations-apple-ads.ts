import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migrations 62 and 63: Apple Ads, read only (docs/adr/0058-apple-ads.md).
 * 62: `app_ads_links` (the link of an app record to an Apple Ads ad account and the app it promotes, with the credential that reads
 * it) and `ads_sync` (the state of the last read). Not a secret: the key stays in `credentials`.
 * 63: the data a sync reads. `ads_campaign_daily` keeps one row per app, campaign and day. `ads_term_daily` keeps one row per app,
 * campaign, kind (`term` for a search term, `keyword` for a bid keyword), key, storefront and day: for a search term the key is the
 * normalised text, for a keyword Apple's keyword id. `ads_term_popularity` keeps Apple's own 1 to 100 popularity of a tracked term per
 * storefront and genre, as last read. Money is stored as integer micro-units (millionths) with its currency, never as a float.
 * Rows are written by an idempotent upsert and kept 90 days (pruned by the sync). Nothing here is ever written back to Apple.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const appleAdsMigrations: Migration[] = [
  {
    id: 62,
    name: 'Apple Ads: app_ads_links and ads_sync',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS app_ads_links (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           credential_id TEXT NOT NULL,
           ad_account_id TEXT NOT NULL,
           ad_account_name TEXT NOT NULL,
           org_id TEXT,
           currency TEXT,
           timezone TEXT,
           adam_id TEXT NOT NULL,
           verified_at ${t} NOT NULL,
           linked_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS app_ads_links_workspace_idx ON app_ads_links (workspace_id)',
        'CREATE INDEX IF NOT EXISTS app_ads_links_credential_idx ON app_ads_links (credential_id)',
        `CREATE TABLE IF NOT EXISTS ads_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           last_attempt_at ${t},
           last_success_at ${t},
           last_error TEXT,
           last_error_code TEXT,
           last_error_params TEXT,
           failure_streak INTEGER NOT NULL DEFAULT 0,
           range_start TEXT,
           range_end TEXT,
           campaigns INTEGER NOT NULL DEFAULT 0,
           complete INTEGER NOT NULL DEFAULT 1,
           skipped INTEGER NOT NULL DEFAULT 0,
           warnings TEXT
         )`,
      ];
    },
  },
  {
    id: 63,
    name: 'Apple Ads: campaign, search term and keyword metrics per day, and Apple popularity',
    statements: (dialect) => {
      const t = epoch(dialect);
      const metrics = `impressions INTEGER NOT NULL DEFAULT 0,
           taps INTEGER NOT NULL DEFAULT 0,
           installs INTEGER NOT NULL DEFAULT 0,
           tap_installs INTEGER NOT NULL DEFAULT 0,
           spend_micros ${t} NOT NULL DEFAULT 0,
           currency TEXT,
           fetched_at ${t} NOT NULL`;
      return [
        `CREATE TABLE IF NOT EXISTS ads_campaign_daily (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           campaign_id TEXT NOT NULL,
           day TEXT NOT NULL,
           name TEXT NOT NULL,
           status TEXT,
           ${metrics},
           PRIMARY KEY (app_id, campaign_id, day)
         )`,
        'CREATE INDEX IF NOT EXISTS ads_campaign_daily_day_idx ON ads_campaign_daily (app_id, day)',
        `CREATE TABLE IF NOT EXISTS ads_term_daily (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           campaign_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           term_key TEXT NOT NULL,
           country TEXT NOT NULL,
           day TEXT NOT NULL,
           term TEXT NOT NULL,
           match_type TEXT,
           source TEXT,
           keyword_text TEXT,
           ${metrics},
           PRIMARY KEY (app_id, campaign_id, kind, term_key, country, day)
         )`,
        'CREATE INDEX IF NOT EXISTS ads_term_daily_day_idx ON ads_term_daily (app_id, kind, day)',
        'CREATE INDEX IF NOT EXISTS ads_term_daily_term_idx ON ads_term_daily (workspace_id, kind, country, term_key)',
        `CREATE TABLE IF NOT EXISTS ads_term_popularity (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           country TEXT NOT NULL,
           term_key TEXT NOT NULL,
           genre TEXT NOT NULL,
           term TEXT NOT NULL,
           period TEXT,
           popularity_100 INTEGER,
           popularity_5 INTEGER,
           rank_in_genre INTEGER,
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (workspace_id, country, term_key, genre)
         )`,
      ];
    },
  },
];
