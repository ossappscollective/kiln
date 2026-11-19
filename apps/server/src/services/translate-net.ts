import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  checkWebhookUrl,
  type Resolver,
  resolveAllowed,
  sameAddress,
} from './webhook-transport.ts';

/**
 * The network rules for the one translation provider whose address a person chooses: LibreTranslate.
 * Same rules as a webhook (webhook-transport.ts) and the safe GET (safe-fetch.ts):
 *
 * - https only; plain http only to a loopback address and only when `allowPrivate`
 *   (MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true).
 * - No user name or password in the URL; no query string or fragment (the key goes in the body).
 * - The host name is resolved here and every answer must be public (or private when allowed); the
 *   connection goes to the checked address, not the name (DNS rebinding), and the socket's peer is
 *   compared to it. Cloud metadata addresses (169.254.169.254, fd00:ec2::254, 100.100.100.200, the
 *   whole link-local range) are refused even when private addresses are allowed.
 * - Redirects are never followed: a 3xx is handed back as the answer and counts as a failure upstream.
 * - The answer is read up to `maxBytes` and not one byte more (a longer one fails, it is never
 *   truncated), and the whole call has a time limit.
 *
 * `createGuardedFetch` returns a `fetch` for the connector, so the connector stays free of server
 * rules. `exchange` is the one place that opens a socket; tests replace it.
 */

export type UrlOk = { ok: true; url: string };
export type UrlRefused = { ok: false; message: string };

/**
 * Checks a LibreTranslate address without the network. The normalized form has no trailing slash
 * and keeps a path prefix (`https://host/libre`).
 */
export function checkTranslateUrl(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): UrlOk | UrlRefused {
  const check = checkWebhookUrl(raw.trim(), options.allowPrivate ? { allowPrivate: true } : {});
  if (!check.ok) return { ok: false, message: check.message };
  if (check.url.search || check.url.hash) {
    return { ok: false, message: 'The address must not have a query string or a fragment.' };
  }
  const path = check.url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${check.url.origin}${path}` };
}

export type PostExchangeRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  secure: boolean;
  servername?: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  maxBytes: number;
  signal: AbortSignal;
};

export type PostExchangeResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
  overflow: boolean;
};

export type PostExchange = (request: PostExchangeRequest) => Promise<PostExchangeResponse>;

export const realPostExchange: PostExchange = (request) =>
  new Promise<PostExchangeResponse>((resolve, reject) => {
    const { url, secure } = request;
    const send = secure ? httpsRequest : httpRequest;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const payload = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
    const req = send({
      host: request.address,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      // No pooling: a kept-alive socket would outlive the check that approved its address.
      agent: false,
      headers: {
        ...request.headers,
        host: url.host,
        'accept-encoding': 'identity',
        ...(payload ? { 'content-length': String(payload.length) } : {}),
      },
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
        return done(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: {},
            body: new Uint8Array(0),
            overflow: true,
          }),
        );
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      const finish = (overflow: boolean) =>
        done(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            overflow,
          }),
        );
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) {
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
    req.end(payload);
  });

export type GuardedFetchOptions = {
  allowPrivate?: boolean;
  resolve?: Resolver;
  exchange?: PostExchange;
  /** Largest answer. Default 2 MiB. */
  maxBytes?: number;
  /** Whole call. Default 15 seconds. */
  timeoutMs?: number;
};

export type GuardedFetch = {
  fetch: typeof fetch;
  /** Why the last request was refused before it was sent (a fixed sentence), or undefined. */
  blocked(): string | undefined;
};

const NO_BODY = new Set([101, 103, 204, 205, 304]);

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
  const exchange = options.exchange ?? realPostExchange;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let blocked: string | undefined;

  const guarded = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    blocked = undefined;
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const check = checkWebhookUrl(raw, options.allowPrivate ? { allowPrivate: true } : {});
    if (!check.ok) {
      blocked = check.message;
      throw new Error('blocked');
    }
    const resolved = await resolveAllowed(check, {
      ...(options.allowPrivate ? { allowPrivate: true } : {}),
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
    if (!resolved.ok) {
      blocked = resolved.message;
      throw new Error('blocked');
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = init?.signal;
    const onOuter = () => controller.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    if (outer?.aborted) controller.abort();
    try {
      // Every candidate address passed the same checks. `localhost` often answers ::1 first while the
      // server listens on IPv4 only (a published Docker port), so a refused connection tries the next one.
      const candidates = [
        { address: resolved.address, family: resolved.family },
        ...(resolved.others ?? []),
      ];
      let res: Awaited<ReturnType<PostExchange>> | undefined;
      for (let i = 0; i < candidates.length && !res; i++) {
        const c = candidates[i] as { address: string; family: 4 | 6 };
        try {
          res = await exchange({
            url: check.url,
            address: c.address,
            family: c.family,
            secure: check.url.protocol === 'https:',
            ...(check.literal ? {} : { servername: check.hostname }),
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? init.body : undefined,
            maxBytes,
            signal: controller.signal,
          });
        } catch (error) {
          if (i === candidates.length - 1 || controller.signal.aborted) throw error;
        }
      }
      if (!res) throw new Error('network');
      if (res.overflow) throw new Error('too large');
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers))
        if (value !== undefined) responseHeaders.set(name, value);
      // Never followed: the 3xx is the answer.
      return new Response(NO_BODY.has(res.status) ? null : res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }) as typeof fetch;

  return { fetch: guarded, blocked: () => blocked };
}
