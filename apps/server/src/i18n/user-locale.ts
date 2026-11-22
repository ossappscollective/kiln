/**
 * The language a person reads (ADR 0045, amendment of 2026-11-22): `users.locale`, a nullable BCP-47 tag restricted to the languages the
 * server has catalogs for. Used by emails that have no request to read `Accept-Language` from (alerts, the digest). Order for such an
 * email: the recipient's `locale`, then the workspace default (there is none; do not add one), then English.
 */
import type { Sql } from '@kiln/db';
import { isServerLocale, SERVER_LOCALES, SOURCE_LOCALE } from './runtime.ts';

/**
 * A language tag from a client to the supported language, or undefined when it is not one of them. `fr`, `FR`, `fr-CA` and `fr_CA` all give
 * `fr` (the catalogs are per language, not per region); `pt`, `fr!` or a non-string give undefined.
 */
export function parseUserLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 35) return undefined;
  const tag = value.trim().replace(/_/g, '-').toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(tag)) return undefined;
  const language = tag.split('-')[0] as string;
  return isServerLocale(language) ? language : undefined;
}

/** A stored value to a language the server can use, or null (a row written by hand, or by a build that knew another language). */
export const storedLocale = (value: unknown): string | null => parseUserLocale(value) ?? null;

/** The language of an email for a person: their choice, else English (there is no workspace default). */
export async function recipientLocale(sql: Sql, userId: string | null | undefined): Promise<string> {
  if (!userId) return SOURCE_LOCALE;
  try {
    const [row] = await sql.query('SELECT locale FROM users WHERE id = ?', [userId]);
    return storedLocale(row?.locale) ?? SOURCE_LOCALE;
  } catch {
    return SOURCE_LOCALE;
  }
}

export { SERVER_LOCALES };
