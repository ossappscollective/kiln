import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 57: the events a person adds to the timeline of an app (docs/adr/0053-timeline-and-reports.md). It lives in its own file and is
 * appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const timelineMigrations: Migration[] = [
  {
    id: 57,
    name: 'Timeline: events a person adds for an app (ad campaign, price change, press, other)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // timeline_events: one row per event a person writes down. `kind` is ad_campaign, price_change, press or other, `day` is a YYYY-MM-DD
      // date (UTC), `title` one line and `note` free text of a person: neither is ever logged or audited (the audit holds the id, the kind and the day).
      // Events Kiln knows by itself (releases, listing changes, experiments) are not stored here: they are read from where they live.
      return [
        `CREATE TABLE IF NOT EXISTS timeline_events (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           day TEXT NOT NULL,
           title TEXT NOT NULL,
           note TEXT NOT NULL DEFAULT '',
           created_by TEXT NOT NULL,
           created_at ${t} NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS timeline_events_app_idx ON timeline_events (app_id, day)',
        'CREATE INDEX IF NOT EXISTS timeline_events_workspace_idx ON timeline_events (workspace_id)',
      ];
    },
  },
];
