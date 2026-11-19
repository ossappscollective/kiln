import assert from 'node:assert/strict';
import { GithubError, type CiArtifact, type CiArtifactDownload, type CiArtifactList } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootCi, FakeCi, run } from './ci-test-helpers.ts';
import { clearBuildCaches, guessArtifact, safeFilename, TESTFLIGHT_LIFETIME_MS } from './services/builds.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { Hono } from 'hono';
import { publicBuildsRoutes } from './routes/builds.ts';
import { createBuildsContext, readDownloadLink, signDownloadLink } from './services/builds.ts';

// Everything runs against a fake GitHub and a fake artifact storage: no live call is ever made.

class FakeBuildsCi extends FakeCi {
  artifacts: CiArtifact[] = [];
  /** What the storage sends for an artifact id; a missing entry is `missing`. */
  storage = new Map<string, CiArtifactDownload>();
  artifactEtags = false;
  listError: unknown[] = [];
  async listArtifacts(options: { etag?: string | undefined } = {}): Promise<CiArtifactList> {
    this.calls.push({ name: 'listArtifacts', args: [options.etag] });
    const error = this.listError.shift();
    if (error) throw error;
    const etag = `W/"${this.artifacts.length}"`;
    if (this.artifactEtags && options.etag === etag) return { artifacts: [], truncated: false, notModified: true, etag };
    return { artifacts: this.artifacts, truncated: false, notModified: false, ...(this.artifactEtags ? { etag } : {}) };
  }
  async openArtifactDownload(id: string): Promise<CiArtifactDownload> {
    this.calls.push({ name: 'openArtifactDownload', args: [id] });
    return this.storage.get(id) ?? { status: 'missing' };
  }
}

const T0 = 1_900_000_000_000;
const DAY = 24 * 60 * 60_000;
const art = (id: string, name: string, extra: Partial<CiArtifact> = {}): CiArtifact => ({
  id, name, sizeInBytes: 1000, expired: false, createdAt: T0 - Number(id), expiresAt: T0 + 30 * DAY, runId: '101', headBranch: 'main', headSha: '1'.repeat(40), digest: null, ...extra,
});
const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });

async function boot(db: Parameters<typeof bootCi>[0], settings: Record<string, unknown> = {}) {
  clearBuildCaches();
  const fake = new FakeBuildsCi();
  const t = await bootCi(db, {}, { connectorFactory: () => fake, builds: { downloadEnabled: true, allowHttpRedirects: true, ...settings } });
  fake.runs = [run('101', { name: 'iOS release' }), run('102', { name: 'Android release' })];
  await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
  return { ...t, fake, appId, list: (cookie = t.owner, id = appId) => t.call(cookie, 'GET', `/apps/${id}/builds/artifacts`) };
}

dbTest('guessArtifact: extension first, then words in the name, then the platform of the app; reports are not builds', async () => {
  const g = (n: string, p: 'ios' | 'android' | 'macos' = 'ios') => guessArtifact(n, p);
  assert.deepEqual(g('App.ipa'), { kind: 'ipa', platform: 'ios' });
  assert.deepEqual(g('app-release.apk'), { kind: 'apk', platform: 'android' });
  assert.deepEqual(g('app-release.aab'), { kind: 'aab', platform: 'android' });
  assert.deepEqual(g('MyApp.app.zip'), { kind: 'app', platform: 'macos' });
  assert.deepEqual(g('MyApp.dmg'), { kind: 'dmg', platform: 'macos' });
  assert.deepEqual(g('installer.pkg'), { kind: 'pkg', platform: 'macos' });
  assert.deepEqual(g('ios-build'), { kind: 'zip', platform: 'ios' });
  assert.deepEqual(g('android-release', 'ios'), { kind: 'zip', platform: 'android' });
  assert.deepEqual(g('release-bundle', 'android'), { kind: 'zip', platform: 'android' });
  assert.deepEqual(g('ios-ipa'), { kind: 'ipa', platform: 'ios' });
  assert.deepEqual(g('test-report'), { kind: 'other', platform: null });
  assert.deepEqual(g('coverage'), { kind: 'other', platform: null });
  assert.deepEqual(g('dSYMs'), { kind: 'other', platform: null });
});

dbTest('safeFilename: no path, no quotes, no control characters, always .zip', async () => {
  assert.equal(safeFilename('ios build #12 (main)'), 'ios_build_12_main.zip');
  assert.equal(safeFilename('../../etc/passwd'), 'etc_passwd.zip');
  assert.equal(safeFilename('a"b\r\nSet-Cookie: x=1'), 'a_b_Set-Cookie_x_1.zip');
  assert.equal(safeFilename('...'), 'build.zip');
  assert.equal(safeFilename('x'.repeat(300)).length, 104);
  assert.equal(safeFilename('Ünïcode-App.zip'), 'Unicode-App.zip');
});

dbTest('list: artifacts of this app\'s runs, newest first, with run, kind, size, expiry and the store builds', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [
    art('1', 'ios-build'), art('2', 'test-report'), art('3', 'old.ipa', { expired: true, expiresAt: T0 - DAY }),
    art('4', 'other-run.ipa', { runId: '999' }), art('5', 'a.apk', { runId: '102', sizeInBytes: 5 * 1024 * 1024 }),
  ];
  await db.execute(
    `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, store_id, version, processing_state, raw_state, expired, uploaded_at, first_seen_at, last_seen_at)
     VALUES (?, 'ios', '240', ?, 'b1', '2.4.0', 'processed', 'VALID', 0, ?, 1, 1), (?, 'ios', '239', ?, 'b0', '2.3.0', 'processed', 'VALID', 1, ?, 1, 1)`,
    [t.appId, t.workspaceId, T0, t.appId, t.workspaceId, T0 - 100 * DAY],
  );
  const res = await t.list();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.artifacts.map((a: { id: string }) => a.id), ['1', '2', '3']);
  assert.equal(res.body.hiddenArtifacts, 2, 'an artifact of a run that is not stored here, or of another platform, is not shown');
  const [first] = res.body.artifacts;
  assert.equal(first.kind, 'zip');
  assert.equal(first.platform, 'ios');
  assert.equal(first.guessed, true);
  assert.equal(first.run.id, '101');
  assert.equal(first.run.shortSha, '1111111');
  assert.equal(first.run.branch, 'main');
  assert.equal(first.downloadable, true);
  const old = res.body.artifacts.find((a: { id: string }) => a.id === '3');
  assert.deepEqual([old.expired, old.downloadable], [true, false]);
  assert.equal(res.body.artifacts.find((a: { id: string }) => a.id === '2').kind, 'other');
  assert.equal(res.body.downloadEnabled, true);
  assert.equal(res.body.canDownload, true);
  assert.equal(JSON.stringify(res.body).includes('archive_download_url'), false);
  const [b240, b239] = res.body.store;
  assert.deepEqual([b240.buildNumber, b240.channel, b240.state, b240.expiresAtEstimated, b240.expiresAt], ['240', 'testflight', 'processed', true, T0 + TESTFLIGHT_LIFETIME_MS]);
  assert.deepEqual([b239.expired, b239.expiresAt], [true, null], 'an expired build has no estimate');
});

dbTest('list: cached 30 seconds and shared; an ETag keeps the stored copy; a repeat call asks GitHub once', async (db) => {
  const t = await boot(db);
  t.fake.artifactEtags = true;
  t.fake.artifacts = [art('1', 'ios-build')];
  await Promise.all([t.list(), t.list(), t.list()]);
  const again = await t.list();
  assert.equal(again.body.cached, true);
  assert.equal(t.fake.count('listArtifacts'), 1);
});

dbTest('list: GitHub refusing is a quiet problem (200), with the permission to fix and no GitHub text, and is not retried at once', async (db) => {
  const t = await boot(db);
  t.fake.listError = [new GithubError('forbidden', 'GitHub refused GET /x: Resource not accessible (needs: actions=read) ghp_SECRETSECRETSECRET1234567890', 403)];
  const res = await t.list();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.problem, { reason: 'no_access', needs: 'actions: read' });
  assert.deepEqual(res.body.artifacts, []);
  assert.equal(res.text.includes('Resource not accessible'), false);
  await t.list();
  assert.equal(t.fake.count('listArtifacts'), 1, 'a refused repository is left alone for a minute');
});

dbTest('list: an app without a repository says so; rights: viewers cannot list, members can; another workspace is 404', async (db) => {
  const t = await boot(db);
  const bare = await t.seedApp('android', [{ version: '1.0', build: '5', track: 'internal', codes: ['5'] }], { repositoryId: null });
  await db.execute(
    "INSERT INTO app_builds (app_id, platform, build_number, workspace_id, version, processing_state, first_seen_at, last_seen_at) VALUES (?, 'android', '5', ?, '1.0', 'processed', 1, 1)",
    [bare, t.workspaceId],
  );
  const res = await t.list(t.owner, bare);
  assert.equal(res.body.problem.reason, 'no_repository');
  assert.equal(res.body.store[0].channel, 'play');
  assert.deepEqual(res.body.store[0].tracks, ['internal']);
  assert.equal(res.body.store[0].optInUrl, null, 'the Publisher API does not give the internal opt-in link');
  assert.equal((await t.list(await t.addMember('viewer'))).status, 403);
  assert.equal((await t.list(await t.addMember('member'))).status, 200);
  assert.equal((await t.list(t.owner, 'nope')).status, 404);
  await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await t.addMember('owner', 'other');
  assert.equal((await t.list(outsider)).status, 404);
});

dbTest('list: Play version codes on a closed track carry the opt-in address of the package', async (db) => {
  const t = await boot(db);
  const id = await t.seedApp('android', [{ version: '1.0', build: '7', track: 'beta', codes: ['7'] }, { version: '1.0', build: '7', track: 'internal', codes: ['7'] }], { repositoryId: null });
  await db.execute(
    "INSERT INTO app_builds (app_id, platform, build_number, workspace_id, version, processing_state, first_seen_at, last_seen_at) VALUES (?, 'android', '7', ?, '1.0', 'processed', 1, 1)",
    [id, t.workspaceId],
  );
  const res = await t.list(t.owner, id);
  assert.deepEqual(res.body.store[0].tracks, ['beta', 'internal']);
  assert.equal(res.body.store[0].optInUrl, 'https://play.google.com/apps/testing/com.acme.android');
});

dbTest('download: flag off answers 409 and never reaches GitHub; the list still works and says downloads are off', async (db) => {
  const t = await boot(db, { downloadEnabled: false });
  t.fake.artifacts = [art('1', 'ios-build')];
  t.fake.storage.set('1', { status: 'ok', body: stream(['x']), contentLength: 1 });
  const listed = await t.list();
  assert.equal(listed.body.downloadEnabled, false);
  const res = await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${t.appId}/builds/artifacts/1/download`, { headers: { cookie: t.owner } });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, 'builds_download_disabled');
  assert.equal(t.fake.count('openArtifactDownload'), 0);
  const link = await t.call(t.owner, 'POST', `/apps/${t.appId}/builds/artifacts/1/link`, {});
  assert.equal(link.status, 409);
});

const dl = (t: Awaited<ReturnType<typeof boot>>, id: string, cookie = t.owner) =>
  t.app.request(`/api/workspaces/${t.workspaceId}/apps/${t.appId}/builds/artifacts/${id}/download`, { headers: { cookie } });

dbTest('download: streams the zip with safe headers, an audit row of ids only, and roles (viewer 403)', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [art('1', 'ios "build" #12\r\nX: y', { sizeInBytes: 9 })];
  t.fake.storage.set('1', { status: 'ok', body: stream(['PK', '\u0003\u0004data']), contentLength: 9 });
  assert.equal((await dl(t, '1', await t.addMember('viewer'))).status, 403);
  const res = await dl(t, '1', await t.addMember('member'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="ios_build_12_X_y.zip"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await res.text(), 'PK\u0003\u0004data');
  const audit = (await t.auditActions()).filter((a) => a.action === 'build.download');
  assert.equal(audit.length, 1);
  assert.match(audit[0]?.detail ?? '', /"artifactId":"1"/);
  assert.equal((audit[0]?.detail ?? '').includes('ios'), false, 'ids and a size, no name');
});

dbTest('download: expired (410), too large before and while streaming, unknown or another app\'s (404), bad id (400)', async (db) => {
  const t = await boot(db, { maxDownloadBytes: 10 });
  t.fake.artifacts = [
    art('1', 'a', { expired: true }), art('2', 'b', { sizeInBytes: 11 }), art('3', 'c', { sizeInBytes: 5 }),
    art('4', 'd', { runId: '999' }), art('5', 'e', { sizeInBytes: 5, expiresAt: T0 }),
  ];
  t.fake.storage.set('2', { status: 'ok', body: stream(['x']), contentLength: 1 });
  t.fake.storage.set('3', { status: 'ok', body: stream(['123456', '789012']), contentLength: null });
  assert.equal((await dl(t, '1')).status, 410);
  const big = await dl(t, '2');
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: string }).error, 'artifact_too_large');
  assert.equal(t.fake.count('openArtifactDownload'), 0, 'refused before asking the storage');
  await assert.rejects(async () => (await dl(t, '3')).text(), /larger than the download limit/);
  assert.equal((await dl(t, '4')).status, 404);
  assert.equal((await dl(t, '777')).status, 404);
  assert.equal((await dl(t, 'x1')).status, 400);
  t.fake.storage.set('3', { status: 'gone' });
  assert.equal((await dl(t, '3')).status, 410, 'the storage says it is gone');
});

dbTest('download: a declared length over the limit is refused; the storage address is never in an answer; limits per workspace', async (db) => {
  const t = await boot(db, { maxDownloadBytes: 10, downloadLimiter: createTestLimiter({ limit: 2, now: () => 1 }) });
  t.fake.artifacts = [art('1', 'a', { sizeInBytes: 5 })];
  t.fake.storage.set('1', { status: 'ok', body: stream(['x']), contentLength: 50 });
  assert.equal((await dl(t, '1')).status, 413);
  t.fake.storage.set('1', { status: 'ok', body: stream(['xy']), contentLength: 2 });
  assert.equal(await (await dl(t, '1')).text(), 'xy');
  const limited = await dl(t, '1');
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

dbTest('link: a signed, single use link that works without a session, expires, and is checked against the person\'s right', async (db) => {
  const clock = { now: Date.now() };
  void clock;
  const t = await boot(db);
  t.fake.artifacts = [art('1', 'ios-build', { sizeInBytes: 4 })];
  t.fake.storage.set('1', { status: 'ok', body: stream(['ZIP!']), contentLength: 4 });
  assert.equal((await t.call(await t.addMember('viewer'), 'POST', `/apps/${t.appId}/builds/artifacts/1/link`, {})).status, 403);
  const made = await t.call(t.owner, 'POST', `/apps/${t.appId}/builds/artifacts/1/link`, {});
  assert.equal(made.status, 200);
  assert.match(made.body.path, /^\/api\/builds\/dl\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(made.text.includes('github'), false, 'never a GitHub address');
  assert.equal(Math.round((made.body.expiresAt - Date.now()) / 60_000), 10);
  // The phone is not signed in: no cookie.
  const first = await t.app.request(made.body.path);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'ZIP!');
  const second = await t.app.request(made.body.path);
  assert.equal(second.status, 410);
  assert.equal(((await second.json()) as { error: string }).error, 'link_used');
  assert.equal(t.fake.count('openArtifactDownload'), 1);
  const audit = (await t.auditActions()).filter((a) => a.action.startsWith('build.'));
  assert.deepEqual(audit.map((a) => a.action), ['build.link_created', 'build.download']);
  assert.match(audit[1]?.detail ?? '', /"via":"link"/);
});

dbTest('link: a tampered or foreign token is 404, a failed open does not burn the link, a removed member loses it', async (db) => {
  const t = await boot(db);
  t.fake.artifacts = [art('1', 'ios-build', { sizeInBytes: 4 })];
  const made = await t.call(t.owner, 'POST', `/apps/${t.appId}/builds/artifacts/1/link`, {});
  const [body, mac] = made.body.path.split('/').pop().split('.');
  assert.ok(made.body.path.length < 80, 'short enough for a small QR code');
  const flipped = `${body.slice(0, 5)}${body[5] === 'A' ? 'B' : 'A'}${body.slice(6)}`;
  for (const bad of [`${flipped}.${mac}`, `${body}.AAAA`, 'nonsense', `${body}.${mac}.extra`, `.${mac}`]) {
    assert.equal((await t.app.request(`/api/builds/dl/${bad}`)).status, 404, bad);
  }
  // The storage has nothing yet: the link is not spent, and works once the artifact can be opened.
  assert.equal((await t.app.request(made.body.path)).status, 404);
  t.fake.storage.set('1', { status: 'ok', body: stream(['ZIP!']), contentLength: 4 });
  assert.equal((await t.app.request(made.body.path)).status, 200);

  const again = await t.call(t.owner, 'POST', `/apps/${t.appId}/builds/artifacts/1/link`, {});
  t.fake.storage.set('1', { status: 'ok', body: stream(['ZIP!']), contentLength: 4 });
  await db.execute('DELETE FROM workspace_members WHERE workspace_id = ?', [t.workspaceId]);
  assert.equal((await t.app.request(again.body.path)).status, 404, 'the person who made it is no longer a member');
});

dbTest('link: expires after the time to live, even with a valid signature; a context with the switch off refuses a link made while it was on', async (db) => {
  const t = await boot(db);
  const clock = { now: T0 };
  const on = createBuildsContext(t.context(clock), { downloadEnabled: true, linkTtlMs: 10 * 60_000 });
  const input = { workspaceId: t.workspaceId, appId: t.appId, artifactId: '1', userId: 'u' };
  const { token, expiresAt } = signDownloadLink(on, input);
  assert.equal(expiresAt, T0 + 10 * 60_000);
  assert.equal(readDownloadLink(on, token).ok, true);
  clock.now = T0 + 10 * 60_000 - 1;
  assert.equal(readDownloadLink(on, token).ok, true);
  clock.now = T0 + 10 * 60_000;
  assert.deepEqual(readDownloadLink(on, token), { ok: false, reason: 'expired' });
  // Another server key does not verify the token, nor does a server that never made it (a restart forgets links).
  const other = createBuildsContext({ ...t.context(clock), masterKey: Buffer.alloc(32, 7) }, { downloadEnabled: true });
  clock.now = T0;
  assert.deepEqual(readDownloadLink(other, token), { ok: false, reason: 'invalid' });
  assert.deepEqual(readDownloadLink(createBuildsContext(t.context(clock), { downloadEnabled: true }), token), { ok: false, reason: 'invalid' });
  const off = new Hono().route('/api/builds', publicBuildsRoutes(createBuildsContext(t.context(clock), { downloadEnabled: false })));
  assert.equal((await off.request(`/api/builds/dl/${token}`)).status, 409);
});
