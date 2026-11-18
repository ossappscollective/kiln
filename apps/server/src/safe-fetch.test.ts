import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { type Exchange, type ExchangeResponse, safeGet } from './services/safe-fetch.ts';

/** The outbound GET of the icon lookup. Every refusal here happens before or without a real connection. */

type Reply = Partial<ExchangeResponse>;
const reply = (r: Reply = {}): ExchangeResponse => ({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3]), overflow: false, ...r });

function scripted(replies: (Reply | Error)[]) {
  const seen: { url: string; address: string; servername?: string }[] = [];
  const exchange: Exchange = async (request) => {
    seen.push({ url: request.url.toString(), address: request.address, ...(request.servername ? { servername: request.servername } : {}) });
    const next = replies.shift() ?? { status: 500 };
    if (next instanceof Error) throw next;
    return reply(next);
  };
  return { exchange, seen };
}

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const only = (...hosts: string[]) => (host: string) => hosts.includes(host);
const base = { allowHost: only('itunes.apple.com', 'a.mzstatic.com'), maxBytes: 1000, resolve: publicResolve };

test('a good answer comes back with its bytes and the connection goes to the checked address', async () => {
  const s = scripted([{ headers: { 'content-type': 'image/png' } }]);
  const res = await safeGet('https://itunes.apple.com/lookup?id=1', { ...base, exchange: s.exchange });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual([...res.body], [1, 2, 3]);
    assert.equal(res.contentType, 'image/png');
  }
  assert.deepEqual(s.seen, [{ url: 'https://itunes.apple.com/lookup?id=1', address: '93.184.216.34', servername: 'itunes.apple.com' }]);
});

test('urls that are refused before any connection', async () => {
  const bad = [
    'http://itunes.apple.com/lookup',
    'ftp://itunes.apple.com/x',
    'https://user:pw@itunes.apple.com/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'not a url',
    `https://itunes.apple.com/${'a'.repeat(3000)}`,
  ];
  for (const url of bad) {
    const s = scripted([reply()]);
    const res = await safeGet(url, { ...base, allowHost: () => true, exchange: s.exchange });
    assert.equal(res.ok, false, url);
    assert.equal(s.seen.length, 0, `${url}: nothing was connected`);
  }
  // The allowlist, with hosts that would otherwise pass.
  for (const url of ['https://example.com/x', 'https://evil.example.com/x', 'https://itunes.apple.com.evil.example.com/x', 'https://evilitunes.apple.com/x', 'https://mzstatic.com/x']) {
    const s = scripted([reply()]);
    const res = await safeGet(url, { ...base, exchange: s.exchange });
    assert.equal(res.ok, false, url);
    assert.equal(s.seen.length, 0, url);
  }
});

test('a host that resolves to a private, loopback, link-local or mixed answer is refused', async () => {
  for (const addresses of [['10.1.2.3'], ['127.0.0.1'], ['192.168.0.9'], ['169.254.169.254'], ['::1'], ['fd00::1'], ['93.184.216.34', '10.0.0.1'], ['::ffff:10.0.0.1']]) {
    const s = scripted([reply()]);
    const res = await safeGet('https://itunes.apple.com/x', {
      ...base,
      resolve: async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      exchange: s.exchange,
    });
    assert.equal(res.ok, false, addresses.join());
    assert.equal(s.seen.length, 0, addresses.join());
    if (!res.ok) assert.equal(res.kind, 'blocked');
  }
});

test('a name that cannot be resolved is a transient failure', async () => {
  const res = await safeGet('https://itunes.apple.com/x', { ...base, resolve: async () => Promise.reject(new Error('nope')), exchange: scripted([]).exchange });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.kind, 'dns');
    assert.equal(res.transient, true);
  }
});

test('redirects are followed to allowed hosts only, each hop is checked again, at most 3', async () => {
  const ok = scripted([
    { status: 302, headers: { location: 'https://a.mzstatic.com/one' } },
    { status: 301, headers: { location: '/two' } },
    { status: 200 },
  ]);
  const good = await safeGet('https://itunes.apple.com/x', { ...base, exchange: ok.exchange });
  assert.equal(good.ok, true);
  assert.deepEqual(ok.seen.map((x) => x.url), ['https://itunes.apple.com/x', 'https://a.mzstatic.com/one', 'https://a.mzstatic.com/two']);

  const targets = [
    'https://evil.example.com/x',
    'http://a.mzstatic.com/x',
    'https://169.254.169.254/x',
    'https://[::1]/x',
    'https://user:pw@a.mzstatic.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ];
  for (const location of targets) {
    const s = scripted([{ status: 302, headers: { location } }, { status: 200 }]);
    const res = await safeGet('https://itunes.apple.com/x', { ...base, allowHost: (h) => h === 'itunes.apple.com' || h === 'a.mzstatic.com', exchange: s.exchange });
    assert.equal(res.ok, false, location);
    assert.equal(s.seen.length, 1, `${location}: the target was never connected to`);
  }

  const loop = scripted(Array.from({ length: 10 }, () => ({ status: 302, headers: { location: 'https://a.mzstatic.com/again' } })));
  const looped = await safeGet('https://a.mzstatic.com/again', { ...base, exchange: loop.exchange });
  assert.equal(looped.ok, false);
  assert.equal(loop.seen.length, 4, 'the first request and three redirects');
  if (!looped.ok) assert.match(looped.message, /Too many redirects/);

  const empty = await safeGet('https://itunes.apple.com/x', { ...base, exchange: scripted([{ status: 302 }]).exchange });
  assert.equal(empty.ok, false);
});

test('a redirect to a name that resolves privately is refused at the second hop', async () => {
  const s = scripted([{ status: 302, headers: { location: 'https://a.mzstatic.com/x' } }, { status: 200 }]);
  const res = await safeGet('https://itunes.apple.com/x', {
    ...base,
    resolve: async (host) => [{ address: host === 'a.mzstatic.com' ? '10.0.0.5' : '93.184.216.34', family: 4 }],
    exchange: s.exchange,
  });
  assert.equal(res.ok, false);
  assert.equal(s.seen.length, 1);
});

test('a body over the cap is a failure, never a truncated success; other statuses are failures too', async () => {
  const big = await safeGet('https://itunes.apple.com/x', { ...base, exchange: scripted([{ overflow: true, body: new Uint8Array(0) }]).exchange });
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.kind, 'too_large');
  for (const [status, transient] of [[404, false], [403, false], [429, true], [500, true], [503, true], [204, false]] as const) {
    const res = await safeGet('https://itunes.apple.com/x', { ...base, exchange: scripted([{ status }]).exchange });
    assert.equal(res.ok, false, String(status));
    if (!res.ok) assert.equal(res.transient, transient, String(status));
  }
});

test('a connection that fails or hangs is reported without the address, and the timeout covers redirects', async () => {
  const failed = await safeGet('https://itunes.apple.com/x', { ...base, exchange: scripted([new Error('connect ECONNREFUSED 93.184.216.34:443')]).exchange });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.kind, 'network');
    assert.doesNotMatch(failed.message, /93\.184|ECONNREFUSED/);
  }
  const hang: Exchange = (request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = await safeGet('https://itunes.apple.com/x', { ...base, exchange: hang, timeoutMs: 30 });
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.equal(slow.kind, 'timeout');
  const controller = new AbortController();
  const aborted = safeGet('https://itunes.apple.com/x', { ...base, exchange: hang, signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  assert.equal((await aborted).ok, false);
});

// ----- the real exchange, against a local server, only with allowPrivate (development) -----------

async function localServer(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the real exchange: reads a body up to the cap, refuses a bigger one, follows a redirect inside the allowlist', async () => {
  const local = await localServer((req, res) => {
    if (req.url === '/ok') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from('hello'));
    } else if (req.url === '/big') {
      res.end(Buffer.alloc(5000, 1));
    } else if (req.url === '/chunked') {
      res.write(Buffer.alloc(800, 1));
      res.write(Buffer.alloc(800, 1));
      res.end();
    } else if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/ok');
      res.end();
    } else if (req.url === '/away') {
      res.statusCode = 302;
      res.setHeader('location', 'http://localhost:1/x');
      res.end();
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  try {
    const options = { allowHost: only('127.0.0.1'), maxBytes: 1000, allowPrivate: true, timeoutMs: 3000 };
    const ok = await safeGet(`${local.url}/ok`, options);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(new TextDecoder().decode(ok.body), 'hello');
    const big = await safeGet(`${local.url}/big`, options);
    assert.equal(big.ok, false);
    if (!big.ok) assert.equal(big.kind, 'too_large');
    const chunked = await safeGet(`${local.url}/chunked`, options);
    assert.equal(chunked.ok, false, 'counted while streaming, not only by Content-Length');
    const hop = await safeGet(`${local.url}/redirect`, options);
    assert.equal(hop.ok, true);
    const away = await safeGet(`${local.url}/away`, options);
    assert.equal(away.ok, false);
    const missing = await safeGet(`${local.url}/nope`, options);
    assert.equal(missing.ok, false);
    // Without allowPrivate the same server is refused outright.
    const refused = await safeGet(`${local.url}/ok`, { ...options, allowPrivate: false });
    assert.equal(refused.ok, false);
  } finally {
    await local.close();
  }
});
