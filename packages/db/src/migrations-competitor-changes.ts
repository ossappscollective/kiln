import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 60: the competitor listing watch (docs/adr/0056-competitor-listing-watch.md). `aso_competitor_changes` holds one row per
 * read of an App Store competitor that found a change (kinds, and the changes with their before and after: image addresses and short
 * texts, all public store data), kept 180 days and 200 per competitor by the code that writes them, deleted with the competitor.
 * `aso_competitors.listing_state` is the last compared state (JSON), what the next read is compared with.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const competitorChangesMigrations: Migration[] = [
  {
    id: 60,
    name: 'Competitor listing watch: the changes found on followed App Store competitors',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS aso_competitor_changes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           competitor_id TEXT NOT NULL REFERENCES aso_competitors(id) ON DELETE CASCADE,
           app_id TEXT NOT NULL,
           detected_at ${t} NOT NULL,
           kinds TEXT NOT NULL,
           changes TEXT NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS aso_competitor_changes_competitor_idx ON aso_competitor_changes (competitor_id, detected_at)',
        'CREATE INDEX IF NOT EXISTS aso_competitor_changes_app_idx ON aso_competitor_changes (workspace_id, app_id, detected_at)',
        'ALTER TABLE aso_competitors ADD COLUMN listing_state TEXT',
      ];
    },
  },
];
