import type { Migration } from './migrations.ts';

/**
 * Migration 50: the stable code of a stored failure note (docs/adr/0045-server-message-localisation.md). `apps.last_sync_error` keeps the
 * English sentence (API clients and rows written before this keep working). `last_sync_error_code` is its machine code (dot.case, for
 * example `store.google.noAccess`) and `last_sync_error_params` the values the sentence needs, as a JSON object of plain scalars
 * (never a secret). The web app shows `errors:<code>` in the person's language and the English text when the code is null or unknown.
 * Rows written before the migration have both null: no data is rewritten. It lives in its own file and is appended to `migrations` in
 * migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const syncErrorCodeMigrations: Migration[] = [
  {
    id: 50,
    name: 'Apps: the code and parameters of the last sync failure note',
    statements: () => [
      'ALTER TABLE apps ADD COLUMN last_sync_error_code TEXT',
      'ALTER TABLE apps ADD COLUMN last_sync_error_params TEXT',
    ],
  },
];
