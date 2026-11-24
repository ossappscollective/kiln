import { secretStrings } from '../errors.ts';
import {
  APPLE_ADS_SCOPE,
  APPLE_ADS_TOKEN_ORIGIN,
  APPLE_ADS_TOKEN_PATH,
  type AppleAdsKey,
  loadAppleAdsSigningKey,
  signAppleAdsClientSecret,
} from './ads-auth.ts';
import { AppleAdsError, type AppleAdsErrorKind, appleAdsErrorKind } from './ads-errors.ts';

/**
 * A small client for the Apple Ads Platform API v1 (docs/adr/0058-apple-ads.md, docs/api/apple-ads.md). READ ONLY: it has `get` and
 * `query` and nothing else. `get` answers only `/me`, `/acls` and `/ad-accounts/{id}`; `query` (a POST, because Apple's reports and
 * lists are POST `.../query` calls that change nothing) answers only the listed report, list and insight paths. Any other path is
 * refused before a request is made, so no code path can create or change a campaign, an ad group, a keyword or a budget.
 *
 * - Hosts: `https://appleid.apple.com` (the token) and `https://api.ads.apple.com/v1` (the API). Both are constants; an override is for
 *   tests and a proxy only and must be an http(s) origin without credentials. A redirect is never followed (it would carry the token
 *   to another address), an answer over `maxResponseBytes` is refused, each request has a time limit.
 * - Token: the ES256 client secret (ads-auth.ts) is exchanged for an access token valid `expires_in` seconds (one hour), cached until
 *   two minutes before it ends, and exchanged again after a 401.
 * - Rate limit: every answer carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds); with the quota nearly
 *   spent the client waits for the reset before the next request. A 429 waits `Retry-After` (else 2, 4, 8 and 16 seconds), up to
 *   three times; a wait longer than `maxWaitSeconds` (default 30) is not slept but reported (`rate_limited`, `retryAfterSeconds`).
 *   A 5xx is tried once more after two seconds. Nothing else is retried.
 * - Errors: only `AppleAdsError` (a fixed sentence per kind; Apple's text is never copied); the key, the client secret and the access
 *   token are redacted from anything that could carry them.
 */
export const APPLE_ADS_API_ORIGIN = 'https://api.ads.apple.com';
export const APPLE_ADS_API_PREFIX = '/v1';
/** The only hosts this client talks to in production. */
export const APPLE_ADS_HOSTS = ['appleid.apple.com', 'api.ads.apple.com'] as const;
export const DEFAULT_APPLE_ADS_TIMEOUT_MS = 20_000;
export const DEFAULT_APPLE_ADS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_APPLE_ADS_MAX_REQUESTS = 120;
const TOKEN_MARGIN_SECONDS = 120;

const GET_PATHS: RegExp[] = [/^\/me$/, /^\/acls$/, /^\/ad-accounts\/[0-9]{1,20}$/];
/** Paths that need no ad account context. */
const NO_CONTEXT = new Set(['/me', '/acls']);
const QUERY_PATHS = new Set([
  '/campaigns/query',
  '/reports/apps/campaigns/query',
  '/reports/apps/keywords/query',
  '/reports/apps/searchterms/query',
  '/insights/apps/search-term-popularity/query',
]);

export type AppleAdsClientOptions = {
  credential: AppleAdsKey;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** Waits; tests pass a fake that records the delay. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  apiOrigin?: string | undefined;
  tokenOrigin?: string | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  /** Requests this client may send in all (token requests do not count). Default 120. */
  maxRequests?: number | undefined;
  /** Longest wait this client will sleep on a 429 or on the quota. Default 30 seconds. */
  maxWaitSeconds?: number | undefined;
  userAgent?: string | undefined;
};

export type AppleAdsClient = {
  readonly apiOrigin: string;
  /** API requests sent so far. */
  readonly requests: number;
  /** True while another request fits the budget. */
  canRequest(reserve?: number): boolean;
  /** Gets (and caches) an access token without calling the API: the key check. */
  authenticate(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  get(
    path: string,
    options?: { adAccountId?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<Record<string, unknown>>;
  query(
    path: string,
    body: Record<string, unknown>,
    options: { adAccountId: string; signal?: AbortSignal | undefined },
  ): Promise<Record<string, unknown>>;
};

export function normalizeAppleAdsOrigin(origin: string | undefined, fallback: string): string {
  const raw = (origin ?? fallback).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppleAdsError('invalid_input', {
      message: 'The Apple Ads address is not a valid URL.',
    });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AppleAdsError('invalid_input', {
      message:
        'The Apple Ads address must be an http(s) origin without credentials, query or fragment.',
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

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppleAdsError('network'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AppleAdsError('network'));
      },
      { once: true },
    );
  });

const seconds = (header: string | null): number | undefined => {
  if (header === null || header.trim() === '') return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
};

export function createAppleAdsClient(options: AppleAdsClientOptions): AppleAdsClient {
  const credential = options.credential;
  const key = loadAppleAdsSigningKey(credential.privateKey);
  const known = [...secretStrings(credential.privateKey), credential.privateKey];
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const apiOrigin = normalizeAppleAdsOrigin(options.apiOrigin, APPLE_ADS_API_ORIGIN);
  const tokenOrigin = normalizeAppleAdsOrigin(options.tokenOrigin, APPLE_ADS_TOKEN_ORIGIN);
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPLE_ADS_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_APPLE_ADS_MAX_RESPONSE_BYTES;
  const maxRequests = options.maxRequests ?? DEFAULT_APPLE_ADS_MAX_REQUESTS;
  const maxWait = options.maxWaitSeconds ?? 30;
  const userAgent = options.userAgent ?? 'kiln';

  let requests = 0;
  let cached: { token: string; until: number } | undefined;
  /** Seconds to wait before the next request, from the quota headers of the last answer. */
  let pace: { until: number } | undefined;
  const fail = (
    kind: AppleAdsErrorKind,
    extra: ConstructorParameters<typeof AppleAdsError>[1] = {},
  ) => new AppleAdsError(kind, { ...extra, known: [...known, ...(cached ? [cached.token] : [])] });

  type Raw = { status: number; headers: Headers; text: string | undefined };
  async function exchange(
    url: string,
    init: RequestInit,
    signalIn: AbortSignal | undefined,
  ): Promise<Raw> {
    const limit = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      limit.abort();
    }, timeoutMs);
    const signal = signalIn ? AbortSignal.any([signalIn, limit.signal]) : limit.signal;
    try {
      const response = await send(url, { ...init, redirect: 'manual', signal });
      return {
        status: response.status,
        headers: response.headers,
        text: await readCapped(response, maxBytes),
      };
    } catch (error) {
      if (error instanceof AppleAdsError) throw error;
      // The error text of the network is dropped on purpose (it can carry the address).
      if (timedOut || (error instanceof Error && error.name === 'TimeoutError')) {
        throw fail('network', {
          timedOut: true,
          message: 'Apple Ads did not answer in time. Try again in a minute.',
        });
      }
      throw fail('network');
    } finally {
      clearTimeout(timer);
    }
  }

  const parse = (text: string | undefined): Record<string, unknown> | undefined => {
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  async function token(signal: AbortSignal | undefined): Promise<string> {
    if (cached && cached.until > now()) return cached.token;
    const secret = signAppleAdsClientSecret(key, credential, now());
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credential.clientId,
      client_secret: secret.token,
      scope: APPLE_ADS_SCOPE,
    });
    const raw = await exchange(
      `${tokenOrigin}${APPLE_ADS_TOKEN_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': userAgent,
        },
        body: form.toString(),
      },
      signal,
    );
    if (raw.status < 200 || raw.status > 299) {
      // `invalid_client` (400 or 401) is a key Apple does not know; 403 here is the same for a person.
      const kind =
        raw.status === 400 || raw.status === 401 || raw.status === 403
          ? 'auth'
          : appleAdsErrorKind(raw.status);
      const retry = seconds(raw.headers.get('retry-after'));
      throw fail(kind, {
        status: raw.status,
        ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
      });
    }
    const body = parse(raw.text);
    const access = body?.access_token;
    if (typeof access !== 'string' || access === '' || /\s/.test(access))
      throw fail('unexpected', { status: raw.status });
    const expires =
      typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    cached = { token: access, until: now() + Math.max(60, expires - TOKEN_MARGIN_SECONDS) * 1000 };
    return access;
  }

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    adAccountId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const allowed = method === 'GET' ? GET_PATHS.some((p) => p.test(path)) : QUERY_PATHS.has(path);
    if (!allowed)
      throw fail('invalid_input', {
        message: 'That is not a read-only Apple Ads request this tool makes.',
      });
    const needsContext = !NO_CONTEXT.has(path);
    if (needsContext && !(adAccountId && /^[0-9]{1,20}$/.test(adAccountId))) {
      throw fail('invalid_input', { message: 'That is not a valid Apple Ads ad account id.' });
    }
    let renewed = false;
    let retriedServer = false;
    let limited = 0;
    for (;;) {
      if (requests >= maxRequests) {
        throw fail('rate_limited', {
          retryAfterSeconds: 60,
          message: 'This read needs more requests than one read may use. Try again in a minute.',
        });
      }
      if (pace && pace.until > now()) {
        const wait = Math.ceil((pace.until - now()) / 1000);
        if (wait > maxWait) throw fail('rate_limited', { retryAfterSeconds: wait });
        await sleep(wait * 1000, signal);
      }
      pace = undefined;
      const access = await token(signal);
      requests += 1;
      const headers: Record<string, string> = {
        authorization: `Bearer ${access}`,
        accept: 'application/json',
        'user-agent': userAgent,
      };
      if (needsContext && adAccountId) headers['x-ap-context'] = `adAccountId=${adAccountId}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const raw = await exchange(
        `${apiOrigin}${APPLE_ADS_API_PREFIX}${path}`,
        { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
        signal,
      );
      const remaining = seconds(raw.headers.get('ratelimit-remaining'));
      const reset = seconds(raw.headers.get('ratelimit-reset'));
      if (remaining !== undefined && reset !== undefined && remaining <= 1 && reset > 0) {
        pace = { until: now() + reset * 1000 };
      }
      const status = raw.status;
      if (status === 401 && !renewed) {
        renewed = true;
        cached = undefined;
        continue;
      }
      if (status === 429) {
        const wait =
          seconds(raw.headers.get('retry-after')) ??
          seconds(raw.headers.get('ratelimit-reset')) ??
          Math.min(2 ** (limited + 1), 16);
        if (limited >= 3 || wait > maxWait)
          throw fail('rate_limited', { status, retryAfterSeconds: Math.max(wait, 1) });
        limited += 1;
        pace = undefined;
        await sleep(wait * 1000, signal);
        continue;
      }
      if (status >= 500 && !retriedServer) {
        retriedServer = true;
        await sleep(2000, signal);
        continue;
      }
      if (status >= 300 && status < 400) throw fail('unexpected', { status });
      if (status < 200 || status > 299) throw fail(appleAdsErrorKind(status), { status });
      const parsed = parse(raw.text);
      if (!parsed) throw fail('unexpected', { status });
      return parsed;
    }
  }

  return {
    apiOrigin,
    get requests() {
      return requests;
    },
    canRequest: (reserve = 0) => maxRequests - requests > reserve,
    async authenticate(opts) {
      await token(opts?.signal);
    },
    get: (path, opts) => call('GET', path, undefined, opts?.adAccountId, opts?.signal),
    query: (path, body, opts) => call('POST', path, body, opts.adAccountId, opts.signal),
  };
}
