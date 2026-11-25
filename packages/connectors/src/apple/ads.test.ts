import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  ADS_ACCOUNT,
  ADS_ACLS,
  ADS_CAMPAIGN_REPORT,
  ADS_KEYWORD_REPORT,
  ADS_POPULARITY,
  ADS_SEARCHTERM_REPORT,
  ADS_TOKEN,
} from './ads.fixtures.ts';
import {
  loadAppleAdsSigningKey,
  parseAppleAdsSecret,
  signAppleAdsClientSecret,
} from './ads-auth.ts';
import { createAppleAdsClient } from './ads-client.ts';
import { AppleAdsError } from './ads-errors.ts';
import {
  adsRangeDays,
  getAppleAdsAccount,
  listAppleAdsAccounts,
  microsOf,
  readAppleAdsCampaigns,
  readAppleAdsKeywords,
  readAppleAdsPopularity,
  readAppleAdsSearchTerms,
} from './ads-read.ts';
import { verifyAppleAdsCredential } from './ads-verify.ts';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SEC1 = privateKey.export({ type: 'sec1', format: 'pem' }).toString();
const IDS = { clientId: 'SEARCHADS.client', teamId: 'SEARCHADS.team', keyId: 'key-1' };
const CREDENTIAL = { ...IDS, privateKey: PEM };
const SECRET = JSON.stringify(CREDENTIAL);
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string };

function fake(handler: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    const r = handler(call, calls.length - 1);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  };
  return { f, calls };
}

const route = (map: Record<string, Reply | ((c: Call) => Reply)>) =>
  fake((call) => {
    const path = new URL(call.url).pathname;
    const r = map[path];
    if (!r) return { status: 404, json: {} };
    return typeof r === 'function' ? r(call) : r;
  });

const slept: number[] = [];
const sleep = async (ms: number) => {
  slept.push(ms);
};

const client = (f: typeof fetch, extra: Partial<Parameters<typeof createAppleAdsClient>[0]> = {}) =>
  createAppleAdsClient({ credential: CREDENTIAL, fetch: f, now: () => NOW, sleep, ...extra });

const rejects = (promise: Promise<unknown>, kind: string) =>
  assert.rejects(promise, (e) => e instanceof AppleAdsError && e.kind === kind);

test('the client secret is an ES256 JWT with the documented claims and a short life', () => {
  const key = loadAppleAdsSigningKey(PEM);
  const { token, expiresAt } = signAppleAdsClientSecret(key, IDS, NOW);
  const [h, p, s] = token.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual(header, { alg: 'ES256', kid: 'key-1' });
  assert.equal(payload.sub, IDS.clientId);
  assert.equal(payload.iss, IDS.teamId);
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.equal(payload.exp - payload.iat, 300);
  assert.equal(expiresAt, payload.exp * 1000);
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey(PEM), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    ),
  );
  // The SEC1 "EC PRIVATE KEY" that openssl writes works too.
  assert.ok(loadAppleAdsSigningKey(SEC1));
});

test('a key that is not a readable P-256 key is invalid_key and the message has no key material', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  for (const bad of ['not a key', rsa]) {
    assert.throws(
      () => loadAppleAdsSigningKey(bad),
      (e) =>
        e instanceof AppleAdsError &&
        e.kind === 'invalid_key' &&
        !e.message.includes('BEGIN PRIVATE') &&
        e.coding?.code === 'ads.invalidKey',
    );
  }
  assert.throws(
    () => parseAppleAdsSecret('{"clientId":"a"}'),
    (e) => e instanceof AppleAdsError && e.kind === 'invalid_input',
  );
});

test('the token request follows the documented form and the token is cached', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': { json: ADS_ACLS },
  });
  const c = client(f);
  const accounts = await listAppleAdsAccounts(c);
  await listAppleAdsAccounts(c);
  assert.deepEqual(
    accounts.map((a) => [a.id, a.name, a.orgId, a.roles[0]]),
    [
      ['123456789', 'AwayFinder', '27154130', 'API Account Read Only'],
      ['987654321', 'Second account', '27154130', 'Limited Access: API Read Only'],
    ],
  );
  const tokens = calls.filter((x) =>
    x.url.startsWith('https://appleid.apple.com/auth/oauth2/token'),
  );
  assert.equal(tokens.length, 1, 'cached');
  const form = new URLSearchParams(tokens[0]?.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'searchadsorg');
  assert.equal(form.get('client_id'), IDS.clientId);
  assert.match(form.get('client_secret') ?? '', /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const api = calls.find((x) => x.url === 'https://api.ads.apple.com/v1/acls');
  assert.equal(api?.headers.authorization, 'Bearer access-token-1');
  assert.equal(api?.headers['x-ap-context'], undefined, 'no context for the ACL call');
});

test('a 401 gets one new token; a refused key is auth', async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const { f } = route({
    '/auth/oauth2/token': () => ({ json: { ...ADS_TOKEN, access_token: `t${++tokenCalls}` } }),
    '/v1/acls': () => (++apiCalls === 1 ? { status: 401 } : { json: ADS_ACLS }),
  });
  assert.equal((await listAppleAdsAccounts(client(f))).length, 2);
  assert.equal(tokenCalls, 2);
  const refused = route({
    '/auth/oauth2/token': { status: 400, json: { error: 'invalid_client' } },
  });
  await assert.rejects(
    listAppleAdsAccounts(client(refused.f)),
    (e) => e instanceof AppleAdsError && e.kind === 'auth' && e.coding?.code === 'ads.auth',
  );
});

test('403 is forbidden, 404 not_found, 5xx is tried once more then server', async () => {
  for (const [status, kind] of [
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const) {
    const { f } = route({
      '/auth/oauth2/token': { json: ADS_TOKEN },
      '/v1/ad-accounts/123456789': {
        status,
        json: { error: { code: 'x', message: 'secret words' } },
      },
    });
    await assert.rejects(
      getAppleAdsAccount(client(f), '123456789'),
      (e) => e instanceof AppleAdsError && e.kind === kind && !e.message.includes('secret words'),
    );
  }
  slept.length = 0;
  let n = 0;
  const { f } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': () => (++n === 1 ? { status: 503 } : { json: ADS_ACLS }),
  });
  assert.equal((await listAppleAdsAccounts(client(f))).length, 2);
  assert.deepEqual(slept, [2000]);
  const down = route({ '/auth/oauth2/token': { json: ADS_TOKEN }, '/v1/acls': { status: 500 } });
  await rejects(listAppleAdsAccounts(client(down.f)), 'server');
});

test('a 429 waits Retry-After, doubles without it, and a long wait is reported not slept', async () => {
  slept.length = 0;
  let n = 0;
  const { f } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': () =>
      ++n === 1 ? { status: 429, headers: { 'retry-after': '7' } } : { json: ADS_ACLS },
  });
  await listAppleAdsAccounts(client(f));
  assert.deepEqual(slept, [7000]);
  slept.length = 0;
  let m = 0;
  const two = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': () => (++m < 3 ? { status: 429 } : { json: ADS_ACLS }),
  });
  await listAppleAdsAccounts(client(two.f));
  assert.deepEqual(slept, [2000, 4000]);
  const long = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': { status: 429, headers: { 'retry-after': '600' } },
  });
  await assert.rejects(
    listAppleAdsAccounts(client(long.f)),
    (e) => e instanceof AppleAdsError && e.kind === 'rate_limited' && e.retryAfterSeconds === 600,
  );
});

test('a nearly spent quota is waited out before the next request', async () => {
  slept.length = 0;
  const { f } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': {
      json: ADS_ACLS,
      headers: { 'ratelimit-limit': '100', 'ratelimit-remaining': '1', 'ratelimit-reset': '12' },
    },
  });
  const c = client(f);
  await listAppleAdsAccounts(c);
  await listAppleAdsAccounts(c);
  assert.deepEqual(slept, [12000]);
});

test('only read-only paths are allowed and a redirect is never followed', async () => {
  const { f, calls } = route({ '/auth/oauth2/token': { json: ADS_TOKEN } });
  const c = client(f);
  for (const path of ['/campaigns', '/campaigns/123', '/ad-accounts', '/me/../acls', '//acls'])
    await rejects(c.get(path), 'invalid_input');
  for (const path of [
    '/campaigns',
    '/keywords/bulk-create',
    '/reports/apps/ads/query',
    '/campaigns/1/query',
  ])
    await rejects(c.query(path, {}, { adAccountId: '1' }), 'invalid_input');
  await rejects(c.query('/campaigns/query', {}, { adAccountId: 'abc' }), 'invalid_input');
  assert.equal(calls.length, 0, 'nothing was sent');
  const redirect = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': { status: 302, headers: { location: 'https://evil.example/' } },
  });
  await rejects(listAppleAdsAccounts(client(redirect.f)), 'unexpected');
  assert.equal(redirect.calls.length, 2);
});

test('scoped calls send X-AP-Context; the account detail is read', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/ad-accounts/123456789': { json: ADS_ACCOUNT },
  });
  const detail = await getAppleAdsAccount(client(f), '123456789');
  assert.deepEqual(
    [detail.currency, detail.timezone, detail.productFeatures],
    ['EUR', 'America/New_York', ['APPSTORE_APP_MANUAL']],
  );
  assert.equal(calls[1]?.headers['x-ap-context'], 'adAccountId=123456789');
});

test('money is parsed to micro-units without floating point', () => {
  assert.equal(microsOf('45.00'), 45_000_000);
  assert.equal(microsOf('0.1'), 100_000);
  assert.equal(microsOf('0.000001'), 1);
  assert.equal(microsOf('1234.56'), 1_234_560_000);
  assert.throws(() => microsOf(45), AppleAdsError);
  assert.throws(() => microsOf('abc'), AppleAdsError);
});

test('the campaign report is read daily and bad rows are counted', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/reports/apps/campaigns/query': { json: ADS_CAMPAIGN_REPORT },
  });
  const r = await readAppleAdsCampaigns(client(f), '123456789', {
    start: '2026-11-01',
    end: '2026-11-02',
  });
  assert.equal(r.complete, true);
  assert.equal(r.skipped, 1);
  assert.deepEqual(
    r.rows.map((c) => [c.campaignId, c.name, c.adamId, c.status]),
    [
      ['444555666', 'AwayFinder US', '987654321', 'ENABLED'],
      ['444555667', 'Other app', '111', 'PAUSED'],
    ],
  );
  const first = r.rows[0]?.days ?? [];
  assert.deepEqual(
    first.map((d) => [
      d.day,
      d.impressions,
      d.taps,
      d.installs,
      d.tapInstalls,
      d.spendMicros,
      d.currency,
    ]),
    [
      ['2026-11-01', 1000, 50, 12, 10, 10_250_000, 'EUR'],
      ['2026-11-02', 2000, 100, 30, 25, 20_250_000, 'EUR'],
    ],
  );
  const body = JSON.parse(calls[1]?.body ?? '{}');
  assert.deepEqual(body.timeRange, {
    start: '2026-11-01',
    end: '2026-11-02',
    timeZone: 'ORTZ',
    granularity: 'DAILY',
  });
  assert.equal(calls[1]?.method, 'POST');
});

test('a one-day range omits granularity; a range over 90 days or backwards is refused before a request', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/reports/apps/campaigns/query': {
      json: {
        result: {
          rows: [
            {
              metadata: { id: 1, name: 'A' },
              totalMetrics: {
                impressions: 5,
                taps: 1,
                localSpend: { amount: '0.50', currency: 'USD' },
              },
            },
          ],
        },
      },
    },
  });
  const r = await readAppleAdsCampaigns(client(f), '1', { start: '2026-11-01', end: '2026-11-01' });
  assert.deepEqual(
    r.rows[0]?.days.map((d) => [d.day, d.impressions, d.spendMicros]),
    [['2026-11-01', 5, 500_000]],
  );
  assert.equal(JSON.parse(calls[1]?.body ?? '{}').timeRange.granularity, undefined);
  assert.equal(adsRangeDays({ start: '2026-11-01', end: '2026-11-30' }), 30);
  const before = calls.length;
  await rejects(
    readAppleAdsCampaigns(client(f), '1', { start: '2026-01-01', end: '2026-11-01' }),
    'invalid_input',
  );
  await rejects(
    readAppleAdsCampaigns(client(f), '1', { start: '2026-11-05', end: '2026-11-01' }),
    'invalid_input',
  );
  assert.equal(calls.length, before);
});

test('pages are followed to the end and a cap is reported as incomplete', async () => {
  const row = (i: number) => ({
    metadata: { id: i, name: `C${i}` },
    granularMetrics: [{ date: '2026-11-01', impressions: i }],
  });
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/reports/apps/campaigns/query': (c) => {
      const { offset, pageSize } = JSON.parse(c.body).pagination as {
        offset: number;
        pageSize: number;
      };
      return {
        json: {
          result: { rows: [1, 2, 3, 4, 5].slice(offset, offset + pageSize).map(row) },
          pagination: { totalCount: 5 },
        },
      };
    },
  });
  const all = await readAppleAdsCampaigns(
    client(f),
    '1',
    { start: '2026-11-01', end: '2026-11-02' },
    { pageSize: 2 },
  );
  assert.equal(all.rows.length, 5);
  assert.equal(all.complete, true);
  assert.equal(calls.filter((x) => x.url.endsWith('/campaigns/query')).length, 3);
  const capped = await readAppleAdsCampaigns(
    client(f, { maxRequests: 1 }),
    '1',
    { start: '2026-11-01', end: '2026-11-02' },
    { pageSize: 2 },
  );
  assert.equal(capped.complete, false);
  assert.equal(capped.rows.length, 2);
});

test('search terms are merged by term, day and country, with the keyword that matched most', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/reports/apps/searchterms/query': { json: ADS_SEARCHTERM_REPORT },
  });
  const r = await readAppleAdsSearchTerms(client(f), '123456789', '444555666', {
    start: '2026-11-01',
    end: '2026-11-02',
  });
  assert.equal(r.skipped, 1);
  assert.equal(r.rows.length, 1);
  const t = r.rows[0];
  assert.equal(t?.term, 'Photo Editor');
  assert.equal(t?.keywordText, 'photo editor');
  assert.equal(t?.matchType, 'EXACT');
  assert.deepEqual(
    t?.days.map((d) => [d.country, d.impressions, d.taps, d.installs, d.spendMicros]),
    [
      ['gb', 40, 2, 0, 500_000],
      ['us', 400, 25, 6, 3_500_000],
    ],
  );
  const body = JSON.parse(calls[1]?.body ?? '{}');
  assert.deepEqual(body.filters, [{ field: 'campaignId', operator: 'EQUALS', value: '444555666' }]);
  assert.deepEqual(body.groupBy, ['countryOrRegion']);
  assert.equal(body.timeRange.timeZone, 'ORTZ');
});

test('keywords are read from the keyword metadata', async () => {
  const { f } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/reports/apps/keywords/query': { json: ADS_KEYWORD_REPORT },
  });
  const r = await readAppleAdsKeywords(client(f), '123456789', '444555666', {
    start: '2026-11-01',
    end: '2026-11-02',
  });
  assert.deepEqual(
    r.rows.map((k) => [k.term, k.keywordId, k.matchType, k.days[0]?.impressions]),
    [['photo', '888999000', 'BROAD', 500]],
  );
});

test('an answer in another shape is unexpected, never guessed at', async () => {
  const bad: Reply[] = [
    { json: { result: {} } },
    { json: { result: { rows: 'x' } } },
    {
      json: {
        result: {
          rows: [{ metadata: { id: 1 }, granularMetrics: [{ date: '2026-11-01', taps: 'many' }] }],
        },
      },
    },
    { text: 'not json' },
  ];
  for (const reply of bad) {
    const { f } = route({
      '/auth/oauth2/token': { json: ADS_TOKEN },
      '/v1/reports/apps/campaigns/query': reply,
    });
    await rejects(
      readAppleAdsCampaigns(client(f), '1', { start: '2026-11-01', end: '2026-11-02' }),
      'unexpected',
    );
  }
  const acls = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': { json: { result: { acls: [{ roles: [] }] } } },
  });
  await rejects(listAppleAdsAccounts(client(acls.f)), 'unexpected');
});

test('popularity asks for the terms of one storefront and week in chunks, and returns Apple rows as sent', async () => {
  const { f, calls } = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/insights/apps/search-term-popularity/query': { json: ADS_POPULARITY },
  });
  const terms = Array.from({ length: 25 }, (_, i) => `term ${i}`);
  const r = await readAppleAdsPopularity(client(f), '123456789', {
    country: 'us',
    terms,
    weekStart: '2026-11-08',
    weekEnd: '2026-11-14',
  });
  const asked = calls.filter((c) => c.url.endsWith('/search-term-popularity/query'));
  assert.equal(asked.length, 2);
  const body = JSON.parse(asked[0]?.body ?? '{}');
  assert.deepEqual(body.filters[0], { field: 'countryOrRegion', operator: 'EQUALS', value: 'US' });
  assert.equal(body.filters[1].operator, 'IN');
  assert.equal(body.filters[1].value.length, 20);
  assert.equal(body.timeRange.granularity, 'WEEKLY_SUN_SAT');
  assert.equal(r.rows.length, 4);
  assert.deepEqual(
    [
      r.rows[0]?.term,
      r.rows[0]?.popularity100,
      r.rows[0]?.popularity5,
      r.rows[0]?.genre,
      r.rows[0]?.country,
    ],
    ['photo editor', 84, 5, 'PHOTO_VIDEO', 'us'],
  );
});

test('the test connection reports the ad accounts and never echoes the key', async () => {
  const ok = route({ '/auth/oauth2/token': { json: ADS_TOKEN }, '/v1/acls': { json: ADS_ACLS } });
  const r = await verifyAppleAdsCredential(SECRET, { fetch: ok.f, now: () => NOW });
  assert.equal(r.ok, true);
  assert.match(r.message, /2 ad accounts/);
  assert.ok(
    r.details?.some((d) => d.includes('AwayFinder') && d.includes('API Account Read Only')),
  );
  const bad = route({ '/auth/oauth2/token': { status: 401, json: { error: 'invalid_client' } } });
  const f = await verifyAppleAdsCredential(SECRET, { fetch: bad.f, now: () => NOW });
  assert.equal(f.ok, false);
  assert.match(f.message, /did not accept the key/);
  const none = route({
    '/auth/oauth2/token': { json: ADS_TOKEN },
    '/v1/acls': { json: { result: { acls: [] } } },
  });
  const n = await verifyAppleAdsCredential(SECRET, { fetch: none.f, now: () => NOW });
  assert.equal(n.ok, false);
  assert.match(n.message, /no ad account/);
  const broken = await verifyAppleAdsCredential(
    JSON.stringify({ ...CREDENTIAL, privateKey: 'nope' }),
    { fetch: ok.f },
  );
  assert.equal(broken.ok, false);
  for (const out of [r, f, n, broken]) {
    const text = JSON.stringify(out);
    assert.ok(
      !text.includes('BEGIN') &&
        !text.includes('access-token-1') &&
        !text.includes(PEM.split('\n')[1] ?? 'zzz'),
    );
  }
});
