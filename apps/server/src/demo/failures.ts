import {
  AiError,
  DraftOutcomeUnknownError,
  GithubError,
  GithubRateLimitError,
  ReleaseOutcomeUnknownError,
  ReplyOutcomeUnknownError,
  RolloutOutcomeUnknownError,
  StoreError,
  StoreRateLimitError,
  SubmitOutcomeUnknownError,
  TranslateError,
} from '@kiln/connectors';
import type { StoreId } from '@kiln/core';

/**
 * Failure injection for the demo (`POST /demo/fail`). A failure is "the next `count` calls to this connector fail like
 * this". Every demo connector is wrapped by `failing()`, which asks the board before each call.
 */

export const FAIL_CONNECTORS = [
  'appstoreconnect',
  'googleplay',
  'stores',
  'github',
  'translation',
  'ai',
  'analytics',
  'aso',
] as const;
export type FailConnector = (typeof FAIL_CONNECTORS)[number];
export const FAIL_KINDS = [
  'rate_limit',
  'auth',
  'forbidden',
  'server',
  'unknown',
  'unknown_applied',
] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

type Entry = { connector: FailConnector; kind: FailKind; count: number };

/** Methods that change something in a store; for them `unknown` is "the request was sent and the answer was lost". */
const WRITES: Record<string, (store: StoreId) => StoreError> = {
  applyDraft: (s) => new DraftOutcomeUnknownError(s, 'The request timed out (demo failure).', []),
  submit: (s) => new SubmitOutcomeUnknownError(s, 'The request timed out (demo failure).'),
  release: (s) => new ReleaseOutcomeUnknownError(s, 'The request timed out (demo failure).'),
  applyChange: (s) => new RolloutOutcomeUnknownError(s, 'The request timed out (demo failure).'),
  replyToReview: (s) => new ReplyOutcomeUnknownError(s, 'The request timed out (demo failure).'),
};
export const WRITE_METHODS = new Set([...Object.keys(WRITES), 'dispatchWorkflow']);

export class FailureBoard {
  entries: Entry[] = [];

  add(connector: FailConnector, kind: FailKind, count: number) {
    this.entries.push({ connector, kind, count });
  }
  clear() {
    this.entries = [];
  }
  list() {
    return this.entries.filter((e) => e.count > 0).map((e) => ({ ...e }));
  }

  /** The entry that applies to `connector`, with one use consumed; undefined when nothing is queued. */
  take(connector: Exclude<FailConnector, 'stores'>): FailKind | undefined {
    const entry = this.entries.find(
      (e) =>
        e.count > 0 &&
        (e.connector === connector ||
          (e.connector === 'stores' &&
            (connector === 'appstoreconnect' || connector === 'googleplay'))),
    );
    if (!entry) return undefined;
    entry.count -= 1;
    return entry.kind;
  }

  /** Throws the error for a queued failure before a call; for `unknown_applied` returns a function that throws after the call ran. */
  before(connector: Exclude<FailConnector, 'stores'>, method: string): (() => never) | undefined {
    const kind = this.take(connector);
    if (!kind) return undefined;
    const after = this.#build(connector, method, kind);
    if (kind === 'unknown_applied' && WRITE_METHODS.has(method)) return after;
    throw after();
  }

  #build(connector: Exclude<FailConnector, 'stores'>, method: string, kind: FailKind): () => never {
    return () => {
      if (connector === 'appstoreconnect' || connector === 'googleplay') {
        if ((kind === 'unknown' || kind === 'unknown_applied') && WRITES[method])
          throw (WRITES[method] as (s: typeof connector) => StoreError)(connector);
        if (kind === 'rate_limit') throw new StoreRateLimitError(connector, 30);
        if (kind === 'auth')
          throw new StoreError(
            connector,
            'auth',
            'The store refused the credential (demo failure).',
            401,
          );
        if (kind === 'forbidden')
          throw new StoreError(
            connector,
            'forbidden',
            'The store says this key may not do that (demo failure).',
            403,
          );
        if (kind === 'server')
          throw new StoreError(
            connector,
            'server',
            'The store answered with an error (demo failure).',
            503,
          );
        throw new StoreError(connector, 'network', 'The request timed out (demo failure).');
      }
      if (connector === 'github') {
        if (kind === 'rate_limit') throw new GithubRateLimitError(429, 'secondary', 30);
        if (kind === 'auth')
          throw new GithubError('auth', 'GitHub refused the token (demo failure).', 401);
        if (kind === 'forbidden')
          throw new GithubError(
            'forbidden',
            'GitHub says this token may not do that (demo failure).',
            403,
          );
        if (kind === 'server')
          throw new GithubError('server', 'GitHub answered with an error (demo failure).', 502);
        throw new GithubError('network', 'The request timed out (demo failure).');
      }
      if (connector === 'ai') {
        if (kind === 'rate_limit') throw new AiError('rate_limited', { retryAfterSeconds: 30 });
        if (kind === 'auth' || kind === 'forbidden') throw new AiError('auth');
        throw new AiError('unavailable', { detail: kind === 'server' ? 'http_503' : 'timeout' });
      }
      if (connector === 'translation') {
        if (kind === 'rate_limit')
          throw new TranslateError('rate_limited', { retryAfterSeconds: 30 });
        if (kind === 'auth' || kind === 'forbidden') throw new TranslateError('auth');
        throw new TranslateError('unavailable');
      }
      // analytics and aso: a plain error, classified by the service as unavailable
      if (kind === 'rate_limit') throw new StoreRateLimitError('appstoreconnect', 30);
      if (kind === 'auth')
        throw new StoreError(
          'appstoreconnect',
          'auth',
          'The store refused the credential (demo failure).',
          401,
        );
      throw new StoreError(
        'appstoreconnect',
        kind === 'server' ? 'server' : 'network',
        'The source did not answer (demo failure).',
        kind === 'server' ? 503 : undefined,
      );
    };
  }
}

/**
 * Wraps a fake so that every method call first asks the board. Properties pass through. Calls run with the real object
 * as `this`, so private fields of the fake keep working.
 */
export function failing<T extends object>(
  target: T,
  board: FailureBoard,
  connector: Exclude<FailConnector, 'stores'>,
): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const late = board.before(connector, prop);
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (!late) return result;
        // A write whose answer was lost: it ran, then the caller gets the error.
        return Promise.resolve(result).then(late, late);
      };
    },
  });
}
