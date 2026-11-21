import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSecret } from '@kiln/core';
import * as fx from './store.fixtures.ts';
import { verifyAppStoreConnectCredential, verifyGooglePlayCredential } from './verify-store.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const apple = fx.appleKeyPem();
const google = fx.googleKeyPem();

const ascSecret = (over: Record<string, string> = {}) =>
  buildSecret('app_store_connect', {
    keyId: fx.KEY_ID,
    issuerId: fx.ISSUER_ID,
    privateKey: apple.privateKey,
    ...over,
  });
const playSecret = () =>
  buildSecret('google_play', { serviceAccount: fx.serviceAccountJson(google.privateKey) });

function everything(result: { message: string; details?: string[] | undefined }): string {
  return [result.message, ...(result.details ?? [])].join('\n');
}

function assertClean(result: { message: string; details?: string[] | undefined }, secret: string) {
  const text = everything(result);
  assert.ok(!text.includes('PRIVATE KEY'));
  assert.ok(!text.includes(secret.trim()), 'not the whole secret');
  // No line of the private key, whichever field it is in (privateKey for Apple, private_key for Google).
  const parsed = (() => {
    try {
      return JSON.parse(secret) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  for (const pem of [parsed.privateKey, parsed.private_key]) {
    if (typeof pem !== 'string') continue;
    for (const line of pem.split('\n')) {
      if (line.length >= 8 && !line.startsWith('-----'))
        assert.ok(!text.includes(line), 'no key line');
    }
  }
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
  assert.ok(!text.includes('ya29.'));
}

const opts = (fake: fx.FakeFetch) => ({ fetch: fake.fetch, now: () => T0 });

// ---------------------------------------------------------------------------------------------
// App Store Connect

test('ASC: a working key is ok, with the app count and what was not checked', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    json: fx.appleAppsOne,
  });
  const result = await verifyAppStoreConnectCredential(ascSecret(), opts(fake));
  assert.equal(result.ok, true);
  assert.match(result.message, /can see 431 apps/);
  assert.ok(result.details?.some((d) => /Apps visible to this key: 431/.test(d)));
  assert.ok(result.details?.some((d) => /Not checked: the key's role/.test(d)));
  assert.equal(fake.calls.length, 1, 'one request');
  assert.equal(fake.calls[0]?.method, 'GET');
  assertClean(result, ascSecret());
});

test('ASC: a key that sees no apps is ok, and says so', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    json: fx.appleAppsEmpty,
  });
  const result = await verifyAppStoreConnectCredential(ascSecret(), opts(fake));
  assert.equal(result.ok, true);
  assert.match(result.message, /no apps yet/);
});

test('ASC: 401 is a wrong key or issuer, with format hints when the values look odd', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    status: 401,
    json: fx.apple401,
  });
  const secret = ascSecret({ keyId: 'abc', issuerId: 'not-a-uuid' });
  const result = await verifyAppStoreConnectCredential(secret, opts(fake));
  assert.equal(result.ok, false);
  assert.match(result.message, /Key ID.*Issuer ID.*do not belong together/s);
  assert.deepEqual(result.details, [
    'The Key ID does not look like 10 letters and digits.',
    'The Issuer ID does not look like a UUID.',
  ]);
  assertClean(result, secret);
});

test('ASC: 401 with a skewed clock is reported as clock skew', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    status: 401,
    json: fx.apple401,
    headers: { date: new Date(T0 + 3600_000).toUTCString() },
  });
  const result = await verifyAppStoreConnectCredential(ascSecret(), opts(fake));
  assert.equal(result.ok, false);
  assert.match(result.message, /clock differs from Apple's by about 3600 seconds \(behind\)/);
  assert.equal(result.details, undefined, 'no format hints for a well-formed key');
});

test('ASC: 403 is a role or revoked key', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    status: 403,
    json: fx.apple403,
  });
  const result = await verifyAppStoreConnectCredential(ascSecret(), opts(fake));
  assert.equal(result.ok, false);
  assert.match(result.message, /role/);
  assert.match(result.message, /revoked/);
});

test('ASC: 429, 5xx, malformed JSON and network failure each have their own message', async () => {
  const cases: [Partial<fx.Route>, RegExp][] = [
    [
      { status: 429, json: fx.apple429, headers: { 'retry-after': '30' } },
      /rate limit.*30 seconds/i,
    ],
    [{ status: 502, raw: 'bad gateway' }, /failed.*502/],
    [{ status: 200, raw: '<html>' }, /could not be read/],
    [{ throws: new Error('boom') }, /Could not reach api\.appstoreconnect\.apple\.com/],
  ];
  for (const [route, pattern] of cases) {
    const fake = new fx.FakeFetch().on({ method: 'GET', match: '/v1/apps?limit=1', ...route });
    const result = await verifyAppStoreConnectCredential(ascSecret(), opts(fake));
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
    assert.equal(fake.calls.length, 1, 'verification does not retry a 429');
  }
});

test('ASC: malformed secrets are caught before any request', async () => {
  const fake = new fx.FakeFetch();
  const cases: [string, RegExp][] = [
    ['not json', /could not be read/],
    [JSON.stringify({ keyId: '', issuerId: fx.ISSUER_ID, privateKey: apple.privateKey }), /Key ID/],
    [
      ascSecret({ privateKey: '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----' }),
      /\.p8/,
    ],
    [ascSecret({ privateKey: google.privateKey }), /P-256/],
  ];
  for (const [secret, pattern] of cases) {
    const result = await verifyAppStoreConnectCredential(secret, opts(fake));
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
    assertClean(result, secret);
  }
  assert.equal(fake.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Google Play

const PROBE = '/androidpublisher/v3/applications/com.example.mrm.credentialcheck/edits';
const PKG = 'com.example.coffee';
const PKG_EDITS = `/androidpublisher/v3/applications/${PKG}/edits`;

function playFake() {
  return new fx.FakeFetch().on({ method: 'POST', match: '/token', json: fx.googleToken });
}

test('Play: with a package, the key, the API and access to the app are proven, and the edit is deleted', async () => {
  const fake = playFake()
    .on({ method: 'POST', match: PKG_EDITS, json: fx.googleEdit })
    .on({ method: 'DELETE', match: `${PKG_EDITS}/${fx.googleEdit.id}`, json: {} });
  const result = await verifyGooglePlayCredential(playSecret(), {
    ...opts(fake),
    packageName: PKG,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /can open an edit for com\.example\.coffee/);
  assert.match(result.message, /deleted without any change/);
  assert.ok(result.details?.includes(`Service account: ${fx.SA_EMAIL}`));
  assert.ok(result.details?.some((d) => /Not checked: which permissions/.test(d)));
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['POST', 'POST', 'DELETE'],
  );
  assertClean(result, playSecret());
});

test('Play: without a package it says plainly what is not proven', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PROBE,
    status: 404,
    json: fx.google404Package,
  });
  const result = await verifyGooglePlayCredential(playSecret(), opts(fake));
  assert.equal(result.ok, true);
  assert.match(result.message, /Access to your apps is not proven/);
  assert.match(result.message, /no call that lists apps/);
  assert.ok(
    result.details?.some((d) => /Not checked: that this service account was invited/.test(d)),
  );
  // Only the token and one rejected edit insert: nothing to delete, nothing read.
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['POST', 'POST'],
  );
});

test('Play: a 403 for the probe package also means "API reachable, access unknown"', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PROBE,
    status: 403,
    json: fx.google403Forbidden,
  });
  const result = await verifyGooglePlayCredential(playSecret(), opts(fake));
  assert.equal(result.ok, true);
  assert.match(result.message, /not proven/);
});

test('Play: the API not being enabled is a failure that names the fix', async () => {
  for (const packageName of [undefined, PKG]) {
    const fake = playFake()
      .on({ method: 'POST', match: PROBE, status: 403, json: fx.google403Disabled })
      .on({ method: 'POST', match: PKG_EDITS, status: 403, json: fx.google403Disabled });
    const result = await verifyGooglePlayCredential(playSecret(), {
      ...opts(fake),
      ...(packageName ? { packageName } : {}),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /not enabled in the Google Cloud project/);
    assert.ok(result.details?.includes('Cloud project: my-project-123'));
  }
});

test('Play: with a package, no permission means the account was not invited for that app', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PKG_EDITS,
    status: 403,
    json: fx.google403Forbidden,
  });
  const result = await verifyGooglePlayCredential(playSecret(), {
    ...opts(fake),
    packageName: PKG,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /no access to com\.example\.coffee/);
  assert.match(result.message, /Users and permissions/);
});

test('Play: with a package, 404 means the app is not visible', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PKG_EDITS,
    status: 404,
    json: fx.google404Package,
  });
  const result = await verifyGooglePlayCredential(playSecret(), {
    ...opts(fake),
    packageName: PKG,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /no app com\.example\.coffee/);
});

test('Play: projectNotLinked is a failure, not a pass, even for the probe', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PROBE,
    status: 403,
    json: fx.google403NotLinked,
  });
  const result = await verifyGooglePlayCredential(playSecret(), opts(fake));
  assert.equal(result.ok, false);
  assert.match(result.message, /not linked/);
});

test('Play: invalid_grant from the token endpoint, with clock skew and without', async () => {
  const skew = new fx.FakeFetch().on({
    method: 'POST',
    match: '/token',
    status: 400,
    json: fx.googleTokenErrors.clock,
    headers: { date: new Date(T0 - 600_000).toUTCString() },
  });
  const a = await verifyGooglePlayCredential(playSecret(), opts(skew));
  assert.equal(a.ok, false);
  assert.match(a.message, /about 600 seconds \(ahead\)/);
  assert.match(a.message, /clock/);
  assert.equal(skew.calls.length, 1, 'no Play request after a failed token exchange');

  const sig = new fx.FakeFetch().on({
    method: 'POST',
    match: '/token',
    status: 400,
    json: fx.googleTokenErrors.signature,
  });
  const b = await verifyGooglePlayCredential(playSecret(), opts(sig));
  assert.equal(b.ok, false);
  assert.match(b.message, /deleted or disabled/);
  assertClean(b, playSecret());
});

test('Play: bad secrets and package names are caught before any request', async () => {
  const fake = new fx.FakeFetch();
  const json = JSON.parse(fx.serviceAccountJson(google.privateKey));
  const cases: [string, string | undefined, RegExp][] = [
    ['nope', undefined, /not valid JSON/],
    [JSON.stringify({ ...json, client_email: '' }), undefined, /client_email/],
    [
      JSON.stringify({
        ...json,
        private_key: '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----',
      }),
      undefined,
      /could not be read/,
    ],
    [fx.serviceAccountJson(google.privateKey), '../x', /not a valid Android package name/],
  ];
  for (const [secret, packageName, pattern] of cases) {
    const result = await verifyGooglePlayCredential(secret, {
      ...opts(fake),
      ...(packageName ? { packageName } : {}),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
    assertClean(result, secret);
  }
  assert.equal(fake.calls.length, 0);
});

test('Play: a hostile error body cannot smuggle the token or key into the result', async () => {
  const fake = playFake().on({
    method: 'POST',
    match: PKG_EDITS,
    status: 400,
    json: { error: { code: 400, message: `${fx.ACCESS_TOKEN} ${google.privateKey}` } },
  });
  const result = await verifyGooglePlayCredential(playSecret(), {
    ...opts(fake),
    packageName: PKG,
  });
  assert.equal(result.ok, false);
  assertClean(result, playSecret());
  assert.ok(!everything(result).includes(fx.ACCESS_TOKEN));
});

test('both verifiers never throw, whatever fetch does', async () => {
  const throwing: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const a = await verifyAppStoreConnectCredential(ascSecret(), { fetch: throwing, now: () => T0 });
  const b = await verifyGooglePlayCredential(playSecret(), { fetch: throwing, now: () => T0 });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.match(a.message, /Could not reach/);
  assert.match(b.message, /Could not reach/);
});
