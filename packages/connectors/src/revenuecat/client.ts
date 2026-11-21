import { secretStrings } from '../errors.ts';
import { RevenueCatError, type RevenueCatErrorKind } from './errors.ts';

/**
 * A small client for the RevenueCat REST API v2 (docs/adr/0039-revenuecat.md, docs/api/revenuecat.md). Read only: it has a GET and a
 * paginated GET and no other verb, so no code path can change anything in RevenueCat.
 *
 * - `Authorization: Bearer <V2 secret key>` on `{apiOrigin}/v2/...`. `fetch` and `apiOrigin` are injected (tests use a fake).
 * - Throws only `RevenueCatError` (errors.ts): a fixed sentence per kind, never RevenueCat's text, the key redacted anyway.
 * - A redirect is never followed (it would carry the key to another address); an answer over `maxResponseBytes` is refused; each
 *   request has a time limit; nothing is retried here.
 * - Rate limit: the project configuration allows 60 requests a minute per key. A 429 is `rate_limited` with the seconds to wait
 *   (`Retry-After`, else the body's `backoff_ms`). The client also counts its own requests (`maxRequests`, default 45) and reads
 *   `RevenueCat-Rate-Limit-Current-Usage` / `-Current-Limit` of every answer, and a paginated read STOPS and says it is incomplete
 *   when either says the budget is used up, instead of provoking a 429.
 * - Pagination follows `starting_after` with the id of the last item (never the `next_page` URL, which could point elsewhere), up
 *   to `maxPages` pages of 100.
 */

export const REVENUECAT_API_ORIGIN = 'https://api.revenuecat.com';
export const DEFAULT_REVENUECAT_TIMEOUT_MS = 15_000;
export const DEFAULT_REVENUECAT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Under the 60 a minute of the project configuration: one sync never uses the whole minute. */
export const DEFAULT_REVENUECAT_MAX_REQUESTS = 45;
export const DEFAULT_REVENUECAT_MAX_PAGES = 20;
/** The documented maximum of `limit` (values above are clamped). */
export const REVENUECAT_PAGE_SIZE = 100;

export type RevenueCatClientOptions = {
  /** The V2 secret API key. */
  apiKey: string;
  fetch?: typeof fetch | undefined;
  /** Default https://api.revenuecat.com. No path, no credentials. */
  apiOrigin?: string | undefined;
  /** Per request. Default 15 seconds. */
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  /** How many requests this client may send in all. Default 45. */
  maxRequests?: number | undefined;
  userAgent?: string | undefined;
};

export type RevenueCatQuery = Record<string, string | number | undefined>;

export type RevenueCatListResult = {
  /** Raw items, as RevenueCat sent them: the typed readers parse them. */
  items: unknown[];
  /** False when a cap (pages, requests, the rate limit headers) ended the read before the last page. */
  complete: boolean;
};

/** What the typed readers need from a client; tests may pass a fake of just this. */
export type RevenueCatClient = {
  readonly apiOrigin: string;
  /** Requests sent so far. */
  readonly requests: number;
  /**
   * True while this client may still send a request AND would be left with more than `reserve` requests afterwards (budget and rate
   * limit headers). A reader that still has reads ahead of it passes their number, so an early read never starves a later one.
   */
  canRequest(reserve?: number): boolean;
  /** One GET below `/v2`, answered as a parsed JSON object. `path` starts with `/` and has its ids percent-encoded. */
  get(
    path: string,
    query?: RevenueCatQuery,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<Record<string, unknown>>;
  /** A paginated GET: all pages up to the caps. */
  list(
    path: string,
    query?: RevenueCatQuery,
    options?: { signal?: AbortSignal | undefined; maxPages?: number | undefined; reserve?: number | undefined },
  ): Promise<RevenueCatListResult>;
};

/** The origin without a trailing slash; a RevenueCatError (`invalid_input`) when it is not an http(s) origin. */
export function normalizeRevenueCatOrigin(origin: string | undefined): string {
  const raw = (origin ?? REVENUECAT_API_ORIGIN).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RevenueCatError('invalid_input', { message: 'The RevenueCat address is not a valid URL.' });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new RevenueCatError('invalid_input', {
      message: 'The RevenueCat address must be an http(s) origin without credentials, query or fragment.',
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

const clampSeconds = (seconds: number) => Math.min(Math.max(Math.ceil(seconds), 1), 3600);

/** Seconds to wait from `Retry-After` (seconds), else the body's `backoff_ms`; 60 when neither is readable. */
function retryAfterOf(header: string | null, body: Record<string, unknown> | undefined): number {
  const seconds = Number(header);
  if (header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return clampSeconds(seconds);
  const ms = body && typeof body.backoff_ms === 'number' ? body.backoff_ms : undefined;
  return ms !== undefined && Number.isFinite(ms) && ms >= 0 ? clampSeconds(ms / 1000) : 60;
}

/**
 * Which kind an error answer is. RevenueCat's `type` (`authentication_error`, `authorization_error`, `rate_limit_error`,
 * `resource_missing`) wins when it is one of the four documented values; the status decides otherwise (401, 403, 404, 429).
 * UNVERIFIED against a live account: the docs show the types and a status table but do not pair them.
 */
export function revenueCatErrorKind(status: number, type: string | undefined): RevenueCatErrorKind {
  switch (type) {
    case 'authentication_error':
      return 'auth';
    case 'authorization_error':
      return 'forbidden';
    case 'rate_limit_error':
      return 'rate_limited';
    case 'resource_missing':
      return 'not_found';
  }
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_input';
  if (status >= 500) return 'server';
  return 'unexpected';
}

const PATH = /^\/[A-Za-z0-9._~\/%-]*$/;

export function createRevenueCatClient(options: RevenueCatClientOptions): RevenueCatClient {
  const key = options.apiKey.trim();
  // A key with a space or a line break cannot be a key (and could split a header).
  if (!key || /\s/.test(key)) throw new RevenueCatError('auth');
  const known = [...secretStrings(key), key];
  const send = options.fetch ?? globalThis.fetch;
  const apiOrigin = normalizeRevenueCatOrigin(options.apiOrigin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVENUECAT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_REVENUECAT_MAX_RESPONSE_BYTES;
  const maxRequests = options.maxRequests ?? DEFAULT_REVENUECAT_MAX_REQUESTS;
  const userAgent = options.userAgent ?? 'kiln';
  const fail = (kind: RevenueCatErrorKind, extra: ConstructorParameters<typeof RevenueCatError>[1] = {}) =>
    new RevenueCatError(kind, { ...extra, known });

  let requests = 0;
  /** The usage and limit RevenueCat reported on the last answer, when it did. */
  let usage: { current: number; limit: number } | undefined;

  const remaining = () => {
    const own = maxRequests - requests;
    return usage && usage.limit > 0 ? Math.min(own, usage.limit - 1 - usage.current) : own;
  };
  const canRequest = (reserve = 0) => remaining() > reserve;

  const queryString = (query: RevenueCatQuery | undefined): string => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(name, String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : '';
  };

  async function get(
    path: string,
    query: RevenueCatQuery | undefined,
    call: { signal?: AbortSignal | undefined },
  ): Promise<Record<string, unknown>> {
    // A path is built by the caller from fixed words and encoded ids; anything else could point the key elsewhere.
    if (!PATH.test(path) || path.includes('..') || path.includes('//')) {
      throw fail('invalid_input', { message: 'That is not a valid RevenueCat request path.' });
    }
    if (requests >= maxRequests) {
      throw fail('rate_limited', {
        retryAfterSeconds: 60,
        message: 'This read needs more requests than one read may use. Try again in a minute.',
      });
    }
    requests += 1;
    // A timer of our own (not AbortSignal.timeout), cleared when the request is over.
    const limit = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      limit.abort();
    }, timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, limit.signal]) : limit.signal;
    let response: Response;
    let text: string | undefined;
    try {
      response = await send(`${apiOrigin}/v2${path}${queryString(query)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': userAgent },
        // A redirect would carry the key to another address.
        redirect: 'manual',
        signal,
      });
      text = await readCapped(response, maxBytes);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (error instanceof RevenueCatError) throw error;
      // The error text of the network is dropped on purpose (it can carry the address).
      if (timedOut || name === 'TimeoutError') {
        throw fail('network', { timedOut: true, message: 'RevenueCat did not answer in time. Try again in a minute.' });
      }
      throw fail('network');
    } finally {
      clearTimeout(timer);
    }

    const current = Number(response.headers.get('revenuecat-rate-limit-current-usage'));
    const max = Number(response.headers.get('revenuecat-rate-limit-current-limit'));
    if (Number.isFinite(current) && Number.isFinite(max) && max > 0) usage = { current, limit: max };

    const status = response.status;
    let body: Record<string, unknown> | undefined;
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) body = parsed;
      } catch {
        body = undefined;
      }
    }
    if (status < 200 || status >= 300) {
      const type = body && typeof body.type === 'string' ? body.type : undefined;
      const kind = revenueCatErrorKind(status, type);
      if (kind === 'rate_limited') {
        throw fail('rate_limited', { status, retryAfterSeconds: retryAfterOf(response.headers.get('retry-after'), body) });
      }
      throw fail(kind, { status });
    }
    if (text === undefined) throw fail('unexpected', { status, message: 'RevenueCat sent too large an answer.' });
    if (!body) throw fail('unexpected', { status });
    return body;
  }

  return {
    apiOrigin,
    get requests() {
      return requests;
    },
    canRequest,
    get: (path, query, call = {}) => get(path, query, call),
    async list(path, query, call = {}) {
      const maxPages = call.maxPages ?? DEFAULT_REVENUECAT_MAX_PAGES;
      const items: unknown[] = [];
      let after: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        // The first page is always asked for; a later one only while the budget holds.
        if (page > 0 && !canRequest(call.reserve ?? 0)) return { items, complete: false };
        const body = await get(path, { ...query, limit: REVENUECAT_PAGE_SIZE, starting_after: after }, call);
        const got = Array.isArray(body.items) ? body.items : undefined;
        if (!got) throw fail('unexpected');
        items.push(...got);
        const more = typeof body.next_page === 'string' && body.next_page !== '';
        if (!more) return { items, complete: true };
        const last: unknown = got[got.length - 1];
        const id = isRecord(last) && typeof last.id === 'string' ? last.id : undefined;
        // A next page without a last id to continue from cannot be followed: say so instead of looping.
        if (id === undefined || id === after) return { items, complete: false };
        after = id;
      }
      return { items, complete: false };
    },
  };
}
