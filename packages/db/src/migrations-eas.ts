import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 44: the link between an app and its Expo Application Services (EAS) project (docs/adr/0033-eas-integration.md). One row
 * per app record (an iOS and an Android record of the same product each have their own, and may name the same project). It lives in
 * its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const easMigrations: Migration[] = [
  {
    id: 44,
    name: 'EAS: the link between an app and its Expo project',
    statements: (dialect) => {
      const t = epoch(dialect);
      // project_id is the EAS project id (a UUID, `expo.extra.eas.projectId`); account_name, slug and project_name are what Expo said
      // when the link was saved (`@account/slug`), kept so a list needs no call to Expo. credential_id names an Expo credential: no
      // foreign key, like apps.credential_id (a credential can be deleted while a link still names it; the link then says so).
      // app_id has no foreign key either: deleteApp removes the row. verified_at is when Expo last confirmed the project.
      // Not a secret: the token stays in `credentials`.
      return [
        `CREATE TABLE IF NOT EXISTS app_expo_links (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           credential_id TEXT NOT NULL,
           project_id TEXT NOT NULL,
           account_name TEXT NOT NULL,
           slug TEXT NOT NULL,
           project_name TEXT NOT NULL,
           verified_at ${t} NOT NULL,
           linked_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS app_expo_links_workspace_idx ON app_expo_links (workspace_id)',
        'CREATE INDEX IF NOT EXISTS app_expo_links_project_idx ON app_expo_links (project_id)',
        'CREATE INDEX IF NOT EXISTS app_expo_links_credential_idx ON app_expo_links (credential_id)',
      ];
    },
  },
];
