import { redactSecrets, StoreError, type StoreName, StoreRateLimitError } from './errors.ts';

/**
 * The HTTP plumbing both store connectors share: one injected `fetch`, a timeout, JSON that may
 * be malformed, redaction of every message, and a bounded wait on 429.
 */

export type StoreReply = {
  status: number;
  headers: Headers;
  /** The parsed body, or undefined when it was empty or not JSON (see `malformed`). */
  json: unknown;
  /** True when a non-empty body could not be parsed as JSON. */
  malformed: boolean;
};

export type StoreHttpOptions = {
  store: StoreName;
  /** Defaults to the global `fetch`. Tests pass a fake. */
  fetch?: typeof fetch;
  /** Per request. Default 30000. */
  timeoutMs?: number;
  userAgent?: string;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * How many times a 429 is waited out and retried. Default 2. The wait is the server's
   * `Retry-After` when it is at most `maxRetryWaitSeconds`; otherwise the error is thrown.
   */
  maxRateLimitRetries?: number;
  /** The longest single wait for a retry. Default 10 seconds. */
  maxRetryWaitSeconds?: number;
  /** Injected for tests. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type StoreRequest = {
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Sent as is with this content type (an image upload to a store). */
  raw?: { body: Uint8Array; contentType: string };
};

/**
 * A request whose answer is read as BYTES (a gzip file, a CSV export), with a hard size cap. Used for pre-signed download links
 * (Apple analytics segments) and Cloud Storage objects. `headers` are sent as given: for a pre-signed link send none, so no
 * bearer token goes to the storage host.
 */
export type BytesRequest = {
  headers?: Record<string, string>;
  /** The most bytes read from a success answer. More is `StoreError` kind `too_large`; nothing beyond the cap is kept. */
  maxBytes: number;
  /** The `accept` header. Default: any type. */
  accept?: string;
};

export type BytesReply = {
  status: number;
  headers: Headers;
  /** The body. For a status outside 2xx at most 64 KiB, enough to read an error document. */
  bytes: Uint8Array;
};

/** The most of an error answer that is read in bytes mode. */
export const MAX_ERROR_BYTES = 64 * 1024;

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
export const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
export const enc = (segment: string) => encodeURIComponent(segment);

/** Seconds from a `Retry-After` header (delta seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 86_400);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(Math.ceil((date - nowMs) / 1000), 86_400));
}

/** The server's idea of "now" from the `Date` header, in epoch ms, or undefined. */
export function serverTime(headers: Headers): number | undefined {
  const value = headers.get('date');
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the store';
  }
}

export class StoreHttp {
  readonly store: StoreName;
  /** Strings that must never appear in a message. Add tokens and key material here. */
  readonly known = new Set<string>();
  readonly now: () => number;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #retries: number;
  readonly #maxWait: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: StoreHttpOptions) {
    this.store = options.store;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#userAgent = options.userAgent ?? 'mobile-release-manager';
    this.now = options.now ?? Date.now;
    this.#retries = options.maxRateLimitRetries ?? 2;
    this.#maxWait = options.maxRetryWaitSeconds ?? 10;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  redact(value: string): string {
    return redactSecrets(value, this.known);
  }

  /**
   * One request. A 429 is waited out (bounded) and retried; everything else, including other
   * error statuses, is returned for the caller to map, because each store words them differently.
   */
  async send(method: string, url: string, request: StoreRequest = {}): Promise<StoreReply> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.#once(method, url, request);
      if (reply.status !== 429) return reply;
      const wait = parseRetryAfter(reply.headers.get('retry-after'), this.now()) ?? 60;
      if (attempt >= this.#retries || wait > this.#maxWait) {
        throw new StoreRateLimitError(this.store, wait);
      }
      await this.#sleep(wait * 1000);
    }
  }

  /**
   * Like `send`, but the body is returned as bytes and never parsed. A 429 is waited out like in `send`. The URL (and its query,
   * which is the secret of a pre-signed link) is added to `known` so no message can carry it. A body over `maxBytes`, by
   * `Content-Length` or by counting while reading, is a `StoreError` of kind `too_large`; the rest is never read into memory.
   */
  async sendBytes(method: string, url: string, request: BytesRequest): Promise<BytesReply> {
    this.known.add(url);
    try {
      const search = new URL(url).search;
      if (search.length >= 8) this.known.add(search);
    } catch {
      // Not a URL: fetch fails below with a plain message.
    }
    for (let attempt = 0; ; attempt++) {
      const reply = await this.#bytesOnce(method, url, request);
      if (reply.status !== 429) return reply;
      const wait = parseRetryAfter(reply.headers.get('retry-after'), this.now()) ?? 60;
      if (attempt >= this.#retries || wait > this.#maxWait) {
        throw new StoreRateLimitError(this.store, wait);
      }
      await this.#sleep(wait * 1000);
    }
  }

  async #bytesOnce(method: string, url: string, request: BytesRequest): Promise<BytesReply> {
    const response = await this.#fetchOnce(method, url, {
      accept: request.accept ?? '*/*',
      'user-agent': this.#userAgent,
      ...request.headers,
    });
    const ok = response.status >= 200 && response.status < 300;
    const cap = ok ? request.maxBytes : MAX_ERROR_BYTES;
    const declared = Number(response.headers.get('content-length'));
    if (ok && Number.isFinite(declared) && declared > cap) {
      await response.body?.cancel().catch(() => undefined);
      throw new StoreError(
        this.store,
        'too_large',
        `The file from ${hostOf(url)} is larger than the limit of ${cap} bytes.`,
        response.status,
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cap) {
            await reader.cancel().catch(() => undefined);
            if (ok) {
              throw new StoreError(
                this.store,
                'too_large',
                `The file from ${hostOf(url)} is larger than the limit of ${cap} bytes.`,
                response.status,
              );
            }
            // An error document longer than the cap: keep what fits.
            chunks.push(value.subarray(0, value.byteLength - (total - cap)));
            break;
          }
          chunks.push(value);
        }
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        this.store,
        'network',
        `The connection to ${hostOf(url)} was cut off while reading the response.`,
        response.status,
      );
    }
    const bytes = new Uint8Array(Math.min(total, cap));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: response.status, headers: response.headers, bytes };
  }

  /** One `fetch` with the timeout and the same plain error messages as `send`. */
  async #fetchOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new StoreError(
        this.store,
        'network',
        timedOut
          ? `The request to ${hostOf(url)} timed out after ${Math.round(this.#timeoutMs / 1000)} seconds.`
          : `Could not reach ${hostOf(url)}. Check the network connection of the server.`,
      );
    }
  }

  async #once(method: string, url: string, request: StoreRequest): Promise<StoreReply> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.#userAgent,
      ...request.headers,
    };
    let body: string | Uint8Array | undefined;
    if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.json);
    } else if (request.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form).toString();
    } else if (request.raw) {
      // A caller's own headers win over the default content type (a pre-signed upload names its own).
      headers['content-type'] = request.raw.contentType;
      body = request.raw.body;
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined
          ? { body: body as unknown as NonNullable<ConstructorParameters<typeof Response>[0]> }
          : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      // The underlying message is not shown: it can echo the URL or parts of the request.
      throw new StoreError(
        this.store,
        'network',
        timedOut
          ? `The request to ${hostOf(url)} timed out after ${Math.round(this.#timeoutMs / 1000)} seconds.`
          : `Could not reach ${hostOf(url)}. Check the network connection of the server.`,
      );
    }
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      throw new StoreError(
        this.store,
        'network',
        `The connection to ${hostOf(url)} was cut off while reading the response.`,
        response.status,
      );
    }
    let json: unknown;
    let malformed = false;
    if (raw.trim() !== '') {
      try {
        json = JSON.parse(raw);
      } catch {
        malformed = true;
      }
    }
    return { status: response.status, headers: response.headers, json, malformed };
  }
}
