import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 61: the signals behind the keyword popularity and difficulty estimates (docs/adr/0057-keyword-estimates.md).
 * `aso_keyword_signals` keeps, per workspace, store, storefront, normalised term and day, the public signals read that day
 * (App Store search hints and the first search results with their rating counts) as JSON, and the model version that was current
 * when the row was written. The estimates themselves are NOT stored: they are recomputed from the signals on every read, so a
 * new model version needs no migration. Rows are kept 90 days and pruned by the refresh that writes them.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const keywordSignalsMigrations: Migration[] = [
  {
    id: 61,
    name: 'Keyword estimates: the public signals read per term, storefront and day',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS aso_keyword_signals (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           store TEXT NOT NULL,
           country TEXT NOT NULL,
           term_key TEXT NOT NULL,
           day TEXT NOT NULL,
           term TEXT NOT NULL,
           signals TEXT NOT NULL,
           model TEXT NOT NULL,
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (workspace_id, store, country, term_key, day)
         )`,
        'CREATE INDEX IF NOT EXISTS aso_keyword_signals_fetched_idx ON aso_keyword_signals (workspace_id, fetched_at)',
      ];
    },
  },
];
