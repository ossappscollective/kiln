import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { graphqlError, userViewer } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { bootRepoApp } from '../../repo-test-helpers.ts';
import { EXPO_TOKEN, FakeExpo, json } from './test-helpers.ts';

/** The Expo kind of credential: stored like the others, tested by asking Expo who the token belongs to. */

async function boot(db: Parameters<typeof bootRepoApp>[0]) {
  const expo = new FakeExpo();
  // The generic credential test calls the verifier with the network it was given.
  const t = await bootRepoApp(db, undefined, { credentialTests: { fetch: expo.fetch } });
  return { ...t, expo };
}

const everything = async (t: Awaited<ReturnType<typeof boot>>) => {
  const parts: string[] = [...t.texts];
  for (const table of ['credentials', 'audit_events']) {
    const rows = await t.db.query(`SELECT * FROM ${table}`);
    parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
  }
  return parts.join('\n');
};

dbTest('an unsaved Expo token is tested against Expo, and the answer names who it belongs to, not the token', async (db) => {
  const t = await boot(db);
  const res = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'expo', secret: EXPO_TOKEN });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Connected to Expo as mobile-release-manager/);
  assert.ok(res.body.details.includes('Type: robot user'));
  assert.equal(t.expo.calls.length, 1);
  assert.equal(t.expo.calls[0]?.authorization, `Bearer ${EXPO_TOKEN}`);
  assert.equal((await t.db.query('SELECT id FROM credentials')).length, 0, 'nothing was stored');
  assert.ok(!(await everything(t)).includes(EXPO_TOKEN));
});

dbTest('a personal token works and is told to prefer a robot user', async (db) => {
  const t = await boot(db);
  t.expo.next.push(json(userViewer()));
  const res = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'expo', secret: EXPO_TOKEN });
  assert.equal(res.body.ok, true);
  assert.ok(res.body.details.some((d: string) => /robot user with the Developer role is recommended/.test(d)));
});

dbTest('a saved Expo credential is stored encrypted, listed without its secret, and its test is remembered', async (db) => {
  const t = await boot(db);
  const id = await t.addCredential('expo', EXPO_TOKEN);
  const stored = await t.db.query('SELECT ciphertext, kind FROM credentials WHERE id = ?', [id]);
  assert.equal(stored[0]?.kind, 'expo');
  assert.ok(!String(stored[0]?.ciphertext).includes(EXPO_TOKEN));
  const tested = await t.call(t.owner, 'POST', `/credentials/${id}/test`);
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  const list = await t.call(t.owner, 'GET', '/credentials');
  const row = list.body.credentials.find((c: { id: string }) => c.id === id);
  assert.equal(row.kind, 'expo');
  assert.equal(row.lastTest.ok, true);
  assert.match(row.lastTest.message, /Connected to Expo/);
  const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use');
  assert.equal(uses.length, 1);
  assert.ok(!(await everything(t)).includes(EXPO_TOKEN));
});

dbTest('Expo refusing the token, or being unreachable, is a sentence and never carries the token', async (db) => {
  const t = await boot(db);
  const id = await t.addCredential('expo', EXPO_TOKEN);
  const answers = [
    json({}, 401),
    json({ data: { meActor: null } }),
    json(graphqlError(`Invalid token ${EXPO_TOKEN}`)),
    json({}, 500),
    new TypeError(`getaddrinfo ENOTFOUND api.expo.dev ${EXPO_TOKEN}`),
  ];
  for (const answer of answers) {
    t.expo.next.push(answer);
    const res = await t.call(t.owner, 'POST', `/credentials/${id}/test`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.message.length > 10);
  }
  assert.ok(!(await everything(t)).includes(EXPO_TOKEN));
});

dbTest('a token with a space or no text is refused before anything is stored or sent', async (db) => {
  const t = await boot(db);
  for (const secret of ['abc def', 'abc\ndef']) {
    const create = await t.call(t.owner, 'POST', '/credentials', { kind: 'expo', label: 'Expo', secret });
    assert.equal(create.status, 400, secret);
    const test = await t.call(t.owner, 'POST', '/credentials/test', { kind: 'expo', secret });
    assert.equal(test.status, 400);
    assert.equal(test.body.error, 'invalid_secret');
  }
  assert.equal(t.expo.calls.length, 0);
  assert.equal((await t.db.query('SELECT id FROM credentials')).length, 0);
});

dbTest('only owners and admins may save or test an Expo credential', async (db) => {
  const t = await boot(db);
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  for (const cookie of [member, viewer]) {
    assert.equal((await t.call(cookie, 'POST', '/credentials', { kind: 'expo', label: 'Expo', secret: EXPO_TOKEN })).status, 403);
    assert.equal((await t.call(cookie, 'POST', '/credentials/test', { kind: 'expo', secret: EXPO_TOKEN })).status, 403);
  }
  assert.equal(t.expo.calls.length, 0);
});
