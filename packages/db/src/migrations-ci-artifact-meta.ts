import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 70: what was read from inside a CI artifact (the build number of an APK, AAB or IPA),
 * kept per app and artifact so a file is
 * downloaded and opened once. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const ciArtifactMetaMigrations: Migration[] = [
  {
    id: 70,
    name: 'CI artifacts: the build number read from inside the file, cached per app and artifact',
    statements: (dialect) => {
      const t = epoch(dialect);
      // One row per (app, GitHub artifact id). status `read`: build_number (the Android versionCode
      // or the iOS CFBundleVersion, as text),
      // version (versionName or CFBundleShortVersionString), package_id (package or
      // CFBundleIdentifier) and format (apk, aab or ipa)
      // came from the file. status `unreadable`: the file was downloaded and held none of them; the
      // other columns are NULL and the
      // artifact is not downloaded again for this. Nothing of the file is kept. read_at is epoch
      // milliseconds.
      return [
        `CREATE TABLE IF NOT EXISTS ci_artifact_meta (
           app_id TEXT NOT NULL,
           artifact_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           status TEXT NOT NULL,
           build_number TEXT,
           version TEXT,
           package_id TEXT,
           format TEXT,
           read_at ${t} NOT NULL,
           PRIMARY KEY (app_id, artifact_id)
         )`,
        'CREATE INDEX IF NOT EXISTS ci_artifact_meta_workspace_idx ON ci_artifact_meta (workspace_id)',
      ];
    },
  },
];
