import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { checkSecret } from '@mrm/core';
import { StoreError } from './errors.ts';

/**
 * App Store Connect API authentication: an ES256 JWT signed with the team API key (.p8, a P-256
 * key in PKCS#8). Rules from Apple's "Generating Tokens for API Requests":
 *
 * - header `{alg: ES256, kid: <key id>, typ: JWT}`
 * - payload `{iss: <issuer id>, iat, exp, aud: 'appstoreconnect-v1'}` (`scope` is optional)
 * - "For most requests, App Store Connect rejects a token with a lifetime greater than 20
 *   minutes", where lifetime is `exp - iat`.
 * - Reuse one token for many requests until it expires.
 */

export type AppStoreConnectKey = {
  keyId: string;
  issuerId: string;
  privateKey: string;
};

/** `exp - iat`. Apple's limit is 20 minutes; stay under it. */
export const APPLE_TOKEN_LIFETIME_SECONDS = 19 * 60;
/**
 * `iat` is set this far in the past, so a clock that runs slightly behind Apple's does not produce
 * a token "issued in the future". It counts against the lifetime above.
 */
export const APPLE_IAT_BACKDATE_SECONDS = 30;
const REFRESH_MARGIN_MS = 60_000;

/** Reads the stored secret (core `buildSecret` JSON). Throws `StoreError` `invalid_input`. */
export function parseAppStoreConnectSecret(secret: string): AppStoreConnectKey {
  const problem = checkSecret('app_store_connect', secret);
  if (problem) throw new StoreError('appstoreconnect', 'invalid_input', problem);
  const parsed = JSON.parse(secret) as Record<string, string>;
  return {
    keyId: (parsed.keyId ?? '').trim(),
    issuerId: (parsed.issuerId ?? '').trim(),
    privateKey: parsed.privateKey ?? '',
  };
}

/** Loads the .p8 key. The Node error is never shown: some versions echo parts of the input. */
export function loadAppleSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new StoreError(
      'appstoreconnect',
      'invalid_input',
      'The private key could not be read. Paste the whole .p8 file from App Store Connect, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.',
    );
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new StoreError(
      'appstoreconnect',
      'invalid_input',
      'The private key is not a P-256 key. App Store Connect API keys (.p8) use P-256, so this looks like a different kind of key.',
    );
  }
  return key;
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A signed token. `nowMs` is epoch milliseconds. */
export function signAppStoreConnectJwt(
  key: KeyObject,
  keyId: string,
  issuerId: string,
  nowMs: number,
): { token: string; expiresAt: number } {
  const iat = Math.floor(nowMs / 1000) - APPLE_IAT_BACKDATE_SECONDS;
  const exp = iat + APPLE_TOKEN_LIFETIME_SECONDS;
  const signingInput = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({
    iss: issuerId,
    iat,
    exp,
    aud: 'appstoreconnect-v1',
  })}`;
  // JWS wants the raw r||s signature, not Node's default DER encoding.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: exp * 1000 };
}

/** Hands out one cached token, renewed a minute before it expires. */
export class AppStoreConnectTokenProvider {
  readonly keyId: string;
  readonly issuerId: string;
  readonly #key: KeyObject;
  readonly #now: () => number;
  #cached?: { token: string; expiresAt: number };

  constructor(credential: AppStoreConnectKey, now: () => number = Date.now) {
    this.keyId = credential.keyId;
    this.issuerId = credential.issuerId;
    this.#key = loadAppleSigningKey(credential.privateKey);
    this.#now = now;
  }

  token(): string {
    const cached = this.#cached;
    if (cached && cached.expiresAt - this.#now() > REFRESH_MARGIN_MS) return cached.token;
    this.#cached = signAppStoreConnectJwt(this.#key, this.keyId, this.issuerId, this.#now());
    return this.#cached.token;
  }

  /** Forget the token, e.g. after a 401, so the next call signs a new one. */
  invalidate(): void {
    this.#cached = undefined;
  }
}
