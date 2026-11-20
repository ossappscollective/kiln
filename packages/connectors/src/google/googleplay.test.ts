import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { test } from 'node:test';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { StoreHttp } from '../store-http.ts';
import { GoogleTokenProvider, parseServiceAccount } from './google-auth.ts';
import { GooglePlayConnector } from './googleplay.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.googleKeyPem();
const PKG = 'com.example.coffee';
const TOKEN_PATH = '/token';
const EDITS = `/androidpublisher/v3/applications/${PKG}/edits`;
const EDIT = `${EDITS}/${fx.googleEdit.id}`;

function setup(packages: string[] = [PKG], extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = new fx.FakeFetch();
  const clock = { now: T0 };
  fake
    .on({ method: 'POST', match: TOKEN_PATH, json: fx.googleToken })
    .on({ method: 'POST', match: EDITS, json: fx.googleEdit })
    .on({ method: 'DELETE', match: EDIT, json: {} });
  const connector = new GooglePlayConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packages,
    fetch: fake.fetch,
    now: () => clock.now,
    sleep: extra.sleep ?? (async () => undefined),
  });
  return { fake, clock, connector };
}

const auth = (call: fx.Call) => call.headers.get('authorization') ?? '';

function assertNoSecrets(error: unknown, fake: fx.FakeFetch) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'));
  for (const line of key.privateKey.split('\n')) {
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line));
  }
  assert.ok(!text.includes(fx.ACCESS_TOKEN), 'no access token');
  assert.ok(!text.includes('ya29.'), 'no access token shape');
  for (const call of fake.calls) {
    const body = call.body ?? '';
    const assertion = /assertion=([^&]+)/.exec(body)?.[1];
    if (assertion) assert.ok(!text.includes(decodeURIComponent(assertion)), 'no JWT assertion');
  }
}

// ---------------------------------------------------------------------------------------------
// Authentication

// The token endpoint is https://oauth2.googleapis.com/token, which is a different host from the
// API; the fake matches on path only, so /token is the token request.

test('the token request is a JWT bearer grant signed RS256 with the androidpublisher scope', async () => {
  const { fake, connector } = setup();
  await connector.checkToken();
  const call = fake.calls[0] as fx.Call;
  assert.equal(call.url.origin, 'https://oauth2.googleapis.com');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = fx.decodeJwt(form.get('assertion') ?? '');
  assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT', kid: 'abcdef0123456789' });
  assert.equal(jwt.payload.iss, fx.SA_EMAIL);
  assert.equal(jwt.payload.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.equal(jwt.payload.aud, 'https://oauth2.googleapis.com/token');
  const iat = jwt.payload.iat as number;
  assert.equal(iat, T0 / 1000);
  assert.ok((jwt.payload.exp as number) - iat <= 3600, 'Google allows one hour at most');
  assert.ok(verify('RSA-SHA256', Buffer.from(jwt.signingInput), key.publicKey, jwt.signature));
});

test('the access token is cached and renewed a minute before it expires', async () => {
  const { fake, clock, connector } = setup();
  await connector.checkToken();
  await connector.checkToken();
  assert.equal(fake.called('POST', TOKEN_PATH).length, 1);
  clock.now = T0 + (3599 - 61) * 1000;
  await connector.checkToken();
  assert.equal(fake.called('POST', TOKEN_PATH).length, 1);
  clock.now = T0 + (3599 - 59) * 1000;
  await connector.checkToken();
  assert.equal(fake.called('POST', TOKEN_PATH).length, 2);
});

test('concurrent calls share one token request', async () => {
  const { fake, connector } = setup();
  await Promise.all([connector.checkToken(), connector.checkToken(), connector.checkToken()]);
  assert.equal(fake.called('POST', TOKEN_PATH).length, 1);
});

const tokenFailures: [keyof typeof fx.googleTokenErrors, string, RegExp][] = [
  ['clock', 'clock_skew', /time.*invalid_grant.*NTP/s],
  ['signature', 'auth', /key.*deleted or disabled/s],
  ['email', 'auth', /does not know this service account/],
  ['generic', 'auth', /invalid_grant/],
  ['scope', 'auth', /androidpublisher scope/],
];

for (const [name, kind, pattern] of tokenFailures) {
  test(`token exchange failure: ${name} is ${kind}`, async () => {
    const { fake, connector } = setup();
    fake
      .clear('POST', TOKEN_PATH)
      .on({ method: 'POST', match: TOKEN_PATH, status: 400, json: fx.googleTokenErrors[name] });
    await assert.rejects(connector.checkToken(), (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, kind);
      assert.match(e.message, pattern);
      assertNoSecrets(e, fake);
      return true;
    });
  });
}

test('clock skew is quantified from the Date header', async () => {
  const { fake, connector } = setup();
  fake.clear('POST', TOKEN_PATH).on({
    method: 'POST',
    match: TOKEN_PATH,
    status: 400,
    json: fx.googleTokenErrors.clock,
    headers: { date: new Date(T0 + 2 * 3600_000).toUTCString() },
  });
  await assert.rejects(connector.checkToken(), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.match(e.message, /about 7200 seconds \(behind\)/);
    return true;
  });
});

test('a token response without access_token, or a malformed one, is unexpected', async () => {
  for (const route of [{ json: { token_type: 'Bearer' } }, { raw: '<html>' }]) {
    const { fake, connector } = setup();
    fake.clear('POST', TOKEN_PATH).on({ method: 'POST', match: TOKEN_PATH, ...route });
    await assert.rejects(
      connector.checkToken(),
      (e: unknown) => e instanceof StoreError && e.kind === 'unexpected',
    );
  }
});

test('the key is checked when the connector is built, without echoing it', () => {
  const json = JSON.parse(fx.serviceAccountJson(key.privateKey));
  json.private_key =
    '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5IGF0IGFsbA==\n-----END PRIVATE KEY-----\n';
  assert.throws(
    () => new GooglePlayConnector({ serviceAccount: JSON.stringify(json), packages: [] }),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'invalid_input');
      assert.ok(!e.message.includes('bm90IGEga2V5'));
      return true;
    },
  );
  assert.throws(
    () => parseServiceAccount('nope'),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  const ec = fx.appleKeyPem().privateKey;
  const wrongType = JSON.stringify({ ...json, private_key: ec });
  assert.throws(
    () =>
      new GoogleTokenProvider(
        parseServiceAccount(wrongType),
        new StoreHttp({ store: 'googleplay' }),
      ),
    (e: unknown) => e instanceof StoreError && /not an RSA key/.test(e.message),
  );
});

test('package names are validated before they reach a URL', () => {
  for (const bad of [
    '',
    'nodots',
    '../etc/passwd',
    'com.example/../x',
    'com.example.1abc',
    'a b.c',
  ]) {
    assert.throws(
      () =>
        new GooglePlayConnector({
          serviceAccount: fx.serviceAccountJson(key.privateKey),
          packages: [bad],
        }),
      (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
      bad,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Reads inside an edit

test('an edit is opened, read, and deleted again, and never committed', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  await connector.listTracks(PKG);
  const sequence = fake.calls
    .filter((c) => c.url.host !== 'oauth2.googleapis.com')
    .map((c) => `${c.method} ${c.url.pathname}`);
  assert.deepEqual(sequence, [`POST ${EDITS}`, `GET ${EDIT}/tracks`, `DELETE ${EDIT}`]);
  assert.ok(
    fake.calls.every((c) => !c.url.pathname.includes(':commit')),
    'no commit',
  );
  assert.ok(
    fake.calls.every(
      (c) =>
        c.method === 'GET' ||
        c.method === 'DELETE' ||
        c.url.pathname === EDITS ||
        c.url.host === 'oauth2.googleapis.com',
    ),
  );
  assert.equal(auth(fake.calls[1] as fx.Call), `Bearer ${fx.ACCESS_TOKEN}`);
});

test('the edit is deleted even when the read fails', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, status: 500, raw: 'oops' });
  await assert.rejects(
    connector.listTracks(PKG),
    (e: unknown) => e instanceof StoreError && e.kind === 'server',
  );
  assert.equal(fake.called('DELETE', EDIT).length, 1);
});

test('a failure to delete the edit does not fail the read', async () => {
  const { fake, connector } = setup();
  fake.clear('DELETE', EDIT).on({ method: 'DELETE', match: EDIT, status: 500, raw: 'oops' });
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  assert.equal((await connector.listTracks(PKG)).length, 6);
});

test('listVersions maps each release on each track', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  const versions = await connector.listVersions(PKG);
  assert.deepEqual(
    versions.map((v) => [
      v.track,
      v.versionString,
      v.rawState,
      v.lifecycleState,
      v.rolloutFraction,
      v.versionCodes?.join('+'),
    ]),
    [
      ['internal', '2.1.0 (211)', 'completed', 'live', undefined, '211'],
      ['beta', '2.1.0 (211)', 'draft', 'draft', undefined, '211'],
      ['production', '2.1.0', 'inProgress', 'rolling_out', 0.2, '211'],
      ['production', '2.0.0', 'completed', 'live', undefined, '200+201'],
      ['alpha', 'halted one', 'halted', 'halted', 0.5, '150'],
      ['qa', '9', 'statusUnspecified', undefined, undefined, '9'],
    ],
  );
  assert.ok(versions.every((v) => v.platform === 'android' && v.appStoreId === PKG));
  assert.ok(!('lifecycleState' in (versions[5] as object)), 'an unknown status is not guessed');
});

test('listBuilds lists bundles and APKs by version code, newest first', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${EDIT}/bundles`, json: fx.googleBundles })
    .on({ method: 'GET', match: `${EDIT}/apks`, json: fx.googleApks });
  const builds = await connector.listBuilds(PKG);
  assert.deepEqual(
    builds.map((b) => [b.storeId, b.buildNumber, b.processing, b.platform]),
    [
      ['aab:211', '211', 'processed', 'android'],
      ['aab:200', '200', 'processed', 'android'],
      ['apk:150', '150', 'processed', 'android'],
    ],
  );
  assert.equal(fake.called('POST', EDITS).length, 1, 'both lists are read in one edit');
});

test('listApps reads each configured package: the title comes from the default-language listing', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${EDIT}/details`, json: fx.googleDetails })
    .on({ method: 'GET', match: `${EDIT}/listings`, json: fx.googleListings });
  assert.deepEqual(await connector.listApps(), [
    { storeId: PKG, platform: 'android', name: 'Coffee', bundleId: PKG },
  ]);
});

test('listApps falls back to the package name without a listing, and an empty list reads nothing', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${EDIT}/details`, json: {} })
    .on({ method: 'GET', match: `${EDIT}/listings`, json: { listings: [] } });
  assert.equal((await connector.listApps())[0]?.name, PKG);
  const none = setup([]);
  assert.deepEqual(await none.connector.listApps(), []);
  assert.equal(none.fake.calls.length, 0);
});

test('edits of one service account never overlap', async () => {
  const { fake, connector } = setup();
  const open: string[] = [];
  let maxOpen = 0;
  fake.clear('POST', EDITS).clear('DELETE', EDIT);
  const orig = fake.fetch;
  let active = 0;
  const wrapped: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(input)).pathname;
    if (method === 'POST' && path === EDITS) {
      active++;
      maxOpen = Math.max(maxOpen, active);
      open.push('open');
    }
    if (method === 'DELETE' && path === EDIT) active--;
    await new Promise((r) => setTimeout(r, 5));
    return orig(input, init);
  };
  fake
    .on({ method: 'POST', match: EDITS, json: fx.googleEdit })
    .on({ method: 'DELETE', match: EDIT, json: {} })
    .on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  const second = new GooglePlayConnector({
    serviceAccount: fx.serviceAccountJson(key.privateKey),
    packages: [PKG],
    fetch: wrapped,
    now: () => T0,
  });
  await Promise.all([second.listTracks(PKG), second.listTracks(PKG), second.listTracks(PKG)]);
  assert.equal(open.length, 3);
  assert.equal(maxOpen, 1);
  void connector;
});

test('an edit that is invalidated mid-read is retried once with a new edit', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${EDIT}/tracks`, status: 404, json: fx.google404Edit, times: 1 })
    .on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  assert.equal((await connector.listTracks(PKG)).length, 6);
  assert.equal(fake.called('POST', EDITS).length, 2);
  assert.equal(fake.called('DELETE', EDIT).length, 2);
});

test('an edit that keeps being invalidated gives up', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: `${EDIT}/tracks`, status: 404, json: fx.google404Edit });
  await assert.rejects(
    connector.listTracks(PKG),
    (e: unknown) => e instanceof StoreError && e.kind === 'edit_invalid',
  );
  assert.equal(fake.called('POST', EDITS).length, 2);
});

test('a 401 on a cached token mints a new token once and retries', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: `${EDIT}/tracks`, status: 401, json: fx.google401, times: 1 })
    .on({ method: 'GET', match: `${EDIT}/tracks`, json: fx.googleTracks });
  assert.equal((await connector.listTracks(PKG)).length, 6);
  assert.equal(fake.called('POST', TOKEN_PATH).length, 2);
});

// ---------------------------------------------------------------------------------------------
// Errors

async function failure(
  route: Partial<fx.Route> & { status: number },
  run: (c: GooglePlayConnector) => Promise<unknown>,
) {
  const { fake, connector } = setup();
  fake.clear('POST', EDITS).on({ method: 'POST', match: EDITS, ...route });
  let caught: unknown;
  try {
    await run(connector);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StoreError, `expected a StoreError, got ${String(caught)}`);
  assertNoSecrets(caught, fake);
  return caught;
}

test('403 with the API disabled is api_disabled and names the project', async () => {
  const e = await failure({ status: 403, json: fx.google403Disabled }, (c) => c.probeEdit(PKG));
  assert.equal(e.kind, 'api_disabled');
  assert.match(e.message, /not enabled/);
  assert.match(e.message, /my-project-123/);
});

test('403 without permission says to invite the service account', async () => {
  const e = await failure({ status: 403, json: fx.google403Forbidden }, (c) => c.probeEdit(PKG));
  assert.equal(e.kind, 'forbidden');
  assert.match(e.message, /Users and permissions/);
  assert.match(e.message, new RegExp(PKG.replace(/\./g, '\\.')));
});

test('403 projectNotLinked says to link the project', async () => {
  const e = await failure({ status: 403, json: fx.google403NotLinked }, (c) => c.probeEdit(PKG));
  assert.equal(e.kind, 'forbidden');
  assert.match(e.message, /not linked/);
});

test('404 package not found is not_found', async () => {
  const e = await failure({ status: 404, json: fx.google404Package }, (c) => c.probeEdit(PKG));
  assert.equal(e.kind, 'not_found');
  assert.match(e.message, /at least one uploaded build/);
});

test('429 is waited out by Retry-After, then a rate limit error', async () => {
  const waits: number[] = [];
  const { fake, connector } = setup([PKG], { sleep: async (ms) => void waits.push(ms) });
  fake
    .clear('POST', EDITS)
    .on({
      method: 'POST',
      match: EDITS,
      status: 429,
      json: fx.google429Quota,
      headers: { 'retry-after': '4' },
      times: 1,
    })
    .on({ method: 'POST', match: EDITS, json: fx.googleEdit });
  await connector.probeEdit(PKG);
  assert.deepEqual(waits, [4000]);
  fake.clear('POST', EDITS).on({
    method: 'POST',
    match: EDITS,
    status: 429,
    json: fx.google429Quota,
    headers: { 'retry-after': '90' },
  });
  await assert.rejects(
    connector.probeEdit(PKG),
    (e: unknown) => e instanceof StoreRateLimitError && e.retryAfterSeconds === 90,
  );
});

test('a quota error sent as 403 is a rate limit error', async () => {
  const e = await failure(
    {
      status: 403,
      json: {
        error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
      },
    },
    (c) => c.probeEdit(PKG),
  );
  assert.ok(e instanceof StoreRateLimitError);
});

test('5xx, malformed JSON and a network failure are typed', async () => {
  assert.equal(
    (await failure({ status: 503, raw: 'down' }, (c) => c.probeEdit(PKG))).kind,
    'server',
  );
  assert.equal(
    (await failure({ status: 200, raw: '{"id":' }, (c) => c.probeEdit(PKG))).kind,
    'unexpected',
  );
  assert.equal(
    (await failure({ status: 200, json: {} }, (c) => c.probeEdit(PKG))).kind,
    'unexpected',
  );
  const net = await failure(
    { status: 200, throws: new Error(`ECONNRESET ${fx.ACCESS_TOKEN}`) },
    (c) => c.probeEdit(PKG),
  );
  assert.equal(net.kind, 'network');
});

test('Google error text that echoes the token is redacted', async () => {
  const e = await failure(
    { status: 400, json: { error: { code: 400, message: `bad request for ${fx.ACCESS_TOKEN}` } } },
    (c) => c.probeEdit(PKG),
  );
  assert.equal(e.kind, 'unexpected');
  assert.ok(!e.message.includes(fx.ACCESS_TOKEN));
});

test('verifyCredentials checks the token and an edit for each configured package', async () => {
  const { fake, connector } = setup([PKG, 'com.example.tea']);
  fake
    .on({
      method: 'POST',
      match: '/androidpublisher/v3/applications/com.example.tea/edits',
      json: { id: 'e2' },
    })
    .on({
      method: 'DELETE',
      match: '/androidpublisher/v3/applications/com.example.tea/edits/e2',
      json: {},
    });
  await connector.verifyCredentials();
  assert.equal(fake.called('POST', EDITS).length, 1);
  assert.equal(
    fake.called('POST', '/androidpublisher/v3/applications/com.example.tea/edits').length,
    1,
  );
  assert.equal(connector.platform, 'android');
});
