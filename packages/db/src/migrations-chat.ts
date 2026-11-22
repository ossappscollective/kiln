import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 52: chat integrations (docs/adr/0047-chat-integrations.md, docs/chat-integrations.md). It lives in its own file and is
 * appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const chatMigrations: Migration[] = [
  {
    id: 52,
    name: 'Chat integrations: destinations (Slack, Teams), routing rules and the delivery log',
    statements: (dialect) => {
      const t = epoch(dialect);
      // chat_destinations: one incoming webhook of Slack or Microsoft Teams. `ciphertext` is the webhook URL, ENCRYPTED with the vault key
      // (bound to the workspace and the destination by AAD): the URL is the secret, it is never returned. `url_hint` is the last four
      // characters, the only part ever shown. `locale` is the language of the messages (en, fr, es, de). `allow_any_host` is the explicit
      // admin choice to accept a host outside the provider's known domains. `digest` is off or daily (at `digest_hour` in `timezone`).
      // `last_sent_at` paces the destination (about one message per second).
      // chat_routes: which alerts go to a destination: alert types (JSON array, or ["*"]), the lowest severity, optional apps and
      // platforms (JSON arrays, NULL = all).
      // chat_deliveries: one row per message to a destination: status, an outcome from a fixed vocabulary (never a provider's text),
      // the HTTP status, and the rendered JSON body (titles, names and links only; no secret).
      return [
        `CREATE TABLE IF NOT EXISTS chat_destinations (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           provider TEXT NOT NULL,
           name TEXT NOT NULL,
           ciphertext TEXT NOT NULL,
           url_hint TEXT NOT NULL,
           locale TEXT NOT NULL DEFAULT 'en',
           enabled INTEGER NOT NULL DEFAULT 1,
           allow_any_host INTEGER NOT NULL DEFAULT 0,
           digest TEXT NOT NULL DEFAULT 'off',
           digest_hour INTEGER NOT NULL DEFAULT 8,
           timezone TEXT NOT NULL DEFAULT 'UTC',
           last_digest_at ${t},
           last_sent_at ${t},
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS chat_destinations_workspace_idx ON chat_destinations (workspace_id)',
        `CREATE TABLE IF NOT EXISTS chat_routes (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           destination_id TEXT NOT NULL REFERENCES chat_destinations(id),
           alert_types TEXT NOT NULL,
           min_severity TEXT NOT NULL DEFAULT 'info',
           app_ids TEXT,
           platforms TEXT,
           enabled INTEGER NOT NULL DEFAULT 1,
           position INTEGER NOT NULL DEFAULT 0,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS chat_routes_destination_idx ON chat_routes (destination_id)',
        `CREATE TABLE IF NOT EXISTS chat_deliveries (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           destination_id TEXT NOT NULL REFERENCES chat_destinations(id),
           alert_id TEXT,
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           outcome TEXT NOT NULL,
           http_status INTEGER,
           attempts INTEGER NOT NULL DEFAULT 0,
           payload TEXT,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL,
           delivered_at ${t}
         )`,
        'CREATE INDEX IF NOT EXISTS chat_deliveries_destination_idx ON chat_deliveries (destination_id, created_at)',
        'CREATE INDEX IF NOT EXISTS chat_deliveries_workspace_idx ON chat_deliveries (workspace_id, created_at)',
      ];
    },
  },
];
