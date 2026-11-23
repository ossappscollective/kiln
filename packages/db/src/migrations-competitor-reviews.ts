import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migration 59: the public reviews of followed App Store competitors (docs/adr/0055-review-summary-and-competitor-reviews.md). Only what Apple's
 * customer-reviews feed says about a review (its id, stars, title, text, version, day); never an author. Kept at most 90 days and 200 per
 * competitor by the code that writes them, and deleted with the competitor. `aso_competitors.reviews_checked_at` is when they were last read.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const competitorReviewsMigrations: Migration[] = [
  {
    id: 59,
    name: 'Competitor reviews: the public App Store reviews of followed competitors',
    statements: (dialect) => {
      const t = epoch(dialect);
      return [
        `CREATE TABLE IF NOT EXISTS aso_competitor_reviews (
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           competitor_id TEXT NOT NULL REFERENCES aso_competitors(id) ON DELETE CASCADE,
           app_id TEXT NOT NULL,
           country TEXT NOT NULL,
           store_review_id TEXT NOT NULL,
           rating INTEGER NOT NULL,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           app_version TEXT,
           reviewed_at ${t} NOT NULL,
           fetched_at ${t} NOT NULL
         )`,
        'CREATE UNIQUE INDEX IF NOT EXISTS aso_competitor_reviews_unique_idx ON aso_competitor_reviews (competitor_id, store_review_id)',
        'CREATE INDEX IF NOT EXISTS aso_competitor_reviews_competitor_idx ON aso_competitor_reviews (competitor_id, reviewed_at)',
        `ALTER TABLE aso_competitors ADD COLUMN reviews_checked_at ${t}`,
      ];
    },
  },
];
