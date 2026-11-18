import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * Sending a webhook is a request to an address a user chose, so it is the one place where the
 * server could be turned against its own network (SSRF). The rules, all enforced here:
 *
 * - https only. With `allowPrivate` (MRM_WEBHOOKS_ALLOW_PRIVATE=1) plain http is also accepted,
 *   but only to a loopback address, for local development.
 * - The host name is resolved by us, every answer is classified, and if ANY answer is not a
 *   public address the request is refused (an attacker-run DNS server can mix good and bad ones).
 * - The connection is made to the address that was checked, not to the name, so the name cannot
 *   resolve somewhere else a moment later (DNS rebinding). The name is still used for the TLS
 *   server name and the Host header, so certificates are verified as usual. The connected socket's
 *   address is compared with the checked one as well.
 * - Private and loopback ranges are refused unless `allowPrivate`. Link-local (which holds the
 *   cloud metadata address 169.254.169.254), unspecified, multicast, reserved, documentation and
 *   translation ranges are refused even then. IPv6 is classified the same way, including IPv4
 *   mapped (::ffff:a.b.c.d), NAT64 and 6to4 forms, which are judged by the IPv4 address inside.
 * - Redirects are never followed; a 3xx is a failed delivery.
 * - A hard timeout, and the response is read only up to a small cap.
 * - Nothing here logs. The caller records a short, redacted result.
 */

export type AddressClass = 'public' | 'private' | 'blocked';

const v4 = (text: string): number[] | undefined => {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^[0-9]{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
};

/** Classifies an IPv4 address given as four numbers. */
function classify4([a, b, c, d]: number[]): AddressClass {
  if (a === undefined || b === undefined || c === undefined || d === undefined) return 'blocked';
  if (a === 0) return 'blocked'; // 0.0.0.0/8, "this network"
  if (a === 127) return 'private'; // loopback
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'blocked'; // link-local, cloud metadata
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'blocked'; // a cloud metadata address inside the CGNAT range
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT, used by some VPNs
  if (a === 192 && b === 0 && c === 0) return 'blocked'; // IETF protocol assignments (192.0.0.192 too)
  if (a === 192 && b === 0 && c === 2) return 'blocked'; // documentation
  if (a === 198 && b === 51 && c === 100) return 'blocked';
  if (a === 203 && b === 0 && c === 113) return 'blocked';
  if (a === 192 && b === 88 && c === 99) return 'blocked'; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return 'blocked'; // benchmarking
  if (a >= 224) return 'blocked'; // multicast, reserved, broadcast
  return 'public';
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it is not valid. Zone ids are refused. */
export function expandIpv6(text: string): number[] | undefined {
  if (text.includes('%') || !text.includes(':')) return undefined;
  let address = text;
  const tail = address.slice(address.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const quad = v4(tail);
    if (!quad) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = quad;
    address = `${address.slice(0, address.lastIndexOf(':') + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return undefined;
  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return nums.every((n) => Number.isInteger(n)) ? nums : undefined;
}

function classify6(g: number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number) => classify4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g5 === 0xffff) return embedded(g6, g7); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(5) && g5 === 0) return g6 === 0 && g7 === 1 ? 'private' : 'blocked'; // ::1 loopback; :: and IPv4-compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b) return 'blocked'; // local-use NAT64 (64:ff9b:1::/48)
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4: the IPv4 address is in bits 16..47
  if (g0 === 0x2001 && g1 === 0) return 'blocked'; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return 'blocked'; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'blocked'; // discard-only
  if (g0 === 0xfd00 && g1 === 0x0ec2) return 'blocked'; // AWS's fd00:ec2::254 metadata address: before the unique local range
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return 'blocked'; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return 'blocked'; // multicast
  if ((g0 & 0xe000) !== 0x2000) return 'blocked'; // not global unicast (2000::/3)
  return 'public';
}

/** Public, private (loopback, RFC 1918, CGNAT, unique local) or blocked (never allowed). */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    const quad = v4(address);
    return quad ? classify4(quad) : 'blocked';
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    return groups ? classify6(groups) : 'blocked';
  }
  return 'blocked';
}

// ---------------------------------------------------------------------------------------------
// The URL

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

export const MAX_URL_LENGTH = 2048;

export type UrlCheck =
  | { ok: true; url: URL; hostname: string; literal: boolean; loopbackHttp: boolean }
  | { ok: false; message: string };

const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

function isLoopbackLiteral(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && classifyAddress(host) === 'private' && /^(127\.|::1$)/.test(host));
}

/** Checks a webhook URL without touching the network. */
export function checkWebhookUrl(raw: string, options: { allowPrivate?: boolean } = {}): UrlCheck {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, message: 'The URL is too long.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'That is not a valid URL.' };
  }
  if (url.username || url.password) return { ok: false, message: 'The URL must not contain a user name or password.' };
  // URL#hostname keeps the brackets of an IPv6 literal.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { ok: false, message: 'The URL has no host.' };
  const literal = isIP(hostname) !== 0;
  const loopback = isLoopbackLiteral(hostname);
  if (url.protocol === 'http:') {
    if (!(options.allowPrivate && loopback)) {
      return {
        ok: false,
        message: options.allowPrivate
          ? 'Plain http is accepted only for localhost. Use https.'
          : 'Use an https URL.',
      };
    }
  } else if (url.protocol !== 'https:') {
    return { ok: false, message: 'Use an https URL.' };
  }
  if (!options.allowPrivate) {
    if (LOCAL_NAME.test(hostname) || (!literal && !hostname.includes('.'))) {
      return { ok: false, message: 'That host name points inside a network. Use a public https URL.' };
    }
  }
  if (literal) {
    const cls = classifyAddress(hostname);
    if (cls === 'blocked' || (cls === 'private' && !options.allowPrivate)) {
      return { ok: false, message: 'That address is not allowed. Use a public https URL.' };
    }
  }
  return { ok: true, url, hostname, literal, loopbackHttp: url.protocol === 'http:' };
}

export type Resolved =
  | {
      ok: true;
      address: string;
      family: 4 | 6;
      /** The other answers (all of them passed the same checks), in order, for a caller that may try the next one. */
      others?: { address: string; family: 4 | 6 }[];
    }
  | { ok: false; message: string; transient: boolean };

/**
 * Resolves the host and returns the one address to connect to. Refuses when any answer is not
 * allowed. `transient` tells the queue whether trying again could help (a DNS failure) or not.
 */
export async function resolveAllowed(
  check: Extract<UrlCheck, { ok: true }>,
  options: { allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<Resolved> {
  let answers: { address: string; family: number }[];
  if (check.literal) {
    answers = [{ address: check.hostname, family: isIP(check.hostname) }];
  } else {
    try {
      answers = await (options.resolve ?? systemResolver)(check.hostname);
    } catch {
      return { ok: false, message: 'The host name could not be resolved.', transient: true };
    }
  }
  if (answers.length === 0) return { ok: false, message: 'The host name has no address.', transient: true };
  for (const { address } of answers) {
    const cls = classifyAddress(address);
    if (cls === 'blocked' || (cls === 'private' && !options.allowPrivate)) {
      return { ok: false, message: 'The host name resolves to an address that is not allowed.', transient: false };
    }
  }
  const first = answers[0];
  if (!first) return { ok: false, message: 'The host name has no address.', transient: true };
  const others = answers.slice(1, 4).map((a) => ({ address: a.address, family: (a.family === 6 ? 6 : 4) as 4 | 6 }));
  return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4, ...(others.length > 0 ? { others } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Sending

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Reading stops here; nothing larger is ever buffered. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** What is kept of a response body for the delivery log. */
export const KEPT_RESPONSE_CHARS = 1000;

export type SendOptions = {
  allowPrivate?: boolean;
  resolve?: Resolver;
  timeoutMs?: number;
};

export type SendResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: 'blocked' | 'dns' | 'timeout' | 'network'; message: string; transient: boolean };

/** Equal addresses, whatever the spelling (an IPv4-mapped IPv6 form counts as its IPv4 address). */
export function sameAddress(a: string, b: string): boolean {
  const norm = (x: string) => {
    const lower = x.toLowerCase();
    if (lower.startsWith('::ffff:') && v4(lower.slice(7))) return lower.slice(7);
    const groups = isIP(lower) === 6 ? expandIpv6(lower) : undefined;
    return groups ? groups.join(':') : lower;
  };
  return norm(a) === norm(b);
}

/** POSTs `body` to `rawUrl` under the rules above. Never throws. */
export async function sendPinned(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  options: SendOptions = {},
): Promise<SendResult> {
  const check = checkWebhookUrl(rawUrl, options);
  if (!check.ok) return { ok: false, kind: 'blocked', message: check.message, transient: false };
  const resolved = await resolveAllowed(check, options);
  if (!resolved.ok) {
    return {
      ok: false,
      kind: resolved.transient ? 'dns' : 'blocked',
      message: resolved.message,
      transient: resolved.transient,
    };
  }
  const { url } = check;
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const send = secure ? httpsRequest : httpRequest;
    const req = send({
      host: resolved.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      // No pooling: a kept-alive socket would outlive the check that approved its address.
      agent: false,
      headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)) },
      // The certificate is checked against the name, while the socket goes to the checked address.
      ...(secure && !check.literal ? { servername: check.hostname } : {}),
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, kind: 'timeout', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`, transient: true });
    }, timeoutMs);
    timer.unref?.();

    req.on('socket', (socket) => {
      const verify = () => {
        // Belt and braces: the peer must be the address that was approved.
        const peer = socket.remoteAddress;
        if (peer && !sameAddress(peer, resolved.address)) {
          req.destroy();
          finish({ ok: false, kind: 'blocked', message: 'The connection went to an unexpected address.', transient: false });
        }
      };
      socket.once(secure ? 'secureConnect' : 'connect', verify);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) {
          chunks.push(chunk);
        } else {
          // Enough: do not keep reading what a server wants to pour in.
          res.destroy();
          finish({ ok: true, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        }
      });
      const done = () => finish({ ok: true, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.on('error', () => {
      // The error text is dropped: it can include the resolved address.
      finish({ ok: false, kind: 'network', message: 'The connection failed.', transient: true });
    });
    req.end(body);
  });
}

/** A response body made safe to store and show: printable text, shortened, secrets removed. */
export function cleanResponseBody(body: string, secrets: string[] = []): string {
  let text = body.slice(0, KEPT_RESPONSE_CHARS * 2);
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.slice(0, KEPT_RESPONSE_CHARS);
}
