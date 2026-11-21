import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  checkWebhookUrl,
  classifyAddress,
  cleanResponseBody,
  expandIpv6,
  KEPT_RESPONSE_CHARS,
  MAX_RESPONSE_BYTES,
  type Resolver,
  resolveAllowed,
  sendPinned,
} from './services/webhook-transport.ts';

// ----- addresses ------------------------------------------------------------------------------

test('classifyAddress: public, private and blocked, in IPv4', () => {
  const cases: [string, string][] = [
    ['93.184.216.34', 'public'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['100.63.0.1', 'public'],
    ['127.0.0.1', 'private'],
    ['127.255.255.254', 'private'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.169.254', 'blocked'],
    ['169.254.0.1', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['0.1.2.3', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['239.255.255.255', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['240.0.0.1', 'blocked'],
  ];
  for (const [address, want] of cases) assert.equal(classifyAddress(address), want, address);
});

test('classifyAddress: IPv6, including the IPv4 forms that hide a private address', () => {
  const cases: [string, string][] = [
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['::1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['::', 'blocked'],
    ['fe80::1', 'blocked'],
    ['febf::1', 'blocked'],
    ['ff02::1', 'blocked'],
    // IPv4-mapped: judged as the IPv4 address inside.
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:10.1.2.3', 'private'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:a9fe:a9fe', 'blocked'],
    // Not global unicast.
    ['3fff:ffff::1', 'public'],
    ['1::1', 'blocked'],
    // NAT64 and 6to4 carry an IPv4 address: it is judged, not the wrapper.
    ['64:ff9b::7f00:1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'blocked'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'blocked'],
    ['2002:7f00:1::1', 'private'],
    ['2001:db8::1', 'blocked'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'blocked'],
    // Unique local is private, but AWS's metadata address inside it is never allowed.
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'blocked'],
  ];
  for (const [address, want] of cases) assert.equal(classifyAddress(address), want, address);
});

test('classifyAddress: anything that is not an address is blocked', () => {
  for (const text of [
    '',
    'example.com',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '0x7f.0.0.1',
    '2130706433',
    '::g',
    '[::1]',
  ]) {
    assert.equal(classifyAddress(text), 'blocked', text);
  }
});

test('expandIpv6 reads the compressed and the mixed forms, and rejects the broken ones', () => {
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    expandIpv6('2001:db8::ff00:42:8329'),
    [0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329],
  );
  assert.deepEqual(expandIpv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.equal(expandIpv6('1::2::3'), undefined);
  assert.equal(expandIpv6('1:2:3:4:5:6:7:8:9'), undefined);
  assert.equal(expandIpv6('12345::1'), undefined);
  assert.equal(expandIpv6('::ffff:1.2.3'), undefined);
});

// ----- URLs -----------------------------------------------------------------------------------

test('checkWebhookUrl accepts public https and refuses the rest', () => {
  assert.equal(checkWebhookUrl('https://hooks.example.com/kiln?x=1').ok, true);
  assert.equal(checkWebhookUrl('https://93.184.216.34/hook').ok, true);
  assert.equal(checkWebhookUrl('https://[2606:4700:4700::1111]/hook').ok, true);
  const refused = [
    'http://example.com/hook',
    'ftp://example.com/hook',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://localhost/hook',
    'https://app.localhost/hook',
    'https://printer.local/hook',
    'https://metadata.internal/hook',
    'https://intranet/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://192.168.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:a9fe:a9fe]/hook',
    'https://2130706433/hook',
    'https://0x7f.0.0.1/hook',
    'https://127.1/hook',
    `https://example.com/${'a'.repeat(2100)}`,
  ];
  for (const url of refused) assert.equal(checkWebhookUrl(url).ok, false, url);
});

test('checkWebhookUrl with allowPrivate: private hosts and http only for loopback, never link-local', () => {
  const allow = { allowPrivate: true };
  assert.equal(checkWebhookUrl('http://localhost:8080/hook', allow).ok, true);
  assert.equal(checkWebhookUrl('http://127.0.0.1:9000/hook', allow).ok, true);
  assert.equal(checkWebhookUrl('http://[::1]:9000/hook', allow).ok, true);
  assert.equal(checkWebhookUrl('https://10.0.0.5/hook', allow).ok, true);
  assert.equal(checkWebhookUrl('https://intranet/hook', allow).ok, true);
  assert.equal(
    checkWebhookUrl('http://10.0.0.5/hook', allow).ok,
    false,
    'plain http is for localhost only',
  );
  assert.equal(checkWebhookUrl('http://example.com/hook', allow).ok, false);
  assert.equal(checkWebhookUrl('https://169.254.169.254/hook', allow).ok, false);
  assert.equal(checkWebhookUrl('http://169.254.169.254/hook', allow).ok, false);
  assert.equal(checkWebhookUrl('https://0.0.0.0/hook', allow).ok, false);
  assert.equal(checkWebhookUrl('https://[fe80::1]/hook', allow).ok, false);
});

// ----- DNS ------------------------------------------------------------------------------------

const answering =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

function checked(url: string, allowPrivate = false) {
  const check = checkWebhookUrl(url, { allowPrivate });
  assert.equal(check.ok, true, url);
  return check as Extract<typeof check, { ok: true }>;
}

test('resolveAllowed: one bad answer refuses the host, even beside good ones (DNS rebinding)', async () => {
  const url = checked('https://hooks.example.com/x');
  assert.deepEqual(await resolveAllowed(url, { resolve: answering('93.184.216.34') }), {
    ok: true,
    address: '93.184.216.34',
    family: 4,
  });
  const mixed = await resolveAllowed(url, { resolve: answering('93.184.216.34', '10.0.0.1') });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.ok === false && mixed.transient, false);
  const metadata = await resolveAllowed(url, { resolve: answering('169.254.169.254') });
  assert.equal(metadata.ok, false);
  const mapped = await resolveAllowed(url, { resolve: answering('::ffff:127.0.0.1') });
  assert.equal(mapped.ok, false);
  // With allowPrivate, private answers pass but link-local never does.
  assert.equal(
    (await resolveAllowed(url, { allowPrivate: true, resolve: answering('10.0.0.1') })).ok,
    true,
  );
  assert.equal(
    (
      await resolveAllowed(url, {
        allowPrivate: true,
        resolve: answering('10.0.0.1', '169.254.169.254'),
      })
    ).ok,
    false,
  );
});

test('resolveAllowed: a DNS failure or an empty answer is transient; a literal needs no lookup', async () => {
  const url = checked('https://hooks.example.com/x');
  const failing = await resolveAllowed(url, {
    resolve: async () => {
      throw new Error('ENOTFOUND hooks.example.com');
    },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.ok === false && failing.transient, true);
  assert.equal(
    failing.ok === false && failing.message.includes('ENOTFOUND'),
    false,
    'the resolver error text is not passed on',
  );
  const empty = await resolveAllowed(url, { resolve: answering() });
  assert.equal(empty.ok === false && empty.transient, true);
  const literal = checked('https://93.184.216.34/x');
  const never: Resolver = async () => assert.fail('a literal must not be resolved');
  assert.deepEqual(await resolveAllowed(literal, { resolve: never }), {
    ok: true,
    address: '93.184.216.34',
    family: 4,
  });
});

// ----- sending, against a local server --------------------------------------------------------

type Seen = {
  method?: string | undefined;
  url?: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
};

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
  run: (port: number, seen: Seen[]) => Promise<void>,
) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sendPinned posts the body with the headers, to the pinned address, under the original Host', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('thanks');
    },
    async (port, seen) => {
      // The name resolves (by the injected resolver) to loopback; the name itself goes in Host.
      const out = await sendPinned(
        `http://localhost:${port}/hooks/in?x=1`,
        '{"a":1}',
        { 'content-type': 'application/json', 'x-kiln-event': 'app.synced' },
        { allowPrivate: true, resolve: answering('127.0.0.1') },
      );
      assert.deepEqual(out, { ok: true, status: 200, body: 'thanks' });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.method, 'POST');
      assert.equal(seen[0]?.url, '/hooks/in?x=1');
      assert.equal(seen[0]?.body, '{"a":1}');
      assert.equal(seen[0]?.headers['x-kiln-event'], 'app.synced');
      assert.equal(seen[0]?.headers.host, `localhost:${port}`);
      assert.equal(seen[0]?.headers['content-length'], '7');
    },
  );
});

test('sendPinned reports an error status as a result, and never follows a redirect', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/internal' });
        res.end();
      } else {
        res.writeHead(500);
        res.end('broken');
      }
    },
    async (port, seen) => {
      const options = { allowPrivate: true, resolve: answering('127.0.0.1') };
      const failed = await sendPinned(`http://localhost:${port}/x`, '{}', {}, options);
      assert.deepEqual(failed, { ok: true, status: 500, body: 'broken' });
      const moved = await sendPinned(`http://localhost:${port}/moved`, '{}', {}, options);
      assert.equal(moved.ok && moved.status, 302);
      assert.equal(seen.length, 2, 'the redirect target was not requested');
    },
  );
});

test('sendPinned refuses a private answer without allowPrivate, before any connection is made', async () => {
  await withServer(
    (_req, res) => res.end('x'),
    async (port, seen) => {
      const viaDns = await sendPinned(
        `https://hooks.example.com:${port}/x`,
        '{}',
        {},
        { resolve: answering('127.0.0.1') },
      );
      assert.equal(viaDns.ok, false);
      assert.equal(viaDns.ok === false && viaDns.kind, 'blocked');
      assert.equal(viaDns.ok === false && viaDns.transient, false);
      const literal = await sendPinned(`https://127.0.0.1:${port}/x`, '{}', {});
      assert.equal(literal.ok === false && literal.kind, 'blocked');
      const http = await sendPinned(`http://127.0.0.1:${port}/x`, '{}', {});
      assert.equal(http.ok === false && http.kind, 'blocked');
      const rebinding = await sendPinned(
        `http://localhost:${port}/x`,
        '{}',
        {},
        { allowPrivate: true, resolve: answering('127.0.0.1', '169.254.169.254') },
      );
      assert.equal(rebinding.ok === false && rebinding.kind, 'blocked');
      assert.equal(seen.length, 0, 'nothing was sent');
    },
  );
});

test('sendPinned times out on a receiver that does not answer, and says so without internals', async () => {
  await withServer(
    () => {
      // never answers
    },
    async (port) => {
      const started = Date.now();
      const out = await sendPinned(
        `http://localhost:${port}/x`,
        '{}',
        {},
        { allowPrivate: true, resolve: answering('127.0.0.1'), timeoutMs: 150 },
      );
      assert.ok(Date.now() - started < 3000);
      assert.equal(out.ok, false);
      assert.equal(out.ok === false && out.kind, 'timeout');
      assert.equal(out.ok === false && out.transient, true);
    },
  );
});

test('sendPinned: a refused connection is a transient network failure that leaks no address', async () => {
  // Find a port nothing listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const out = await sendPinned(
    `http://localhost:${port}/x`,
    '{}',
    {},
    { allowPrivate: true, resolve: answering('127.0.0.1'), timeoutMs: 2000 },
  );
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.kind, 'network');
  assert.equal(out.ok === false && out.transient, true);
  assert.equal(out.ok === false && /127\.0\.0\.1|ECONN/.test(out.message), false);
});

test('sendPinned stops reading a huge response', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 'a');
      let sent = 0;
      const pump = () => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    },
    async (port) => {
      const out = await sendPinned(
        `http://localhost:${port}/x`,
        '{}',
        {},
        { allowPrivate: true, resolve: answering('127.0.0.1'), timeoutMs: 5000 },
      );
      assert.equal(out.ok && out.status, 200);
      assert.ok(out.ok && out.body.length <= MAX_RESPONSE_BYTES, 'the body is capped');
    },
  );
});

// ----- response text --------------------------------------------------------------------------

test('cleanResponseBody keeps printable text, shortens it and removes secrets', () => {
  assert.equal(cleanResponseBody('ok\u0000\u0007\u001b[31m red'), 'ok[31m red');
  assert.equal(cleanResponseBody('line one\nline two\ttab'), 'line one\nline two\ttab');
  assert.equal(cleanResponseBody('x'.repeat(5000)).length, KEPT_RESPONSE_CHARS);
  assert.equal(
    cleanResponseBody('echo whsec_abcdefghijkl back', ['whsec_abcdefghijkl']),
    'echo [redacted] back',
  );
  // Too short to be a secret: left alone rather than shredding the text.
  assert.equal(cleanResponseBody('abc def', ['abc']), 'abc def');
});
