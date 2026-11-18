/**
 * Typed errors for repo hosts. Messages are safe to show to a person and to write to a log:
 * they never carry a token, a JWT or a private key (see `redactSecrets`).
 */

export type GithubErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'unexpected'
  | 'invalid_input'
  | 'not_text'
  | 'too_large'
  | 'no_changes'
  | 'branch_exists'
  | 'default_branch'
  | 'change_conflict'
  | 'blocked_path'
  | 'pull_request_failed';

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  /** The HTTP status, when the error came from a response. */
  readonly status?: number;
  constructor(kind: GithubErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GithubError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * GitHub said to slow down. Nothing is retried here; the caller (a job, a request) decides.
 * `retryAfterSeconds` is always set: from `Retry-After`, else from `x-ratelimit-reset`, else the
 * minute GitHub's documentation asks for.
 */
export class GithubRateLimitError extends GithubError {
  readonly limit: 'primary' | 'secondary';
  readonly retryAfterSeconds: number;
  /** When the window resets, in epoch milliseconds, if GitHub said. */
  readonly resetAt?: number;
  constructor(
    status: number,
    limit: 'primary' | 'secondary',
    retryAfterSeconds: number,
    resetAt?: number,
  ) {
    super(
      'rate_limited',
      `GitHub ${limit} rate limit reached. Retry in ${retryAfterSeconds} seconds.`,
      status,
    );
    this.name = 'GithubRateLimitError';
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
    if (resetAt !== undefined) this.resetAt = resetAt;
  }
}

/** The branch the change set should be written to already exists. Pick another name. */
export class BranchExistsError extends GithubError {
  readonly branch: string;
  constructor(branch: string) {
    super('branch_exists', `The branch ${branch} already exists.`, 422);
    this.name = 'BranchExistsError';
    this.branch = branch;
  }
}

/** A proposal may never write to the repository's default branch. */
export class DefaultBranchError extends GithubError {
  readonly branch: string;
  constructor(branch: string) {
    super(
      'default_branch',
      `Refusing to write to the default branch (${branch}). Use a new branch.`,
    );
    this.name = 'DefaultBranchError';
    this.branch = branch;
  }
}

/** Files changed in the repository since the change set was made, so it no longer applies. */
export class ChangeConflictError extends GithubError {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(
      'change_conflict',
      `The repository changed since this change set was made: ${paths.slice(0, 10).join(', ')}${
        paths.length > 10 ? `, and ${paths.length - 10} more` : ''
      }.`,
    );
    this.name = 'ChangeConflictError';
    this.paths = paths;
  }
}

/** The branch and commit were created but the pull request could not be. The branch is kept. */
export class PullRequestFailedError extends GithubError {
  readonly branch: string;
  readonly commitSha: string;
  constructor(branch: string, commitSha: string, cause: GithubError) {
    super(
      'pull_request_failed',
      `The branch ${branch} was created, but opening the pull request failed: ${cause.message}`,
      cause.status,
    );
    this.name = 'PullRequestFailedError';
    this.branch = branch;
    this.commitSha = commitSha;
    // The underlying error, e.g. a GithubRateLimitError that says how long to wait.
    this.cause = cause;
  }
}

/** Which store a `StoreError` came from. */
export type StoreName = 'appstoreconnect' | 'googleplay';

export type StoreErrorKind =
  /** The credential itself is unusable: malformed key, wrong key or issuer, bad JWT. */
  | 'auth'
  /** Authenticated, but not allowed: role, app access or a disabled API. */
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'network'
  /** The service answered with something that could not be read. */
  | 'unexpected'
  | 'invalid_input'
  /** Our clock and the store's clock disagree enough to invalidate a token. */
  | 'clock_skew'
  /** The Play Developer API is not enabled in the Cloud project that owns the service account. */
  | 'api_disabled'
  /** A Play edit was invalidated (another edit, a Console change) while it was being read. */
  | 'edit_invalid'
  /** The store has no API for this. */
  | 'unsupported';

/**
 * Typed errors for the app stores. Like `GithubError`: the message is safe to show and to log and
 * never carries a key, a JWT or an access token.
 */
export class StoreError extends Error {
  readonly store: StoreName;
  readonly kind: StoreErrorKind;
  /** The HTTP status, when the error came from a response. */
  readonly status?: number;
  constructor(store: StoreName, kind: StoreErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'StoreError';
    this.store = store;
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * The store said to slow down. Nothing is retried beyond the one bounded wait the connector may
 * do; `retryAfterSeconds` is from `Retry-After` when sent. Apple documents no `Retry-After` (its
 * limit is a rolling hour), so without one this is a conservative 60.
 */
export class StoreRateLimitError extends StoreError {
  readonly retryAfterSeconds: number;
  constructor(store: StoreName, retryAfterSeconds: number, status = 429) {
    super(
      store,
      'rate_limited',
      `${store === 'appstoreconnect' ? 'App Store Connect' : 'Google Play'} rate limit reached. Retry in ${retryAfterSeconds} seconds.`,
      status,
    );
    this.name = 'StoreRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Google OAuth access tokens.
  /\bya29\.[A-Za-z0-9._-]{16,}/g,
];

/**
 * Removes anything that looks like a credential, plus every string in `known`, from text that
 * is about to be shown or logged.
 */
export function redactSecrets(text: string, known: Iterable<string> = []): string {
  let out = text;
  for (const secret of known) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]');
}

/**
 * Every string of a stored secret that must never appear in a message: the whole secret, and for
 * a JSON secret each string value, plus each non-header line of a private key. Pass the result to
 * `redactSecrets` as `known`. Values shorter than 8 characters are ignored there.
 */
export function secretStrings(secret: string): string[] {
  const found = new Set<string>([secret, secret.trim()]);
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      found.add(value);
      found.add(value.trim());
      for (const line of value.split(/\r?\n/)) {
        if (line && !line.startsWith('-----')) found.add(line.trim());
      }
    } else if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) add(item);
    }
  };
  try {
    add(JSON.parse(secret));
  } catch {
    // Not JSON (a token): the whole string is already included.
  }
  return [...found].filter((v) => v.length >= 8);
}
