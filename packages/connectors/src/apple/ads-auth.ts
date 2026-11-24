import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { AppleAdsError } from './ads-errors.ts';

/**
 * Apple Ads authentication (docs/adr/0058-apple-ads.md), from Apple's "Implementing OAuth for the Apple Ads Platform API":
 *
 * - the API user's private key is an EC P-256 key (`openssl ecparam -genkey -name prime256v1`); its public half is saved in Apple Ads
 *   (Account Settings, API), which then shows a client ID, a team ID and a key ID;
 * - the CLIENT SECRET is a JWT signed ES256 with that key: header `{alg: ES256, kid: <key id>}`, payload `{sub: <client id>,
 *   aud: https://appleid.apple.com, iat, exp, iss: <team id>}`; `exp` must be after now and less than 180 days after `iat`;
 * - POST it as `client_secret`, with `grant_type=client_credentials`, `client_id` and `scope=searchadsorg`, to
 *   https://appleid.apple.com/auth/oauth2/token; the answer's `access_token` is a Bearer token valid `expires_in` seconds (one hour).
 *
 * The client secret here lives five minutes (the access token it buys lives an hour): a leaked client secret is soon useless.
 */
export const APPLE_ADS_TOKEN_ORIGIN = 'https://appleid.apple.com';
export const APPLE_ADS_TOKEN_PATH = '/auth/oauth2/token';
export const APPLE_ADS_SCOPE = 'searchadsorg';
export const APPLE_ADS_AUDIENCE = 'https://appleid.apple.com';
/** `exp - iat` of one client secret. Apple's limit is 180 days. */
export const APPLE_ADS_CLIENT_SECRET_SECONDS = 5 * 60;
/** `iat` is set this far in the past, so a clock slightly behind Apple's does not produce a token issued in the future. */
export const APPLE_ADS_IAT_BACKDATE_SECONDS = 30;

export type AppleAdsKey = {
  clientId: string;
  teamId: string;
  keyId: string;
  /** The PEM private key. Never logged, never returned. */
  privateKey: string;
};

const FIELDS = ['clientId', 'teamId', 'keyId', 'privateKey'] as const;

/** Reads the stored secret (core `buildSecret` JSON). Throws `AppleAdsError` `invalid_input`. */
export function parseAppleAdsSecret(secret: string): AppleAdsKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AppleAdsError('invalid_input', {
      message: 'The Apple Ads credential could not be read.',
    });
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  for (const name of FIELDS) {
    if (typeof o[name] !== 'string' || (o[name] as string).trim() === '') {
      throw new AppleAdsError('invalid_input', {
        message:
          'The Apple Ads credential is incomplete: client ID, team ID, key ID and private key are all needed.',
      });
    }
  }
  return {
    clientId: (o.clientId as string).trim(),
    teamId: (o.teamId as string).trim(),
    keyId: (o.keyId as string).trim(),
    privateKey: o.privateKey as string,
  };
}

/** Loads the PEM key. The Node error is never shown: some versions echo parts of the input. */
export function loadAppleAdsSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new AppleAdsError('invalid_key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new AppleAdsError('invalid_key');
  }
  return key;
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** One client secret (a JWT). `nowMs` is epoch milliseconds. */
export function signAppleAdsClientSecret(
  key: KeyObject,
  ids: { clientId: string; teamId: string; keyId: string },
  nowMs: number,
): { token: string; expiresAt: number } {
  const iat = Math.floor(nowMs / 1000) - APPLE_ADS_IAT_BACKDATE_SECONDS;
  const exp = iat + APPLE_ADS_CLIENT_SECRET_SECONDS;
  const signingInput = `${part({ alg: 'ES256', kid: ids.keyId })}.${part({
    sub: ids.clientId,
    aud: APPLE_ADS_AUDIENCE,
    iat,
    exp,
    iss: ids.teamId,
  })}`;
  // JWS wants the raw r||s signature, not Node's default DER encoding.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: exp * 1000 };
}
