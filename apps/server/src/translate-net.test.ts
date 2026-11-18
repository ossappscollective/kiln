import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTranslateUrl, createGuardedFetch } from './services/translate-net.ts';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const ok = (body: unknown = {}) => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), overflow: false });

test('checkTranslateUrl: https only, no credentials, no query, normalized', () => {
  const good = (raw: string, want: string, allowPrivate = false) => {
    const r = checkTranslateUrl(raw, { allowPrivate });
    assert.deepEqual(r, { ok: true, url: want }, raw);
  };
  good('https://libre.example.com', 'https://libre.example.com');
  good('https://libre.example.com/', 'https://libre.example.com');
  good(' https://libre.example.com/api// ', 'https://libre.example.com/api');
  good('https://libre.example.com:8443/api', 'https://libre.example.com:8443/api');
  for (const raw of [
    'http://libre.example.com',
    'ftp://libre.example.com',
    'https://user@libre.example.com',
    'https://user:pw@libre.example.com',
    'https://libre.example.com/?api_key=1',
    'https://libre.example.com/#x',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://192.168.0.1',
    'https://[::1]',
    'https://169.254.169.254',
    'https://metadata.google.internal',
    '',
    'libre.example.com',
  ]) {
    assert.equal(checkTranslateUrl(raw).ok, false, raw);
  }
});

test('checkTranslateUrl: with MRM_TRANSLATE_ALLOW_PRIVATE_URLS private and loopback pass, http only on loopback, metadata never', () => {
  const allow = { allowPrivate: true };
  for (const raw of ['https://10.0.0.1', 'https://192.168.1.5:5000', 'http://127.0.0.1:5000', 'http://localhost:5000', 'https://[::1]:5000']) {
    assert.equal(checkTranslateUrl(raw, allow).ok, true, raw);
  }
  for (const raw of ['http://10.0.0.1', 'http://192.168.1.5', 'https://169.254.169.254', 'http://169.254.169.254', 'https://100.100.100.200', 'https://[fd00:ec2::254]', 'https://[fe80::1]']) {
    assert.equal(checkTranslateUrl(raw, allow).ok, false, raw);
  }
});

test('guarded fetch: resolves, checks, pins the connection and never follows a redirect', async () => {
  const seen: { address: string; servername?: string | undefined; url: string }[] = [];
  const guard = createGuardedFetch({
    resolve: async () => PUBLIC,
    exchange: async (r) => {
      seen.push({ address: r.address, servername: r.servername, url: r.url.toString() });
      return { status: 302, headers: { location: 'http://169.254.169.254/' }, body: new Uint8Array(), overflow: false };
    },
  });
  const res = await guard.fetch('https://libre.example.com/translate', { method: 'POST', body: '{}' });
  assert.equal(res.status, 302, 'the redirect is the answer');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { address: '93.184.216.34', servername: 'libre.example.com', url: 'https://libre.example.com/translate' });
  assert.equal(guard.blocked(), undefined);
});

test('guarded fetch: refuses a private, loopback or metadata address at call time, and says why', async () => {
  for (const [address, allowPrivate] of [['10.0.0.5', false], ['127.0.0.1', false], ['169.254.169.254', true], ['100.100.100.200', true], ['fd00:ec2::254', true]] as const) {
    let sent = 0;
    const guard = createGuardedFetch({
      allowPrivate,
      resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      exchange: async () => {
        sent += 1;
        return ok();
      },
    });
    await assert.rejects(() => guard.fetch('https://libre.example.com/translate', { method: 'POST', body: '{}' }));
    assert.equal(sent, 0, address);
    assert.ok(guard.blocked(), address);
    assert.ok(!String(guard.blocked()).includes(address), 'the address is not named');
  }
  // A literal address is checked without a lookup; http is refused outside loopback.
  const guard = createGuardedFetch({ exchange: async () => ok() });
  await assert.rejects(() => guard.fetch('http://libre.example.com/translate'));
  await assert.rejects(() => guard.fetch('https://169.254.169.254/translate'));
  await assert.rejects(() => guard.fetch('https://user:pw@libre.example.com/translate'));
});

test('guarded fetch: a mixed answer with one private address is refused, an oversized answer throws, a timeout aborts', async () => {
  const mixed = createGuardedFetch({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], exchange: async () => ok() });
  await assert.rejects(() => mixed.fetch('https://libre.example.com/'));
  const big = createGuardedFetch({ resolve: async () => PUBLIC, exchange: async () => ({ ...ok(), overflow: true }) });
  await assert.rejects(() => big.fetch('https://libre.example.com/'));
  const slow = createGuardedFetch({
    resolve: async () => PUBLIC,
    timeoutMs: 20,
    exchange: (r) => new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(() => slow.fetch('https://libre.example.com/'));
});
