import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 72: what the last batch publishes of an app did. The answer of `POST .../publish` was only ever shown to the browser that
 * sent it, so a failure vanished on reload and could not be seen from another browser. One row per finished run, kept per app (the
 * newest five): `steps` (a JSON array of the step types the batch ran) and `results` (a JSON array with one entry per step: its status,
 * the error code and the HTTP status, the outcome, a SANITISED message from the store; never a token, a key or an upload), when it
 * started and finished, who ran it, and `dismissed_at`/`dismissed_by` (a person hid the failure; a newer run is not hidden). Never edit
 * a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const publishRunsMigrations: Migration[] = [
  {
    id: 72,
    name: 'Store publish runs: the last batch publishes of an app, with the reason a step failed',
    statements: (dialect) => {
      const t = epoch(dialect);
      // No foreign key on app_id (like the other store tables): deleting an app deletes its rows in code. `outcome` is `completed`,
      // `partial` (some step applied, then one did not) or `failed`. `by_user` is null for a token or a deleted person.
      return [
        `CREATE TABLE IF NOT EXISTS store_publish_runs (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           platform TEXT NOT NULL,
           started_at ${t} NOT NULL,
           finished_at ${t} NOT NULL,
           outcome TEXT NOT NULL,
           steps TEXT NOT NULL,
           results TEXT NOT NULL,
           by_user TEXT,
           dismissed_at ${t},
           dismissed_by TEXT
         )`,
        'CREATE INDEX IF NOT EXISTS store_publish_runs_app_idx ON store_publish_runs (app_id, finished_at)',
        'CREATE INDEX IF NOT EXISTS store_publish_runs_workspace_idx ON store_publish_runs (workspace_id)',
      ];
    },
  },
];
