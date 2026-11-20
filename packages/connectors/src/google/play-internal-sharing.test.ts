import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import {
  InternalSharingOutcomeUnknownError,
  PlayInternalSharingConnector,
} from './play-internal-sharing.ts';

const key = fx.googleKeyPem();
const PKG = 'com.example.coffee';
const LINK = 'https://play.google.com/apps/test/com.example.coffee/241?token=SECRETLINK123';
const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Seen = { method: string; url: string; headers: Record<string, string>; bytes: number };

function setup(answer: (n: number) => Response | Error) {
  const seen: Seen[] = [];
  let uploads = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/token')) return json(200, fx.googleToken);
    const body = init?.body as Uint8Array | undefined;
    seen.push({
      method,
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      bytes: body?.byteLength ?? 0,
    });
    const out = answer(++uploads);
    if (out instanceof Error) throw out;
    return out;
  };
  const connector = new PlayInternalSharingConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packageName: PKG,
    fetch: fetchFake,
    sleep: async () => undefined,
  });
  return { connector, seen };
}

const bytes = new Uint8Array([1, 2, 3, 4]);
const good = () =>
  json(200, { downloadUrl: LINK, certificateFingerprint: 'AA:BB', sha256: 'A'.repeat(64) });

test('an app bundle is one POST to the internal app sharing upload endpoint, as media, with the bearer token; the link comes back', async () => {
  const { connector, seen } = setup(good);
  const done = await connector.upload('bundle', bytes);
  assert.deepEqual(done, {
    downloadUrl: LINK,
    certificateFingerprint: 'AA:BB',
    sha256: 'a'.repeat(64),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(
    seen[0]?.url,
    `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/internalappsharing/${PKG}/artifacts/bundle?uploadType=media`,
  );
  assert.equal(seen[0]?.headers['content-type'], 'application/octet-stream');
  assert.equal(seen[0]?.headers.authorization, `Bearer ${fx.ACCESS_TOKEN}`);
  assert.equal(seen[0]?.bytes, 4);
});

test('an APK goes to .../artifacts/apk; an empty file is refused before any request', async () => {
  const { connector, seen } = setup(good);
  await connector.upload('apk', bytes);
  assert.match(
    seen[0]?.url ?? '',
    /\/internalappsharing\/com\.example\.coffee\/artifacts\/apk\?uploadType=media$/,
  );
  await assert.rejects(
    () => connector.upload('apk', new Uint8Array()),
    (e) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  assert.equal(seen.length, 1);
});

test('a missing or odd link, or a missing fingerprint, is handled: no link is an unknown outcome, an odd fingerprint or hash is dropped', async () => {
  for (const body of [
    {},
    { downloadUrl: 'http://insecure.example/x' },
    { downloadUrl: 'not a url' },
    { downloadUrl: `https://x.example/${'a'.repeat(3000)}` },
  ]) {
    const { connector } = setup(() => json(200, body));
    await assert.rejects(
      () => connector.upload('bundle', bytes),
      (e) => e instanceof InternalSharingOutcomeUnknownError,
    );
  }
  const { connector: malformed } = setup(() => new Response('<html>', { status: 200 }));
  await assert.rejects(
    () => malformed.upload('bundle', bytes),
    (e) => e instanceof InternalSharingOutcomeUnknownError,
  );
  const { connector } = setup(() => json(200, { downloadUrl: LINK, sha256: 'not hex' }));
  assert.deepEqual(await connector.upload('bundle', bytes), {
    downloadUrl: LINK,
    certificateFingerprint: null,
    sha256: null,
  });
});

test('an upload is never sent twice: a 5xx, a cut connection and a timeout are unknown outcomes', async () => {
  for (const answer of [
    () => json(503),
    () => json(500, { error: { message: 'x' } }),
    () => new TypeError('fetch failed'),
    () => Object.assign(new Error('t'), { name: 'TimeoutError' }),
  ]) {
    let calls = 0;
    const { connector, seen } = setup((n) => {
      calls = n;
      return answer();
    });
    await assert.rejects(
      () => connector.upload('bundle', bytes),
      (e) => e instanceof InternalSharingOutcomeUnknownError && !e.message.includes(LINK),
    );
    assert.equal(calls, 1);
    assert.equal(seen.length, 1);
  }
});

test('a 401 gets one new token and one more try (Google looked at nothing); a second 401 is an auth error', async () => {
  const { connector, seen } = setup((n) =>
    n === 1 ? json(401, { error: { message: 'expired' } }) : good(),
  );
  assert.equal((await connector.upload('bundle', bytes)).downloadUrl, LINK);
  assert.equal(seen.length, 2);
  const { connector: stuck } = setup(() => json(401, { error: { message: 'no' } }));
  await assert.rejects(
    () => stuck.upload('bundle', bytes),
    (e) => e instanceof StoreError && e.kind === 'auth',
  );
});

test('the refusals have a vocabulary: 400, 403, 404, 413 and 429; nothing is retried and no message has the key or the token', async () => {
  const cases: [number, unknown, string][] = [
    [400, { error: { message: 'Invalid bundle' } }, 'invalid_input'],
    [403, { error: { message: 'The caller does not have permission' } }, 'forbidden'],
    [404, { error: { message: 'Package not found: com.example.coffee' } }, 'not_found'],
    [413, {}, 'too_large'],
  ];
  for (const [status, body, kind] of cases) {
    const { connector, seen } = setup(() => json(status, body));
    await assert.rejects(
      () => connector.upload('bundle', bytes),
      (e) => {
        assert.ok(e instanceof StoreError, String(status));
        assert.equal(e.kind, kind, String(status));
        assert.ok(!(e instanceof InternalSharingOutcomeUnknownError));
        assert.ok(!e.message.includes(fx.ACCESS_TOKEN) && !e.message.includes('PRIVATE KEY'));
        return true;
      },
    );
    assert.equal(seen.length, 1, `${status} is not retried`);
  }
  const { connector, seen } = setup(() =>
    json(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }),
  );
  await assert.rejects(
    () => connector.upload('bundle', bytes),
    (e) => e instanceof StoreRateLimitError,
  );
  assert.equal(seen.length, 1, 'a 429 is not waited out and sent again: the write is sent once');
});

test('a package name that is not one is refused when the connector is built', () => {
  assert.throws(
    () =>
      new PlayInternalSharingConnector({
        serviceAccount: fx.serviceAccountJson(key.privateKey),
        packageName: '../x',
      }),
    (e) => e instanceof StoreError && e.kind === 'invalid_input',
  );
});
