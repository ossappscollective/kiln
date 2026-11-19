import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { checkSecret } from '@mrm/core';
import { StoreError } from './errors.ts';
import { isRecord, type StoreHttp, serverTime, text } from './store-http.ts';

/**
 * Google service account authentication without a client library: a self-signed RS256 JWT is
 * exchanged for an access token at the OAuth token endpoint (the JWT bearer grant). Rules from
 * "Using OAuth 2.0 for Server to Server Applications":
 *
 * - header `{alg: RS256, typ: JWT}` (`kid` optional)
 * - claims `iss` (service account email), `scope`, `aud` (the token endpoint), `exp`, `iat`;
 *   `exp` is at most one hour after `iat`
 * - POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`
 * - the response carries `access_token`, `token_type: Bearer`, `expires_in` (3600 in the docs)
 */

export type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  projectId?: string;
};

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
/** Play Developer Reporting API (Android vitals). Confirmed on the `query` and `anomalies.list` reference pages. */
export const PLAY_DEVELOPER_REPORTING_SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting';
/** Cloud Storage, read only: the monthly Play Console CSV reports. Google names it for programmatic access to those reports. */
export const DEVSTORAGE_READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const REFRESH_MARGIN_MS = 60_000;

/** Reads the service account JSON key file. Throws a `StoreError` of kind `invalid_input`. */
export function parseServiceAccount(secret: string): ServiceAccount {
  const problem = checkSecret('google_play', secret);
  if (problem) throw new StoreError('googleplay', 'invalid_input', problem);
  const parsed = JSON.parse(secret) as Record<string, unknown>;
  const account: ServiceAccount = {
    clientEmail: String(parsed.client_email).trim(),
    privateKey: String(parsed.private_key),
  };
  if (typeof parsed.private_key_id === 'string') account.privateKeyId = parsed.private_key_id;
  if (typeof parsed.project_id === 'string') account.projectId = parsed.project_id;
  return account;
}

/** Loads the RSA key. The Node error is never shown: some versions echo parts of the input. */
export function loadGoogleSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new StoreError(
      'googleplay',
      'invalid_input',
      'The private_key in the service account JSON could not be read. Download a new JSON key from the Google Cloud console and paste the whole file.',
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new StoreError(
      'googleplay',
      'invalid_input',
      'The private_key in the service account JSON is not an RSA key, which Google service accounts use.',
    );
  }
  return key;
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A signed assertion for the token endpoint, valid for 55 minutes from `nowMs`. */
export function signGoogleAssertion(
  key: KeyObject,
  account: ServiceAccount,
  nowMs: number,
  scope: string = ANDROID_PUBLISHER_SCOPE,
): string {
  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (account.privateKeyId) header.kid = account.privateKeyId;
  const signingInput = `${part(header)}.${part({
    iss: account.clientEmail,
    scope,
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat,
    exp: iat + 55 * 60,
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Turns a failed token exchange into a `StoreError` whose message says what to fix. Nothing from
 * the response is echoed except Google's short error code, which is not a secret.
 */
export function googleTokenError(
  status: number,
  json: unknown,
  headers: Headers,
  nowMs: number,
  scope: string = ANDROID_PUBLISHER_SCOPE,
): StoreError {
  const body = isRecord(json) ? json : {};
  const code = text(body.error) ?? '';
  const description = text(body.error_description) ?? '';
  const skew = serverTime(headers);
  const skewSeconds = skew === undefined ? undefined : Math.round((nowMs - skew) / 1000);
  if (code === 'invalid_grant') {
    if (/short-lived|reasonable timeframe|iat|exp/i.test(description)) {
      const by =
        skewSeconds !== undefined && Math.abs(skewSeconds) > 30
          ? ` This server's clock differs from Google's by about ${Math.abs(skewSeconds)} seconds (${
              skewSeconds > 0 ? 'ahead' : 'behind'
            }).`
          : '';
      return new StoreError(
        'googleplay',
        'clock_skew',
        `Google rejected the sign-in because of the time (invalid_grant).${by} Check that the server clock is correct and synchronized (NTP).`,
        status,
      );
    }
    if (/signature/i.test(description)) {
      return new StoreError(
        'googleplay',
        'auth',
        'Google rejected the key signature (invalid_grant: Invalid JWT Signature). The key was probably deleted or disabled in the Google Cloud console. Create a new JSON key for the service account.',
        status,
      );
    }
    if (/account not found|not a valid email|invalid email/i.test(description)) {
      return new StoreError(
        'googleplay',
        'auth',
        'Google does not know this service account (invalid_grant). It may have been deleted, or client_email is wrong. Download a fresh JSON key.',
        status,
      );
    }
    return new StoreError(
      'googleplay',
      'auth',
      'Google refused the sign-in (invalid_grant). The service account key may be disabled or deleted, or the server clock may be wrong.',
      status,
    );
  }
  if (code === 'invalid_scope' || code === 'unauthorized_client') {
    return new StoreError(
      'googleplay',
      'auth',
      `Google refused the ${scope.slice(scope.lastIndexOf('/') + 1)} scope for this service account (${code}).`,
      status,
    );
  }
  if (code === 'invalid_client') {
    return new StoreError(
      'googleplay',
      'auth',
      'Google does not recognise this service account (invalid_client). Download a fresh JSON key.',
      status,
    );
  }
  return new StoreError(
    'googleplay',
    status >= 500 ? 'server' : 'auth',
    status >= 500
      ? `Google's sign-in service failed (HTTP ${status}). Try again in a few minutes.`
      : `Google's sign-in service refused the request (HTTP ${status}${code ? `, ${code}` : ''}).`,
    status,
  );
}

/**
 * Mints and caches access tokens for one service account and ONE scope, renewed a minute before expiry. The scope defaults to
 * `androidpublisher`, so every existing caller is unchanged; analytics builds one provider per scope from the same key
 * (`PLAY_DEVELOPER_REPORTING_SCOPE`, `DEVSTORAGE_READ_ONLY_SCOPE`), so a token for one API is never sent to another.
 */
export class GoogleTokenProvider {
  readonly account: ServiceAccount;
  readonly scope: string;
  readonly #key: KeyObject;
  readonly #http: StoreHttp;
  #cached?: { token: string; expiresAt: number };
  #pending?: Promise<string>;

  constructor(account: ServiceAccount, http: StoreHttp, scope: string = ANDROID_PUBLISHER_SCOPE) {
    this.account = account;
    this.scope = scope;
    this.#http = http;
    this.#key = loadGoogleSigningKey(account.privateKey);
    http.known.add(account.privateKey);
    http.known.add(account.privateKey.trim());
    for (const line of account.privateKey.split(/\r?\n/)) {
      if (line && !line.startsWith('-----')) http.known.add(line.trim());
    }
  }

  token(): Promise<string> {
    const cached = this.#cached;
    if (cached && cached.expiresAt - this.#http.now() > REFRESH_MARGIN_MS) {
      return Promise.resolve(cached.token);
    }
    this.#pending ??= this.#mint().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  async #mint(): Promise<string> {
    const assertion = signGoogleAssertion(this.#key, this.account, this.#http.now(), this.scope);
    this.#http.known.add(assertion);
    const reply = await this.#http.send('POST', GOOGLE_TOKEN_ENDPOINT, {
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      },
    });
    if (reply.status !== 200) {
      throw googleTokenError(reply.status, reply.json, reply.headers, this.#http.now(), this.scope);
    }
    const body = isRecord(reply.json) ? reply.json : {};
    const token = text(body.access_token);
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    if (!token) {
      throw new StoreError(
        'googleplay',
        'unexpected',
        'Google answered the sign-in with a response that could not be read.',
        reply.status,
      );
    }
    this.#http.known.add(token);
    this.#cached = { token, expiresAt: this.#http.now() + expiresIn * 1000 };
    return token;
  }
}
