import type { Migration } from './migrations.ts';

/**
 * Migration 51: the language a person reads (docs/adr/0045-server-message-localisation.md, amendment of 2026-11-22). `users.locale` is a
 * nullable BCP-47 tag restricted to the languages the server has catalogs for (en, fr, es, de; the API validates it, the column is plain
 * text so a new language needs no migration). NULL means "no choice": a background email then uses English. Nothing is backfilled.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const userLocaleMigrations: Migration[] = [
  {
    id: 51,
    name: 'Users: the language of the person (locale)',
    statements: () => ['ALTER TABLE users ADD COLUMN locale TEXT'],
  },
];
