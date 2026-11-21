import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apps, errorBody, fakeFetch, KEY, list, PROJECT_ID, project } from './revenuecat.fixtures.ts';
import { verifyRevenueCatCredential } from './verify-revenuecat.ts';

test('Test connection names the projects and counts their apps, and reads only projects and apps', async () => {
  const f = fakeFetch((call) => (call.path === '/v2/projects' ? { body: list([project()]) } : { body: list([apps.ios, apps.play, apps.stripe]) }));
  const result = await verifyRevenueCatCredential(KEY, { fetch: f.fetch });
  assert.equal(result.ok, true);
  assert.match(result.message, /project MagicWeather/);
  assert.deepEqual(result.details, ['Project: MagicWeather (3 apps, 1 of a store this tool does not read)']);
  assert.deepEqual(f.calls.map((c) => c.path), ['/v2/projects', `/v2/projects/${PROJECT_ID}/apps`]);
  assert.ok(f.calls.every((c) => c.init.method === 'GET'));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('Test connection: an unknown key, a missing permission, no project, a public key and an outage each get one clear sentence', async () => {
  const auth = await verifyRevenueCatCredential('appl_publicSdkKey0123456789', {
    fetch: fakeFetch(() => ({ status: 401, body: errorBody('authentication_error') })).fetch,
  });
  assert.equal(auth.ok, false);
  assert.match(auth.message, /did not accept the secret API key/);
  assert.ok(auth.details?.some((d) => /does not start with sk_/.test(d)));
  assert.ok(auth.details?.some((d) => d === 'HTTP status: 401'));

  const noProjects = await verifyRevenueCatCredential(KEY, { fetch: fakeFetch(() => ({ body: list([]) })).fetch });
  assert.equal(noProjects.ok, false);
  assert.match(noProjects.message, /sees no project/);

  const noRead = await verifyRevenueCatCredential(KEY, { fetch: fakeFetch(() => ({ status: 403, body: errorBody('authorization_error') })).fetch });
  assert.equal(noRead.ok, false);
  assert.match(noRead.message, /may not read this/);

  const noApps = await verifyRevenueCatCredential(KEY, {
    fetch: fakeFetch((call) => (call.path === '/v2/projects' ? { body: list([project()]) } : { status: 403, body: errorBody('authorization_error') })).fetch,
  });
  assert.equal(noApps.ok, false);
  assert.match(noApps.message, /may not read the apps/);

  const down = await verifyRevenueCatCredential(KEY, { fetch: fakeFetch(() => new Error('boom')).fetch });
  assert.equal(down.ok, false);
  assert.match(down.message, /Could not reach RevenueCat/);

  const limited = await verifyRevenueCatCredential(KEY, { fetch: fakeFetch(() => ({ status: 429, headers: { 'retry-after': '5' }, body: {} })).fetch });
  assert.match(limited.message, /slow down/);

  assert.deepEqual(await verifyRevenueCatCredential('  '), { ok: false, message: 'Enter the secret API key.' });
  assert.equal((await verifyRevenueCatCredential('sk_a b')).ok, false);
  for (const r of [auth, noProjects, noRead, noApps, down, limited]) assert.ok(!JSON.stringify(r).includes(KEY));
});
