import { redactSecrets } from '../errors.ts';

/**
 * Typed errors of the Expo (EAS) client. The kinds are the ones the other connectors use (`GithubErrorKind`, `StoreErrorKind`), so a
 * caller maps them to HTTP the same way. The message is a fixed sentence per kind: Expo's own text is never copied into it (it can name
 * ids and, in principle, echo a request), and `redactSecrets` runs over it anyway. The token is never part of an error.
 */
export type ExpoErrorKind =
  /** The token is missing, malformed, revoked or unknown to Expo. */
  | 'auth'
  /** Expo knows the token, but it may not do this (role, account, project). */
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  /** Expo answered 5xx or said it had an unexpected server error. */
  | 'server'
  /** No answer: the connection failed or the time limit passed (`timedOut`). */
  | 'network'
  /** Expo answered with something this client cannot read. */
  | 'unexpected'
  /** The request was refused before it was sent (a bad project reference, a bad address). */
  | 'invalid_input';

const MESSAGES: Record<ExpoErrorKind, string> = {
  auth: 'Expo did not accept the access token. Check that it is correct and has not been deleted.',
  forbidden:
    'Expo accepted the token, but it may not do this. Use a robot user with the Developer role on the account that owns the project.',
  not_found: 'Expo has no such project, or the token cannot see it.',
  rate_limited: 'Expo said to slow down. Try again in a minute.',
  server: 'Expo had a problem. Try again in a few minutes.',
  network:
    'Could not reach Expo. Check that this server has internet access (and a proxy, if it needs one), then try again.',
  unexpected: 'Expo answered with something this server could not read.',
  invalid_input: 'That is not a valid Expo project reference.',
};

export class ExpoError extends Error {
  readonly kind: ExpoErrorKind;
  /** The HTTP status, when the error came from a response. */
  readonly status?: number;
  /** Expo's own short error code (`extensions.errorCode`), when it sent one that looks like a code. Safe to log. */
  readonly code?: string;
  /** The request ran out of time (`kind` is `network`). */
  readonly timedOut: boolean;
  /** Seconds to wait, for `rate_limited`. */
  readonly retryAfterSeconds?: number;
  constructor(
    kind: ExpoErrorKind,
    options: {
      status?: number | undefined;
      code?: string | undefined;
      timedOut?: boolean | undefined;
      retryAfterSeconds?: number | undefined;
      message?: string | undefined;
      known?: Iterable<string> | undefined;
    } = {},
  ) {
    super(redactSecrets(options.message ?? MESSAGES[kind], options.known ?? []));
    this.name = 'ExpoError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    this.timedOut = options.timedOut === true;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const isExpoError = (value: unknown): value is ExpoError => value instanceof ExpoError;

/** The sentence for a kind, for a caller that builds its own error. */
export const expoErrorMessage = (kind: ExpoErrorKind): string => MESSAGES[kind];
