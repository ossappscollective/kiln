import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Platform } from '@mrm/core';
import {
  type StoreApp,
  type StoreBuild,
  type StoreConnector,
  StoreError,
  StoreRateLimitError,
  type StoreVersion,
} from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import type { createApp } from './app.ts';
import { createWorker } from './jobs.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import {
  type AppsContext,
  type StoreConnectorFactory,
  type StoreConnectorInput,
  createAppSyncHandler,
  defaultStoreConnectorFactory,
} from './services/apps.ts';
import { createTestLimiter } from './services/credential-tests.ts';

// Everything here runs against fakes: no store is ever contacted.

const KEY_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTOPSECRETKEYBODY';
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}\n-----END PRIVATE KEY-----`;
const ASC_SECRET = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: PEM });
const PLAY_SECRET = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: PEM });
const LEAKS = [KEY_LINE, 'bot@proj.iam.gserviceaccount.com'];

type SyncOverrides = NonNullable<Parameters<typeof createApp>[0]['appSync']>;

const ios = (
  versionString: string,
  rawState: string,
  lifecycleState?: StoreVersion['lifecycleState'],
): StoreVersion => ({
  storeId: `v-${versionString}`,
  appStoreId: '1234567890',
  platform: 'ios',
  versionString,
  rawState,
  ...(lifecycleState ? { lifecycleState } : {}),
});

const play = (
  track: string,
  versionString: string,
  rawState: string,
  codes: string[],
  lifecycleState?: StoreVersion['lifecycleState'],
  rolloutFraction?: number,
): StoreVersion => ({
  storeId: `${track}:${codes.join(',')}`,
  appStoreId: 'com.acme.app',
  platform: 'android',
  versionString,
  rawState,
  track,
  versionCodes: codes,
  ...(lifecycleState ? { lifecycleState } : {}),
  ...(rolloutFraction !== undefined ? { rolloutFraction } : {}),
});

const build = (
  buildNumber: string,
  versionString: string,
  uploadedAt: number,
  extra: Partial<StoreBuild> = {},
): StoreBuild => ({
  storeId: `b-${buildNumber}`,
  appStoreId: '1234567890',
  platform: 'ios',
  buildNumber,
  versionString,
  processing: 'processed',
  uploadedAt,
  ...extra,
});

/** A connector that answers from tables, remembers what it was asked, and can be made to fail. */
class FakeStore implements StoreConnector {
  readonly platform: Platform;
  apps: StoreApp[] = [{ storeId: '1234567890', platform: 'ios', name: 'Acme', bundleId: 'com.acme.app' }];
  versions: StoreVersion[] = [];
  builds: StoreBuild[] = [];
  error: unknown;
  delayMs = 0;
  gate?: Promise<void>;
  calls: string[] = [];
  constructor(platform: Platform) {
    this.platform = platform;
  }
  async #enter(call: string) {
    this.calls.push(call);
    if (this.gate) await this.gate;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.error) throw this.error;
  }
  async verifyCredentials() {}
  async listApps() {
    await this.#enter('listApps');
    return this.apps;
  }
  async listVersions(id: string) {
    await this.#enter(`listVersions:${id}`);
    return this.versions;
  }
  async listBuilds(id: string) {
    await this.#enter(`listBuilds:${id}`);
    return this.builds;
  }
}

async function boot(db: Parameters<typeof bootRepoApp>[0], sync: SyncOverrides = {}) {
  const stores = { ios: new FakeStore('ios'), android: new FakeStore('android') };
  const built: StoreConnectorInput[] = [];
  const factory: StoreConnectorFactory = (input) => {
    built.push(input);
    return input.kind === 'app_store_connect' ? stores.ios : stores.android;
  };
  const masterKey = randomBytes(32);
  const t = await bootRepoApp(db, undefined, {
    masterKey,
    appSync: { connectorFactory: factory, ...sync },
  });
  const iosCredential = await t.addCredential('app_store_connect', ASC_SECRET);
  const playCredential = await t.addCredential('google_play', PLAY_SECRET);
  const addIos = (extra: Record<string, unknown> = {}) =>
    t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: 'com.acme.app',
      credentialId: iosCredential,
      name: 'Acme',
      ...extra,
    });
  const addAndroid = (extra: Record<string, unknown> = {}) =>
    t.call(t.owner, 'POST', '/apps', {
      platform: 'android',
      identifier: 'com.acme.app',
      credentialId: playCredential,
      ...extra,
    });
  const ctx = (overrides: Partial<AppsContext> = {}): AppsContext => {
    let clock = Date.now();
    return { db, masterKey, now: () => ++clock, connectorFactory: factory, timeoutMs: 5_000, ...overrides };
  };
  const noLeaks = () => {
    for (const text of t.texts) {
      for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak.slice(0, 10)}`);
    }
  };
  return { ...t, stores, built, iosCredential, playCredential, addIos, addAndroid, ctx, noLeaks };
}

const syncPath = (id: string) => `/apps/${id}/sync`;

// ---------------------------------------------------------------------------------------------
// Rights and isolation

dbTest('rights: viewers read, members read and sync, only admins add and remove', async (db) => {
  const t = await boot(db);
  const created = await t.addIos();
  assert.equal(created.status, 201);
  const id = created.body.app.id as string;
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_SALE', 'live')];

  for (const cookie of [viewer, member, admin]) {
    assert.equal((await t.call(cookie, 'GET', '/apps')).status, 200);
    assert.equal((await t.call(cookie, 'GET', `/apps/${id}`)).status, 200);
  }
  const body = { platform: 'android', identifier: 'com.acme.other', credentialId: t.playCredential };
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'POST', '/apps', body)).status, 403);
    assert.equal((await t.call(cookie, 'DELETE', `/apps/${id}`)).status, 403);
  }
  assert.equal((await t.call(viewer, 'POST', syncPath(id))).status, 403);
  assert.equal((await t.call(member, 'POST', syncPath(id))).status, 200);
  assert.equal((await t.call(admin, 'POST', syncPath(id))).status, 200);
  assert.equal((await t.call(admin, 'POST', '/apps', body)).status, 201);
  assert.equal((await t.call(admin, 'DELETE', `/apps/${id}`)).status, 204);
  assert.equal((await t.call(t.owner, 'GET', `/apps/${id}`)).status, 404);
});

dbTest('a non-member and an unknown workspace get 404 everywhere, and see nothing', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const calls: [string, string, unknown?][] = [
    ['GET', '/apps'],
    ['POST', '/apps', { platform: 'ios', identifier: 'com.x.y', credentialId: t.iosCredential }],
    ['GET', `/apps/${id}`],
    ['DELETE', `/apps/${id}`],
    ['POST', syncPath(id)],
  ];
  for (const [method, path, body] of calls) {
    const res = await t.call(outsider, method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
  assert.equal((await t.call(t.owner, 'GET', '/apps', undefined, 'no-such-workspace')).status, 404);
  assert.equal(t.stores.ios.calls.length, 0);
});

dbTest('workspaces are isolated: their apps and ids never mix', async (db) => {
  const t = await boot(db);
  const mine = (await t.addIos()).body.app.id as string;
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const theirCredential = await t.addCredential('app_store_connect', ASC_SECRET, outsider, 'other');
  // The same bundle id in another workspace is a different app.
  const theirs = await t.call(
    outsider,
    'POST',
    '/apps',
    { platform: 'ios', identifier: 'com.acme.app', credentialId: theirCredential },
    'other',
  );
  assert.equal(theirs.status, 201);
  assert.equal((await t.call(outsider, 'GET', '/apps', undefined, 'other')).body.apps.length, 1);
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 1);
  // An id from one workspace is unknown in the other, even for its owner.
  assert.equal((await t.call(outsider, 'GET', `/apps/${mine}`, undefined, 'other')).status, 404);
  assert.equal((await t.call(outsider, 'POST', syncPath(mine), undefined, 'other')).status, 404);
  assert.equal((await t.call(outsider, 'DELETE', `/apps/${mine}`, undefined, 'other')).status, 404);
  // The main workspace's credential cannot be used from the other workspace either.
  const cross = await t.call(
    outsider,
    'POST',
    '/apps',
    { platform: 'ios', identifier: 'com.other.app', credentialId: t.iosCredential },
    'other',
  );
  assert.equal(cross.status, 422);
  assert.equal(cross.body.error, 'credential_not_found');
  assert.equal((await t.call(t.owner, 'GET', `/apps/${mine}`)).status, 200);
});

// ---------------------------------------------------------------------------------------------
// Add and remove

dbTest('create validates the credential, the identifier, the repository and duplicates', async (db) => {
  const t = await boot(db);
  const ok = await t.addIos({ name: undefined });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.app.name, 'com.acme.app', 'the name defaults to the identifier');
  assert.equal(ok.body.app.platform, 'ios');
  assert.equal(ok.body.app.lastSyncedAt, null);
  assert.equal(ok.body.app.lastSyncError, null);
  assert.equal(ok.body.app.repositoryId, null);
  assert.equal(t.stores.ios.calls.length, 0, 'creating an app does not contact the store');

  // The wrong kind of credential, either way round.
  const iosWithPlay = await t.call(t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.b.c',
    credentialId: t.playCredential,
  });
  assert.equal(iosWithPlay.status, 422);
  assert.equal(iosWithPlay.body.error, 'credential_kind');
  const androidWithAsc = await t.addAndroid({ credentialId: t.iosCredential });
  assert.equal(androidWithAsc.status, 422);
  assert.equal(androidWithAsc.body.error, 'credential_kind');
  const github = await t.addCredential();
  assert.equal((await t.addAndroid({ credentialId: github })).body.error, 'credential_kind');
  assert.equal((await t.addIos({ identifier: 'com.b.c', credentialId: 'nope' })).body.error, 'credential_not_found');

  // Identifiers are checked per platform.
  for (const identifier of ['', 'has space', 'a/b', '../x']) {
    assert.equal((await t.addIos({ identifier })).status, 400, `ios ${identifier}`);
  }
  for (const identifier of ['nodots', '1bad.pkg', 'com.acme app']) {
    const res = await t.addAndroid({ identifier });
    assert.equal(res.status, 400, `android ${identifier}`);
    assert.equal(res.body.issues[0].path, 'identifier');
  }
  const badPlatform = await t.call(t.owner, 'POST', '/apps', {
    platform: 'windows',
    identifier: 'a.b',
    credentialId: t.iosCredential,
  });
  assert.equal(badPlatform.status, 400);
  assert.equal((await t.addIos({ identifier: 'com.b.c', name: 'two\nlines' })).status, 400);

  // Duplicates: bundle ids ignore case, package names do not, and the platform matters.
  const again = await t.addIos({ identifier: 'COM.Acme.App' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_exists');
  assert.equal((await t.addAndroid()).status, 201, 'same identifier on the other platform');
  assert.equal((await t.addAndroid()).status, 409);
  assert.equal((await t.addAndroid({ identifier: 'com.Acme.app' })).status, 201);

  assert.equal((await t.addIos({ identifier: 'com.b.c', repositoryId: 'nope' })).body.error, 'repository_not_found');
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 3);
});

dbTest('an app can link a repository of the workspace, and loses the link when it is disconnected', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const created = await t.addIos({ repositoryId });
  assert.equal(created.status, 201);
  assert.equal(created.body.app.repositoryId, repositoryId);
  const del = await t.call(t.owner, 'DELETE', `/repositories/${repositoryId}`);
  assert.equal(del.status, 204);
  const after = await t.call(t.owner, 'GET', `/apps/${created.body.app.id}`);
  assert.equal(after.body.app.repositoryId, null);
});

dbTest('delete removes the app and its releases, and every mutation is audited', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_SALE', 'live')];
  assert.equal((await t.call(t.owner, 'POST', syncPath(id))).status, 200);
  assert.equal((await db.query('SELECT id FROM app_releases WHERE app_id = ?', [id])).length, 1);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${id}`)).status, 204);
  assert.equal((await db.query('SELECT id FROM app_releases WHERE app_id = ?', [id])).length, 0);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${id}`)).status, 404);

  const actions = await t.auditActions();
  const mine = actions.filter((a) => a.action.startsWith('app.'));
  assert.deepEqual(
    mine.map((a) => a.action),
    ['app.create', 'app.sync', 'app.delete'],
  );
  assert.ok(mine.every((a) => a.targetId === id));
  const use = actions.filter((a) => a.action === 'credential.use');
  assert.equal(use.length, 1);
  assert.match(use[0]?.detail ?? '', /app\.sync/);
  for (const a of actions) for (const leak of LEAKS) assert.ok(!a.detail.includes(leak));
  t.noLeaks();
});

// ---------------------------------------------------------------------------------------------
// Sync

dbTest('sync reads an iOS app: finds the Apple id, maps states, attaches the newest build', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [
    ios('2.1', 'WAITING_FOR_REVIEW', 'in_review'),
    ios('2.0', 'READY_FOR_DISTRIBUTION', 'live'),
    ios('1.8', 'SOMETHING_NEW'),
  ];
  t.stores.ios.builds = [
    build('41', '2.1', 1_000),
    build('42', '2.1', 2_000),
    build('43', '2.1', 3_000, { processing: 'processing' }),
    build('40', '2.0', 500),
  ];
  const res = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ...res.body.sync, at: undefined },
    { at: undefined, found: 3, added: 3, updated: 0, removed: 0, unmapped: 1 },
  );
  assert.deepEqual(t.stores.ios.calls, ['listApps', 'listVersions:1234567890', 'listBuilds:1234567890']);
  // Built from the decrypted credential, with the right kind and identifier.
  assert.equal(t.built.length, 1);
  assert.equal(t.built[0]?.kind, 'app_store_connect');
  assert.equal(t.built[0]?.secret, ASC_SECRET);
  assert.equal(t.built[0]?.identifier, 'com.acme.app');

  const releases = res.body.releases as Record<string, unknown>[];
  const byVersion = Object.fromEntries(releases.map((r) => [r.version as string, r]));
  assert.equal(byVersion['2.1']?.status, 'in_review');
  assert.equal(byVersion['2.1']?.rawState, 'WAITING_FOR_REVIEW');
  assert.equal(byVersion['2.1']?.build, '42', 'the newest processed build of that version');
  assert.equal(byVersion['2.1']?.storeUpdatedAt, 2_000);
  assert.equal(byVersion['2.0']?.status, 'live');
  assert.equal(byVersion['2.0']?.build, '40');
  assert.equal(byVersion['1.8']?.status, null, 'an unmapped state is not guessed');
  assert.equal(byVersion['1.8']?.rawState, 'SOMETHING_NEW');
  assert.equal(byVersion['1.8']?.build, null);
  assert.ok(releases.every((r) => r.track === null && r.versionCodes === null && r.platform === 'ios'));
  assert.equal(res.body.app.storeAppId, '1234567890');
  assert.equal(res.body.app.lastSyncError, null);
  assert.equal(res.body.app.lastSyncedAt, res.body.sync.at);

  const one = await t.call(t.owner, 'GET', `/apps/${id}`);
  assert.deepEqual(one.body.releases, res.body.releases);

  // The Apple id is remembered: the next sync does not list the team's apps again.
  t.stores.ios.calls.length = 0;
  assert.equal((await t.call(t.owner, 'POST', syncPath(id))).status, 200);
  assert.deepEqual(t.stores.ios.calls, ['listVersions:1234567890', 'listBuilds:1234567890']);
  t.noLeaks();
});

dbTest('sync reads an Android app: one release per track, with version codes and rollout', async (db) => {
  const t = await boot(db);
  const id = (await t.addAndroid()).body.app.id as string;
  t.stores.android.versions = [
    play('production', '2.4.0', 'inProgress', ['240', '241'], 'rolling_out', 0.2),
    play('production', '2.3.0', 'completed', ['230'], 'live'),
    play('internal', '2.5.0', 'draft', ['250'], 'draft'),
    play('beta', '2.4.1', 'statusUnspecified', []),
  ];
  const res = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(res.status, 200);
  assert.equal(res.body.sync.found, 4);
  assert.equal(res.body.sync.unmapped, 1);
  assert.deepEqual(t.stores.android.calls, ['listVersions:com.acme.app']);
  assert.equal(t.built[0]?.kind, 'google_play');
  assert.equal(res.body.app.storeAppId, 'com.acme.app');

  const find = (version: string) => res.body.releases.find((r: { version: string }) => r.version === version);
  const rollout = find('2.4.0');
  assert.equal(rollout.track, 'production');
  assert.equal(rollout.status, 'rolling_out');
  assert.equal(rollout.rawState, 'inProgress');
  assert.equal(rollout.rolloutFraction, 0.2);
  assert.deepEqual(rollout.versionCodes, ['240', '241']);
  assert.equal(rollout.build, '240,241');
  assert.equal(rollout.storeUpdatedAt, null);
  assert.equal(find('2.3.0').rolloutFraction, null);
  assert.equal(find('2.4.1').status, null);
  assert.equal(find('2.4.1').build, null);
  assert.deepEqual(
    res.body.releases.map((r: { track: string }) => r.track),
    ['beta', 'internal', 'production', 'production'],
  );
});

dbTest('syncing again is idempotent; changes update in place and vanished releases are removed', async (db) => {
  const t = await boot(db);
  const id = (await t.addAndroid()).body.app.id as string;
  t.stores.android.versions = [
    play('production', '2.3.0', 'completed', ['230'], 'live'),
    play('beta', '2.4.0', 'draft', ['240'], 'draft'),
  ];
  const first = await t.call(t.owner, 'POST', syncPath(id));
  const second = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(second.status, 200);
  assert.deepEqual(
    { ...second.body.sync, at: undefined },
    { at: undefined, found: 2, added: 0, updated: 0, removed: 0, unmapped: 0 },
  );
  const ids = (r: { body: { releases: { id: string }[] } }) => r.body.releases.map((x) => x.id);
  assert.deepEqual(ids(second), ids(first), 'the same rows');
  assert.ok(second.body.sync.at > first.body.sync.at);
  assert.equal((await db.query('SELECT id FROM app_releases WHERE app_id = ?', [id])).length, 2);

  // The beta release moves to production (a new key) and the old one disappears.
  t.stores.android.versions = [
    play('production', '2.4.0', 'inProgress', ['240'], 'rolling_out', 0.5),
    play('production', '2.3.0', 'completed', ['230'], 'live'),
  ];
  const third = await t.call(t.owner, 'POST', syncPath(id));
  assert.deepEqual(
    { ...third.body.sync, at: undefined },
    { at: undefined, found: 2, added: 1, updated: 0, removed: 1, unmapped: 0 },
  );
  // The rollout grows: the same row changes in place.
  t.stores.android.versions = [
    play('production', '2.4.0', 'inProgress', ['240'], 'rolling_out', 0.9),
    play('production', '2.3.0', 'completed', ['230'], 'live'),
  ];
  const fourth = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(fourth.body.sync.updated, 1);
  assert.deepEqual(ids(fourth), ids(third), 'updated in place');
  assert.equal(
    fourth.body.releases.find((r: { version: string }) => r.version === '2.4.0').rolloutFraction,
    0.9,
  );

  // A repeated key in the store's answer is one row (the last wins), never a unique violation.
  t.stores.android.versions = [
    play('production', '2.4.0', 'inProgress', ['240'], 'rolling_out', 0.9),
    play('production', '2.4.0', 'halted', ['240'], 'halted', 0.9),
  ];
  const fifth = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(fifth.body.releases.length, 1);
  assert.equal(fifth.body.releases[0].status, 'halted');
});

dbTest('a failed sync is stored safely, keeps the last good snapshot, and the next success clears it', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_DISTRIBUTION', 'live')];
  const good = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(good.status, 200);

  // The error text echoes the key and a token, as a careless upstream message might.
  t.stores.ios.error = new StoreError(
    'appstoreconnect',
    'auth',
    `Apple rejected the credentials (401). key ${KEY_LINE} and Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4eHh4eHgifQ.c2lnbmF0dXJlc2lnbmF0dXJl`,
    401,
  );
  const bad = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'store_auth');
  assert.match(bad.body.message, /Apple rejected the credentials/);
  assert.equal(bad.body.app.lastSyncError, bad.body.message);
  assert.equal(bad.body.app.lastSyncedAt, good.body.app.lastSyncedAt, 'a failure is not a sync');
  assert.ok(bad.body.app.lastSyncAttemptAt > good.body.app.lastSyncedAt);
  assert.ok(!bad.text.includes(KEY_LINE));
  assert.ok(!bad.text.includes('eyJhbGci'));

  const stored = await t.call(t.owner, 'GET', `/apps/${id}`);
  assert.equal(stored.body.app.lastSyncError, bad.body.message);
  assert.equal(stored.body.releases.length, 1, 'the last good snapshot stays');

  const audit = (await t.auditActions()).filter((a) => a.action === 'app.sync');
  assert.equal(audit.length, 2);
  assert.match(audit[1]?.detail ?? '', /"ok":false/);
  assert.match(audit[1]?.detail ?? '', /store_auth/);

  t.stores.ios.error = undefined;
  const healed = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(healed.status, 200);
  assert.equal(healed.body.app.lastSyncError, null);
  t.noLeaks();
});

dbTest('every kind of store failure has its own code and never leaks, even from an unknown error', async (db) => {
  const t = await boot(db);
  const id = (await t.addAndroid()).body.app.id as string;
  const cases: [unknown, number, string][] = [
    [new StoreError('googleplay', 'forbidden', 'No access (403).', 403), 422, 'store_forbidden'],
    [new StoreError('googleplay', 'api_disabled', 'Enable the API.', 403), 422, 'store_forbidden'],
    [new StoreError('googleplay', 'not_found', 'No such package.', 404), 422, 'store_not_found'],
    [new StoreError('googleplay', 'clock_skew', 'Clock is off.'), 422, 'store_auth'],
    [new StoreError('googleplay', 'server', 'Google failed (HTTP 503).', 503), 502, 'store_unavailable'],
    [new StoreError('googleplay', 'network', 'No route to host.'), 502, 'store_unavailable'],
    // Not a StoreError: its text may echo anything, so nothing of it is shown or stored.
    [new Error(`boom ${KEY_LINE} bot@proj.iam.gserviceaccount.com`), 502, 'sync_failed'],
    ['a string was thrown', 502, 'sync_failed'],
  ];
  for (const [error, status, code] of cases) {
    t.stores.android.error = error;
    const res = await t.call(t.owner, 'POST', syncPath(id));
    assert.equal(res.status, status, code);
    assert.equal(res.body.error, code);
    assert.equal(res.body.app.lastSyncError, res.body.message);
  }
  t.noLeaks();
  const app = await db.query('SELECT last_sync_error FROM apps WHERE id = ?', [id]);
  const events = await db.query('SELECT detail FROM audit_events');
  for (const row of [...app, ...events]) {
    for (const leak of LEAKS) assert.ok(!JSON.stringify(row).includes(leak), `leaked in ${JSON.stringify(row)}`);
  }

  // A store that says slow down: 429 with Retry-After, and the wait is passed on.
  t.stores.android.error = new StoreRateLimitError('googleplay', 42);
  const limited = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '42');
  assert.equal(limited.body.retryAfterSeconds, 42);
  assert.equal(limited.body.error, 'rate_limited');
});

dbTest('a sync that takes too long is stopped with a 504 and recorded', async (db) => {
  const t = await boot(db, { timeoutMs: 30 });
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_DISTRIBUTION', 'live')];
  t.stores.ios.delayMs = 300;
  const res = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
  assert.equal(res.body.app.lastSyncError, res.body.message);
  // The abandoned read must not write anything when it finally returns.
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal((await db.query('SELECT id FROM app_releases WHERE app_id = ?', [id])).length, 0);
});

dbTest('a deleted or unreadable credential is a recorded 422, not a crash', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  await db.execute('DELETE FROM credentials WHERE id = ?', [t.iosCredential]);
  const gone = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(gone.status, 422);
  assert.equal(gone.body.error, 'credential_not_found');
  assert.equal(gone.body.app.lastSyncError, gone.body.message);
  assert.equal(t.built.length, 0);

  // A ciphertext that does not decrypt (moved, or the master key changed).
  const other = await t.addCredential('app_store_connect', ASC_SECRET);
  const second = await t.addIos({ identifier: 'com.acme.second', credentialId: other });
  await db.execute("UPDATE credentials SET ciphertext = 'garbage' WHERE id = ?", [other]);
  const bad = await t.call(t.owner, 'POST', syncPath(second.body.app.id));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'credential_unreadable');
  assert.equal(t.built.length, 0);
});

dbTest('an app that the key cannot see is a store_not_found with a useful message', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos({ identifier: 'com.acme.missing' })).body.app.id as string;
  const res = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'store_not_found');
  assert.match(res.body.message, /com\.acme\.missing/);
});

dbTest('a second sync of an app that is already syncing is refused with 409', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_DISTRIBUTION', 'live')];
  let release: () => void = () => {};
  t.stores.ios.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = t.call(t.owner, 'POST', syncPath(id));
  while (t.stores.ios.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'sync_in_progress');
  release();
  assert.equal((await first).status, 200);
  // Free again afterwards.
  assert.equal((await t.call(t.owner, 'POST', syncPath(id))).status, 200);
});

dbTest('syncs are limited per workspace; an unknown app costs no slot', async (db) => {
  let time = 1_000_000;
  const limiter = createTestLimiter({ limit: 2, windowMs: 60_000, now: () => time });
  const t = await boot(db, { limiter });
  const id = (await t.addIos()).body.app.id as string;
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_DISTRIBUTION', 'live')];
  for (let i = 0; i < 5; i++) assert.equal((await t.call(t.owner, 'POST', syncPath('nope'))).status, 404);
  assert.equal((await t.call(t.owner, 'POST', syncPath(id))).status, 200);
  assert.equal((await t.call(t.owner, 'POST', `${syncPath(id)}?background=true`)).status, 202, 'jobs count too');
  const limited = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.body.app, undefined);
  time += 61_000;
  assert.equal((await t.call(t.owner, 'POST', syncPath(id))).status, 200);
});

// ---------------------------------------------------------------------------------------------
// As a job

dbTest('a sync can run as an app.sync job, audited as the system on behalf of the user', async (db) => {
  const t = await boot(db);
  const id = (await t.addAndroid()).body.app.id as string;
  t.stores.android.versions = [play('production', '2.3.0', 'completed', ['230'], 'live')];
  const queued = await t.call(t.owner, 'POST', `${syncPath(id)}?background=true`);
  assert.equal(queued.status, 202);
  assert.equal(typeof queued.body.jobId, 'string');
  assert.equal(t.stores.android.calls.length, 0, 'nothing runs in the request');
  const [job] = await db.query('SELECT queue, status, payload FROM jobs WHERE id = ?', [queued.body.jobId]);
  assert.equal(job?.queue, 'app.sync');
  assert.equal(job?.status, 'queued');
  const [owner] = await db.query("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", [
    t.workspaceId,
  ]);
  assert.deepEqual(JSON.parse(String(job?.payload)), {
    workspaceId: t.workspaceId,
    appId: id,
    requestedBy: String(owner?.user_id),
  });

  // The app's test clock runs a little ahead of the real one, so the worker's clock does too.
  const worker = createWorker({
    sql: db,
    handlers: { 'app.sync': createAppSyncHandler(t.ctx()) },
    now: () => Date.now() + 60_000,
  });
  assert.equal(await worker.tick(), true);
  const [done] = await db.query('SELECT status FROM jobs WHERE id = ?', [queued.body.jobId]);
  assert.equal(done?.status, 'done');
  const read = await t.call(t.owner, 'GET', `/apps/${id}`);
  assert.equal(read.body.releases.length, 1);
  assert.ok(read.body.app.lastSyncedAt > 0);

  const audit = (await t.auditActions()).filter((a) => a.action === 'app.sync' || a.action === 'credential.use');
  assert.deepEqual(
    audit.map((a) => a.actorType),
    ['system', 'system'],
  );
  const sync = audit.find((a) => a.action === 'app.sync');
  assert.match(sync?.detail ?? '', /"trigger":"job"/);
  assert.match(sync?.detail ?? '', new RegExp(`"requestedBy":"${String(owner?.user_id)}"`));
});

dbTest('a job retries temporary failures and ends on permanent ones, recording both on the app', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  let time = Date.now() + 60_000;
  const worker = createWorker({
    sql: db,
    handlers: { 'app.sync': createAppSyncHandler(t.ctx()) },
    now: () => time,
    maxAttempts: 3,
  });

  t.stores.ios.error = new StoreError(
    'appstoreconnect',
    'server',
    `App Store Connect failed (HTTP 503) ${KEY_LINE}`,
    503,
  );
  await t.call(t.owner, 'POST', `${syncPath(id)}?background=true`);
  await worker.tick();
  const [retry] = await db.query("SELECT status, last_error FROM jobs WHERE queue = 'app.sync'");
  assert.equal(retry?.status, 'queued', 'temporary: retried with backoff');
  assert.match(String(retry?.last_error), /HTTP 503/);
  assert.ok(!String(retry?.last_error).includes(KEY_LINE), 'the stored job error is redacted too');
  const afterRetry = await t.call(t.owner, 'GET', `/apps/${id}`);
  assert.match(afterRetry.body.app.lastSyncError, /HTTP 503/);

  t.stores.ios.error = new StoreError('appstoreconnect', 'auth', 'Apple rejected the credentials (401).', 401);
  time += 3_600_000;
  await worker.tick();
  const [ended] = await db.query("SELECT status FROM jobs WHERE queue = 'app.sync'");
  assert.equal(ended?.status, 'done', 'permanent: not retried');
  const stored = await t.call(t.owner, 'GET', `/apps/${id}`);
  assert.match(stored.body.app.lastSyncError, /rejected the credentials/);
  t.noLeaks();
});

dbTest('a job for an app that was deleted ends quietly', async (db) => {
  const t = await boot(db);
  const id = (await t.addIos()).body.app.id as string;
  await t.call(t.owner, 'POST', `${syncPath(id)}?background=true`);
  await t.call(t.owner, 'DELETE', `/apps/${id}`);
  // The app's test clock runs a little ahead of the real one, so the worker's clock does too.
  const worker = createWorker({
    sql: db,
    handlers: { 'app.sync': createAppSyncHandler(t.ctx()) },
    now: () => Date.now() + 60_000,
  });
  await worker.tick();
  const [row] = await db.query("SELECT status FROM jobs WHERE queue = 'app.sync'");
  assert.equal(row?.status, 'done');
  assert.equal(t.built.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The real connectors, behind a fake fetch

const { privateKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (key: typeof rsaKey) => key.export({ type: 'pkcs8', format: 'pem' }).toString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

dbTest('the default factory builds the real Google Play connector and reads through the given fetch', async (db) => {
  const secret = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem(rsaKey) });
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${new URL(url).pathname}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json({ access_token: 'ya29.fake-access-token-for-tests', token_type: 'Bearer', expires_in: 3600 });
    }
    if (method === 'POST' && url.endsWith('/edits')) return json({ id: 'edit-1', expiryTimeSeconds: '9999999999' });
    if (method === 'DELETE') return json({});
    if (url.endsWith('/tracks')) {
      return json({
        tracks: [
          {
            track: 'production',
            releases: [{ name: '2.4.0', versionCodes: ['240'], status: 'inProgress', userFraction: 0.2 }],
          },
        ],
      });
    }
    return json({ error: { code: 404, message: 'unexpected request in test' } }, 404);
  };
  const wrapped: StoreConnectorFactory = (input) => defaultStoreConnectorFactory({ ...input, fetch: fakeFetch });
  const t = await bootRepoApp(db, undefined, { appSync: { connectorFactory: wrapped } });
  const credentialId = await t.addCredential('google_play', secret);
  const created = await t.call(t.owner, 'POST', '/apps', {
    platform: 'android',
    identifier: 'com.acme.app',
    credentialId,
  });
  const res = await t.call(t.owner, 'POST', syncPath(created.body.app.id));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.releases.length, 1);
  assert.equal(res.body.releases[0].track, 'production');
  assert.equal(res.body.releases[0].status, 'rolling_out');
  assert.equal(res.body.releases[0].rolloutFraction, 0.2);
  assert.ok(requests.includes('POST /androidpublisher/v3/applications/com.acme.app/edits'));
  assert.ok(requests.some((r) => r.startsWith('DELETE')), 'the edit is deleted, never committed');
  assert.ok(!requests.some((r) => r.includes(':commit')));
  assert.ok(!t.texts.some((x) => x.includes('ya29.fake-access-token')));
});

dbTest('the default factory builds the real App Store Connect connector, and a 401 becomes store_auth', async (db) => {
  const secret = JSON.stringify({ keyId: 'ABC123DEFG', issuerId: 'issuer-1', privateKey: pem(ecKey) });
  let reject = false;
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (reject) {
      return json(
        { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.' }] },
        401,
      );
    }
    if (url.pathname === '/v1/apps') {
      return json({ data: [{ type: 'apps', id: '777', attributes: { name: 'Acme', bundleId: 'com.acme.app' } }] });
    }
    if (url.pathname === '/v1/apps/777/appStoreVersions') {
      return json({
        data: [
          {
            type: 'appStoreVersions',
            id: 'v1',
            attributes: { platform: 'IOS', versionString: '2.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
          },
        ],
      });
    }
    // Apple's app-scoped builds endpoint documents only `limit` and `fields[builds]`: it refuses
    // `sort` and `include` (the maintainer's real failure). The filtered top-level list takes them.
    if (url.pathname === '/v1/apps/777/builds' && (url.searchParams.has('sort') || url.searchParams.has('include'))) {
      return json(
        {
          errors: [
            {
              status: '400',
              code: 'PARAMETER_ERROR.ILLEGAL',
              title: 'A given parameter is not allowed for this request',
              source: { parameter: url.searchParams.has('sort') ? 'sort' : 'include' },
            },
          ],
        },
        400,
      );
    }
    if (url.pathname === '/v1/builds' && url.searchParams.get('filter[app]') === '777') {
      return json({
        data: [
          {
            type: 'builds',
            id: 'b1',
            attributes: { version: '55', processingState: 'VALID', uploadedDate: '2024-05-01T10:00:00Z' },
            relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'p1' } } },
          },
        ],
        included: [{ type: 'preReleaseVersions', id: 'p1', attributes: { version: '2.0', platform: 'IOS' } }],
      });
    }
    return json({}, 404);
  };
  const wrapped: StoreConnectorFactory = (input) => defaultStoreConnectorFactory({ ...input, fetch: fakeFetch });
  const t = await bootRepoApp(db, undefined, { appSync: { connectorFactory: wrapped } });
  const credentialId = await t.addCredential('app_store_connect', secret);
  const created = await t.call(t.owner, 'POST', '/apps', {
    platform: 'ios',
    identifier: 'com.acme.app',
    credentialId,
  });
  const id = created.body.app.id as string;
  const res = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.releases[0].version, '2.0');
  assert.equal(res.body.releases[0].status, 'live');
  assert.equal(res.body.releases[0].build, '55');
  assert.equal(res.body.app.storeAppId, '777');
  assert.ok(requests.every((r) => r.startsWith('GET ')), 'every store request is a read');

  reject = true;
  const bad = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'store_auth');
  assert.ok(!bad.text.includes('PRIVATE KEY'));
});

// ---------------------------------------------------------------------------------------------
// Discover and import

const discoverPath = '/apps/discover';
const importPath = '/apps/import';

const appleApp = (storeId: string, name: string, bundleId: string): StoreApp => ({
  storeId,
  platform: 'ios',
  name,
  bundleId,
});

/**
 * A Google Play fake that answers one package per connector, like the real factory is used:
 * a StoreApp for a package it knows, an error to throw otherwise (not found when unlisted).
 */
function playTable(table: Record<string, StoreApp | Error>, delays: Record<string, number> = {}) {
  const asked: string[] = [];
  const factory: StoreConnectorFactory = (input) => {
    const store = new FakeStore('android');
    store.listApps = async () => {
      asked.push(input.identifier);
      const wait = delays[input.identifier];
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const hit = table[input.identifier];
      if (hit instanceof Error) throw hit;
      if (!hit) throw new StoreError('googleplay', 'not_found', `No app ${input.identifier} for this account.`, 404);
      return [hit];
    };
    return store;
  };
  return { factory, asked };
}

const playApp = (name: string, id: string): StoreApp => ({
  storeId: id,
  platform: 'android',
  name,
  bundleId: id,
});

dbTest('discover and import need apps.write; a non-member gets 404', async (db) => {
  const t = await boot(db);
  t.stores.ios.apps = [appleApp('111', 'Acme', 'com.acme.app')];
  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  const discover = { credentialId: t.iosCredential };
  const imports = {
    credentialId: t.iosCredential,
    items: [{ platform: 'ios', identifier: 'com.acme.app' }],
  };
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'POST', discoverPath, discover)).status, 403);
    assert.equal((await t.call(cookie, 'POST', importPath, imports)).status, 403);
  }
  assert.equal(t.stores.ios.calls.length, 0);
  assert.equal(t.built.length, 0);
  assert.equal((await t.call(admin, 'POST', discoverPath, discover)).status, 200);
  assert.equal((await t.call(admin, 'POST', importPath, imports)).status, 200);

  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  for (const [path, body] of [
    [discoverPath, discover],
    [importPath, imports],
  ] as const) {
    const res = await t.call(outsider, 'POST', path, body);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { error: 'not_found' });
    assert.equal((await t.call(outsider, 'POST', path, body, 'no-such-workspace')).status, 404);
  }
  assert.equal(t.stores.ios.calls.length, 1, 'only the admin read the store');
});

dbTest('discover and import refuse an unknown, foreign or unsuitable credential', async (db) => {
  const t = await boot(db);
  const github = await t.addCredential();
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const theirs = await t.addCredential('app_store_connect', ASC_SECRET, outsider, 'other');
  const items = [{ platform: 'ios', identifier: 'com.acme.app' }];

  for (const [credentialId, error] of [
    [github, 'credential_kind'],
    ['nope', 'credential_not_found'],
    [theirs, 'credential_not_found'],
  ] as const) {
    const d = await t.call(t.owner, 'POST', discoverPath, { credentialId, packages: ['com.acme.app'] });
    assert.equal(d.status, 422, `discover ${error}`);
    assert.equal(d.body.error, error);
    const i = await t.call(t.owner, 'POST', importPath, { credentialId, items });
    assert.equal(i.status, 422, `import ${error}`);
    assert.equal(i.body.error, error);
  }
  assert.equal(t.built.length, 0, 'no secret was decrypted for them');
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 0);
  assert.equal((await t.auditActions()).filter((a) => a.action === 'credential.use').length, 0);
});

dbTest('discover validates its body', async (db) => {
  const t = await boot(db);
  const bad = async (body: unknown) => (await t.call(t.owner, 'POST', discoverPath, body)).status;
  assert.equal(await bad({}), 400);
  assert.equal(await bad({ credentialId: '' }), 400);
  assert.equal(await bad({ credentialId: t.playCredential, packages: [] }), 400);
  assert.equal(await bad({ credentialId: t.playCredential, packages: 'com.acme.app' }), 400);
  const many = Array.from({ length: 51 }, (_, i) => `com.acme.app${i}`);
  assert.equal(await bad({ credentialId: t.playCredential, packages: many }), 400);
  const res = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.playCredential,
    packages: ['com.acme.app', 'nodots'],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.issues[0].path, 'packages.1');
  const huge = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.playCredential,
    packages: ['com.acme.app'],
    padding: 'x'.repeat(20_000),
  });
  assert.equal(huge.status, 413);
  assert.equal(t.built.length, 0);
});

dbTest('Apple discovery lists what the key sees and marks the apps already added', async (db) => {
  const t = await boot(db);
  t.stores.ios.apps = [
    appleApp('222', 'Zeta', 'com.acme.zeta'),
    appleApp('111', 'Acme', 'com.acme.app'),
    appleApp('333', 'Beta\nApp', 'com.acme.beta'),
    appleApp('111', 'Acme again', 'COM.ACME.APP'),
    { storeId: '9', platform: 'android', name: 'Odd', bundleId: 'com.acme.odd' },
    appleApp('8', 'Bad', 'bad id!'),
  ];
  const created = await t.addIos({ identifier: 'com.acme.BETA', name: 'Beta' });
  const res = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.iosCredential,
    packages: ['ignored.for.apple'],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.credentialId, t.iosCredential);
  assert.equal(res.body.kind, 'app_store_connect');
  assert.deepEqual(res.body.failures, []);
  assert.deepEqual(res.body.candidates, [
    { platform: 'ios', storeId: '111', identifier: 'com.acme.app', name: 'Acme', alreadyAdded: false },
    {
      platform: 'ios',
      storeId: '333',
      identifier: 'com.acme.beta',
      name: 'Beta App',
      alreadyAdded: true,
      appId: created.body.app.id,
    },
    { platform: 'ios', storeId: '222', identifier: 'com.acme.zeta', name: 'Zeta', alreadyAdded: false },
  ]);
  assert.deepEqual(t.stores.ios.calls, ['listApps'], 'a single read, nothing else');
  assert.equal(t.built.length, 1);
  assert.equal(t.built[0]?.kind, 'app_store_connect');
  assert.equal(t.built[0]?.secret, ASC_SECRET);
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 1, 'discovery adds nothing');

  const use = (await t.auditActions()).filter((a) => a.action === 'credential.use');
  assert.equal(use.length, 1);
  assert.match(use[0]?.detail ?? '', /app\.discover/);
  assert.equal(use[0]?.targetId, t.iosCredential);
  t.noLeaks();
});

dbTest('discovery failures of the whole call are mapped like sync failures, with safe messages', async (db) => {
  const t = await boot(db);
  const discover = () => t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential });
  t.stores.ios.error = new StoreError('appstoreconnect', 'auth', 'Apple rejected the key.', 401);
  const auth = await discover();
  assert.equal(auth.status, 422);
  assert.equal(auth.body.error, 'store_auth');
  t.stores.ios.error = new StoreError('appstoreconnect', 'forbidden', 'The key has no access.', 403);
  assert.equal((await discover()).body.error, 'store_forbidden');
  t.stores.ios.error = new StoreError('appstoreconnect', 'server', 'Apple failed.', 500);
  const down = await discover();
  assert.equal(down.status, 502);
  assert.equal(down.body.error, 'store_unavailable');
  t.stores.ios.error = new StoreRateLimitError('appstoreconnect', 42);
  const limited = await discover();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.retryAfterSeconds, 42);
  assert.equal(limited.headers.get('retry-after'), '42');
  // An error that is not ours to explain says nothing of what it carried.
  t.stores.ios.error = new Error(`boom ${KEY_LINE}`);
  const other = await discover();
  assert.equal(other.status, 502);
  assert.equal(other.body.error, 'discover_failed');
  assert.ok(!other.text.includes(KEY_LINE));
  t.noLeaks();
});

dbTest('Google Play discovery needs package names and verifies each one on its own', async (db) => {
  const table = playTable({
    'com.acme.app': playApp('Acme Android', 'com.acme.app'),
    'com.acme.other': playApp('Other', 'com.acme.other'),
    'com.acme.locked': new StoreError('googleplay', 'forbidden', 'The service account may not open this app.', 403),
    'com.acme.flaky': new StoreError('googleplay', 'server', 'Google Play failed.', 503),
    'com.acme.crash': new Error(`boom ${KEY_LINE}`),
  });
  const t = await boot(db, { connectorFactory: table.factory });
  const created = await t.addAndroid({ name: 'Mine' });

  const none = await t.call(t.owner, 'POST', discoverPath, { credentialId: t.playCredential });
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'packages_required');
  assert.match(none.body.message, /package names/);
  assert.equal(table.asked.length, 0);

  const res = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.playCredential,
    packages: [
      'com.acme.app',
      'com.acme.other',
      'com.acme.missing',
      'com.acme.locked',
      'com.acme.flaky',
      'com.acme.crash',
      'com.acme.other',
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.kind, 'google_play');
  assert.deepEqual(res.body.candidates, [
    {
      platform: 'android',
      storeId: 'com.acme.app',
      identifier: 'com.acme.app',
      name: 'Acme Android',
      alreadyAdded: true,
      appId: created.body.app.id,
    },
    {
      platform: 'android',
      storeId: 'com.acme.other',
      identifier: 'com.acme.other',
      name: 'Other',
      alreadyAdded: false,
    },
  ]);
  const codes = Object.fromEntries(
    (res.body.failures as { identifier: string; error: string; message: string }[]).map((f) => [
      f.identifier,
      f.error,
    ]),
  );
  assert.deepEqual(codes, {
    'com.acme.missing': 'store_not_found',
    'com.acme.locked': 'store_forbidden',
    'com.acme.flaky': 'store_unavailable',
    'com.acme.crash': 'discover_failed',
  });
  assert.ok(res.body.failures.every((f: { message: string }) => f.message.length > 0));
  assert.deepEqual(
    table.asked,
    ['com.acme.app', 'com.acme.other', 'com.acme.missing', 'com.acme.locked', 'com.acme.flaky', 'com.acme.crash'],
    'each distinct package is checked once',
  );
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 1);
  t.noLeaks();
});

dbTest('a problem of the Google credential itself ends the checks and marks the rest', async (db) => {
  const table = playTable({
    'com.acme.a': playApp('A', 'com.acme.a'),
    'com.acme.b': new StoreError('googleplay', 'api_disabled', 'The Android Developer API is not enabled.', 403),
    'com.acme.c': playApp('C', 'com.acme.c'),
  });
  const t = await boot(db, { connectorFactory: table.factory });
  const res = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.playCredential,
    packages: ['com.acme.a', 'com.acme.b', 'com.acme.c'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.candidates.length, 1);
  assert.deepEqual(
    res.body.failures.map((f: { identifier: string; error: string }) => [f.identifier, f.error]),
    [
      ['com.acme.b', 'store_forbidden'],
      ['com.acme.c', 'store_forbidden'],
    ],
  );
  assert.deepEqual(table.asked, ['com.acme.a', 'com.acme.b'], 'no further requests after that');
});

dbTest('discovery is limited per workspace; a refused request costs no slot', async (db) => {
  let time = 1_000_000;
  const limiter = createTestLimiter({ limit: 2, windowMs: 60_000, now: () => time });
  const t = await boot(db, { limiter });
  const github = await t.addCredential();
  for (let i = 0; i < 5; i++) {
    assert.equal((await t.call(t.owner, 'POST', discoverPath, { credentialId: github })).status, 422);
    assert.equal(
      (await t.call(t.owner, 'POST', discoverPath, { credentialId: t.playCredential })).status,
      422,
      'packages_required',
    );
  }
  const ok = { credentialId: t.iosCredential };
  assert.equal((await t.call(t.owner, 'POST', discoverPath, ok)).status, 200);
  assert.equal((await t.call(t.owner, 'POST', discoverPath, ok)).status, 200);
  const limited = await t.call(t.owner, 'POST', discoverPath, ok);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds > 0);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(t.stores.ios.calls.length, 2, 'the refused request never reached the store');
  assert.equal(t.built.length, 2, 'and decrypted nothing');
  time += 61_000;
  assert.equal((await t.call(t.owner, 'POST', discoverPath, ok)).status, 200);
});

dbTest('a slow Apple discovery is stopped with a 504', async (db) => {
  const t = await boot(db, { timeoutMs: 30 });
  t.stores.ios.delayMs = 300;
  const res = await t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential });
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'timeout');
  await new Promise((r) => setTimeout(r, 400));
});

dbTest('a slow Google Play check keeps what it verified and marks the rest as timed out', async (db) => {
  const table = playTable(
    {
      'com.acme.fast': playApp('Fast', 'com.acme.fast'),
      'com.acme.slow': playApp('Slow', 'com.acme.slow'),
      'com.acme.late': playApp('Late', 'com.acme.late'),
    },
    { 'com.acme.slow': 400 },
  );
  const t = await boot(db, { connectorFactory: table.factory, timeoutMs: 60 });
  const res = await t.call(t.owner, 'POST', discoverPath, {
    credentialId: t.playCredential,
    packages: ['com.acme.fast', 'com.acme.slow', 'com.acme.late'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.candidates.map((c: { identifier: string }) => c.identifier),
    ['com.acme.fast'],
  );
  assert.deepEqual(
    res.body.failures.map((f: { identifier: string; error: string }) => [f.identifier, f.error]),
    [
      ['com.acme.slow', 'timeout'],
      ['com.acme.late', 'timeout'],
    ],
  );
  assert.deepEqual(table.asked, ['com.acme.fast', 'com.acme.slow']);
  await new Promise((r) => setTimeout(r, 400));
});

dbTest('import creates the selected apps in one go, reports each item, and is idempotent', async (db) => {
  const t = await boot(db);
  const { repositoryId } = await t.connect();
  const preexisting = await t.addIos({ identifier: 'com.acme.old', name: 'Old' });
  const items = [
    { platform: 'ios', identifier: 'com.acme.app', storeAppId: '111', name: 'Acme', repositoryId },
    { platform: 'ios', identifier: 'COM.ACME.OLD' },
    { platform: 'ios', identifier: 'com.acme.noname' },
    { platform: 'ios', identifier: 'com.acme.app' },
    { platform: 'ios', identifier: 'com.acme.ghost', repositoryId: 'nope' },
    { platform: 'android', identifier: 'com.acme.droid' },
  ];
  const res = await t.call(t.owner, 'POST', importPath, { credentialId: t.iosCredential, items });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.summary, { created: 2, skipped: 2, failed: 2 });
  const results = res.body.results as {
    identifier: string;
    status: string;
    error?: string;
    app?: Record<string, unknown>;
  }[];
  assert.deepEqual(
    results.map((r) => [r.identifier, r.status, r.error]),
    [
      ['com.acme.app', 'created', undefined],
      ['COM.ACME.OLD', 'skipped', 'already_exists'],
      ['com.acme.noname', 'created', undefined],
      ['com.acme.app', 'skipped', 'already_exists'],
      ['com.acme.ghost', 'failed', 'repository_not_found'],
      ['com.acme.droid', 'failed', 'credential_kind'],
    ],
  );
  const first = results[0]?.app;
  assert.equal(first?.name, 'Acme');
  assert.equal(first?.storeAppId, '111');
  assert.equal(first?.repositoryId, repositoryId);
  assert.equal(first?.credentialId, t.iosCredential);
  assert.equal(first?.lastSyncedAt, null);
  assert.equal(results[1]?.app?.id, preexisting.body.app.id, 'a skipped item points at the existing app');
  assert.equal(results[2]?.app?.name, 'com.acme.noname', 'the name defaults to the identifier');
  assert.equal(results[2]?.app?.storeAppId, null);
  assert.equal(results[3]?.app?.id, first?.id);
  assert.equal(t.stores.ios.calls.length, 0, 'importing does not contact the store');

  const before = (await t.call(t.owner, 'GET', '/apps')).body.apps;
  assert.equal(before.length, 3);
  const again = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: items.slice(0, 3),
  });
  assert.deepEqual(again.body.summary, { created: 0, skipped: 3, failed: 0 });
  assert.deepEqual((await t.call(t.owner, 'GET', '/apps')).body.apps, before);

  const creates = (await t.auditActions()).filter((a) => a.action === 'app.create');
  assert.equal(creates.length, 3, 'one for the manual app, one per imported app, none for skips');
  const imported = creates.filter((a) => a.detail.includes('"source":"import"'));
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map((a) => a.targetId).sort(), [first?.id, results[2]?.app?.id].sort());
  assert.ok(imported.every((a) => a.actorType === 'user'));
  for (const a of creates) for (const leak of LEAKS) assert.ok(!a.detail.includes(leak));
  t.noLeaks();
});

dbTest('import of Google Play apps stores the package name as the store id', async (db) => {
  const t = await boot(db);
  const res = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.playCredential,
    items: [
      { platform: 'android', identifier: 'com.acme.app', name: 'Acme Android', storeAppId: 'com.acme.app' },
      { platform: 'android', identifier: 'com.acme.second' },
      { platform: 'ios', identifier: 'com.acme.app' },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.summary, { created: 2, skipped: 0, failed: 1 });
  assert.equal(res.body.results[0].app.storeAppId, 'com.acme.app');
  assert.equal(res.body.results[1].app.storeAppId, 'com.acme.second');
  assert.equal(res.body.results[2].error, 'credential_kind');
  assert.equal(t.stores.android.calls.length, 0);
});

dbTest('import validates its body', async (db) => {
  const t = await boot(db);
  const post = (items: unknown, extra: Record<string, unknown> = {}) =>
    t.call(t.owner, 'POST', importPath, { credentialId: t.iosCredential, items, ...extra });
  const many = Array.from({ length: 51 }, (_, i) => ({ platform: 'ios', identifier: `com.a.b${i}` }));
  assert.equal((await post([])).status, 400);
  assert.equal((await post('x')).status, 400);
  assert.equal((await post(many)).status, 400);
  assert.equal((await post([{ platform: 'windows', identifier: 'a.b' }])).status, 400);
  assert.equal((await post([{ platform: 'ios', identifier: 'has space' }])).status, 400);
  assert.equal((await post([{ platform: 'ios', identifier: 'com.a.b', storeAppId: 'a/b' }])).status, 400);
  assert.equal((await post([{ platform: 'ios', identifier: 'com.a.b', name: 'x'.repeat(101) }])).status, 400);
  const bad = await post([
    { platform: 'ios', identifier: 'com.a.b' },
    { platform: 'android', identifier: 'nodots' },
  ]);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.issues[0].path, 'items.1.identifier');
  assert.equal((await t.call(t.owner, 'POST', importPath, { items: [] })).status, 400);
  const big = await post([{ platform: 'ios', identifier: 'com.a.b' }], { padding: 'x'.repeat(40_000) });
  assert.equal(big.status, 413);
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 0, 'nothing was created');
});

dbTest('import is transactional: a database error leaves nothing behind', async (db) => {
  if (db.dialect !== 'sqlite') return;
  const t = await boot(db);
  await db.execute(
    `CREATE TRIGGER apps_boom BEFORE INSERT ON apps WHEN NEW.identifier = 'com.acme.boom'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  );
  // A 500 is not JSON, so this goes around the helper.
  const res = await t.app.request(`/api/workspaces/${t.workspaceId}${importPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: t.owner },
    body: JSON.stringify({
      credentialId: t.iosCredential,
      items: [
        { platform: 'ios', identifier: 'com.acme.first' },
        { platform: 'ios', identifier: 'com.acme.boom' },
        { platform: 'ios', identifier: 'com.acme.third' },
      ],
    }),
  });
  assert.equal(res.status, 500);
  assert.equal((await db.query('SELECT id FROM apps')).length, 0, 'the first insert was rolled back');
  assert.equal((await t.auditActions()).filter((a) => a.action === 'app.create').length, 0);
  await db.execute('DROP TRIGGER apps_boom');
  const ok = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: [{ platform: 'ios', identifier: 'com.acme.first' }],
  });
  assert.equal(ok.body.summary.created, 1);
});

dbTest('import and discovery never cross workspaces', async (db) => {
  const t = await boot(db);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  const theirs = await t.addCredential('app_store_connect', ASC_SECRET, outsider, 'other');
  const mine = (await t.addIos()).body.app.id as string;

  // The same bundle id in the other workspace is a different app, and is not "already added".
  const found = await t.call(outsider, 'POST', discoverPath, { credentialId: theirs }, 'other');
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.body.candidates.map((c: { alreadyAdded: boolean }) => c.alreadyAdded),
    [false],
  );
  const done = await t.call(
    outsider,
    'POST',
    importPath,
    { credentialId: theirs, items: [{ platform: 'ios', identifier: 'com.acme.app' }] },
    'other',
  );
  assert.equal(done.body.summary.created, 1);
  assert.notEqual(done.body.results[0].app.id, mine);
  // Their credential cannot be used from this workspace, and the reverse.
  const cross = await t.call(t.owner, 'POST', importPath, {
    credentialId: theirs,
    items: [{ platform: 'ios', identifier: 'com.acme.cross' }],
  });
  assert.equal(cross.body.error, 'credential_not_found');
  const reverse = await t.call(
    outsider,
    'POST',
    importPath,
    { credentialId: t.iosCredential, items: [{ platform: 'ios', identifier: 'com.acme.cross' }] },
    'other',
  );
  assert.equal(reverse.body.error, 'credential_not_found');
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 1);
  assert.equal((await t.call(outsider, 'GET', '/apps', undefined, 'other')).body.apps.length, 1);
});

dbTest('an imported app can be synced like any other, and nothing leaks a secret', async (db) => {
  const t = await boot(db);
  t.stores.ios.apps = [appleApp('1234567890', 'Acme', 'com.acme.app')];
  t.stores.ios.versions = [ios('2.0', 'READY_FOR_SALE', 'live')];
  const found = await t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential });
  const c = found.body.candidates[0];
  const done = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: [{ platform: c.platform, identifier: c.identifier, storeAppId: c.storeId, name: c.name }],
  });
  const id = done.body.results[0].app.id as string;
  t.stores.ios.calls.length = 0;
  const sync = await t.call(t.owner, 'POST', syncPath(id));
  assert.equal(sync.status, 200, sync.text);
  assert.deepEqual(
    t.stores.ios.calls,
    ['listVersions:1234567890', 'listBuilds:1234567890'],
    'the store id from discovery spares the lookup',
  );
  for (const a of await t.auditActions()) for (const leak of LEAKS) assert.ok(!a.detail.includes(leak));
  t.noLeaks();
});

// ---------------------------------------------------------------------------------------------
// The same identifier on both platforms (a bundle id equal to a package name) is two apps.

const SAME = 'com.acme.same';

dbTest('importing the same identifier for iOS and Android, in two requests, creates two apps', async (db) => {
  const t = await boot(db);
  const ios = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: [{ platform: 'ios', identifier: SAME, storeAppId: '1499117252', name: 'Same' }],
  });
  const android = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.playCredential,
    items: [{ platform: 'android', identifier: SAME, name: 'Same' }],
  });
  assert.deepEqual(ios.body.summary, { created: 1, skipped: 0, failed: 0 });
  assert.deepEqual(android.body.summary, { created: 1, skipped: 0, failed: 0 }, 'Android is not skipped because of iOS');
  const apps = (await t.call(t.owner, 'GET', '/apps')).body.apps as {
    id: string;
    platform: string;
    identifier: string;
    storeAppId: string | null;
  }[];
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map((a) => [a.platform, a.identifier, a.storeAppId]).sort(), [
    ['android', SAME, SAME],
    ['ios', SAME, '1499117252'],
  ]);
  assert.notEqual(apps[0]?.id, apps[1]?.id);
  const creates = (await t.auditActions()).filter((a) => a.action === 'app.create');
  assert.equal(creates.length, 2);
  // Each is addressable on its own.
  for (const a of apps) assert.equal((await t.call(t.owner, 'GET', `/apps/${a.id}`)).body.app.platform, a.platform);
});

dbTest('one import request cannot mix platforms, so the other platform fails alone; same platform twice is skipped', async (db) => {
  const t = await boot(db);
  const res = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: [
      { platform: 'ios', identifier: SAME },
      { platform: 'android', identifier: SAME },
      { platform: 'ios', identifier: SAME },
      { platform: 'ios', identifier: SAME.toUpperCase() },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    res.body.results.map((r: { platform: string; status: string; error?: string }) => [r.platform, r.status, r.error]),
    [
      ['ios', 'created', undefined],
      ['android', 'failed', 'credential_kind'],
      ['ios', 'skipped', 'already_exists'],
      ['ios', 'skipped', 'already_exists'],
    ],
  );
  assert.deepEqual(res.body.summary, { created: 1, skipped: 2, failed: 1 });
  // The failed Android item is still importable with the Android credential afterwards.
  const android = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.playCredential,
    items: [
      { platform: 'android', identifier: SAME },
      { platform: 'android', identifier: SAME },
    ],
  });
  assert.deepEqual(android.body.summary, { created: 1, skipped: 1, failed: 0 });
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 2);
});

dbTest('discovery marks an app as already added only for its own platform', async (db) => {
  const table = playTable({ [SAME]: playApp('Same', SAME) });
  const iosStore = new FakeStore('ios');
  iosStore.apps = [appleApp('1499117252', 'Same', SAME)];
  const t = await boot(db, {
    connectorFactory: (input) => (input.kind === 'app_store_connect' ? iosStore : table.factory(input)),
  });
  const discoverIos = async () =>
    (await t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential })).body.candidates;
  const discoverAndroid = async () =>
    (await t.call(t.owner, 'POST', discoverPath, { credentialId: t.playCredential, packages: [SAME] })).body.candidates;

  assert.deepEqual((await discoverIos()).map((c: { alreadyAdded: boolean }) => c.alreadyAdded), [false]);
  assert.deepEqual((await discoverAndroid()).map((c: { alreadyAdded: boolean }) => c.alreadyAdded), [false]);

  // Only Android exists: iOS is still addable.
  const droid = await t.addAndroid({ identifier: SAME, name: 'Same' });
  const [iosOnly] = await discoverIos();
  assert.equal(iosOnly.alreadyAdded, false);
  assert.equal(iosOnly.appId, undefined);
  const [droidAdded] = await discoverAndroid();
  assert.equal(droidAdded.alreadyAdded, true);
  assert.equal(droidAdded.appId, droid.body.app.id);

  // Both exist: each points at its own app.
  const apple = await t.addIos({ identifier: SAME, name: 'Same' });
  const [iosAdded] = await discoverIos();
  assert.equal(iosAdded.alreadyAdded, true);
  assert.equal(iosAdded.appId, apple.body.app.id);
  assert.notEqual(iosAdded.appId, droidAdded.appId);
});

// ---------------------------------------------------------------------------------------------
// macOS: a third platform on the same app entry

dbTest('a macOS app is a third record next to iOS and Android, and its connector is built for macOS', async (db) => {
  const t = await boot(db);
  const mac = await t.call(t.owner, 'POST', '/apps', {
    platform: 'macos',
    identifier: 'com.acme.app',
    credentialId: t.iosCredential,
    name: 'Acme',
  });
  assert.equal(mac.status, 201, mac.text);
  assert.equal(mac.body.app.platform, 'macos');
  assert.equal((await t.addIos()).status, 201, 'iOS with the same bundle id is a different record');
  assert.equal((await t.addAndroid()).status, 201);
  assert.equal((await t.addIos()).status, 409, 'the same platform twice is still refused');
  assert.equal((await t.call(t.owner, 'GET', '/apps')).body.apps.length, 3);

  // A macOS app needs an App Store Connect credential, like iOS.
  const withPlay = await t.call(t.owner, 'POST', '/apps', {
    platform: 'macos',
    identifier: 'com.acme.other',
    credentialId: t.playCredential,
  });
  assert.equal(withPlay.status, 422);

  t.stores.ios.versions = [
    { ...ios('3.0', 'READY_FOR_SALE', 'live'), platform: 'macos' },
  ];
  const res = await t.call(t.owner, 'POST', syncPath(mac.body.app.id as string));
  assert.equal(res.status, 200, res.text);
  assert.equal(t.built.at(-1)?.platform, 'macos', 'the connector is asked for the macOS versions');
  assert.equal(t.built.at(-1)?.kind, 'app_store_connect');
  assert.deepEqual(res.body.releases.map((r: { platform: string }) => r.platform), ['macos']);
  t.noLeaks();
});

dbTest('a macOS sync with no macOS version says so, instead of showing the iOS versions', async (db) => {
  const t = await boot(db);
  const mac = await t.call(t.owner, 'POST', '/apps', {
    platform: 'macos',
    identifier: 'com.acme.app',
    credentialId: t.iosCredential,
  });
  t.stores.ios.versions = [];
  const res = await t.call(t.owner, 'POST', syncPath(mac.body.app.id as string));
  assert.equal(res.status, 422, res.text);
  assert.equal(res.body.error, 'store_not_found');
  assert.match(res.text, /no macOS version/);
});

dbTest('Apple discovery lists one candidate per platform of a universal app, and import adds a macOS record', async (db) => {
  const t = await boot(db);
  t.stores.ios.apps = [
    { ...appleApp('111', 'Acme', 'com.acme.app'), platforms: ['ios', 'macos'] },
    { ...appleApp('222', 'Mac Only', 'com.acme.mac'), platforms: ['macos'] },
    appleApp('333', 'Unknown', 'com.acme.unknown'),
  ];
  const res = await t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    res.body.candidates.map((c: { platform: string; identifier: string }) => [c.platform, c.identifier]),
    [
      ['ios', 'com.acme.app'],
      ['macos', 'com.acme.app'],
      ['macos', 'com.acme.mac'],
      ['ios', 'com.acme.unknown'],
    ],
    'an app whose platforms are unknown stays an iOS candidate, as before',
  );

  const imported = await t.call(t.owner, 'POST', importPath, {
    credentialId: t.iosCredential,
    items: [
      { platform: 'ios', identifier: 'com.acme.app', storeAppId: '111', name: 'Acme' },
      { platform: 'macos', identifier: 'com.acme.app', storeAppId: '111', name: 'Acme' },
      { platform: 'macos', identifier: 'com.acme.app', storeAppId: '111', name: 'Acme' },
    ],
  });
  assert.equal(imported.status, 200, imported.text);
  assert.deepEqual(imported.body.summary, { created: 2, skipped: 1, failed: 0 });
  const apps = (await t.call(t.owner, 'GET', '/apps')).body.apps as { platform: string; storeAppId: string }[];
  assert.deepEqual(apps.map((a) => [a.platform, a.storeAppId]).sort(), [
    ['ios', '111'],
    ['macos', '111'],
  ]);

  const again = (await t.call(t.owner, 'POST', discoverPath, { credentialId: t.iosCredential })).body.candidates as {
    platform: string;
    identifier: string;
    alreadyAdded: boolean;
  }[];
  const flags = again.map((c) => [c.platform, c.identifier, c.alreadyAdded]);
  assert.deepEqual(flags[0], ['ios', 'com.acme.app', true]);
  assert.deepEqual(flags[1], ['macos', 'com.acme.app', true]);
  assert.deepEqual(flags[2], ['macos', 'com.acme.mac', false]);
});
