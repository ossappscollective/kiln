import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 55: dismissed Insights cards (docs/adr/0051-insights.md). It lives in its own file and is appended to `migrations` in migrations.ts.
 * Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const insightsMigrations: Migration[] = [
  {
    id: 55,
    name: 'Insights: cards a person dismissed for an app, with the fingerprint of the finding that was dismissed',
    statements: (dialect) => {
      const t = epoch(dialect);
      // insight_dismissals: one row per app and card id (`visibility`, `localize:de`, ...). `fingerprint` is the finding at the time of the dismissal
      // (direction and size band, the items in it); the card stays hidden while the computed fingerprint is the same and shows again when it changes.
      // No foreign key to apps: deleteApp removes the rows. Cards themselves are computed on read and never stored.
      return [
        `CREATE TABLE IF NOT EXISTS insight_dismissals (
           app_id TEXT NOT NULL,
           card_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           fingerprint TEXT NOT NULL,
           dismissed_at ${t} NOT NULL,
           dismissed_by TEXT,
           PRIMARY KEY (app_id, card_id)
         )`,
        'CREATE INDEX IF NOT EXISTS insight_dismissals_workspace_idx ON insight_dismissals (workspace_id)',
      ];
    },
  },
];
