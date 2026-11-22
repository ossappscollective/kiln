import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 56: Kiln's own daily record of an app's star rating per store and country (docs/adr/0052-ratings-and-health.md). The stores only
 * say what a rating is now, so a row is written for every day a read saw one. It lives in its own file and is appended to `migrations` in
 * migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const ratingsMigrations: Migration[] = [
  {
    id: 56,
    name: 'Ratings history: one row per app, store, country and day a read saw the rating',
    statements: (dialect) => {
      const t = epoch(dialect);
      // app_rating_days: `day` is YYYY-MM-DD (UTC) of the read; the average is thousandths (4.512 -> 4512); `rating_count` is null when the store gives
      // no count; `star1`..`star5` (ratings with that many stars) are all null or all set, and only when the store says them (Apple's lookup
      // does not, so they stay null there). `version` is the version on sale when the store says. `observed_at` is epoch milliseconds. The
      // newest read of a day replaces the earlier one.
      return [
        `CREATE TABLE IF NOT EXISTS app_rating_days (
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           store TEXT NOT NULL,
           territory TEXT NOT NULL,
           day TEXT NOT NULL,
           average_milli INTEGER NOT NULL,
           rating_count ${t},
           star1 ${t},
           star2 ${t},
           star3 ${t},
           star4 ${t},
           star5 ${t},
           version TEXT,
           observed_at ${t} NOT NULL,
           PRIMARY KEY (app_id, store, territory, day)
         )`,
        'CREATE INDEX IF NOT EXISTS app_rating_days_workspace_idx ON app_rating_days (workspace_id, app_id, day)',
      ];
    },
  },
];
