import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 42: the Google Play reports bucket of a Play developer account. Google keeps ONE private Cloud Storage bucket
 * (`pubsite_prod_rev_<number>`) per developer account and organises the reports inside by package name, so the id is stored once per
 * Play credential and read by every Android app that uses it (an app may still override it: `analytics_app_config.play_bucket_id`).
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const analyticsBucketMigrations: Migration[] = [
  {
    id: 42,
    name: 'Analytics: the Google Play reports bucket of a Play developer account (per Play credential)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // One row per Play credential. play_bucket_id is the normalised bucket id (no gs:// prefix). Not a secret: it is the name of a
      // bucket the service account must be granted access to. Deleted with the credential (see deleteCredential).
      return [
        `CREATE TABLE IF NOT EXISTS analytics_credential_config (
           credential_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           play_bucket_id TEXT,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS analytics_credential_config_workspace_idx ON analytics_credential_config (workspace_id)',
      ];
    },
  },
];
