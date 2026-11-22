import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 54: TestFlight beta feedback and crash submissions (docs/adr/0049-testflight-feedback.md, docs/spikes/testflight-feedback.md). It lives
 * in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const testflightFeedbackMigrations: Migration[] = [
  {
    id: 54,
    name: 'TestFlight feedback: screenshot feedback and crash submissions read from App Store Connect, with local triage, and the sync status',
    statements: (dialect) => {
      const t = epoch(dialect);
      // testflight_feedback: one row per TestFlight submission of an app record (`kind` feedback = a screenshot feedback, crash = a crash
      // submission). `apple_id` is Apple's id; unique with `app_id`. `created_at` is Apple's `createdDate` (the time first seen when Apple gave none),
      // epoch milliseconds. `build_number` is `builds.version`, `version` the marketing version (prerelease version), both nullable. The tester is
      // `tester_email` (personal data: shown to administrators only) and `tester_key`, a stable pseudonym derived from it (see the ADR); the tester's
      // name is never stored. `comment` is free text of a person: never logged. `screenshots_json` holds the SIZES of the screenshots, never a link
      // (links expire and are read on demand). `crash_log` is the log text capped in size (`crash_log_truncated`), `crash_log_state` is
      // none (not asked yet or not a crash), stored, or missing (Apple had none); `signature` is the grouping key derived from the log, `symbolicated`
      // whether its top frame has a symbol. `status`, `assignee_user_id`, `internal_note`, `status_changed_*` are Kiln's own triage, never sent to Apple.
      // testflight_sync: the state of the last sync of an app, like store_experiments_sync. A failed sync keeps what was stored.
      return [
        `CREATE TABLE IF NOT EXISTS testflight_feedback (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           apple_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           created_at ${t} NOT NULL,
           build_id TEXT,
           build_number TEXT,
           version TEXT,
           platform TEXT,
           bundle_id TEXT,
           tester_key TEXT,
           tester_email TEXT,
           device_model TEXT,
           device_family TEXT,
           os_version TEXT,
           locale TEXT,
           time_zone TEXT,
           architecture TEXT,
           connection_type TEXT,
           paired_watch TEXT,
           app_uptime_ms ${t},
           disk_free_bytes ${t},
           disk_total_bytes ${t},
           battery_percent INTEGER,
           screen_width INTEGER,
           screen_height INTEGER,
           comment TEXT NOT NULL DEFAULT '',
           screenshots_json TEXT NOT NULL DEFAULT '[]',
           crash_log TEXT,
           crash_log_truncated INTEGER NOT NULL DEFAULT 0,
           crash_log_state TEXT NOT NULL DEFAULT 'none',
           signature TEXT,
           symbolicated INTEGER,
           status TEXT NOT NULL DEFAULT 'new',
           assignee_user_id TEXT,
           internal_note TEXT,
           status_changed_at ${t},
           status_changed_by TEXT,
           first_seen_at ${t} NOT NULL,
           fetched_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS testflight_feedback_apple_idx ON testflight_feedback (app_id, apple_id)',
        'CREATE INDEX IF NOT EXISTS testflight_feedback_app_kind_idx ON testflight_feedback (app_id, kind, created_at)',
        'CREATE INDEX IF NOT EXISTS testflight_feedback_app_build_idx ON testflight_feedback (app_id, build_number)',
        'CREATE INDEX IF NOT EXISTS testflight_feedback_app_status_idx ON testflight_feedback (app_id, status)',
        'CREATE INDEX IF NOT EXISTS testflight_feedback_workspace_idx ON testflight_feedback (workspace_id)',
        `CREATE TABLE IF NOT EXISTS testflight_sync (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           last_attempt_at ${t},
           last_synced_at ${t},
           last_error TEXT,
           failures INTEGER NOT NULL DEFAULT 0,
           feedback_count INTEGER NOT NULL DEFAULT 0,
           crash_count INTEGER NOT NULL DEFAULT 0,
           complete INTEGER NOT NULL DEFAULT 1,
           warnings_json TEXT NOT NULL DEFAULT '[]'
         )`,
        'CREATE INDEX IF NOT EXISTS testflight_sync_workspace_idx ON testflight_sync (workspace_id)',
      ];
    },
  },
];
