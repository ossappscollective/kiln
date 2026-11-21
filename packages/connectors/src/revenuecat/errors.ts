import { redactSecrets } from '../errors.ts';

/**
 * Typed errors of the RevenueCat client (docs/adr/0039-revenuecat.md). The kinds are the ones the other connectors use, so a caller
 * maps them to HTTP the same way. The message is a fixed sentence per kind: RevenueCat's own text is never copied into it (it can
 * name ids and echo a request), and `redactSecrets` runs over it anyway. The secret key is never part of an error.
 */
export type RevenueCatErrorKind =
  /** The key is missing, malformed, revoked or unknown to RevenueCat (`authentication_error`, 401). */
  | 'auth'
  /** RevenueCat knows the key, but it may not read this (`authorization_error`, 403): a permission is missing. */
  | 'forbidden'
  /** No such project or app, or the key cannot see it (`resource_missing`, 404). */
  | 'not_found'
  /** `rate_limit_error`, 429: 60 requests a minute for the project configuration, per key. */
  | 'rate_limited'
  /** RevenueCat answered 5xx. */
  | 'server'
  /** No answer: the connection failed or the time limit passed (`timedOut`). */
  | 'network'
  /** RevenueCat answered with something this client cannot read (including a redirect, which is never followed). */
  | 'unexpected'
  /** The request was refused before it was sent (a bad id, a bad address). */
  | 'invalid_input';

const MESSAGES: Record<RevenueCatErrorKind, string> = {
  auth: 'RevenueCat did not accept the secret API key. Check that it is a V2 secret key (it starts with sk_) and has not been revoked.',
  forbidden:
    'RevenueCat accepted the key, but it may not read this. Allow reading projects, apps, products, entitlements, offerings and packages for the key in the RevenueCat dashboard.',
  not_found: 'RevenueCat has no such project or app, or the key cannot see it.',
  rate_limited:
    'RevenueCat said to slow down (it allows 60 reads a minute for the project configuration, per key). Try again in a minute.',
  server: 'RevenueCat had a problem. Try again in a few minutes.',
  network:
    'Could not reach RevenueCat. Check that this server has internet access (and a proxy, if it needs one), then try again.',
  unexpected: 'RevenueCat answered with something this server could not read.',
  invalid_input: 'That is not a valid RevenueCat project or app reference.',
};

export class RevenueCatError extends Error {
  readonly kind: RevenueCatErrorKind;
  /** The HTTP status, when the error came from a response. */
  readonly status?: number;
  /** The request ran out of time (`kind` is `network`). */
  readonly timedOut: boolean;
  /** Seconds to wait, for `rate_limited`. */
  readonly retryAfterSeconds?: number;
  constructor(
    kind: RevenueCatErrorKind,
    options: {
      status?: number | undefined;
      timedOut?: boolean | undefined;
      retryAfterSeconds?: number | undefined;
      message?: string | undefined;
      known?: Iterable<string> | undefined;
    } = {},
  ) {
    super(redactSecrets(options.message ?? MESSAGES[kind], options.known ?? []));
    this.name = 'RevenueCatError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    this.timedOut = options.timedOut === true;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const isRevenueCatError = (value: unknown): value is RevenueCatError =>
  value instanceof RevenueCatError;

/** The sentence for a kind, for a caller that builds its own error. */
export const revenueCatErrorMessage = (kind: RevenueCatErrorKind): string => MESSAGES[kind];
