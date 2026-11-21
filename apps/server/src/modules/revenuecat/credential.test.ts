import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { apps, list, project } from '../../../../../packages/connectors/src/revenuecat/revenuecat.fixtures.ts';
import { bootRevenueCat, errorBody, json, REVENUECAT_KEY } from './test-helpers.ts';

/** The RevenueCat kind of credential: stored like the others, tested by asking RevenueCat which projects the key sees. */

const happy = (t: Awaited<ReturnType<typeof bootRevenueCat>>) => {
  t.rc.apps = [apps.ios, apps.play, apps.stripe];
};

dbTest('an unsaved key is tested against RevenueCat, and the answer names the project, not the key', async (db) => {
  const t = await bootRevenueCat(db);
  happy(t);
  const res = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'revenuecat', secret: REVENUECAT_KEY });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Connected to RevenueCat, project MagicWeather/);
  assert.deepEqual(res.body.details, ['Project: MagicWeather (3 apps, 1 of a store this tool does not read)']);
  assert.deepEqual(t.rc.calls.map((c) => c.method), ['GET', 'GET'], 'reads only');
  assert.equal(t.rc.calls[0]?.authorization, `Bearer ${REVENUECAT_KEY}`);
  assert.deepEqual(t.rc.calls.map((c) => c.path), ['/v2/projects', '/v2/projects/proj1ab2c3d4/apps']);
  assert.equal((await t.db.query('SELECT id FROM credentials WHERE kind = ?', ['revenuecat'])).length, 1, 'only the one the boot saved');
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
});

dbTest('a saved key is stored encrypted, listed without its secret, and its test is remembered', async (db) => {
  const t = await bootRevenueCat(db);
  happy(t);
  const stored = await t.db.query('SELECT ciphertext, kind FROM credentials WHERE id = ?', [t.rcCredential]);
  assert.equal(stored[0]?.kind, 'revenuecat');
  assert.ok(!String(stored[0]?.ciphertext).includes(REVENUECAT_KEY), 'the key is not in the stored value');
  const tested = await t.call(t.owner, 'POST', `/credentials/${t.rcCredential}/test`);
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  const listed = await t.call(t.owner, 'GET', '/credentials');
  const row = listed.body.credentials.find((c: { id: string }) => c.id === t.rcCredential);
  assert.equal(row.kind, 'revenuecat');
  assert.equal(row.lastTest.ok, true);
  assert.match(row.lastTest.message, /Connected to RevenueCat/);
  assert.ok(!JSON.stringify(row).includes(REVENUECAT_KEY));
  const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use');
  assert.equal(uses.length, 1);
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY), 'no response, credential or audit row holds the key');
});

dbTest('RevenueCat refusing the key, a missing permission, or an outage is a sentence and never carries the key', async (db) => {
  const t = await bootRevenueCat(db);
  const answers = [
    json(errorBody('authentication_error'), 401),
    json(errorBody('authorization_error'), 403),
    json(list([])),
    json({}, 500),
    json({}, 429, { 'retry-after': '3' }),
    new TypeError(`getaddrinfo ENOTFOUND api.revenuecat.com ${REVENUECAT_KEY}`),
  ];
  for (const answer of answers) {
    t.rc.next.push(answer);
    const res = await t.call(t.owner, 'POST', `/credentials/${t.rcCredential}/test`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.message.length > 10);
  }
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
  t.rc.projects = [project()];
});

dbTest('a key with a space or no text is refused before anything is stored or sent', async (db) => {
  const t = await bootRevenueCat(db);
  const before = t.rc.calls.length;
  for (const secret of ['sk_a b', 'sk_a\nb']) {
    assert.equal((await t.call(t.owner, 'POST', '/credentials', { kind: 'revenuecat', label: 'RC', secret })).status, 400, secret);
    const test = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'revenuecat', secret });
    assert.equal(test.status, 400);
    assert.equal(test.body.error, 'invalid_secret');
  }
  assert.equal(t.rc.calls.length, before);
});

dbTest('only owners and admins may save or test a RevenueCat credential', async (db) => {
  const t = await bootRevenueCat(db);
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  for (const cookie of [member, viewer]) {
    assert.equal((await t.call(cookie, 'POST', '/credentials', { kind: 'revenuecat', label: 'RC', secret: REVENUECAT_KEY })).status, 403);
    assert.equal((await t.call(cookie, 'POST', '/credentials/test', { kind: 'revenuecat', secret: REVENUECAT_KEY })).status, 403);
  }
  assert.equal(t.rc.calls.length, 0);
});
