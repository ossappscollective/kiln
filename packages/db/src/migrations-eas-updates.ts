import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 64: the stored state of EAS Updates (OTA) of an app record (docs/adr/0060-eas-update-state.md). Read by the same status
 * sync as the builds (modules/eas/status.ts); nothing here is ever written back to Expo.
 * `eas_updates`: one row per channel and update (one platform of an update group; two channels may serve one branch) that is the CURRENT update of a channel (`is_current` 1: the newest
 * update of the branches the channel serves) or is mid-rollout. `rollout_percentage` is Expo's per-update rollout (1 to 99), null when the update
 * is not mid-rollout; `rollout_since` is when this server first read that percentage (a changed percentage starts again), the clock of the
 * stuck-rollout alert; `stuck_event_at` is when that alert's event was raised (once per update). `message` is the publisher's text from Expo, cut
 * at 200 characters, shown to people and never put in an alert, an event or a log. No foreign keys to apps: deleteApp removes the rows.
 * `eas_status_sync` gets `updates_read_at` (last successful read of the updates) and `updates_error` (a short code, never Expo's text), so a
 * failing updates read does not hide a good builds read.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const easUpdatesMigrations: Migration[] = [
  {
    id: 64,
    name: 'EAS Update state: eas_updates, and the updates read of eas_status_sync',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS eas_updates (
           app_id TEXT NOT NULL,
           update_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           platform TEXT NOT NULL,
           channel TEXT NOT NULL,
           branch TEXT,
           group_id TEXT NOT NULL,
           runtime_version TEXT,
           message TEXT,
           created_at ${t},
           rollout_percentage INTEGER,
           rollout_since ${t},
           stuck_event_at ${t},
           is_current INTEGER NOT NULL DEFAULT 0,
           fetched_at ${t} NOT NULL,
           PRIMARY KEY (app_id, channel, update_id)
         )`,
        'CREATE INDEX IF NOT EXISTS eas_updates_app_idx ON eas_updates (app_id, channel)',
        'CREATE INDEX IF NOT EXISTS eas_updates_workspace_idx ON eas_updates (workspace_id)',
        `ALTER TABLE eas_status_sync ADD COLUMN updates_read_at ${t}`,
        'ALTER TABLE eas_status_sync ADD COLUMN updates_error TEXT',
      ];
    },
  },
];
