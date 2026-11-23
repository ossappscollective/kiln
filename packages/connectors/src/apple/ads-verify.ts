import { redactSecrets, secretStrings } from '../errors.ts';
import type { VerifyOptions, VerifyResult } from '../verify.ts';
import { createAppleAdsClient } from './ads-client.ts';
import { parseAppleAdsSecret } from './ads-auth.ts';
import { AppleAdsError } from './ads-errors.ts';
import { listAppleAdsAccounts } from './ads-read.ts';

/**
 * "Test connection" for an Apple Ads credential: signs the client secret, exchanges it for an access token (`appleid.apple.com`) and
 * asks which ad accounts the key may read (`GET /v1/acls`). Both are reads. Never throws; no message or detail carries the private
 * key, the client secret or the token. It reads no campaign and no report.
 */
export type AppleAdsVerifyOptions = VerifyOptions & {
  apiOrigin?: string | undefined;
  tokenOrigin?: string | undefined;
  timeoutMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

const MAX_SHOWN = 5;

export async function verifyAppleAdsCredential(secret: string, options: AppleAdsVerifyOptions = {}): Promise<VerifyResult> {
  const known = secretStrings(secret);
  const clean = (value: string) => redactSecrets(value, known);
  try {
    const credential = parseAppleAdsSecret(secret);
    const client = createAppleAdsClient({
      credential,
      fetch: options.fetch,
      now: options.now,
      apiOrigin: options.apiOrigin,
      tokenOrigin: options.tokenOrigin,
      timeoutMs: options.timeoutMs ?? 10_000,
      sleep: options.sleep,
      maxWaitSeconds: 5,
    });
    await client.authenticate();
    const accounts = await listAppleAdsAccounts(client);
    if (accounts.length === 0) throw new AppleAdsError('no_account');
    const details = accounts.slice(0, MAX_SHOWN).map((a) => `Ad account: ${clean(a.name)} (${a.id})${a.roles.length ? `, role ${a.roles.map(clean).join(', ')}` : ''}`);
    if (accounts.length > MAX_SHOWN) details.push(`and ${accounts.length - MAX_SHOWN} more ad accounts`);
    return {
      ok: true,
      message: `Connected to Apple Ads. The key can read ${accounts.length} ad account${accounts.length === 1 ? '' : 's'}.`,
      details,
    };
  } catch (error) {
    if (error instanceof AppleAdsError) {
      const status = error.status !== undefined ? [`HTTP status: ${error.status}`] : [];
      return { ok: false, message: clean(error.message), ...(status.length ? { details: status } : {}) };
    }
    return { ok: false, message: 'The Apple Ads key could not be checked. Try again in a moment.' };
  }
}
