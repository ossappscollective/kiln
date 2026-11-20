import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 45: in-app purchases and subscriptions read from the stores (docs/adr/0034-in-app-products.md). It lives in its own file and is
 * appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const monetizationMigrations: Migration[] = [
  {
    id: 45,
    name: 'In-app products: products, localizations and prices read from the stores, the sync status of an app, and the write claim',
    statements: (dialect) => {
      const t = epoch(dialect);
      // store_products: one row per product of an app record (an in-app purchase or a subscription). `product_id` is the id the developer chose
      // (the same in the store and in the app); `store_ref` is Apple's resource id (null for Google Play). `kind` is consumable,
      // non_consumable or subscription; `state` is the normalized state and `raw_state` the store's own. `availability_json` is
      // {"territories":[...],"availableInNewTerritories":bool|null} or NULL when the store gave none; `detail_json` holds the small extras
      // (plans, offers). `raw_hash` is a hash of everything read, to tell whether a sync changed the product. Replaced by every successful
      // sync; a product the store no longer lists is deleted. No foreign key to apps: deleteApp removes the rows.
      // store_product_localizations: the display name and description per locale (`store_ref` is Apple's id of the localization).
      // store_product_prices: the price per territory in MINOR units as a string; `plan_id` is the Google Play base plan or purchase option, ''
      // when there is none. Prices are what the stores say, never edited here.
      // store_product_sync: the state of the last sync of an app (one row per app): when, whether the list was complete, what failed (a
      // redacted sentence) and how many syncs in a row failed. A failed sync keeps the last good snapshot.
      // store_product_claims: one write in flight per app (a localization edit), kept in the database so it holds across processes. status is
      // writing (expires after a TTL) or unknown (the outcome of the last write is not known; a successful read of the store clears it).
      return [
        `CREATE TABLE IF NOT EXISTS store_products (
           app_id TEXT NOT NULL,
           product_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           store_ref TEXT,
           kind TEXT NOT NULL,
           reference_name TEXT NOT NULL,
           state TEXT NOT NULL,
           raw_state TEXT,
           group_name TEXT,
           period TEXT,
           base_territory TEXT,
           availability_json TEXT,
           detail_json TEXT NOT NULL DEFAULT '{}',
           raw_hash TEXT NOT NULL,
           synced_at ${t} NOT NULL,
           PRIMARY KEY (app_id, product_id)
         )`,
        'CREATE INDEX IF NOT EXISTS store_products_workspace_idx ON store_products (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_product_localizations (
           app_id TEXT NOT NULL,
           product_id TEXT NOT NULL,
           locale TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           description TEXT NOT NULL,
           store_ref TEXT,
           PRIMARY KEY (app_id, product_id, locale)
         )`,
        'CREATE INDEX IF NOT EXISTS store_product_localizations_workspace_idx ON store_product_localizations (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_product_prices (
           app_id TEXT NOT NULL,
           product_id TEXT NOT NULL,
           plan_id TEXT NOT NULL DEFAULT '',
           territory TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           currency TEXT NOT NULL,
           amount TEXT NOT NULL,
           PRIMARY KEY (app_id, product_id, plan_id, territory)
         )`,
        'CREATE INDEX IF NOT EXISTS store_product_prices_workspace_idx ON store_product_prices (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_product_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           last_attempt_at ${t},
           last_synced_at ${t},
           last_error TEXT,
           failures INTEGER NOT NULL DEFAULT 0,
           product_count INTEGER NOT NULL DEFAULT 0,
           complete INTEGER NOT NULL DEFAULT 1,
           warnings_json TEXT NOT NULL DEFAULT '[]'
         )`,
        'CREATE INDEX IF NOT EXISTS store_product_sync_workspace_idx ON store_product_sync (workspace_id)',
        `CREATE TABLE IF NOT EXISTS store_product_claims (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           product_id TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS store_product_claims_workspace_idx ON store_product_claims (workspace_id)',
      ];
    },
  },
];
