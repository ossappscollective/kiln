import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 53: store experiments and custom product pages (docs/adr/0048-store-experiments.md, docs/spikes/store-experiments.md). It lives in
 * its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const storeExperimentsMigrations: Migration[] = [
  {
    id: 53,
    name: 'Store experiments: Apple experiments and custom product pages read from the store, the sync status, and the manual tracker',
    statements: (dialect) => {
      const t = epoch(dialect);
      // store_experiments: one row per Product Page Optimization experiment (`kind` = 'experiment') or custom product page (`kind` =
      // 'custom_page') of an app record, as the last successful sync read it. `item_id` is Apple's resource id. `state` is the normalized state
      // and `raw_state` Apple's own word. `starts_at` and `ends_at` are epoch milliseconds (experiments only). `url` is the address of a custom
      // page. `detail_json` holds the rest (traffic, treatments with their locales and media counts, or versions and locales, as the connector
      // returned them). Replaced by every complete sync; no foreign key to apps: deleteApp removes the rows.
      // store_experiments_sync: the state of the last sync of an app (one row per app), like store_product_sync: when, whether the lists were
      // complete, what failed (a redacted sentence) and how many syncs in a row failed. A failed sync keeps the last good snapshot.
      // store_experiment_notes: the manual tracker (Google Play has no API for experiments; any app can use it): one row per note a person writes.
      // `kind` is experiment or custom_page, `status` is planned, running, finished or stopped, `started_on` and `ended_on` are YYYY-MM-DD
      // dates or NULL, `url` an optional link, `listing` the Google Play custom store listing parameter (the `listing=` of its public address), `note` free text (what was tested and what was learned).
      return [
        `CREATE TABLE IF NOT EXISTS store_experiments (
           app_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           item_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           state TEXT NOT NULL,
           raw_state TEXT,
           starts_at ${t},
           ends_at ${t},
           url TEXT,
           detail_json TEXT NOT NULL DEFAULT '{}',
           synced_at ${t} NOT NULL,
           PRIMARY KEY (app_id, kind, item_id)
         )`,
        'CREATE INDEX IF NOT EXISTS store_experiments_workspace_idx ON store_experiments (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_experiments_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           last_attempt_at ${t},
           last_synced_at ${t},
           last_error TEXT,
           failures INTEGER NOT NULL DEFAULT 0,
           experiment_count INTEGER NOT NULL DEFAULT 0,
           page_count INTEGER NOT NULL DEFAULT 0,
           complete INTEGER NOT NULL DEFAULT 1,
           warnings_json TEXT NOT NULL DEFAULT '[]'
         )`,
        'CREATE INDEX IF NOT EXISTS store_experiments_sync_workspace_idx ON store_experiments_sync (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_experiment_notes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           name TEXT NOT NULL,
           status TEXT NOT NULL,
           started_on TEXT,
           ended_on TEXT,
           url TEXT,
           listing TEXT,
           note TEXT NOT NULL DEFAULT '',
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS store_experiment_notes_workspace_idx ON store_experiment_notes (workspace_id)',
        'CREATE INDEX IF NOT EXISTS store_experiment_notes_app_idx ON store_experiment_notes (app_id)',
      ];
    },
  },
];
