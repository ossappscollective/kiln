import type { Migration } from './migrations.ts';

/**
 * Migration 58: the Apple vendor number of an App Store Connect credential (one per Apple team). A workspace can hold apps of several
 * teams, and Sales and Trends answers only for the vendor number of the key's own team, so the number is stored per credential next to
 * the Play bucket (`analytics_credential_config`, migration 42). The workspace setting `analytics.appleVendorNumber` stays as the
 * default for a credential without its own. Not a secret (a number shown in App Store Connect), never written to the audit log.
 * It lives in its own file and is appended to `migrations` in migrations.ts. Never edit a migration that has shipped; add a new one.
 */
export const analyticsVendorMigrations: Migration[] = [
  {
    id: 58,
    name: 'Analytics: the Apple vendor number of an App Store Connect credential',
    statements: () => ['ALTER TABLE analytics_credential_config ADD COLUMN apple_vendor_number TEXT'],
  },
];
