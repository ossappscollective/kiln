import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExpoError, expoViewer } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import {
  appJson,
  graphqlError,
  project,
} from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { seedWorkspace } from '../../testkit.ts';
import { expoClientFor, expoFailure } from './index.ts';
import {
  bootEas,
  type EasBoot,
  EXPO_TOKEN,
  json,
  OTHER_PROJECT_ID,
  PROJECT_ID,
} from './test-helpers.ts';

/** Everything that could hold a secret, as one string: the credentials (without the ciphertext) and the audit log. */
async function dump(t: EasBoot) {
  const parts: string[] = [];
  for (const table of ['credentials', 'audit_events', 'app_expo_links']) {
    const rows = await t.db.query(`SELECT * FROM ${table}`);
    parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
  }
  return parts.join('\n');
}

const noToken = (text: string) => assert.ok(!text.includes(EXPO_TOKEN), 'the Expo token leaked');

const linkRows = async (t: EasBoot) => t.db.query('SELECT * FROM app_expo_links ORDER BY app_id');

dbTest(
  'no link at first; saving one asks Expo with the credential and stores what Expo said',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    const empty = await t.call(t.owner, 'GET', `/apps/${appId}/expo`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { link: null });
    assert.equal(t.expo.calls.length, 0, 'reading the link never calls Expo');

    // Typed with another case: the stored values are Expo's.
    const res = await t.put(appId, {
      credentialId: t.expoCredentialId,
      project: PROJECT_ID.toUpperCase(),
    });
    assert.equal(res.status, 200, res.text);
    const link = res.body.link;
    assert.equal(link.appId, appId);
    assert.equal(link.credentialId, t.expoCredentialId);
    assert.equal(link.credentialLabel, 'GitHub');
    assert.equal(link.credentialAvailable, true);
    assert.equal(link.projectId, PROJECT_ID);
    assert.equal(link.accountName, 'acme');
    assert.equal(link.slug, 'trail-notes');
    assert.equal(link.fullName, '@acme/trail-notes');
    assert.equal(link.projectName, 'Trail Notes');
    assert.ok(link.verifiedAt > 0);

    assert.equal(t.expo.calls.length, 1);
    const call = t.expo.calls[0];
    assert.equal(call?.url, 'https://api.expo.dev/graphql');
    assert.equal(call?.authorization, `Bearer ${EXPO_TOKEN}`);
    assert.deepEqual(call?.variables, { appId: PROJECT_ID });

    const again = await t.call(t.owner, 'GET', `/apps/${appId}/expo`);
    assert.deepEqual(again.body.link, link);
    noToken(await dump(t));
    for (const text of t.texts) noToken(text);
  },
);

dbTest('the project can be given as @account/slug or account/slug', async (db) => {
  const t = await bootEas(db);
  const a = await t.seedApp();
  const b = await t.seedApp({ platform: 'android' });
  assert.equal(
    (await t.put(a, { credentialId: t.expoCredentialId, project: '@acme/trail-notes' })).status,
    200,
  );
  assert.equal(
    (await t.put(b, { credentialId: t.expoCredentialId, project: 'acme/trail-notes' })).status,
    200,
  );
  assert.deepEqual(
    t.expo.calls.map((c) => c.variables),
    [{ fullName: '@acme/trail-notes' }, { fullName: '@acme/trail-notes' }],
  );
  // Two records of one product may name the same project.
  const rows = await linkRows(t);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.project_id, PROJECT_ID);
  assert.equal(rows[1]?.project_id, PROJECT_ID);
});

dbTest(
  'saving again replaces the link, keeps when it was first made, and says so in the audit',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    t.expo.projects.set(
      OTHER_PROJECT_ID,
      project({ id: OTHER_PROJECT_ID, slug: 'other', fullName: '@acme/other', name: 'Other' }),
    );
    const first = await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
    const second = await t.put(appId, { credentialId: t.expoCredentialId, project: '@acme/other' });
    assert.equal(second.status, 200);
    assert.equal(second.body.link.projectId, OTHER_PROJECT_ID);
    assert.equal(second.body.link.createdAt, first.body.link.createdAt);
    assert.ok(second.body.link.updatedAt > first.body.link.createdAt);
    assert.equal((await linkRows(t)).length, 1);
    const sets = (await t.auditActions()).filter((a) => a.action === 'eas.link_set');
    assert.equal(sets.length, 2);
    assert.equal(JSON.parse(sets[0]?.detail ?? '{}').replaced, false);
    assert.equal(JSON.parse(sets[1]?.detail ?? '{}').replaced, true);
    assert.equal(sets[1]?.targetId, appId);
    assert.equal(JSON.parse(sets[1]?.detail ?? '{}').projectId, OTHER_PROJECT_ID);
  },
);

dbTest(
  'saving audits the use of the credential, and nothing in the audit holds the token',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
    const uses = (await t.auditActions()).filter(
      (a) => a.action === 'credential.use' && a.targetId === t.expoCredentialId,
    );
    assert.equal(uses.length, 1);
    assert.deepEqual(JSON.parse(uses[0]?.detail ?? '{}'), { purpose: 'eas.link' });
    noToken(await dump(t));
  },
);

dbTest(
  'a bad credential, a bad project or a refusal by Expo saves nothing and says why',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    const githubCredential = await t.addCredential('github_token');
    const ok = { credentialId: t.expoCredentialId, project: PROJECT_ID };

    const kind = await t.put(appId, { ...ok, credentialId: githubCredential });
    assert.equal(kind.status, 422);
    assert.equal(kind.body.error, 'credential_kind');
    const missing = await t.put(appId, { ...ok, credentialId: 'nope' });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error, 'credential_not_found');
    const bad = await t.put(appId, { ...ok, project: 'not a project' });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'invalid_project');
    assert.equal(t.expo.calls.length, 0, 'none of these reached Expo');

    const refused: [Response | Error, number, string][] = [
      [json({}, 401), 422, 'expo_auth'],
      [json({}, 403), 422, 'expo_forbidden'],
      [json(graphqlError('Entity not authorized')), 422, 'expo_forbidden'],
      [json(graphqlError('Experience with id x does not exist')), 422, 'expo_not_found'],
      [json({}, 500), 502, 'expo_unavailable'],
      [json({ data: { nothing: 1 } }), 502, 'expo_unavailable'],
      [new TypeError(`connect ECONNREFUSED ${EXPO_TOKEN}`), 502, 'expo_unavailable'],
    ];
    for (const [answer, status, code] of refused) {
      t.expo.next.push(answer);
      const res = await t.put(appId, ok);
      assert.equal(res.status, status, code);
      assert.equal(res.body.error, code);
      noToken(res.text);
    }
    const unknown = await t.put(appId, { ...ok, project: OTHER_PROJECT_ID });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, 'expo_not_found');

    t.expo.next.push(json({}, 429, { 'retry-after': '17' }));
    const slow = await t.put(appId, ok);
    assert.equal(slow.status, 429);
    assert.equal(slow.headers.get('retry-after'), '17');
    assert.equal(slow.body.retryAfterSeconds, 17);

    assert.equal((await linkRows(t)).length, 0, 'nothing was saved');
    assert.equal((await t.auditActions()).filter((a) => a.action === 'eas.link_set').length, 0);
    noToken(await dump(t));
  },
);

dbTest('a malformed body is a 400', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  for (const body of [
    {},
    { credentialId: t.expoCredentialId },
    { project: PROJECT_ID },
    { credentialId: '', project: PROJECT_ID },
    { credentialId: 'x', project: '  ' },
    { credentialId: 'x', project: PROJECT_ID, extra: 1 },
  ]) {
    const res = await t.put(appId, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'invalid_request');
  }
  assert.equal(t.expo.calls.length, 0);
});

dbTest('who may do what: members read, admins change, strangers see nothing', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  const saved = await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  assert.equal(saved.status, 200);
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  const body = { credentialId: t.expoCredentialId, project: PROJECT_ID };

  for (const cookie of [member, viewer]) {
    assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/expo`)).status, 200);
    assert.equal((await t.put(appId, body, cookie)).status, 403);
    assert.equal((await t.call(cookie, 'DELETE', `/apps/${appId}/expo`)).status, 403);
    assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/expo/detect`)).status, 403);
  }
  assert.equal((await t.put(appId, body, admin)).status, 200);
  assert.equal((await linkRows(t)).length, 1, 'still linked after the refusals');

  const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
  for (const [method, path] of [
    ['GET', `/apps/${appId}/expo`],
    ['PUT', `/apps/${appId}/expo`],
    ['DELETE', `/apps/${appId}/expo`],
    ['GET', `/apps/${appId}/expo/detect`],
  ] as const) {
    assert.equal(
      (await t.call(other.cookie, method, path, method === 'PUT' ? body : undefined)).status,
      404,
      path,
    );
    // Their own workspace has no such app.
    assert.equal(
      (
        await t.call(
          other.cookie,
          method,
          path,
          method === 'PUT' ? body : undefined,
          other.workspaceId,
        )
      ).status,
      404,
      path,
    );
  }
  // Not signed in.
  const anonymous = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${appId}/expo`);
  assert.equal(anonymous.status, 401);
  // An app of another workspace cannot be linked through this one.
  const foreign = await t.seedApp({ workspaceId: other.workspaceId, repositoryId: null });
  assert.equal((await t.put(foreign, body)).status, 404);
});

dbTest('a credential of another workspace cannot be used', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
  const theirs = await t.addCredential(
    'expo',
    'expo_tok_theirs_0123456789abcdef',
    other.cookie,
    other.workspaceId,
  );
  const res = await t.put(appId, { credentialId: theirs, project: PROJECT_ID });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'credential_not_found');
  assert.equal(t.expo.calls.length, 0);
});

dbTest(
  'removing the link: audited, nothing at Expo, the credential stays, a second removal is a 404',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
    const calls = t.expo.calls.length;
    const res = await t.call(t.owner, 'DELETE', `/apps/${appId}/expo`);
    assert.equal(res.status, 204);
    assert.equal(t.expo.calls.length, calls, 'removing never calls Expo');
    assert.deepEqual((await t.call(t.owner, 'GET', `/apps/${appId}/expo`)).body, { link: null });
    const removed = (await t.auditActions()).filter((a) => a.action === 'eas.link_remove');
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.targetId, appId);
    assert.equal(JSON.parse(removed[0]?.detail ?? '{}').fullName, '@acme/trail-notes');
    assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}/expo`)).status, 404);
    assert.equal(
      (await t.call(t.owner, 'GET', '/credentials')).body.credentials.some(
        (c: { id: string }) => c.id === t.expoCredentialId,
      ),
      true,
    );
  },
);

dbTest('a deleted credential leaves the link, which says it needs another', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  assert.equal((await t.call(t.owner, 'DELETE', `/credentials/${t.expoCredentialId}`)).status, 204);
  const link = (await t.call(t.owner, 'GET', `/apps/${appId}/expo`)).body.link;
  assert.equal(link.credentialAvailable, false);
  assert.equal(link.credentialLabel, null);
  assert.equal(link.projectId, PROJECT_ID);
  // Choosing another credential repairs it.
  const next = await t.addCredential('expo', 'expo_tok_second_0123456789abcdef');
  const fixed = await t.put(appId, { credentialId: next, project: PROJECT_ID });
  assert.equal(fixed.body.link.credentialAvailable, true);
});

dbTest('deleting the app removes its link', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  const keep = await t.seedApp({ platform: 'android' });
  await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  await t.put(keep, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  assert.deepEqual(
    (await linkRows(t)).map((r) => r.app_id),
    [keep],
  );
});

dbTest(
  'a token limited to one app can link only that app; one with no list of apps cannot touch these without apps.write',
  async (db) => {
    const t = await bootEas(db);
    const a1 = await t.seedApp({ id: 'a1' });
    const a2 = await t.seedApp({ id: 'a2' });
    const made = await t.call(t.owner, 'POST', '/tokens', {
      name: 'CI',
      role: 'admin',
      appIds: [a1],
    });
    const token = made.body.token as string;
    const send = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const body = { credentialId: t.expoCredentialId, project: PROJECT_ID };
    assert.equal((await send('PUT', `/apps/${a1}/expo`, body)).status, 200);
    assert.equal((await send('GET', `/apps/${a1}/expo`)).status, 200);
    assert.equal((await send('PUT', `/apps/${a2}/expo`, body)).status, 404);
    assert.equal((await send('GET', `/apps/${a2}/expo`)).status, 404);
    assert.equal((await send('DELETE', `/apps/${a2}/expo`)).status, 404);
    // The audit names the token and the person it acts for.
    const row = (await t.auditActions()).find((a) => a.action === 'eas.link_set');
    assert.equal(row?.actorType, 'token');
    // A viewer token may read the link of its app and nothing else.
    const viewerToken = (await t.call(t.owner, 'POST', '/tokens', { name: 'V', role: 'viewer' }))
      .body.token as string;
    const asViewer = (method: string, path: string, body?: unknown) =>
      t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${viewerToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal((await asViewer('GET', `/apps/${a1}/expo`)).status, 200);
    assert.equal((await asViewer('PUT', `/apps/${a1}/expo`, body)).status, 403);
  },
);

dbTest('the limit: 20 saves a minute per workspace', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  const body = { credentialId: t.expoCredentialId, project: PROJECT_ID };
  for (let i = 0; i < 20; i++) assert.equal((await t.put(appId, body)).status, 200);
  const res = await t.put(appId, body);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

// ----- detecting the project from the repository ------------------------------------------------

const detect = (t: EasBoot, appId: string) => t.call(t.owner, 'GET', `/apps/${appId}/expo/detect`);

dbTest(
  'detect reads app.json as JSON: the project id, the owner and the slug; nothing is saved',
  async (db) => {
    const t = await bootEas(db);
    t.repo.files.set('app.json', appJson());
    const appId = await t.seedApp();
    const res = await detect(t, appId);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.detection, {
      detected: {
        projectId: PROJECT_ID,
        owner: 'acme',
        slug: 'trail-notes',
        fullName: '@acme/trail-notes',
        path: 'app.json',
      },
      reason: null,
      message: null,
    });
    assert.equal(t.expo.calls.length, 0, 'detecting never calls Expo');
    assert.equal((await linkRows(t)).length, 0);
    const uses = (await t.auditActions()).filter(
      (a) => a.action === 'credential.use' && JSON.parse(a.detail || '{}').purpose === 'eas.detect',
    );
    assert.equal(uses.length, 1);
  },
);

dbTest('detect says why it found nothing', async (db) => {
  const t = await bootEas(db);
  const appId = await t.seedApp();
  const reason = async () => (await detect(t, appId)).body.detection;

  assert.equal((await reason()).reason, 'no_app_json');
  assert.equal((await reason()).detected, null);

  t.repo.files.set('app.json', 'not json at all');
  assert.equal((await reason()).reason, 'unreadable');
  t.repo.files.set('app.json', '{"expo":{"name":"X"}}');
  const noId = await reason();
  assert.equal(noId.reason, 'no_project_id');
  assert.match(noId.message, /eas init/);
  // owner and slug alone still prefill the name.
  t.repo.files.set('app.json', '{"expo":{"owner":"acme","slug":"trail-notes"}}');
  const named = await reason();
  assert.equal(named.reason, null);
  assert.equal(named.detected.projectId, null);
  assert.equal(named.detected.fullName, '@acme/trail-notes');

  const bare = await t.seedApp({ repositoryId: null });
  const none = (await detect(t, bare)).body.detection;
  assert.equal(none.reason, 'no_repository');
  assert.equal(none.detected, null);
});

dbTest('a dynamic app.config.js is never run: detect says so', async (db) => {
  const t = await bootEas(db);
  t.repo.files.set('package.json', '{"dependencies":{"expo":"~52.0.0"}}');
  t.repo.files.set(
    'app.config.js',
    'module.exports = { expo: { extra: { eas: { projectId: "x" } } } };',
  );
  const appId = await t.seedApp();
  assert.equal((await t.call(t.owner, 'POST', `/repositories/${t.repositoryId}/scan`)).status, 200);
  const res = await detect(t, appId);
  assert.equal(res.body.detection.reason, 'dynamic_config');
  assert.equal(res.body.detection.detected, null);
});

dbTest(
  'detect: a repository that cannot be read is a sentence, a rate limit is a 429',
  async (db) => {
    const t = await bootEas(db);
    const appId = await t.seedApp();
    t.repo.readFile = async () => {
      throw new Error('boom ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    };
    const res = await detect(t, appId);
    assert.equal(res.status, 200);
    assert.equal(res.body.detection.reason, 'read_failed');
    assert.ok(!res.text.includes('ghp_'));
    // The credential of the repository is gone.
    await db.execute("DELETE FROM credentials WHERE kind = 'github_token'");
    const gone = await detect(t, appId);
    assert.equal(gone.body.detection.reason, 'repository_unavailable');
  },
);

// ----- the seam other features use --------------------------------------------------------------

dbTest(
  'expoClientFor: a client for one credential, audited with the purpose, refusing what is not an Expo credential',
  async (db) => {
    const t = await bootEas(db);
    const use = {
      actor: { type: 'system' as const, id: 'status-sync' },
      purpose: 'eas.builds',
      now: 1_800_000_000_000,
    };
    const opened = await expoClientFor(
      db,
      t.masterKey,
      t.workspaceId,
      t.expoCredentialId,
      { fetch: t.expo.fetch, apiOrigin: 'https://proxy.example.com' },
      use,
    );
    assert.ok(opened.ok);
    const who = await expoViewer(opened.client);
    assert.equal(who?.kind, 'robot');
    assert.equal(t.expo.calls[0]?.url, 'https://proxy.example.com/graphql');
    assert.equal(t.expo.calls[0]?.authorization, `Bearer ${EXPO_TOKEN}`);
    // The client does not expose the token.
    assert.ok(!JSON.stringify(opened.client).includes(EXPO_TOKEN));
    assert.ok(
      !Object.values(opened.client).some((v) => typeof v === 'string' && v.includes(EXPO_TOKEN)),
    );
    const uses = (await t.auditActions()).filter(
      (a) => a.action === 'credential.use' && a.targetId === t.expoCredentialId,
    );
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.actorType, 'system');
    assert.equal(uses[0]?.actorId, 'status-sync');
    assert.deepEqual(JSON.parse(uses[0]?.detail ?? '{}'), { purpose: 'eas.builds' });

    const github = await t.addCredential('github_token');
    const refusals: [string, string][] = [
      [github, 'credential_kind'],
      ['nope', 'credential_not_found'],
    ];
    for (const [id, code] of refusals) {
      const refused = await expoClientFor(db, t.masterKey, t.workspaceId, id, undefined, use);
      assert.ok(!refused.ok);
      assert.equal(refused.body.error, code);
    }
    const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
    const foreign = await expoClientFor(
      db,
      t.masterKey,
      other.workspaceId,
      t.expoCredentialId,
      undefined,
      use,
    );
    assert.ok(!foreign.ok);
    assert.equal(foreign.body.error, 'credential_not_found');
    // A secret that no longer decrypts (another master key).
    const wrongKey = await expoClientFor(
      db,
      Buffer.alloc(32, 7),
      t.workspaceId,
      t.expoCredentialId,
      undefined,
      use,
    );
    assert.ok(!wrongKey.ok);
    assert.equal(wrongKey.body.error, 'credential_unreadable');
    // Only the first call was a use.
    const after = (await t.auditActions()).filter(
      (a) => a.action === 'credential.use' && a.targetId === t.expoCredentialId,
    );
    assert.equal(after.length, 1);
  },
);

test('expoFailure: one code per kind, a timeout is a 504, a rate limit says how long, and unknown errors say nothing of themselves', () => {
  const rows: [ExpoError, number, string][] = [
    [new ExpoError('auth'), 422, 'expo_auth'],
    [new ExpoError('forbidden'), 422, 'expo_forbidden'],
    [new ExpoError('not_found'), 422, 'expo_not_found'],
    [new ExpoError('invalid_input'), 422, 'invalid_project'],
    [new ExpoError('server'), 502, 'expo_unavailable'],
    [new ExpoError('unexpected'), 502, 'expo_unavailable'],
    [new ExpoError('network'), 502, 'expo_unavailable'],
    [new ExpoError('network', { timedOut: true }), 504, 'timeout'],
  ];
  for (const [error, status, code] of rows) {
    const f = expoFailure(error);
    assert.equal(f.status, status, code);
    assert.equal(f.body.error, code);
  }
  const limited = expoFailure(new ExpoError('rate_limited', { retryAfterSeconds: 9 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers?.['Retry-After'], '9');
  const unknown = expoFailure(new Error(`secret ${EXPO_TOKEN}`));
  assert.equal(unknown.status, 502);
  assert.ok(!JSON.stringify(unknown).includes(EXPO_TOKEN));
});
