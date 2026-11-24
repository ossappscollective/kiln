import type { Migration } from './migrations.ts';

/**
 * Migration 65: the address of the build file of an EAS build (`eas_builds.artifact_url`, docs/adr/0061-eas-install-dialog.md).
 * Expo's `artifacts.buildUrl` (or `applicationArchiveUrl`), kept so the install dialog can offer "Download build" and "Open with Orbit"
 * as links straight to Expo. It is never proxied, logged or audited, and the server returns it only where the builds download switch
 * is on and the role may download. Nullable: older rows and builds without a file have none until the next read of Expo.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const easArtifactMigrations: Migration[] = [
  {
    id: 65,
    name: 'EAS builds: artifact_url',
    statements: () => ['ALTER TABLE eas_builds ADD COLUMN artifact_url TEXT'],
  },
];
