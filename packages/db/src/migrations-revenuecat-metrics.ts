import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 49: the RevenueCat metrics overview of an app record's project (docs/adr/0043-revenuecat-metrics.md): the last good read of
 * `GET /v2/projects/{project_id}/metrics/overview` and how the last attempt went. A cached copy, written by the RevenueCat sync and read by
 * the Products page, the API and the MCP server; nothing is ever written back to RevenueCat. It lives in its own file and is appended to
 * `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const revenueCatMetricsMigrations: Migration[] = [
  {
    id: 49,
    name: 'RevenueCat: revenuecat_metrics, the cached metrics overview of the linked project',
    statements: (dialect) => {
      const t = epoch(dialect);
      // revenuecat_metrics: one row per app record, replaced by a good read. project_id is the project the figures are about (they cover
      // the WHOLE project, every app and store of it, not this app alone). currency is the code RevenueCat reported for its money
      // figures (MRR, Revenue); null when it said none: an amount without a currency is never shown as money. metrics_json is the list
      // of metrics as read (id, name, unit, period, value, last_updated_at). fetched_at is the time of the last good read (null until
      // there is one). A failed read keeps the old figures and sets only last_attempt_at, last_error (a fixed sentence, never
      // RevenueCat's text) and failures. No customer data is read or stored.
      return [
        `CREATE TABLE IF NOT EXISTS revenuecat_metrics (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           project_id TEXT NOT NULL,
           currency TEXT,
           metrics_json TEXT NOT NULL DEFAULT '[]',
           fetched_at ${t},
           last_attempt_at ${t},
           last_error TEXT,
           failures INTEGER NOT NULL DEFAULT 0
         )`,
        'CREATE INDEX IF NOT EXISTS revenuecat_metrics_workspace_idx ON revenuecat_metrics (workspace_id)',
      ];
    },
  },
];
