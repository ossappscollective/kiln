import type { Migration } from './migrations.ts';

/**
 * Migration 43: the HTML part of an alert email. The delivery row already holds the rendered subject and text, so a retry sends the
 * same message; it now holds the HTML twin as well (null for rows written before, which go out as text only). It lives in its own file
 * and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const alertEmailMigrations: Migration[] = [
  {
    id: 43,
    name: 'Alerts: the HTML part of an alert email on the delivery row',
    statements: () => ['ALTER TABLE alert_deliveries ADD COLUMN html TEXT'],
  },
];
