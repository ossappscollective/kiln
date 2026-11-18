import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  type Resolver,
  checkWebhookUrl,
  resolveAllowed,
  sameAddress,
} from './webhook-transport.ts';

/**
 * A GET to an address that is NOT chosen by a user but still comes from a third party (the image
 * URL an App Store lookup answers with), under the same rules as sending a webhook
 * (webhook-transport.ts), plus:
 *
 * - a host allowlist (`allowHost`), checked for the first URL and again for EVERY redirect target;
 * - redirects are followed at most `maxRedirects` times (default 3), each one fully re-checked
 *   (scheme, host, resolved addresses), and never from https to http;
 * - the body is read up to `maxBytes` and not one byte more: a longer one (by Content-Length or by
 *   counting) is a failure, never a truncated success;
 * - a total time limit that covers redirects;
 * - nothing here logs, and errors carry no address or header.
 *
 * `exchange` is the one place that opens a socket. The default connects to the checked address
 * (not the name) with the name as TLS server name; tests replace it to play redirects and big bodies.
 */

export type ExchangeRequest = {
  url: URL;
  /** The address that was checked: connect here, not to the host name. */
  address: string;
  family: 4 | 6;
  secure: boolean;
  /** For TLS: the name to verify the certificate against (absent for an IP literal). */
  servername?: string;
  headers: Record<string, string>;
  maxBytes: number;
  signal: AbortSignal;
};

export type ExchangeResponse = {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: Uint8Array;
  /** The body was longer than `maxBytes` (what is in `body` is what fit). */
  overflow: boolean;
};

export type Exchange = (request: ExchangeRequest) => Promise<ExchangeResponse>;

export type SafeGetOptions = {
  /** Called with the lower-case host name of every URL, the first and each redirect target. */
  allowHost: (host: string) => boolean;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  /** Development only (MRM_WEBHOOKS_ALLOW_PRIVATE): accept loopback and private addresses. */
  allowPrivate?: boolean;
  resolve?: Resolver;
  exchange?: Exchange;
  signal?: AbortSignal;
};

export type SafeGetResult =
  | { ok: true; status: number; body: Uint8Array; contentType: string | null; finalUrl: string }
  | { ok: false; kind: 'blocked' | 'dns' | 'timeout' | 'network' | 'status' | 'too_large' | 'redirect'; message: string; transient: boolean; status?: number };

export const SAFE_GET_TIMEOUT_MS = 10_000;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export const realExchange: Exchange = (request) =>
  new Promise<ExchangeResponse>((resolve, reject) => {
    const { url, secure } = request;
    const send = secure ? httpsRequest : httpRequest;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const req = send({
      host: request.address,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // No pooling: a kept-alive socket would outlive the check that approved its address.
      agent: false,
      headers: { ...request.headers, host: url.host },
      ...(secure && request.servername ? { servername: request.servername } : {}),
    });
    const onAbort = () => {
      req.destroy();
      done(() => reject(new Error('aborted')));
    };
    if (request.signal.aborted) return onAbort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    req.on('socket', (socket) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        // Belt and braces: the peer must be the address that was approved.
        const peer = socket.remoteAddress;
        if (peer && !sameAddress(peer, request.address)) {
          req.destroy();
          done(() => reject(new Error('unexpected address')));
        }
      });
    });
    req.on('response', (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > request.maxBytes) {
        res.destroy();
        req.destroy();
        return done(() => resolve({ status: res.statusCode ?? 0, headers: {}, body: new Uint8Array(0), overflow: true }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      const finish = (overflow: boolean) =>
        done(() => resolve({ status: res.statusCode ?? 0, headers, body: new Uint8Array(Buffer.concat(chunks)), overflow }));
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) {
          // Nothing more is read, and what came is dropped.
          res.destroy();
          req.destroy();
          return finish(true);
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(false));
      res.on('error', () => done(() => reject(new Error('network'))));
      res.on('close', () => {
        if (!res.complete) done(() => reject(new Error('network')));
      });
    });
    // The error text is dropped: it can include the resolved address.
    req.on('error', () => done(() => reject(new Error('network'))));
    req.end();
  });

/** GETs `rawUrl` under the rules above. Never throws. */
export async function safeGet(rawUrl: string, options: SafeGetOptions): Promise<SafeGetResult> {
  const timeoutMs = options.timeoutMs ?? SAFE_GET_TIMEOUT_MS;
  const exchange = options.exchange ?? realExchange;
  const maxRedirects = options.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = checkWebhookUrl(current, options.allowPrivate ? { allowPrivate: true } : {});
      if (!check.ok) return { ok: false, kind: 'blocked', message: check.message, transient: false };
      if (!options.allowHost(check.hostname)) {
        return { ok: false, kind: hop === 0 ? 'blocked' : 'redirect', message: 'That host is not allowed.', transient: false };
      }
      const resolved = await resolveAllowed(check, {
        ...(options.allowPrivate ? { allowPrivate: true } : {}),
        ...(options.resolve ? { resolve: options.resolve } : {}),
      });
      if (!resolved.ok) {
        return { ok: false, kind: resolved.transient ? 'dns' : 'blocked', message: resolved.message, transient: resolved.transient };
      }
      if (controller.signal.aborted) {
        return { ok: false, kind: 'timeout', message: 'The request was stopped.', transient: true };
      }
      let res: ExchangeResponse;
      try {
        res = await exchange({
          url: check.url,
          address: resolved.address,
          family: resolved.family,
          secure: check.url.protocol === 'https:',
          ...(check.literal ? {} : { servername: check.hostname }),
          headers: { accept: options.accept ?? '*/*', 'accept-encoding': 'identity', 'user-agent': 'mobile-release-manager' },
          maxBytes: options.maxBytes,
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          return { ok: false, kind: 'timeout', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`, transient: true };
        }
        return { ok: false, kind: 'network', message: 'The connection failed.', transient: true };
      }
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.location;
        if (!location) return { ok: false, kind: 'redirect', message: 'A redirect without a location.', transient: false, status: res.status };
        let next: URL;
        try {
          next = new URL(location, check.url);
        } catch {
          return { ok: false, kind: 'redirect', message: 'A redirect to an invalid URL.', transient: false, status: res.status };
        }
        if (check.url.protocol === 'https:' && next.protocol !== 'https:') {
          return { ok: false, kind: 'redirect', message: 'A redirect from https to plain http.', transient: false, status: res.status };
        }
        current = next.toString();
        continue;
      }
      if (res.overflow) return { ok: false, kind: 'too_large', message: `The answer is larger than ${options.maxBytes} bytes.`, transient: false };
      if (res.status !== 200) {
        return {
          ok: false,
          kind: 'status',
          message: `The server answered ${res.status}.`,
          transient: res.status >= 500 || res.status === 429,
          status: res.status,
        };
      }
      return { ok: true, status: 200, body: res.body, contentType: res.headers['content-type'] ?? null, finalUrl: check.url.toString() };
    }
    return { ok: false, kind: 'redirect', message: 'Too many redirects.', transient: false };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
