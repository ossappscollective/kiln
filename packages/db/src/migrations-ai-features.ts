import type { Dialect } from './dialect.ts';
import type { Migration } from './migrations.ts';

/**
 * Migrations 40 and 41: the data of the AI features (docs/adr/0024-ai-features.md). They live in their own file and are appended to
 * `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */

const epoch = (dialect: Dialect) => (dialect === 'postgres' ? 'BIGINT' : 'INTEGER');

export const aiFeatureMigrations: Migration[] = [
  {
    id: 40,
    name: 'AI app context: what a person tells the assistant once about an app (description, audience, tone, banned words, brand terms)',
    statements: (dialect) => {
      const t = epoch(dialect);
      // ai_app_context: one row per app. context = JSON of the fields the person filled in (about, audience, tone, brandVoice,
      // bannedWords, brandTerms, doList, dontList). It is text a person TYPED for the assistant and is sent with every AI task of
      // the app (only the parts that are filled in). No credential and no review text is ever stored here. Deleted with the app.
      return [
        `CREATE TABLE IF NOT EXISTS ai_app_context (
           app_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           context TEXT NOT NULL,
           updated_by TEXT NOT NULL,
           updated_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS ai_app_context_workspace_idx ON ai_app_context (workspace_id)',
      ];
    },
  },
  {
    id: 41,
    name: 'AI review classifications: the tags the assistant gave a review, cached so a review is tagged once',
    statements: (dialect) => {
      const t = epoch(dialect);
      // review_classifications: one row per review. topics = JSON list from a fixed vocabulary, sentiment, severity, language
      // and needs_reply (0 or 1) are the assistant's ADVISORY tags; they change nothing about the review. text_hash = SHA-256 of
      // the text that was classified and task_version the classifier's version: a review whose text changed, or a newer
      // classifier, is tagged again; otherwise the row is the cache, so a review costs tokens once. NO REVIEW TEXT is stored,
      // only the hash. Deleted with the app, and when the review is gone.
      return [
        `CREATE TABLE IF NOT EXISTS review_classifications (
           review_id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id),
           app_id TEXT NOT NULL,
           task_version INTEGER NOT NULL,
           text_hash TEXT NOT NULL,
           topics TEXT NOT NULL,
           sentiment TEXT NOT NULL,
           severity TEXT NOT NULL,
           language TEXT,
           needs_reply INTEGER NOT NULL DEFAULT 0,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           created_at ${t} NOT NULL
         )`,
        'CREATE INDEX IF NOT EXISTS review_classifications_app_idx ON review_classifications (workspace_id, app_id)',
      ];
    },
  },
];
