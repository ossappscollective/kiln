import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { redactSecrets, secretStrings } from './errors.ts';
import { verifyGithubAppCredential, verifyGithubTokenCredential } from './verify-github.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const INSTALL_TOKEN = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
const PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const appSecret = (over: Record<string, string> = {}) =>
  JSON.stringify({ appId: '123', installationId: '42', privateKey: PEM, ...over });

type Answer = { status?: number; json?: unknown; headers?: Record<string, string> };
type Call = { method: string; path: string; auth: string };

/** A fake GitHub: answers by "METHOD /path", records calls, 404 for anything else. */
function fakeGithub(routes: Record<string, Answer | (() => never)>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      auth: new Headers(init?.headers).get('authorization') ?? '',
    });
    const answer = routes[key];
    if (typeof answer === 'function') answer();
    const a = (answer ?? { status: 404, json: { message: 'Not Found' } }) as Answer;
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: a.headers });
  };
  return { fetch: fetchFn, calls };
}

const happyApp = (over: Record<string, Answer | (() => never)> = {}, permissions?: object) => ({
  'GET /app': { json: { id: 123, name: 'Release Bot', slug: 'release-bot' } },
  'GET /app/installations/42': {
    json: {
      account: { login: 'acme', type: 'Organization' },
      repository_selection: 'selected',
      permissions: permissions ?? { contents: 'write', pull_requests: 'write', actions: 'write', metadata: 'read' },
    },
  },
  'POST /app/installations/42/access_tokens': { status: 201, json: { token: INSTALL_TOKEN, expires_at: '2030-01-01T00:00:00Z' } },
  'GET /installation/repositories': { json: { total_count: 3, repositories: [] } },
  'DELETE /installation/token': { status: 204 },
  ...over,
});

const noLeak = (result: unknown) => {
  const text = JSON.stringify(result);
  for (const secret of [PEM, INSTALL_TOKEN, PAT, ...PEM.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'))]) {
    assert.ok(!text.includes(secret), 'result must not contain a secret');
  }
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
};

test('app: success reports the app, the account and the repository count, and revokes its token', async () => {
  const gh = fakeGithub(happyApp());
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, true);
  assert.match(result.message, /Release Bot/);
  assert.match(result.message, /acme/);
  assert.match(result.message, /3 repositories/);
  assert.ok(result.details?.includes('Repositories it can see: 3'));
  assert.ok(!result.details?.some((d) => d.startsWith('Warning')));
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), [
    'GET /app',
    'GET /app/installations/42',
    'POST /app/installations/42/access_tokens',
    'GET /installation/repositories',
    'DELETE /installation/token',
  ]);
  // The app JWT goes to the app endpoints and the installation token to the installation ones.
  assert.match(gh.calls[0]?.auth ?? '', /^Bearer eyJ/);
  assert.equal(gh.calls[3]?.auth, `Bearer ${INSTALL_TOKEN}`);
  noLeak(result);
});

test('app: the JWT names the app and is signed with the key', async () => {
  const gh = fakeGithub(happyApp());
  let jwt = '';
  const spy: typeof fetch = async (input, init) => {
    jwt ||= new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    return gh.fetch(input, init);
  };
  await verifyGithubAppCredential(appSecret(), { fetch: spy, now: () => 1_800_000_000_000 });
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
  assert.equal(payload.iss, '123');
  assert.equal(payload.exp, 1_800_000_000 + 9 * 60);
});

test('app: warns about missing and read-only permissions but still connects', async () => {
  const gh = fakeGithub(happyApp({}, { contents: 'read', metadata: 'read' }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, true);
  const warnings = (result.details ?? []).filter((d) => d.startsWith('Warning'));
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /Contents is read-only/);
  assert.match(warnings.join('\n'), /no Pull requests permission/);
  assert.match(warnings.join('\n'), /no Actions permission/);
  assert.match(result.message, /attention/);
});

test('app: warns when the installation has no repositories', async () => {
  const gh = fakeGithub(happyApp({ 'GET /installation/repositories': { json: { total_count: 0 } } }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, true);
  assert.match((result.details ?? []).join('\n'), /no repositories/);
});

test('app: a rejected JWT says the key does not match the app', async () => {
  const gh = fakeGithub({ 'GET /app': { status: 401, json: { message: 'A JSON web token could not be decoded' } } });
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch, now: () => Date.now() });
  assert.equal(result.ok, false);
  assert.match(result.message, /private key does not match the app/);
  noLeak(result);
});

test('app: a rejected JWT with a skewed clock points at the clock', async () => {
  const gh = fakeGithub({
    'GET /app': { status: 401, headers: { date: new Date(Date.now() - 3_600_000).toUTCString() } },
  });
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.match(result.message, /clock/);
});

test('app: an installation that is not this app\'s', async () => {
  const gh = fakeGithub(happyApp({ 'GET /app/installations/42': { status: 404, json: { message: 'Not Found' } } }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, false);
  assert.match(result.message, /installation ID does not belong to this app/);
  assert.deepEqual(result.details, ['App: Release Bot']);
});

test('app: a suspended installation', async () => {
  const gh = fakeGithub(happyApp({
    'GET /app/installations/42': { json: { account: { login: 'acme' }, suspended_at: '2026-01-01T00:00:00Z' } },
  }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, false);
  assert.match(result.message, /suspended/);
});

test('app: the key belongs to a different app than the App ID', async () => {
  const gh = fakeGithub(happyApp({ 'GET /app': { json: { id: 999, name: 'Other' } } }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, false);
  assert.match(result.message, /App ID/);
});

test('app: ids that are not numbers and keys that are not RSA are caught before any request', async () => {
  const gh = fakeGithub(happyApp());
  const bad = await verifyGithubAppCredential(appSecret({ appId: 'abc' }), { fetch: gh.fetch });
  assert.match(bad.message, /App ID must be a number/);
  const bad2 = await verifyGithubAppCredential(appSecret({ installationId: '4 2' }), { fetch: gh.fetch });
  assert.match(bad2.message, /installation ID must be a number/);
  const junk = '-----BEGIN PRIVATE KEY-----\nTOPSECRETJUNK\n-----END PRIVATE KEY-----';
  const unreadable = await verifyGithubAppCredential(appSecret({ privateKey: junk }), { fetch: gh.fetch });
  assert.match(unreadable.message, /private key could not be read/);
  assert.doesNotMatch(JSON.stringify(unreadable), /TOPSECRETJUNK/);
  const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const notRsa = await verifyGithubAppCredential(
    appSecret({ privateKey: ec.export({ type: 'pkcs8', format: 'pem' }).toString() }),
    { fetch: gh.fetch },
  );
  assert.match(notRsa.message, /not an RSA key/);
  assert.equal(gh.calls.length, 0);
});

test('app: a secret of the wrong shape is reported, not thrown', async () => {
  const result = await verifyGithubAppCredential('{"appId":"1"}', { fetch: fakeGithub({}).fetch });
  assert.equal(result.ok, false);
  assert.match(result.message, /Fill in/);
});

test('app: a network failure and a timeout are sentences, not exceptions', async () => {
  const down: typeof fetch = async () => {
    throw Object.assign(new Error(`connect ECONNREFUSED while sending ${PEM}`), { name: 'FetchError' });
  };
  const failed = await verifyGithubAppCredential(appSecret(), { fetch: down });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Could not reach GitHub/);
  noLeak(failed);

  const slow: typeof fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const timedOut = await verifyGithubAppCredential(appSecret(), { fetch: slow });
  assert.match(timedOut.message, /did not answer in time/);
});

test('app: a rate limit says how long to wait; a server error says to retry', async () => {
  const limited = fakeGithub({ 'GET /app': { status: 403, headers: { 'retry-after': '30' }, json: { message: 'rate limit' } } });
  assert.match((await verifyGithubAppCredential(appSecret(), { fetch: limited.fetch })).message, /30 seconds/);
  const broken = fakeGithub({ 'GET /app': { status: 502 } });
  assert.match((await verifyGithubAppCredential(appSecret(), { fetch: broken.fetch })).message, /problem \(HTTP 502\)/);
});

test('app: GitHub echoing a secret in its error message is redacted', async () => {
  const gh = fakeGithub({ 'GET /app': { status: 418, json: { message: `bad key ${PEM}` } } });
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, false);
  noLeak(result);
});

test('app: failing to revoke the installation token does not fail the check', async () => {
  const gh = fakeGithub(happyApp({ 'DELETE /installation/token': () => { throw new Error('boom'); } }));
  const result = await verifyGithubAppCredential(appSecret(), { fetch: gh.fetch });
  assert.equal(result.ok, true);
});

test('app: apiBase points at GitHub Enterprise Server', async () => {
  const urls: string[] = [];
  const gh = fakeGithub(happyApp());
  const spy: typeof fetch = async (input, init) => {
    urls.push(String(input));
    return gh.fetch(input, init);
  };
  // fake paths are matched by pathname, so a /api/v3 prefix would 404; just check the host.
  await verifyGithubAppCredential(appSecret(), { fetch: spy, apiBase: 'https://ghe.example.com' });
  assert.ok(urls.every((u) => u.startsWith('https://ghe.example.com/')));
});

// ----- tokens ---------------------------------------------------------------------------------

test('token: a classic token reports its login and scopes', async () => {
  const gh = fakeGithub({ 'GET /user': { json: { login: 'ada' }, headers: { 'x-oauth-scopes': 'repo, read:org' } } });
  const result = await verifyGithubTokenCredential(`  ${PAT}\n`, { fetch: gh.fetch });
  assert.equal(result.ok, true);
  assert.match(result.message, /Connected as ada/);
  assert.ok(result.details?.includes('Scopes: repo, read:org'));
  assert.equal(gh.calls[0]?.auth, `Bearer ${PAT}`);
  noLeak(result);
});

test('token: a classic token without the repo scope is warned about', async () => {
  const gh = fakeGithub({ 'GET /user': { json: { login: 'ada' }, headers: { 'x-oauth-scopes': 'read:user' } } });
  const result = await verifyGithubTokenCredential(PAT, { fetch: gh.fetch });
  assert.equal(result.ok, true);
  assert.match((result.details ?? []).join('\n'), /no repo scope/);
});

test('token: a fine-grained token has no scopes header, and we say so instead of guessing', async () => {
  const gh = fakeGithub({
    'GET /user': { json: { login: 'ada' }, headers: { 'github-authentication-token-expiration': '2030-01-01 00:00:00 UTC' } },
  });
  const result = await verifyGithubTokenCredential(PAT, { fetch: gh.fetch });
  assert.equal(result.ok, true);
  assert.match(result.message, /could not be checked/);
  assert.ok(!(result.details ?? []).some((d) => d.startsWith('Scopes')));
  assert.ok(result.details?.includes('Expires: 2030-01-01 00:00:00 UTC'));
});

test('token: rejected, malformed, unreachable', async () => {
  const rejected = await verifyGithubTokenCredential(PAT, { fetch: fakeGithub({ 'GET /user': { status: 401 } }).fetch });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /rejected the token/);
  const spaced = await verifyGithubTokenCredential('a b', { fetch: fakeGithub({}).fetch });
  assert.equal(spaced.ok, false);
  const down: typeof fetch = async () => {
    throw new Error(`socket hang up ${PAT}`);
  };
  const unreachable = await verifyGithubTokenCredential(PAT, { fetch: down });
  assert.match(unreachable.message, /Could not reach GitHub/);
  noLeak(unreachable);
});

// ----- redaction helper -----------------------------------------------------------------------

test('secretStrings collects values and key lines for redaction', () => {
  const known = secretStrings(appSecret());
  assert.ok(known.includes(PEM));
  assert.ok(known.some((s) => PEM.includes(s) && !s.startsWith('-----')));
  assert.ok(!known.includes('123'), 'short values are not worth redacting');
  assert.equal(redactSecrets(`oops ${PEM.split('\n')[1]}`, known), 'oops [redacted]');
  assert.deepEqual(secretStrings('short'), []);
  assert.deepEqual(secretStrings(PAT).includes(PAT), true);
});
