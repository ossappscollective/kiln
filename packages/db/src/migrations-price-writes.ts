import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

/**
 * Migration 66: price changes of in-app purchases and subscriptions (docs/adr/0062-price-writes.md).
 * `staged_price_changes`: what a person prepared and has not sent, one row per product and plan (a new staging replaces it). It has its own
 * table, not a kind of `staged_changes`, ON PURPOSE: the push of staged changes writes every row it finds into a store draft, and a price must
 * never be reachable from that path. `payload_json` is the validated price change (territories with before and after in MINOR units, effective
 * date, what happens to existing subscribers, the acknowledgements given); `value_hash` hashes it so the cart can tell a changed row; `synced_at`
 * is the snapshot the person saw. Amounts are not store text, so they may be shown and audited. No foreign key to apps: deleteApp removes rows.
 * `store_price_claims`: one price write in flight per app, kept in the database so it holds across processes; `writing` (expires after a TTL) or
 * `unknown` (the outcome of the last write is not known; a successful read of the store clears it).
 */
export const priceWriteMigrations: Migration[] = [
  {
    id: 66,
    name: 'Price writes: staged price changes and the price write claim',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS staged_price_changes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           product_id TEXT NOT NULL,
           plan_id TEXT NOT NULL DEFAULT '',
           store TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           value_hash TEXT NOT NULL,
           synced_at ${t} NOT NULL,
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS staged_price_changes_slot_idx ON staged_price_changes (app_id, product_id, plan_id)',
        'CREATE INDEX IF NOT EXISTS staged_price_changes_workspace_idx ON staged_price_changes (workspace_id, app_id)',
        `CREATE TABLE IF NOT EXISTS store_price_claims (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           status TEXT NOT NULL DEFAULT 'writing',
           claimed_by TEXT NOT NULL,
           claim_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS store_price_claims_workspace_idx ON store_price_claims (workspace_id)',
      ];
    },
  },
];
