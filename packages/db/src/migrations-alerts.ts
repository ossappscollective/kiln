import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migrations 37 and 38: the alert system (docs/adr/0022-alerts.md, docs/alerts.md). They live in their own file and are spliced
 * into `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const alertMigrations: Migration[] = [
  {
    id: 37,
    name: 'Alert settings: workspace rules, personal settings and choices, mutes',
    statements: (dialect) => {
      const t = epoch(dialect);
      // alert_workspace_rules: what an admin decided for one alert type of a workspace. channels is a JSON array of the channels (in_app,
      // email, desktop, webhook) the type uses by default for people who made no choice of their own (and the webhook channel itself);
      // params is JSON with the numeric thresholds of the type. A missing row means "the catalog defaults". max_per_hour caps alerts of
      // the type per workspace and hour (repeats are then only counted); NULL means the catalog value.
      // alert_user_settings: one row per person and workspace: the lowest severity they want, quiet hours (minutes after midnight in
      // their timezone, an IANA name; critical alerts ignore them), and an optional email digest (off, daily or weekly) sent at digest_hour.
      // alert_preferences: a person's own channels for one alert type, for all apps (app_id '') or one app. alert_mutes: a snooze or a
      // mute of one app, one alert type or both (NULL = all); until NULL means "until I turn it back on".
      // Nothing in these tables is a secret: they hold choices, never an address (the address is the user's, read when sending).
      return [
        `CREATE TABLE IF NOT EXISTS alert_workspace_rules (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           alert_type TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 1,
           channels TEXT NOT NULL,
           max_per_hour INTEGER,
           params TEXT,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL,
           PRIMARY KEY (workspace_id, alert_type)
         )`,
        `CREATE TABLE IF NOT EXISTS alert_user_settings (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           min_severity TEXT NOT NULL DEFAULT 'info',
           quiet_start INTEGER,
           quiet_end INTEGER,
           timezone TEXT,
           digest TEXT NOT NULL DEFAULT 'off',
           digest_hour INTEGER NOT NULL DEFAULT 8,
           last_digest_at ${t},
           updated_at ${t} NOT NULL,
           PRIMARY KEY (workspace_id, user_id)
         )`,
        `CREATE TABLE IF NOT EXISTS alert_preferences (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           alert_type TEXT NOT NULL,
           app_id TEXT NOT NULL DEFAULT '',
           channels TEXT NOT NULL,
           updated_at ${t} NOT NULL,
           PRIMARY KEY (workspace_id, user_id, alert_type, app_id)
         )`,
        `CREATE TABLE IF NOT EXISTS alert_mutes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           app_id TEXT,
           alert_type TEXT,
           until ${t},
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS alert_mutes_user_idx ON alert_mutes (workspace_id, user_id)',
      ];
    },
  },
  {
    id: 38,
    name: 'Alerts: the occurrences, the inbox, the delivery log and the state conditions the evaluator watches',
    statements: (dialect) => {
      const t = epoch(dialect);
      // alerts: one row per alert after repeats collapsed. dedupe_key is the type's key (see the catalog); an occurrence with the same key
      // within the type's window is counted in `count` and moves last_at instead of making a row. title and body are rendered from ids,
      // names and numbers (no secret, no review text); data is the JSON of those values. resolved_at is set when a state condition clears.
      // alert_inbox: one row per person and alert (the in-app channel). desktop = 1 when the person's choices allow a desktop
      // notification for it (outside quiet hours); the client shows it once. read_at NULL means unread.
      // alert_deliveries: the log. One row per channel attempt for a person (or the workspace webhook). status is queued, retrying, sent,
      // failed, skipped or deferred; outcome is a code from a FIXED vocabulary (never text a provider said). subject and body are the
      // rendered message kept for a retry (email only). event_id points at the alert.raised event of the webhook channel.
      // alert_conditions: what the evaluator last saw for a state condition (key = the alert's dedupe key), so a condition raises once
      // when it starts, again only after its renotify time, and is marked resolved when it ends.
      return [
        `CREATE TABLE IF NOT EXISTS alerts (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           type TEXT NOT NULL,
           severity TEXT NOT NULL,
           app_id TEXT,
           dedupe_key TEXT NOT NULL,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           data TEXT NOT NULL,
           count INTEGER NOT NULL DEFAULT 1,
           first_at ${t} NOT NULL,
           last_at ${t} NOT NULL,
           resolved_at ${t},
           is_test INTEGER NOT NULL DEFAULT 0
         )`,
        'CREATE INDEX IF NOT EXISTS alerts_key_idx ON alerts (workspace_id, dedupe_key, last_at)',
        'CREATE INDEX IF NOT EXISTS alerts_workspace_idx ON alerts (workspace_id, last_at)',
        'CREATE INDEX IF NOT EXISTS alerts_type_idx ON alerts (workspace_id, type, first_at)',
        `CREATE TABLE IF NOT EXISTS alert_inbox (
           alert_id TEXT NOT NULL REFERENCES alerts(id),
           user_id TEXT NOT NULL REFERENCES users(id),
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           desktop INTEGER NOT NULL DEFAULT 0,
           read_at ${t},
           created_at ${t} NOT NULL,
           PRIMARY KEY (alert_id, user_id)
         )`,
        'CREATE INDEX IF NOT EXISTS alert_inbox_user_idx ON alert_inbox (workspace_id, user_id, read_at)',
        `CREATE TABLE IF NOT EXISTS alert_deliveries (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           alert_id TEXT,
           user_id TEXT,
           channel TEXT NOT NULL,
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           outcome TEXT NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 0,
           subject TEXT,
           body TEXT,
           event_id ${t},
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           delivered_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS alert_deliveries_workspace_idx ON alert_deliveries (workspace_id, created_at)',
        'CREATE INDEX IF NOT EXISTS alert_deliveries_alert_idx ON alert_deliveries (alert_id)',
        `CREATE TABLE IF NOT EXISTS alert_conditions (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           dedupe_key TEXT NOT NULL,
           type TEXT NOT NULL,
           app_id TEXT,
           first_seen_at ${t} NOT NULL,
           last_seen_at ${t} NOT NULL,
           raised_at ${t} NOT NULL,
           active INTEGER NOT NULL DEFAULT 1,
           alert_id TEXT,
           PRIMARY KEY (workspace_id, dedupe_key)
         )`,
        'CREATE INDEX IF NOT EXISTS alert_conditions_active_idx ON alert_conditions (workspace_id, active)',
      ];
    },
  },
];
