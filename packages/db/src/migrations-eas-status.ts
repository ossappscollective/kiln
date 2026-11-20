import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 47: the cached status of the EAS builds and submissions of an app (docs/adr/0036-eas-build-submit-status.md). Read from
 * Expo by the status sync (modules/eas/status-sync.ts); nothing here is ever written back to Expo. It lives in its own file and is
 * appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const easStatusMigrations: Migration[] = [
  {
    id: 47,
    name: 'EAS Build and Submit status: eas_builds, eas_submissions and eas_status_sync',
    statements: (dialect) => {
      const t = epoch(dialect);
      // eas_builds: one row per EAS build of the project an app record is linked to (app_expo_links), for the platform of that record.
      // platform is Expo's own (ios or android). status is our word for Expo's BuildStatus (new, in_queue, in_progress, pending_cancel,
      // finished, errored, canceled, or unknown for a value this server does not know); raw_status is Expo's, kept so an unknown one can
      // be shown. distribution is store, internal, simulator or unknown. simulator is 0 or 1 (null when Expo did not say). has_artifact is
      // 0 or 1: Expo holds a build file. The ADDRESS of the file is deliberately not stored (docs/adr/0036): it would be a way around
      // the switch of the builds download; the Expo page of the build is the install link. git_commit_message is the first line, cut at 200
      // characters. error_message is Expo's text, cut at 500 characters, shown to people and never logged. Times are Expo's (epoch ms);
      // expires_at is when Expo deletes the build file. fetched_at is when this server last read the row.
      // eas_submissions: one row per EAS submission (a build sent to a store), same rules. build_id is the build that was submitted.
      // target_identifier is the bundle id or package name Expo reports for the submission (ascAppIdentifier or applicationIdentifier);
      // track and release_status are Google Play's, from the submission config. The target store itself is derived from platform when read.
      // eas_status_sync: one row per app record with the last attempt and success of the sync, the last failure as a short code (never
      // Expo's text), the failure streak, the time before which the scheduler does not try again (backoff) and the project and credential
      // the snapshot was read with, so a changed link starts again from nothing. No foreign keys to apps: deleteApp removes the rows.
      return [
        `CREATE TABLE IF NOT EXISTS eas_builds (
           app_id TEXT NOT NULL,
           build_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           platform TEXT NOT NULL,
           status TEXT NOT NULL,
           raw_status TEXT,
           build_profile TEXT,
           channel TEXT,
           app_version TEXT,
           app_build_version TEXT,
           sdk_version TEXT,
           runtime_version TEXT,
           distribution TEXT,
           simulator INTEGER,
           app_identifier TEXT,
           git_commit_hash TEXT,
           git_commit_message TEXT,
           error_code TEXT,
           error_message TEXT,
           has_artifact INTEGER NOT NULL DEFAULT 0,
           created_at ${t},
           updated_at ${t},
           completed_at ${t},
           expires_at ${t},
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, build_id)
         )`,
        'CREATE INDEX IF NOT EXISTS eas_builds_app_idx ON eas_builds (app_id, created_at)',
        'CREATE INDEX IF NOT EXISTS eas_builds_workspace_idx ON eas_builds (workspace_id)',
        `CREATE TABLE IF NOT EXISTS eas_submissions (
           app_id TEXT NOT NULL,
           submission_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           platform TEXT NOT NULL,
           status TEXT NOT NULL,
           raw_status TEXT,
           build_id TEXT,
           target_identifier TEXT,
           track TEXT,
           release_status TEXT,
           error_code TEXT,
           error_message TEXT,
           created_at ${t},
           completed_at ${t},
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, submission_id)
         )`,
        'CREATE INDEX IF NOT EXISTS eas_submissions_app_idx ON eas_submissions (app_id, created_at)',
        'CREATE INDEX IF NOT EXISTS eas_submissions_workspace_idx ON eas_submissions (workspace_id)',
        `CREATE TABLE IF NOT EXISTS eas_status_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           project_id TEXT,
           credential_id TEXT,
           last_attempt_at ${t},
           last_success_at ${t},
           last_error TEXT,
           consecutive_failures INTEGER NOT NULL DEFAULT 0,
           backoff_until ${t},
           builds_truncated INTEGER NOT NULL DEFAULT 0,
           submissions_truncated INTEGER NOT NULL DEFAULT 0
         )`,
        'CREATE INDEX IF NOT EXISTS eas_status_sync_workspace_idx ON eas_status_sync (workspace_id)',
      ];
    },
  },
];
