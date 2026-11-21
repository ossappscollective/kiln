import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 48: RevenueCat next to the store products (docs/adr/0039-revenuecat.md): the link between an app record and a RevenueCat
 * project and app, and a cached copy of the project configuration that was read (products, entitlements, offerings with their
 * packages) and of the state of the last read. Read from RevenueCat by a sync; nothing here is ever written back. It lives in its
 * own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const revenueCatMigrations: Migration[] = [
  {
    id: 48,
    name: 'RevenueCat: app_revenuecat_links and the cached products, entitlements, offerings and sync state',
    statements: (dialect) => {
      const t = epoch(dialect);
      // app_revenuecat_links: one row per app record. credential_id names a `revenuecat` credential (no foreign key, like
      // app_expo_links: a credential can be deleted while the link names it). project_id and project_name, rc_app_id, rc_app_name,
      // rc_app_type (app_store, mac_app_store or play_store) and rc_identifier (the bundle id or package name RevenueCat holds for the
      // app) are what RevenueCat said when the link was saved. Not a secret: the key stays in `credentials`. No foreign key to apps:
      // deleteApp removes the rows of every table here.
      // revenuecat_products: the products of the linked RevenueCat APP (those of its other apps are not stored). store_identifier is
      // RevenueCat's: the store product id, or `subscription_id:base_plan_id` on Google Play. state is `active`, `archived` or `unknown`
      // (raw_state is RevenueCat's word); product_type is RevenueCat's type kept as text so a new one still shows. duration,
      // grace_period and trial_duration are ISO 8601 or null.
      // revenuecat_entitlements: the entitlements of the PROJECT that hold a product of the linked app, or none at all.
      // product_ids_json is the RevenueCat product ids of this app attached to it; project_product_count counts every product attached
      // in the project (so an entitlement with only other apps' products is not mistaken for an empty one).
      // revenuecat_offerings: the offerings of the project; packages_json holds the packages that hold a product of this app, each with
      // its lookup key, position and the product ids with their eligibility criteria (all, google_sdk_lt_6 or google_sdk_ge_6).
      // revenuecat_sync: the last attempt and success of the read, the last failure as a fixed sentence (never RevenueCat's text), the
      // failure streak, how many products of other apps were left out, whether the read finished (complete), and warnings. Never money
      // amounts or customer data: none is read.
      return [
        `CREATE TABLE IF NOT EXISTS app_revenuecat_links (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           credential_id TEXT NOT NULL,
           project_id TEXT NOT NULL,
           project_name TEXT NOT NULL,
           rc_app_id TEXT NOT NULL,
           rc_app_name TEXT NOT NULL,
           rc_app_type TEXT NOT NULL,
           rc_identifier TEXT,
           verified_at ${t} NOT NULL,
           linked_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS app_revenuecat_links_workspace_idx ON app_revenuecat_links (workspace_id)',
        'CREATE INDEX IF NOT EXISTS app_revenuecat_links_credential_idx ON app_revenuecat_links (credential_id)',
        `CREATE TABLE IF NOT EXISTS revenuecat_products (
           app_id TEXT NOT NULL,
           rc_product_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           store_identifier TEXT NOT NULL,
           product_type TEXT NOT NULL,
           state TEXT NOT NULL,
           raw_state TEXT,
           display_name TEXT,
           duration TEXT,
           grace_period TEXT,
           trial_duration TEXT,
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, rc_product_id)
         )`,
        'CREATE INDEX IF NOT EXISTS revenuecat_products_workspace_idx ON revenuecat_products (workspace_id)',
        `CREATE TABLE IF NOT EXISTS revenuecat_entitlements (
           app_id TEXT NOT NULL,
           entitlement_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           lookup_key TEXT NOT NULL,
           display_name TEXT,
           state TEXT NOT NULL,
           raw_state TEXT,
           product_ids_json TEXT NOT NULL DEFAULT '[]',
           project_product_count INTEGER NOT NULL DEFAULT 0,
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, entitlement_id)
         )`,
        'CREATE INDEX IF NOT EXISTS revenuecat_entitlements_workspace_idx ON revenuecat_entitlements (workspace_id)',
        `CREATE TABLE IF NOT EXISTS revenuecat_offerings (
           app_id TEXT NOT NULL,
           offering_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           lookup_key TEXT NOT NULL,
           display_name TEXT,
           is_current INTEGER NOT NULL DEFAULT 0,
           state TEXT NOT NULL,
           raw_state TEXT,
           packages_json TEXT NOT NULL DEFAULT '[]',
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, offering_id)
         )`,
        'CREATE INDEX IF NOT EXISTS revenuecat_offerings_workspace_idx ON revenuecat_offerings (workspace_id)',
        `CREATE TABLE IF NOT EXISTS revenuecat_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           project_id TEXT,
           credential_id TEXT,
           last_attempt_at ${t},
           last_synced_at ${t},
           last_error TEXT,
           failures INTEGER NOT NULL DEFAULT 0,
           product_count INTEGER NOT NULL DEFAULT 0,
           other_app_product_count INTEGER NOT NULL DEFAULT 0,
           complete INTEGER NOT NULL DEFAULT 1,
           warnings_json TEXT NOT NULL DEFAULT '[]'
         )`,
        'CREATE INDEX IF NOT EXISTS revenuecat_sync_workspace_idx ON revenuecat_sync (workspace_id)',
      ];
    },
  },
];
