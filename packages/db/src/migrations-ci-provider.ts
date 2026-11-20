import type { Migration } from './migrations.ts';

/**
 * Migration 46: which CI provider a stored run belongs to (docs/adr/0035-eas-workflows.md). `workflow_runs` held GitHub Actions runs
 * only; EAS Workflows runs are kept in the same table so the pipeline, the builds, the running-now list and the alerts read them with
 * no special case. `provider` is `github` (every row that exists) or `eas-workflows`. It lives in its own file and is appended to
 * `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const ciProviderMigrations: Migration[] = [
  {
    id: 46,
    name: 'CI runs: the provider of a stored run (github, eas-workflows)',
    // A default, so the rows that exist are GitHub's and the same statement runs on SQLite and PostgreSQL.
    statements: () => ["ALTER TABLE workflow_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'"],
  },
];
