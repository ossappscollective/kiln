import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 67: the per-app choice of what reviews may be sent to an AI provider, and 68: the schedule of the reads of competitor reviews
 * (docs/adr/0064-ai-review-privacy-and-competitor-schedule.md). Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const reviewControlMigrations: Migration[] = [
  {
    id: 67,
    name: 'AI review privacy: per app, which reviews may go to AI and in what form',
    statements: (dialect) => {
      const t = epoch(dialect);
      // One row per app, only once a person chose something. own_reviews and competitor_reviews: 'on', 'off' or NULL (follow the
      // workspace, which is the ceiling). detail: full, text or ratings. redact: 1 or 0. No review text is stored here.
      return [
        `CREATE TABLE IF NOT EXISTS ai_app_review_policy (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           own_reviews TEXT,
           competitor_reviews TEXT,
           detail TEXT NOT NULL DEFAULT 'text',
           redact INTEGER NOT NULL DEFAULT 1,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS ai_app_review_policy_workspace_idx ON ai_app_review_policy (workspace_id)',
      ];
    },
  },
  {
    id: 68,
    name: 'Competitor review schedule: per app, and per competitor an override and the state of the last read',
    statements: (dialect) => {
      const t = epoch(dialect);
      // competitor_review_schedules: one row per app (mode off, daily or weekly; weekday 0 to 6; timezone an IANA name or NULL for UTC;
      // paused 0 or 1; max_competitors and max_reviews are the cost guards). The columns of aso_competitors: review_schedule is the
      // competitor's own override (NULL follows the app) with review_weekday and review_schedule_at (when it was set); the rest is the state of the scheduled reads (the newest
      // review seen, how many were new, failures in a row, the backoff, the last coded error, the last scheduled attempt).
      return [
        `CREATE TABLE IF NOT EXISTS competitor_review_schedules (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           mode TEXT NOT NULL DEFAULT 'off',
           weekday INTEGER,
           timezone TEXT,
           paused INTEGER NOT NULL DEFAULT 0,
           max_competitors INTEGER NOT NULL DEFAULT 5,
           max_reviews INTEGER NOT NULL DEFAULT 20,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS competitor_review_schedules_workspace_idx ON competitor_review_schedules (workspace_id)',
        'ALTER TABLE aso_competitors ADD COLUMN review_schedule TEXT',
        'ALTER TABLE aso_competitors ADD COLUMN review_weekday INTEGER',
        `ALTER TABLE aso_competitors ADD COLUMN review_schedule_at ${t}`,
        'ALTER TABLE aso_competitors ADD COLUMN reviews_last_seen_id TEXT',
        'ALTER TABLE aso_competitors ADD COLUMN reviews_new_count INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE aso_competitors ADD COLUMN reviews_failures INTEGER NOT NULL DEFAULT 0',
        `ALTER TABLE aso_competitors ADD COLUMN reviews_backoff_until ${t}`,
        'ALTER TABLE aso_competitors ADD COLUMN reviews_last_error TEXT',
        `ALTER TABLE aso_competitors ADD COLUMN reviews_attempt_at ${t}`,
      ];
    },
  },
];
