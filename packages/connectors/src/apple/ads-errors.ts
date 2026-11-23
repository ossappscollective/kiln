import { type ErrorCoding, redactSecrets } from '../errors.ts';

/**
 * Typed errors of the Apple Ads client (docs/adr/0058-apple-ads.md). The message is a fixed sentence per kind: Apple's own text is never
 * copied into it (it can echo ids and requests), and `redactSecrets` runs over it anyway. The private key, the client secret and the
 * access token are never part of an error.
 */
export type AppleAdsErrorKind =
  /** The private key could not be read, or is not a P-256 key. Nothing was sent. */
  | 'invalid_key'
  /** Apple's sign-in refused the key (`invalid_client`, 400 or 401): the public key is not in Apple Ads, or the ids do not match. */
  | 'auth'
  /** Apple Ads accepted the key, but the user has no access to the ad account or lacks the role (403). */
  | 'forbidden'
  /** No such ad account or campaign, or the key cannot see it (404). */
  | 'not_found'
  /** 429 `rate_limit_exceeded`. */
  | 'rate_limited'
  /** Apple answered 5xx. */
  | 'server'
  /** No answer: the connection failed or the time limit passed (`timedOut`). */
  | 'network'
  /** Apple answered with something this client cannot read (including a redirect, which is never followed). */
  | 'unexpected'
  /** The request was refused before it was sent (a bad id, a bad date range, a path that is not on the read-only list). */
  | 'invalid_input'
  /** The key sees no ad account. */
  | 'no_account';

const TABLE: Record<AppleAdsErrorKind, { message: string; code: string }> = {
  invalid_key: {
    message:
      'The private key could not be read. Paste the whole private-key.pem file, from -----BEGIN EC PRIVATE KEY----- to -----END EC PRIVATE KEY-----. It must be a P-256 key.',
    code: 'ads.invalidKey',
  },
  auth: {
    message:
      'Apple did not accept the key. Check that the public key of this private key is saved in Apple Ads (Account Settings, API) and that the client ID, team ID and key ID are the ones Apple Ads showed after saving it.',
    code: 'ads.auth',
  },
  forbidden: {
    message:
      'Apple Ads accepted the key, but this user may not read the ad account. Give the API user a role with read access, such as API Account Read Only, in Apple Ads.',
    code: 'ads.forbidden',
  },
  not_found: {
    message: 'Apple Ads has no such ad account or campaign, or the key cannot see it.',
    code: 'ads.notFound',
  },
  rate_limited: {
    message: 'Apple Ads asked to slow down. Try again in a minute.',
    code: 'ads.rateLimited',
  },
  server: { message: 'Apple Ads had a problem. Try again in a few minutes.', code: 'ads.server' },
  network: {
    message:
      'Could not reach Apple Ads. Check that this server has internet access (and a proxy, if it needs one) to appleid.apple.com and api.ads.apple.com, then try again.',
    code: 'ads.network',
  },
  unexpected: {
    message: 'Apple Ads answered with something this server could not read.',
    code: 'ads.unexpected',
  },
  invalid_input: { message: 'That is not a valid Apple Ads request.', code: 'ads.invalidInput' },
  no_account: {
    message:
      'Apple Ads accepted the key, but it sees no ad account. Invite the API user to the account in Apple Ads (Account Settings, User Management).',
    code: 'ads.noAccount',
  },
};

export class AppleAdsError extends Error {
  readonly kind: AppleAdsErrorKind;
  readonly status?: number;
  readonly timedOut: boolean;
  /** Seconds to wait, for `rate_limited`. */
  readonly retryAfterSeconds?: number;
  readonly coding?: ErrorCoding;
  constructor(
    kind: AppleAdsErrorKind,
    options: {
      status?: number | undefined;
      timedOut?: boolean | undefined;
      retryAfterSeconds?: number | undefined;
      message?: string | undefined;
      known?: Iterable<string> | undefined;
    } = {},
  ) {
    super(redactSecrets(options.message ?? TABLE[kind].message, options.known ?? []));
    this.name = 'AppleAdsError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    this.timedOut = options.timedOut === true;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    // Only the unmodified sentence has a code: a custom message is shown in English.
    if (options.message === undefined) this.coding = { code: TABLE[kind].code };
  }
}

export const isAppleAdsError = (value: unknown): value is AppleAdsError =>
  value instanceof AppleAdsError;

export const appleAdsErrorMessage = (kind: AppleAdsErrorKind): string => TABLE[kind].message;
export const appleAdsErrorCode = (kind: AppleAdsErrorKind): string => TABLE[kind].code;

/** Which kind an error answer of the Apple Ads API (or of Apple's sign-in) is, from the status. 400 on the token endpoint is `auth`: see the client. */
export function appleAdsErrorKind(status: number): AppleAdsErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_input';
  if (status >= 500) return 'server';
  return 'unexpected';
}
