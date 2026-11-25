import { redactSecrets, secretStrings } from '../errors.ts';
import { ExpoError, type ExpoErrorKind } from './errors.ts';

/**
 * A small GraphQL client for Expo Application Services. One request shape: `POST {apiOrigin}/graphql` with
 * `Authorization: Bearer <access token>` (what eas-cli does: packages/eas-cli/src/commandUtils/context/contextUtils/createGraphqlClient.ts).
 *
 * - `fetch` and `apiOrigin` are injected: tests use a fake, an operator can point it at a proxy. The default origin is
 *   https://api.expo.dev.
 * - Throws only `ExpoError` (see errors.ts): a network failure, a timeout, an HTTP status, or a GraphQL `errors` entry becomes a kind
 *   from the shared vocabulary. The token and Expo's own text never reach a message. Nothing is retried here.
 * - A redirect is never followed (it would carry the token to another address); a body over `maxResponseBytes` is refused.
 * - The token lives in this closure only. It is not a property of the client and not in anything the client returns or throws.
 */

export const EXPO_API_ORIGIN = 'https://api.expo.dev';
export const DEFAULT_EXPO_TIMEOUT_MS = 15_000;
export const DEFAULT_EXPO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ExpoClientOptions = {
  /** The Expo access token (a robot user's token is recommended). */
  token: string;
  /** Replaces the network. Defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
  /** Default https://api.expo.dev. No path, no credentials. */
  apiOrigin?: string | undefined;
  /** Per request. Default 15 seconds. */
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  userAgent?: string | undefined;
};

export type GraphqlRequest = {
  query: string;
  variables?: Record<string, unknown> | undefined;
  operationName?: string | undefined;
};

/** What the typed functions of this folder need from a client; tests and later features may pass a fake of just this. */
export type ExpoGraphql = {
  readonly apiOrigin: string;
  /** Runs one query or mutation and returns its `data`. */
  graphql<T>(request: GraphqlRequest, options?: { signal?: AbortSignal | undefined }): Promise<T>;
};

export type RestRequest = {
  method: 'GET' | 'POST';
  /** Starts with `/`, below the API origin (`/v2/workflows/dispatch`). Ids in it are percent-encoded by the caller. */
  path: string;
  /** JSON; sent only when given. */
  body?: unknown;
  /** The fixed sentence for a 404, when the default (which speaks of a project) does not fit. */
  notFound?: string | undefined;
  /** The fixed sentence for a 400, when the default (which speaks of a project reference) does not fit. */
  invalid?: string | undefined;
};

/** The REST side of Expo (`https://api.expo.dev/v2/...`, docs.expo.dev/eas/workflows/rest-api): the same token, the same errors. */
export type ExpoRest = {
  readonly apiOrigin: string;
  /** Runs one REST call and returns the parsed JSON object. Never retried. */
  rest<T>(request: RestRequest, options?: { signal?: AbortSignal | undefined }): Promise<T>;
};

export type ExpoClient = ExpoGraphql & ExpoRest;

/** The origin without a trailing slash; an ExpoError (`invalid_input`) when it is not an http(s) origin. */
export function normalizeExpoOrigin(origin: string | undefined): string {
  const raw = (origin ?? EXPO_API_ORIGIN).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExpoError('invalid_input', { message: 'The Expo address is not a valid URL.' });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ExpoError('invalid_input', {
      message: 'The Expo address must be an http(s) origin without credentials, query or fragment.',
    });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Seconds from a Retry-After header (a number of seconds), bounded; 60 when absent or unreadable. */
function retryAfterOf(header: string | null): number {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.max(Math.ceil(seconds), 1), 3600)
    : 60;
}

/** Expo's own error codes look like `EXPERIENCE_NOT_FOUND`: keep one only when it is a short constant-like word. */
const codeOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(value) ? value : undefined;

/**
 * Which kind a GraphQL error is. Expo's error codes are not documented, so this reads what is seen in the wild (eas-cli reports
 * "Entity not authorized", "Experience with id ... does not exist", "Unexpected server error", and sets `extensions.errorCode` and
 * `extensions.errorType`) by wording, and falls back to `unexpected`. UNVERIFIED against a live account: see docs/adr/0033.
 */
export function graphqlErrorKind(message: string, code: string | undefined): ExpoErrorKind {
  const text = `${code ?? ''} ${message}`;
  if (/rate.?limit|too many requests|throttl/i.test(text)) return 'rate_limited';
  if (
    /unauthenticated|not authenticated|authentication|invalid (access )?token|token.*(expired|revoked|invalid)|must be logged in/i.test(
      text,
    )
  )
    return 'auth';
  if (/not authorized|unauthorized|forbidden|permission|not allowed/i.test(text))
    return 'forbidden';
  if (/not.?found|does not exist|no such/i.test(text)) return 'not_found';
  if (/unexpected server error|internal server error|service unavailable|timeout/i.test(text))
    return 'server';
  return 'unexpected';
}

export function createExpoClient(options: ExpoClientOptions): ExpoClient {
  const token = options.token.trim();
  // A token with a space or a line break cannot be a token (and could split a header).
  if (!token || /\s/.test(token)) throw new ExpoError('auth');
  const known = [...secretStrings(token), token];
  const send = options.fetch ?? globalThis.fetch;
  const apiOrigin = normalizeExpoOrigin(options.apiOrigin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPO_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_EXPO_MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? 'kiln';
  const fail = (kind: ExpoErrorKind, extra: ConstructorParameters<typeof ExpoError>[1] = {}) =>
    new ExpoError(kind, { ...extra, known });

  type Call = { signal?: AbortSignal | undefined };

  /** One HTTP exchange under the time limit and the size cap. The error text of the network is dropped on purpose (it can carry the address). */
  async function exchange(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    call: Call,
  ): Promise<{ response: Response; text: string | undefined }> {
    // A timer of our own (not AbortSignal.timeout, whose timer does not keep the process alive), cleared when the request is over.
    const limit = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      limit.abort();
    }, timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, limit.signal]) : limit.signal;
    try {
      const response = await send(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}`, 'user-agent': userAgent },
        // A redirect would carry the token to another address.
        redirect: 'manual',
        signal,
      });
      return { response, text: await readCapped(response, maxBytes) };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (error instanceof ExpoError) throw error;
      if (timedOut || name === 'TimeoutError') {
        throw fail('network', {
          timedOut: true,
          message: 'Expo did not answer in time. Try again in a minute.',
        });
      }
      throw fail('network');
    } finally {
      clearTimeout(timer);
    }
  }

  const parseObject = (text: string, status: number): Record<string, unknown> => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail('unexpected', { status });
    }
    if (!isRecord(body)) throw fail('unexpected', { status });
    return body;
  };

  return {
    apiOrigin,
    async graphql<T>(request: GraphqlRequest, call: Call = {}) {
      const { response, text } = await exchange(
        `${apiOrigin}/graphql`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            query: request.query,
            ...(request.variables ? { variables: request.variables } : {}),
            ...(request.operationName ? { operationName: request.operationName } : {}),
          }),
        },
        call,
      );

      const status = response.status;
      if (status === 429) {
        throw fail('rate_limited', {
          status,
          retryAfterSeconds: retryAfterOf(response.headers.get('retry-after')),
        });
      }
      if (status === 401) throw fail('auth', { status });
      if (status === 403) throw fail('forbidden', { status });
      if (status >= 500) throw fail('server', { status });
      if (status < 200 || status >= 300) throw fail('unexpected', { status });
      if (text === undefined)
        throw fail('unexpected', { status, message: 'Expo sent too large an answer.' });

      const body = parseObject(text, status);
      const errors = body.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        const message = isRecord(first) && typeof first.message === 'string' ? first.message : '';
        const extensions = isRecord(first) && isRecord(first.extensions) ? first.extensions : {};
        const code = codeOf(extensions.errorCode) ?? codeOf(extensions.code);
        throw fail(graphqlErrorKind(redactSecrets(message, known), code), { status, code });
      }
      if (!isRecord(body.data)) throw fail('unexpected', { status });
      return body.data as T;
    },

    async rest<T>(request: RestRequest, call: Call = {}) {
      // A path is built by the caller from fixed words and encoded ids; anything else could point the token elsewhere.
      if (
        !/^\/[A-Za-z0-9._~/%-]*$/.test(request.path) ||
        request.path.includes('..') ||
        request.path.includes('//')
      ) {
        throw fail('invalid_input', { message: 'That is not a valid Expo request path.' });
      }
      const { response, text } = await exchange(
        `${apiOrigin}${request.path}`,
        {
          method: request.method,
          headers: {
            accept: 'application/json',
            ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        },
        call,
      );
      const status = response.status;
      if (status === 429) {
        throw fail('rate_limited', {
          status,
          retryAfterSeconds: retryAfterOf(response.headers.get('retry-after')),
        });
      }
      if (status === 401) throw fail('auth', { status });
      if (status === 403) throw fail('forbidden', { status });
      if (status === 404) throw fail('not_found', { status, message: request.notFound });
      if (status === 400 || status === 422)
        throw fail('invalid_input', { status, message: request.invalid });
      if (status >= 500) throw fail('server', { status });
      if (status < 200 || status >= 300) throw fail('unexpected', { status });
      if (text === undefined)
        throw fail('unexpected', { status, message: 'Expo sent too large an answer.' });
      return parseObject(text, status) as T;
    },
  };
}
