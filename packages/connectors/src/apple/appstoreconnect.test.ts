import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { buildSecret } from '@mrm/core';
import {
  APPLE_IAT_BACKDATE_SECONDS,
  APPLE_TOKEN_LIFETIME_SECONDS,
  loadAppleSigningKey,
  parseAppStoreConnectSecret,
} from './apple-auth.ts';
import { AppStoreConnectConnector } from './appstoreconnect.ts';
import { StoreError, StoreRateLimitError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const key = fx.appleKeyPem();

function setup(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = new fx.FakeFetch();
  const clock = { now: T0 };
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    now: options.now ?? (() => clock.now),
    sleep: options.sleep ?? (async () => undefined),
  });
  return { fake, clock, connector };
}

const bearer = (call: fx.Call) => (call.headers.get('authorization') ?? '').replace(/^Bearer /, '');

/** No message may carry the key, a JWT, or any line of the key. */
function assertNoSecrets(error: unknown, fake: fx.FakeFetch) {
  assert.ok(error instanceof Error);
  const text = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!text.includes('PRIVATE KEY'), 'no PEM header');
  for (const line of key.privateKey.split('\n')) {
    if (line && !line.startsWith('-----')) assert.ok(!text.includes(line), 'no key line');
  }
  for (const call of fake.calls) {
    const token = bearer(call);
    if (token) assert.ok(!text.includes(token), 'no token');
  }
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(text), 'no JWT');
}

test("the JWT follows Apple's rules: ES256, kid, iss, aud, lifetime under 20 minutes", async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: '/v1/apps?limit=1', json: fx.appleAppsOne });
  await connector.verifyCredentials();
  const token = bearer(fake.calls[0] as fx.Call);
  const jwt = fx.decodeJwt(token);
  assert.deepEqual(jwt.header, { alg: 'ES256', kid: fx.KEY_ID, typ: 'JWT' });
  assert.equal(jwt.payload.iss, fx.ISSUER_ID);
  assert.equal(jwt.payload.aud, 'appstoreconnect-v1');
  const iat = jwt.payload.iat as number;
  const exp = jwt.payload.exp as number;
  assert.equal(iat, T0 / 1000 - APPLE_IAT_BACKDATE_SECONDS);
  assert.equal(exp - iat, APPLE_TOKEN_LIFETIME_SECONDS);
  assert.ok(exp - iat <= 20 * 60, 'Apple rejects a lifetime above 20 minutes');
  assert.ok(exp * 1000 > T0, 'not expired when issued');
  // The signature is raw r||s (64 bytes), not DER, and verifies with the public key.
  assert.equal(jwt.signature.length, 64);
  assert.ok(
    verify(
      'sha256',
      Buffer.from(jwt.signingInput),
      { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
      jwt.signature,
    ),
  );
  assert.equal(fake.calls[0]?.method, 'GET');
});

test('one token is reused and renewed a minute before it expires', async () => {
  const { fake, clock, connector } = setup();
  fake.on({ method: 'GET', match: '/v1/apps?limit=1', json: fx.appleAppsOne });
  await connector.verifyCredentials();
  clock.now = T0 + 10 * 60_000;
  await connector.verifyCredentials();
  assert.equal(bearer(fake.calls[0] as fx.Call), bearer(fake.calls[1] as fx.Call));
  // Token expires at T0 - 30s + 19min = T0 + 18.5min; renewed from T0 + 17.5min.
  clock.now = T0 + 18 * 60_000;
  await connector.verifyCredentials();
  assert.notEqual(bearer(fake.calls[1] as fx.Call), bearer(fake.calls[2] as fx.Call));
});

test('verifyCredentials reads one app only (GET /v1/apps?limit=1) and reports the count', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: '/v1/apps?limit=1', json: fx.appleAppsOne });
  assert.deepEqual(await connector.checkAccess(), { appCount: 431 });
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['GET'],
  );
});

test('listApps follows links.next across pages', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: '/v1/apps?limit=200', json: fx.appleAppsPage1 }).on({
    method: 'GET',
    match: '/v1/apps?cursor=AoJ4g7mg6o4DKzEwNzQ2ODIxOTc2.ANrJC88&limit=2',
    json: fx.appleAppsPage2,
  });
  const apps = await connector.listApps();
  assert.deepEqual(
    apps.map((a) => [a.storeId, a.name, a.bundleId, a.platform]),
    [
      ['10746822401', 'Your Next Cortado', 'com.bdt.ync', 'ios'],
      ['10746821976', 'A Lot of Latte', 'com.bdt.latte', 'ios'],
      ['10746822555', 'Flat White', 'com.bdt.flat', 'ios'],
    ],
  );
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.unexpected, []);
});

test('a paging link to another host is not followed, and the token is not sent there', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: '/v1/apps?limit=200',
    json: { ...fx.appleAppsPage1, links: { next: 'https://evil.example.com/v1/apps?cursor=1' } },
  });
  await assert.rejects(connector.listApps(), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.equal(e.kind, 'unexpected');
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test('paging stops at maxPages', async () => {
  const fake = new fx.FakeFetch();
  fake.on({
    method: 'GET',
    match: /^\/v1\/apps/,
    json: { ...fx.appleAppsPage1, links: { next: `${fx.APPLE_BASE}/v1/apps?cursor=loop` } },
  });
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    maxPages: 3,
  });
  await connector.listApps();
  assert.equal(fake.calls.length, 3);
});

test('listVersions reads appVersionState, falls back to appStoreState, skips other platforms', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: '/v1/apps/10746822401/appStoreVersions?limit=200',
    json: fx.appleVersions,
  });
  const versions = await connector.listVersions('10746822401');
  assert.deepEqual(
    versions.map((v) => [v.storeId, v.versionString, v.rawState, v.lifecycleState]),
    [
      ['v-new', '2.1', 'WAITING_FOR_REVIEW', 'in_review'],
      ['v-new-only', '2.0', 'READY_FOR_DISTRIBUTION', 'live'],
      ['v-old-only', '1.9', 'READY_FOR_SALE', 'live'],
      ['v-unknown', '1.8', 'SOMETHING_NEW', undefined],
    ],
  );
  assert.ok(versions.every((v) => v.platform === 'ios' && v.appStoreId === '10746822401'));
  // An unknown state is kept verbatim and not mapped.
  assert.ok(!('lifecycleState' in (versions[3] as object)));
});

test('listBuilds joins the marketing version and maps processing states', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match:
      '/v1/builds?filter[app]=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate',
    json: fx.appleBuilds,
  });
  const builds = await connector.listBuilds('10746822401');
  assert.deepEqual(
    builds.map((b) => [
      b.storeId,
      b.buildNumber,
      b.versionString,
      b.processing,
      b.rawProcessingState,
    ]),
    [
      ['b-valid', '210', '2.1', 'processed', 'VALID'],
      ['b-processing', '211', '2.1', 'processing', 'PROCESSING'],
      ['b-failed', '200', '2.0', 'invalid', 'FAILED'],
      ['b-invalid', '201', '2.0', 'invalid', 'INVALID'],
      ['b-future', '202', '2.0', 'processing', 'SOMETHING_NEW'],
      ['b-nopre', '7', undefined, 'processed', 'VALID'],
    ],
  );
  assert.equal(builds[0]?.uploadedAt, Date.parse('2022-09-07T10:42:15-07:00'));
  assert.equal(builds[2]?.expired, true);
  assert.equal(builds[0]?.expired, false);
});

const BUILDS_EXPECTED = [
  ['b-valid', '210', '2.1', 'processed', 'VALID'],
  ['b-processing', '211', '2.1', 'processing', 'PROCESSING'],
  ['b-failed', '200', '2.0', 'invalid', 'FAILED'],
  ['b-invalid', '201', '2.0', 'invalid', 'INVALID'],
  ['b-future', '202', '2.0', 'processing', 'SOMETHING_NEW'],
  ['b-nopre', '7', undefined, 'processed', 'VALID'],
];
const BUILDS_PRIMARY =
  '/v1/builds?filter[app]=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate';
const BUILDS_MINIMAL = '/v1/apps/10746822401/builds?limit=200';
const PRERELEASE_PATH =
  '/v1/preReleaseVersions?filter[app]=10746822401&include=builds&limit=200&limit[builds]=50';
const summarize = (builds: Awaited<ReturnType<AppStoreConnectConnector['listBuilds']>>) =>
  builds.map((b) => [
    b.storeId,
    b.buildNumber,
    b.versionString,
    b.processing,
    b.rawProcessingState,
  ]);

test('listBuilds: when Apple rejects sort, the message names the parameter and a minimal query is retried', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: BUILDS_PRIMARY, status: 400, json: fx.apple400Sort })
    .on({ method: 'GET', match: BUILDS_MINIMAL, json: fx.appleBuildsMinimal })
    .on({ method: 'GET', match: PRERELEASE_PATH, json: fx.applePreReleaseVersions });
  const builds = await connector.listBuilds('10746822401');
  // The same result as the one-request path, with the marketing versions read the other way.
  assert.deepEqual(summarize(builds), BUILDS_EXPECTED);
  assert.deepEqual(
    fake.calls.map((c) => c.url.pathname + c.url.search),
    [BUILDS_PRIMARY, BUILDS_MINIMAL, PRERELEASE_PATH],
  );
  assert.deepEqual(fake.unexpected, []);
  // The retry has no sort and no include on the builds request.
  const minimal = (fake.calls[1] as fx.Call).url.searchParams;
  assert.deepEqual([...minimal.keys()], ['limit']);
});

test('listBuilds: the rejected parameter is in the error message and in details when nothing works', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: BUILDS_PRIMARY, status: 400, json: fx.apple400Sort }).on({
    method: 'GET',
    match: BUILDS_MINIMAL,
    status: 400,
    json: fx.appleParameterError('limit'),
  });
  let caught: unknown;
  try {
    await connector.listBuilds('10746822401');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StoreError);
  assertNoSecrets(caught, fake);
  assert.equal(caught.status, 400);
  assert.equal(caught.kind, 'unexpected');
  assert.match(caught.message, /listing the builds of app 10746822401 with HTTP 400/);
  assert.match(
    caught.message,
    /PARAMETER_ERROR\.ILLEGAL: A given parameter is not allowed for this request/,
  );
  assert.match(caught.message, /parameter: limit/);
  assert.deepEqual(
    caught.details?.map((d) => [d.code, d.parameter]),
    [['PARAMETER_ERROR.ILLEGAL', 'limit']],
  );
  // Only the two builds requests were made: no second retry loop.
  assert.equal(fake.calls.length, 2);
});

test('a 400 names the rejected parameter (listVersions)', async () => {
  const e = await failure(
    (f) =>
      f.on({
        method: 'GET',
        match: '/v1/apps/10746822401/appStoreVersions?limit=200',
        status: 400,
        json: fx.appleParameterError('limit'),
      }),
    (c) => c.listVersions('10746822401'),
  );
  assert.equal(e.status, 400);
  assert.match(e.message, /parameter: limit/);
  assert.match(e.message, /can not be used with this request/);
  assert.equal(e.details?.[0]?.parameter, 'limit');
});

test('the structured details are redacted like the message', async () => {
  const line = key.privateKey.split('\n')[1] as string;
  const body = fx.appleParameterError('filter[app]');
  const [entry] = body.errors;
  assert.ok(entry);
  entry.detail = `echoed ${line}`;
  const e = await failure(
    (f) =>
      f.on({
        method: 'GET',
        match: '/v1/apps/10746822401/appStoreVersions?limit=200',
        status: 400,
        json: body,
      }),
    (c) => c.listVersions('10746822401'),
  );
  assert.ok(!JSON.stringify(e.details).includes(line));
  assert.match(JSON.stringify(e.details), /\[redacted\]/);
  assert.equal(e.details?.[0]?.parameter, 'filter[app]');
});

test('a 400 that is not about a parameter is not retried', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: BUILDS_PRIMARY, status: 400, json: fx.apple400Entity });
  await assert.rejects(connector.listBuilds('10746822401'), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.match(e.message, /ENTITY_ERROR\.ATTRIBUTE\.INVALID/);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test('the fallback still returns builds when the pre-release versions are rejected too', async () => {
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: BUILDS_PRIMARY, status: 400, json: fx.apple400Sort })
    .on({ method: 'GET', match: BUILDS_MINIMAL, json: fx.appleBuildsMinimal })
    .on({
      method: 'GET',
      match: PRERELEASE_PATH,
      status: 400,
      json: fx.appleParameterError('include'),
    });
  const builds = await connector.listBuilds('10746822401');
  // Without versions, and without a platform to filter on: every build is kept, none has a version.
  assert.equal(builds.length, 7);
  assert.ok(builds.every((b) => b.versionString === undefined));
});

test('listBuilds follows links.next and keeps the versions that arrive with each page', async () => {
  const { fake, connector } = setup();
  const next = `${fx.APPLE_BASE}/v1/builds?cursor=AoJ4g7mg6o4&filter%5Bapp%5D=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate`;
  const [first, ...rest] = fx.appleBuilds.data;
  assert.ok(first);
  fake
    .on({
      method: 'GET',
      match: BUILDS_PRIMARY,
      json: {
        data: [first],
        included: fx.appleBuilds.included.slice(0, 1),
        links: { next },
      },
    })
    .on({
      method: 'GET',
      match:
        '/v1/builds?cursor=AoJ4g7mg6o4&filter%5Bapp%5D=10746822401&include=preReleaseVersion&limit=200&sort=-uploadedDate',
      json: { data: rest, included: fx.appleBuilds.included.slice(1) },
    });
  const builds = await connector.listBuilds('10746822401');
  assert.deepEqual(summarize(builds), BUILDS_EXPECTED);
  assert.deepEqual(fake.unexpected, []);
});

test('only parameters that Apple documents for each endpoint are sent, and limit stays within 200', async () => {
  // From the "Query Parameters" of each page (see docs/spikes/store-api-conventions.md).
  const documented: Record<string, { params: string[]; sort?: string[]; include?: string[] }> = {
    '/v1/apps': {
      params: [
        'limit',
        'sort',
        'include',
        'filter[bundleId]',
        'filter[id]',
        'filter[name]',
        'filter[sku]',
      ],
      sort: ['name', '-name', 'bundleId', '-bundleId', 'sku', '-sku'],
    },
    '/v1/apps/10746822401/appStoreVersions': {
      params: [
        'limit',
        'include',
        'filter[platform]',
        'filter[appVersionState]',
        'filter[id]',
        'filter[versionString]',
      ],
    },
    '/v1/builds': {
      params: [
        'limit',
        'sort',
        'include',
        'filter[app]',
        'filter[id]',
        'filter[version]',
        'filter[expired]',
        'filter[processingState]',
      ],
      sort: [
        'version',
        '-version',
        'uploadedDate',
        '-uploadedDate',
        'preReleaseVersion',
        '-preReleaseVersion',
      ],
      include: ['preReleaseVersion', 'app', 'appStoreVersion', 'buildBetaDetail'],
    },
    '/v1/preReleaseVersions': {
      params: ['limit', 'limit[builds]', 'sort', 'include', 'filter[app]', 'filter[platform]'],
      sort: ['version', '-version'],
      include: ['builds', 'app'],
    },
    // The app-scoped builds endpoint lists only `limit` and `fields[builds]`: no sort, no include.
    '/v1/apps/10746822401/builds': { params: ['limit', 'fields[builds]'] },
  };
  const { fake, connector } = setup();
  fake
    .on({ method: 'GET', match: /^\/v1\/apps\?/, json: { data: [] } })
    .on({ method: 'GET', match: /appStoreVersions/, json: { data: [] } })
    .on({ method: 'GET', match: /^\/v1\/builds\?/, json: { data: [] } });
  await connector.verifyCredentials();
  await connector.listApps();
  await connector.listVersions('10746822401');
  await connector.listBuilds('10746822401');
  // And the fallback, which is only reached after a parameter error.
  const rejected = setup();
  rejected.fake
    .on({ method: 'GET', match: /^\/v1\/builds\?/, status: 400, json: fx.apple400Sort })
    .on({ method: 'GET', match: /^\/v1\/apps\/10746822401\/builds\?/, json: { data: [] } })
    .on({ method: 'GET', match: /^\/v1\/preReleaseVersions\?/, json: { data: [] } });
  await rejected.connector.listBuilds('10746822401');
  const calls = [...fake.calls, ...rejected.fake.calls];
  assert.equal(calls.length, 4 + 3);
  for (const call of calls) {
    const rule = documented[call.url.pathname];
    assert.ok(rule, `no documented endpoint ${call.url.pathname}`);
    for (const [name, value] of call.url.searchParams) {
      assert.ok(
        rule.params.includes(name),
        `${call.url.pathname}: ${name} is not a documented parameter`,
      );
      if (name === 'sort')
        assert.ok(rule.sort?.includes(value), `${call.url.pathname}: sort=${value}`);
      if (name === 'include')
        assert.ok(rule.include?.includes(value), `${call.url.pathname}: include=${value}`);
      if (name === 'limit') assert.ok(Number(value) >= 1 && Number(value) <= 200, `limit=${value}`);
      if (name === 'limit[builds]')
        assert.ok(Number(value) >= 1 && Number(value) <= 50, `limit[builds]=${value}`);
    }
  }
  assert.deepEqual(fake.unexpected, []);
});

test("pageSize above Apple's maximum is clamped to 200", async () => {
  const fake = new fx.FakeFetch().on({ method: 'GET', match: /.*/, json: { data: [] } });
  const connector = new AppStoreConnectConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    pageSize: 1000,
  });
  await connector.listApps();
  await connector.listVersions('1');
  await connector.listBuilds('1');
  assert.ok(fake.calls.every((c) => c.url.searchParams.get('limit') === '200'));
});

test('the app id is encoded into the path', async () => {
  const { fake, connector } = setup();
  fake.on({ method: 'GET', match: /.*/, json: { data: [] } });
  await connector.listVersions('1/../2');
  assert.ok(fake.calls[0]?.url.pathname.startsWith('/v1/apps/1%2F..%2F2/'));
});

// ---------------------------------------------------------------------------------------------
// Errors

async function failure(
  setupRoute: (fake: fx.FakeFetch) => void,
  run: (c: AppStoreConnectConnector) => Promise<unknown>,
) {
  const { fake, connector } = setup();
  setupRoute(fake);
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

test('401 is an auth error that says what to check', async () => {
  const e = await failure(
    (f) => f.on({ method: 'GET', match: '/v1/apps?limit=1', status: 401, json: fx.apple401 }),
    (c) => c.verifyCredentials(),
  );
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 401);
  assert.match(e.message, /Key ID/);
  assert.match(e.message, /Issuer ID/);
});

test("401 with a clock far from Apple's is reported as clock skew, with the size of it", async () => {
  const e = await failure(
    (f) =>
      f.on({
        method: 'GET',
        match: '/v1/apps?limit=1',
        status: 401,
        json: fx.apple401,
        headers: { date: new Date(T0 - 10 * 60_000).toUTCString() },
      }),
    (c) => c.verifyCredentials(),
  );
  assert.equal(e.kind, 'clock_skew');
  assert.match(e.message, /about 600 seconds \(ahead\)/);
  assert.match(e.message, /NTP/);
});

test("401 with a clock close to Apple's is not clock skew", async () => {
  const e = await failure(
    (f) =>
      f.on({
        method: 'GET',
        match: '/v1/apps?limit=1',
        status: 401,
        json: fx.apple401,
        headers: { date: new Date(T0 - 5_000).toUTCString() },
      }),
    (c) => c.verifyCredentials(),
  );
  assert.equal(e.kind, 'auth');
});

test('403 is a role or revoked-key error', async () => {
  const e = await failure(
    (f) => f.on({ method: 'GET', match: '/v1/apps?limit=1', status: 403, json: fx.apple403 }),
    (c) => c.verifyCredentials(),
  );
  assert.equal(e.kind, 'forbidden');
  assert.match(e.message, /role/);
  assert.match(e.message, /revoked/);
});

test('404 is not_found', async () => {
  const e = await failure(
    (f) => f.on({ method: 'GET', match: /appStoreVersions/, status: 404, json: fx.apple404 }),
    (c) => c.listVersions('1'),
  );
  assert.equal(e.kind, 'not_found');
});

test('5xx is a server error, and other statuses are unexpected', async () => {
  const a = await failure(
    (f) => f.on({ method: 'GET', match: /.*/, status: 503, raw: '<html>down</html>' }),
    (c) => c.listApps(),
  );
  assert.equal(a.kind, 'server');
  const b = await failure(
    (f) => f.on({ method: 'GET', match: /.*/, status: 409, json: fx.apple429 }),
    (c) => c.listApps(),
  );
  assert.equal(b.kind, 'unexpected');
});

test('a 200 that is not JSON is an unexpected error, not a crash', async () => {
  const e = await failure(
    (f) => f.on({ method: 'GET', match: /.*/, raw: '{"data": [' }),
    (c) => c.listApps(),
  );
  assert.equal(e.kind, 'unexpected');
  const e2 = await failure(
    (f) => f.on({ method: 'GET', match: /.*/, json: ['not', 'an', 'object'] }),
    (c) => c.listApps(),
  );
  assert.equal(e2.kind, 'unexpected');
});

test('a network failure is a network error that does not echo the cause', async () => {
  const e = await failure(
    (f) =>
      f.on({
        method: 'GET',
        match: /.*/,
        throws: new Error('connect ECONNREFUSED Bearer secret-token-value-123456'),
      }),
    (c) => c.listApps(),
  );
  assert.equal(e.kind, 'network');
  assert.ok(!e.message.includes('secret-token'));
});

test('429 is waited out using Retry-After, then succeeds', async () => {
  const waits: number[] = [];
  const { fake, connector } = setup({ sleep: async (ms) => void waits.push(ms) });
  fake
    .on({
      method: 'GET',
      match: '/v1/apps?limit=1',
      status: 429,
      json: fx.apple429,
      headers: { 'retry-after': '3' },
      times: 1,
    })
    .on({ method: 'GET', match: '/v1/apps?limit=1', json: fx.appleAppsOne });
  assert.deepEqual(await connector.checkAccess(), { appCount: 431 });
  assert.deepEqual(waits, [3000]);
  assert.equal(fake.calls.length, 2);
});

test('a persistent 429 gives up with StoreRateLimitError and the wait', async () => {
  const waits: number[] = [];
  const { fake, connector } = setup({ sleep: async (ms) => void waits.push(ms) });
  fake.on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    status: 429,
    json: fx.apple429,
    headers: { 'retry-after': '2' },
  });
  await assert.rejects(connector.checkAccess(), (e: unknown) => {
    assert.ok(e instanceof StoreRateLimitError);
    assert.equal(e.retryAfterSeconds, 2);
    assert.equal(e.kind, 'rate_limited');
    return true;
  });
  assert.equal(fake.calls.length, 3, 'one try and two retries');
  assert.deepEqual(waits, [2000, 2000]);
});

test('a long Retry-After, or none, is not waited out', async () => {
  const waits: number[] = [];
  const { fake, connector } = setup({ sleep: async (ms) => void waits.push(ms) });
  fake.on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    status: 429,
    json: fx.apple429,
    headers: { 'retry-after': '120' },
    times: 1,
  });
  await assert.rejects(
    connector.checkAccess(),
    (e: unknown) => e instanceof StoreRateLimitError && e.retryAfterSeconds === 120,
  );
  assert.equal(fake.calls.length, 1);
  // Apple documents no Retry-After (only a rolling hour): assume 60 seconds, and do not wait.
  const second = setup();
  second.fake.on({ method: 'GET', match: '/v1/apps?limit=1', status: 429, json: fx.apple429 });
  await assert.rejects(
    second.connector.checkAccess(),
    (e: unknown) => e instanceof StoreRateLimitError && e.retryAfterSeconds === 60,
  );
  assert.deepEqual(waits, []);
});

test('error text from Apple that echoes the token is redacted', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: /.*/,
    status: 400,
    json: {
      errors: [
        {
          status: '400',
          code: 'PARAMETER_ERROR',
          title: 'echo: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
          detail: 'x',
        },
      ],
    },
  });
  // A hostile body: the title has a bearer token shape in it.
  await assert.rejects(connector.listApps(), (e: unknown) => {
    assert.ok(e instanceof StoreError);
    assert.ok(!e.message.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// Secrets and keys

test('the connector can be built from the stored secret', async () => {
  const secret = buildSecret('app_store_connect', {
    keyId: fx.KEY_ID,
    issuerId: fx.ISSUER_ID,
    privateKey: key.privateKey,
  });
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match: '/v1/apps?limit=1',
    json: fx.appleAppsOne,
  });
  const connector = AppStoreConnectConnector.fromSecret(secret, { fetch: fake.fetch });
  await connector.verifyCredentials();
  assert.equal(connector.platform, 'ios');
});

test('malformed secrets and keys are invalid_input, and never echo the key', () => {
  assert.throws(
    () => parseAppStoreConnectSecret('not json'),
    (e: unknown) => e instanceof StoreError && e.kind === 'invalid_input',
  );
  assert.throws(
    () =>
      parseAppStoreConnectSecret(
        JSON.stringify({ keyId: fx.KEY_ID, issuerId: '', privateKey: key.privateKey }),
      ),
    (e: unknown) => e instanceof StoreError && /Issuer ID/.test(e.message),
  );
  const broken = key.privateKey.replace(/.{20}$/m, 'garbage');
  assert.throws(
    () => loadAppleSigningKey(broken),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.equal(e.kind, 'invalid_input');
      assert.match(e.message, /\.p8/);
      assert.ok(!e.message.includes('garbage'));
      return true;
    },
  );
  // An RSA key is not a P-256 key.
  const rsa = fx.googleKeyPem().privateKey;
  assert.throws(
    () => loadAppleSigningKey(rsa),
    (e: unknown) => e instanceof StoreError && /P-256/.test(e.message),
  );
  // A P-384 key is not a P-256 key either.
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  assert.throws(
    () => loadAppleSigningKey(p384),
    (e: unknown) => e instanceof StoreError && /P-256/.test(e.message),
  );
  assert.ok(createPrivateKey(key.privateKey));
});

test('listVersionBuilds maps each version to the build Apple links to it', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: '/v1/apps/10746822401/appStoreVersions?include=build&limit=200',
    json: {
      data: [
        {
          type: 'appStoreVersions',
          id: 'v311',
          relationships: { build: { data: { type: 'builds', id: 'b170' } } },
        },
        { type: 'appStoreVersions', id: 'v300', relationships: { build: { data: null } } },
      ],
    },
  });
  const links = await connector.listVersionBuilds('10746822401');
  assert.deepEqual([...links], [['v311', 'b170']]);
});

test('listVersionBuilds gives an empty map when Apple rejects the parameter', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: '/v1/apps/10746822401/appStoreVersions?include=build&limit=200',
    status: 400,
    json: fx.appleParameterError('include'),
  });
  assert.equal((await connector.listVersionBuilds('10746822401')).size, 0);
});

test('listVersionBuilds asks for the build of a version that is not live when the list gave no link', async () => {
  const { fake, connector } = setup();
  fake.on({
    method: 'GET',
    match: '/v1/apps/10746822401/appStoreVersions?include=build&limit=200',
    json: {
      data: [
        {
          type: 'appStoreVersions',
          id: 'v311',
          attributes: { versionString: '3.1.1', appVersionState: 'WAITING_FOR_REVIEW' },
        },
        {
          type: 'appStoreVersions',
          id: 'v300',
          attributes: { versionString: '3.0.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
        },
      ],
    },
  });
  fake.on({
    method: 'GET',
    match: '/v1/appStoreVersions/v311/build',
    json: { data: { type: 'builds', id: 'b170', attributes: { version: '170' } } },
  });
  const links = await connector.listVersionBuilds('10746822401');
  assert.deepEqual([...links], [['v311', 'b170']]);
});
