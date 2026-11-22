import { redactSecrets, secretStrings } from '../errors.ts';
import type { VerifyOptions, VerifyResult } from '../verify.ts';
import { createExpoClient } from './client.ts';
import { ExpoError } from './errors.ts';
import { expoViewer } from './queries.ts';

/**
 * "Test connection" for an Expo access token: asks Expo who the token belongs to (`meActor`, a read) and says so. Never throws; no
 * message or detail carries the token. The stored secret is the token itself (one string, like a GitHub token).
 */

export type ExpoVerifyOptions = VerifyOptions & {
  /** Default https://api.expo.dev. */
  apiOrigin?: string | undefined;
  /** Per request. Default 10000. */
  timeoutMs?: number | undefined;
};

const MAX_ACCOUNTS_SHOWN = 8;

export async function verifyExpoCredential(
  secret: string,
  options: ExpoVerifyOptions = {},
): Promise<VerifyResult> {
  const known = secretStrings(secret);
  const clean = (value: string) => redactSecrets(value, known);
  const token = secret.trim();
  if (!token) return { ok: false, message: 'Enter the access token.' };
  if (/\s/.test(token)) return { ok: false, message: 'A token has no spaces or line breaks.' };
  try {
    const client = createExpoClient({
      token,
      fetch: options.fetch,
      apiOrigin: options.apiOrigin,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    const who = await expoViewer(client);
    if (!who) {
      return {
        ok: false,
        message:
          'Expo did not recognize the token. Create an access token in the Expo dashboard (Access tokens) and enter it again.',
      };
    }
    const names = who.accounts.map((a) => a.name);
    const shown = names.slice(0, MAX_ACCOUNTS_SHOWN).join(', ');
    const more =
      names.length > MAX_ACCOUNTS_SHOWN ? `, and ${names.length - MAX_ACCOUNTS_SHOWN} more` : '';
    const details = [
      `Signed in as: ${clean(who.displayName)}`,
      who.kind === 'robot'
        ? 'Type: robot user'
        : 'Type: personal token (a robot user with the Developer role is recommended)',
      names.length > 0
        ? `Accounts: ${clean(shown)}${more}`
        : 'Accounts: none visible to this token',
    ];
    return { ok: true, message: `Connected to Expo as ${clean(who.displayName)}.`, details };
  } catch (error) {
    if (error instanceof ExpoError) {
      const details = error.status !== undefined ? [`HTTP status: ${error.status}`] : [];
      return { ok: false, message: clean(error.message), ...(details.length ? { details } : {}) };
    }
    return { ok: false, message: 'The Expo token could not be checked. Try again in a moment.' };
  }
}
