import type { Dialect } from './dialect.ts';

/**
 * Forward-only SQL migrations, applied in order at boot (see migrate() in index.ts).
 *
 * Rules, so one list serves both dialects: text ids, epoch milliseconds in BIGINT (INTEGER on
 * SQLite), JSON as text, no vendor functions. Never edit a migration that has shipped; add a
 * new one. The drizzle schemas next to this file describe the same tables and are checked
 * against these migrations by schema-drift.test.ts.
 */
export type Migration = {
  id: number;
  name: string;
  statements: (dialect: Dialect) => string[];
};

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial tables',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS workspaces (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS users (
           id TEXT PRIMARY KEY,
           email TEXT NOT NULL UNIQUE,
           display_name TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS workspace_members (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           role TEXT NOT NULL,
           PRIMARY KEY (workspace_id, user_id)
         )`,
        `CREATE TABLE IF NOT EXISTS credentials (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           kind TEXT NOT NULL,
           label TEXT NOT NULL,
           ciphertext TEXT NOT NULL,
           created_at ${t} NOT NULL,
           rotated_at ${t}
         )`,
        `CREATE TABLE IF NOT EXISTS audit_events (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           actor_type TEXT NOT NULL,
           actor_id TEXT NOT NULL,
           action TEXT NOT NULL,
           target_type TEXT,
           target_id TEXT,
           detail TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events (workspace_id, created_at)',
        `CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           queue TEXT NOT NULL,
           payload TEXT NOT NULL,
           status TEXT NOT NULL,
           run_at ${t} NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           locked_at ${t},
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, run_at)',
      ];
    },
  },
  {
    id: 2,
    name: 'local accounts and sessions',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        // Nullable so rows from before this migration stay valid; a user without a hash cannot log in.
        'ALTER TABLE users ADD COLUMN password_hash TEXT',
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL REFERENCES users(id),
           created_at ${t} NOT NULL,
           expires_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)',
      ];
    },
  },
  {
    id: 3,
    name: 'credential last test',
    statements: (dialect) => {
      const t = epoch(dialect);
      // All nullable: a credential that was never tested has no last test. last_test_ok is 0 or 1.
      return [
        `ALTER TABLE credentials ADD COLUMN last_test_at ${t}`,
        'ALTER TABLE credentials ADD COLUMN last_test_ok INTEGER',
        'ALTER TABLE credentials ADD COLUMN last_test_message TEXT',
      ];
    },
  },
  {
    id: 4,
    name: 'repositories and change sets',
    statements: (dialect) => {
      const t = epoch(dialect);
      // credential_id has no foreign key on purpose: deleting a credential must stay possible,
      // and a repository whose credential is gone reports that when it is used.
      // files_json holds the file changes (path, before, after) of a change set; detection_json
      // the last project scan. status: draft, approved, applying, applied, discarded, failed.
      return [
        `CREATE TABLE IF NOT EXISTS repositories (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           credential_id TEXT NOT NULL,
           owner TEXT NOT NULL,
           repo TEXT NOT NULL,
           default_branch TEXT NOT NULL,
           project_kind TEXT,
           detected_at ${t},
           detection_json TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS repositories_workspace_repo_idx ON repositories (workspace_id, owner, repo)',
        `CREATE TABLE IF NOT EXISTS change_sets (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           repository_id TEXT NOT NULL REFERENCES repositories(id),
           summary TEXT NOT NULL,
           status TEXT NOT NULL,
           created_by_type TEXT NOT NULL,
           created_by_id TEXT NOT NULL,
           files_json TEXT NOT NULL,
           branch TEXT,
           pr_url TEXT,
           pr_number INTEGER,
           commit_sha TEXT,
           error TEXT,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           approved_by TEXT,
           approved_at ${t},
           applied_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS change_sets_workspace_idx ON change_sets (workspace_id, created_at)',
        'CREATE INDEX IF NOT EXISTS change_sets_repository_idx ON change_sets (repository_id)',
      ];
    },
  },
  {
    id: 5,
    name: 'invitations',
    statements: (dialect) => {
      const t = epoch(dialect);
      // Only the SHA-256 of the one-time token is stored. A row is pending while accepted_at and
      // revoked_at are null and expires_at is in the future.
      return [
        `CREATE TABLE IF NOT EXISTS invitations (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           email TEXT NOT NULL,
           role TEXT NOT NULL,
           token_hash TEXT NOT NULL UNIQUE,
           created_by TEXT NOT NULL REFERENCES users(id),
           created_at ${t} NOT NULL,
           expires_at ${t} NOT NULL,
           accepted_at ${t},
           accepted_by TEXT REFERENCES users(id),
           revoked_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS invitations_workspace_idx ON invitations (workspace_id)',
      ];
    },
  },
  {
    id: 6,
    name: 'apps and store releases',
    statements: (dialect) => {
      const t = epoch(dialect);
      // credential_id and repository_id have no foreign key on purpose: deleting a credential or
      // disconnecting a repository must stay possible; the app reports it when it is used.
      // platform is ios or android; identifier is the bundle id or package name; store_app_id is
      // the store's own id (Apple's numeric app id), filled by the first sync.
      // app_releases is a snapshot of the store: track is '' on iOS, status is the normalized
      // lifecycle state (NULL when the store's state is not mapped), raw_state the store's own,
      // details_json holds version codes and the rollout fraction.
      return [
        `CREATE TABLE IF NOT EXISTS apps (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           name TEXT NOT NULL,
           platform TEXT NOT NULL,
           identifier TEXT NOT NULL,
           store_app_id TEXT,
           credential_id TEXT NOT NULL,
           repository_id TEXT,
           last_synced_at ${t},
           last_sync_attempt_at ${t},
           last_sync_error TEXT,
           created_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS apps_workspace_identifier_idx ON apps (workspace_id, platform, identifier)',
        `CREATE TABLE IF NOT EXISTS app_releases (
           id TEXT PRIMARY KEY,
           app_id TEXT NOT NULL REFERENCES apps(id),
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           platform TEXT NOT NULL,
           version TEXT NOT NULL,
           track TEXT NOT NULL DEFAULT '',
           build TEXT,
           status TEXT,
           raw_state TEXT NOT NULL,
           details_json TEXT,
           store_updated_at ${t},
           synced_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS app_releases_app_version_idx ON app_releases (app_id, platform, version, track)',
        'CREATE INDEX IF NOT EXISTS app_releases_workspace_idx ON app_releases (workspace_id)',
      ];
    },
  },
];
