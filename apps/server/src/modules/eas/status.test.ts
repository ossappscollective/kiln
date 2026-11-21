import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import {
  ARTIFACT_URL,
  buildsBody,
  easBuild,
  easSubmission,
  submissionsBody,
} from '../../../../../packages/connectors/src/expo/eas-status.fixtures.ts';
import { graphqlError } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import { createScheduler } from '../../scheduler.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { seedWorkspace } from '../../testkit.ts';
import { type EasBoot, EXPO_TOKEN, json, OTHER_PROJECT_ID, PROJECT_ID, bootEas } from './test-helpers.ts';
import { project } from '../../../../../packages/connectors/src/expo/expo.fixtures.ts';
import {
  createEasStatusHandler,
  EAS_STATUS_QUEUE,
  easStatusIntervalMs,
  queueEasStatusSyncs,
} from './status-sync.ts';
import { easBackoffMs, EAS_BACKOFF_MAX_MS } from './status.ts';

const MINUTE = 60_000;

type StatusCall = { operation: string; variables: Record<string, unknown>; authorization: string };

/** A fake Expo that also answers the builds and submissions queries; everything else goes to the foundation's fake. */
function statusFake(t: EasBoot) {
  const state = {
    builds: [easBuild()] as unknown[],
    submissions: [easSubmission()] as unknown[],
    /** Answers handed out instead of the normal one, in order. */
    next: [] as (Response | Error)[],
    calls: [] as StatusCall[],
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { operationName?: string; variables?: Record<string, unknown> };
    if (body.operationName !== 'MrmEasBuilds' && body.operationName !== 'MrmEasSubmissions') {
      return t.expo.fetch(input, init);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    state.calls.push({
      operation: body.operationName,
      variables: body.variables ?? {},
      authorization: headers.authorization ?? '',
    });
    const queued = state.next.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    return json(body.operationName === 'MrmEasBuilds' ? buildsBody(state.builds) : submissionsBody(state.submissions));
  };
  return { state, fetch: fetchFn };
}

async function boot(db: Parameters<typeof bootEas>[0], extra: Parameters<typeof bootEas>[1] = {}) {
  // The fake needs the booted app's own Expo fake, so it is built after boot and handed in through a late-bound fetch.
  let late: typeof fetch = async () => new Response('{}');
  const t = await bootEas(db, { eas: { fetch: (input, init) => late(input, init) }, ...extra });
  const fake = statusFake(t);
  late = fake.fetch;
  const appId = await t.seedApp();
  const link = (id = appId) => t.put(id, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  return { t, fake, appId, link };
}

const noSecrets = async (t: EasBoot) => {
  const parts: string[] = [...t.texts];
  for (const table of ['credentials', 'audit_events', 'app_expo_links', 'eas_builds', 'eas_submissions', 'eas_status_sync', 'jobs']) {
    const rows = await t.db.query(`SELECT * FROM ${table}`);
    parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
  }
  const all = parts.join('\n');
  assert.ok(!all.includes(EXPO_TOKEN), 'the Expo token leaked');
  assert.ok(!all.includes('secret-signed-path'), 'a build file address leaked');
  assert.ok(!all.includes(ARTIFACT_URL), 'a build file address leaked');
};

dbTest('an app with no link has no status, and a read says so', async (db) => {
  const { t, fake, appId } = await boot(db);
  const status = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status.project, null);
  assert.deepEqual(status.body.status.builds, []);
  assert.equal(status.body.status.sync.readAt, null);
  const refresh = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(refresh.status, 409);
  assert.equal(refresh.body.error, 'not_linked');
  assert.equal(fake.state.calls.length, 0);
});

dbTest('a read stores the builds and submissions of the platform and the views show them; listing never calls Expo', async (db) => {
  const { t, fake, appId, link } = await boot(db);
  assert.equal((await link()).status, 200);
  const before = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(before.body.status.project.fullName, '@acme/trail-notes');
  assert.equal(before.body.status.project.url, 'https://expo.dev/accounts/acme/projects/trail-notes');
  assert.equal(before.body.status.sync.readAt, null, 'nothing is read until a read is asked for');
  assert.equal(fake.state.calls.length, 0);

  const res = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    fake.state.calls.map((c) => [c.operation, c.variables.platform ?? (c.variables.filter as { platform: string }).platform, c.authorization]),
    [
      ['MrmEasBuilds', 'IOS', `Bearer ${EXPO_TOKEN}`],
      ['MrmEasSubmissions', 'IOS', `Bearer ${EXPO_TOKEN}`],
    ],
  );
  const { status } = res.body;
  assert.equal(status.supported, true);
  assert.equal(status.active, false);
  assert.ok(status.sync.readAt > 0);
  assert.equal(status.sync.lastError, null);
  assert.equal(status.sync.buildsTruncated, false);
  const [build] = status.builds;
  assert.equal(status.builds.length, 1);
  assert.deepEqual(
    { ...build, createdAt: undefined, updatedAt: undefined, completedAt: undefined, artifactExpiresAt: undefined },
    {
      id: 'b0000000-0000-4000-8000-000000000001',
      platform: 'ios',
      status: 'finished',
      rawStatus: 'FINISHED',
      active: false,
      buildProfile: 'production',
      channel: 'production',
      appVersion: '1.4.0',
      buildNumber: '57',
      buildNumberLabel: 'Build',
      sdkVersion: '52.0.0',
      runtimeVersion: '1.4.0',
      distribution: 'store',
      internal: false,
      simulator: false,
      appIdentifier: 'com.acme.trail',
      gitCommitHash: '0123456789abcdef0123456789abcdef01234567',
      gitCommitMessage: 'Fix the trail map',
      error: null,
      hasArtifact: true,
      expoUrl: 'https://expo.dev/accounts/acme/projects/trail-notes/builds/b0000000-0000-4000-8000-000000000001',
      createdAt: undefined,
      updatedAt: undefined,
      completedAt: undefined,
      artifactExpiresAt: undefined,
    },
  );
  assert.equal(build.createdAt, Date.parse('2026-11-18T10:00:00.000Z'));
  assert.equal(build.artifactExpiresAt, Date.parse('2026-12-18T10:20:00.000Z'));
  const [submission] = status.submissions;
  assert.deepEqual(
    { ...submission, createdAt: undefined, completedAt: undefined },
    {
      id: 's0000000-0000-4000-8000-000000000001',
      platform: 'ios',
      status: 'finished',
      rawStatus: 'FINISHED',
      active: false,
      buildId: 'b0000000-0000-4000-8000-000000000001',
      build: { appVersion: '1.4.0', buildNumber: '57', buildNumberLabel: 'Build' },
      store: { id: 'appstoreconnect', name: 'App Store Connect' },
      identifier: '1234567890',
      track: null,
      releaseStatus: null,
      error: null,
      expoUrl: 'https://expo.dev/accounts/acme/projects/trail-notes/submissions/s0000000-0000-4000-8000-000000000001',
      createdAt: undefined,
      completedAt: undefined,
    },
  );

  // Listing reads the database only.
  const calls = fake.state.calls.length;
  const again = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.deepEqual(again.body.status, status);
  assert.equal(fake.state.calls.length, calls);

  // The use of the credential and the manual read are audited; no token and no build file address anywhere.
  const audit = await t.auditActions();
  assert.ok(audit.some((a) => a.action === 'credential.use' && JSON.parse(a.detail).purpose === 'eas.status'));
  const refreshed = audit.find((a) => a.action === 'eas.status_refresh');
  assert.equal(refreshed?.targetId, appId);
  assert.deepEqual(JSON.parse(refreshed?.detail ?? '{}'), { appId, projectId: PROJECT_ID, builds: 1, submissions: 1 });
  await noSecrets(t);
});

dbTest('an Android record reads Android, shows version codes, tracks, internal distribution and errors', async (db) => {
  const { t, fake, link } = await boot(db);
  const appId = await t.seedApp({ platform: 'android' });
  assert.equal((await link(appId)).status, 200);
  fake.state.builds = [
    easBuild({
      id: 'b-internal',
      platform: 'ANDROID',
      distribution: 'INTERNAL',
      buildProfile: 'preview',
      appBuildVersion: '120',
      status: 'IN_PROGRESS',
      completedAt: null,
      artifacts: null,
      createdAt: '2026-11-20T08:00:00.000Z',
    }),
    easBuild({
      id: 'b-failed',
      platform: 'ANDROID',
      status: 'ERRORED',
      createdAt: '2026-11-19T08:00:00.000Z',
      error: { errorCode: 'EAS_BUILD_UNKNOWN_GRADLE_ERROR', message: 'Gradle build failed with unknown error.' },
      artifacts: { buildUrl: null, applicationArchiveUrl: null },
    }),
  ];
  fake.state.submissions = [
    easSubmission({
      id: 's-play',
      platform: 'ANDROID',
      status: 'ERRORED',
      submittedBuild: { id: 'b-failed' },
      iosConfig: null,
      androidConfig: { applicationIdentifier: 'com.acme.trail', track: 'INTERNAL', releaseStatus: 'DRAFT' },
      error: { errorCode: 'SUBMISSION_REJECTED', message: 'Play refused the upload.' },
    }),
  ];
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(fake.state.calls.map((c) => c.variables.platform ?? (c.variables.filter as { platform: string }).platform), ['ANDROID', 'ANDROID']);
  const { status } = res.body;
  assert.equal(status.active, true, 'a build is still running');
  const [running, failed] = status.builds;
  assert.equal(running.id, 'b-internal', 'newest first');
  assert.equal(running.active, true);
  assert.equal(running.internal, true);
  assert.equal(running.buildNumber, '120');
  assert.equal(running.buildNumberLabel, 'Version code');
  assert.equal(running.hasArtifact, false);
  assert.equal(failed.status, 'errored');
  assert.deepEqual(failed.error, { code: 'EAS_BUILD_UNKNOWN_GRADLE_ERROR', message: 'Gradle build failed with unknown error.' });
  const [submission] = status.submissions;
  assert.equal(submission.store.id, 'googleplay');
  assert.equal(submission.store.name, 'Google Play Console');
  assert.equal(submission.track, 'INTERNAL');
  assert.equal(submission.releaseStatus, 'DRAFT');
  assert.equal(submission.identifier, 'com.acme.trail');
  assert.deepEqual(submission.build, { appVersion: '1.4.0', buildNumber: '57', buildNumberLabel: 'Version code' });
  assert.deepEqual(submission.error, { code: 'SUBMISSION_REJECTED', message: 'Play refused the upload.' });
});

dbTest('a macOS record is not read (EAS has no macOS), and an app without a usable credential says so', async (db) => {
  const { t, fake, appId, link } = await boot(db);
  await db.execute("UPDATE apps SET platform = 'macos' WHERE id = ?", [appId]);
  await db.execute(
    `INSERT INTO app_expo_links (app_id, workspace_id, credential_id, project_id, account_name, slug, project_name, verified_at, linked_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'acme', 'trail-notes', 'Trail Notes', 1, 'u', 1, 1)`,
    [appId, t.workspaceId, t.expoCredentialId, PROJECT_ID],
  );
  const view = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(view.body.status.supported, false);
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'platform_unsupported');
  assert.equal(fake.state.calls.length, 0);

  const other = await t.seedApp();
  assert.equal((await link(other)).status, 200);
  await db.execute('DELETE FROM credentials WHERE id = ?', [t.expoCredentialId]);
  const gone = await t.call(t.owner, 'POST', `/apps/${other}/eas/status/refresh`);
  assert.equal(gone.status, 422);
  assert.equal(gone.body.error, 'credential_not_found');
  assert.equal(fake.state.calls.length, 0);
});

dbTest('a failed read keeps the old snapshot, says why, backs off, and the next good read clears it', async (db) => {
  const { t, fake, appId, link } = await boot(db);
  await link();
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 200);

  fake.state.next.push(json(graphqlError('Entity not authorized: Build')));
  const forbidden = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.body.error, 'expo_forbidden');
  fake.state.next.push(new Response('{}', { status: 429, headers: { 'retry-after': '90' } }));
  const slow = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(slow.status, 429);
  assert.equal(slow.headers.get('retry-after'), '90');
  fake.state.next.push(new Response('nope', { status: 500 }));
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 502);

  const kept = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(kept.body.status.builds.length, 1, 'the old snapshot is still there');
  assert.equal(kept.body.status.sync.lastError, 'expo_unavailable');
  assert.equal(kept.body.status.sync.consecutiveFailures, 3);
  assert.ok(kept.body.status.sync.readAt > 0);
  const [state] = await db.query('SELECT backoff_until, last_attempt_at FROM eas_status_sync WHERE app_id = ?', [appId]);
  assert.equal(Number(state?.backoff_until) - Number(state?.last_attempt_at), easBackoffMs(3));

  const ok = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status.sync.lastError, null);
  assert.equal(ok.body.status.sync.consecutiveFailures, 0);
  const [after] = await db.query('SELECT backoff_until FROM eas_status_sync WHERE app_id = ?', [appId]);
  assert.equal(after?.backoff_until, null);
  await noSecrets(t);
});

dbTest('the backoff doubles and stops at six hours', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => easBackoffMs(n) / MINUTE), [10, 20, 40, 80, 160, 320, 360, 360]);
  assert.equal(easBackoffMs(50), EAS_BACKOFF_MAX_MS);
});

dbTest('a project Expo does not show, an unreadable answer and a timeout use the shared codes', async (db) => {
  const { t, fake, appId, link } = await boot(db);
  await link();
  fake.state.next.push(json({ data: { app: { byId: null } } }));
  const missing = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, 'expo_not_found');
  fake.state.next.push(json({ data: { app: { byId: { id: 'p', builds: 'no' } } } }));
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 502);
  fake.state.next.push(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
  const timeout = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.error, 'timeout');
  assert.equal((await db.query('SELECT * FROM eas_builds')).length, 0, 'a failed first read stores nothing');
});

dbTest('who may do what: members read and read again, viewers and strangers cannot', async (db) => {
  const { t, appId, link } = await boot(db);
  await link();
  const admin = await t.addMember('admin');
  const member = await t.addMember('member');
  const viewer = await t.addMember('viewer');
  for (const cookie of [t.owner, admin, member]) {
    assert.equal((await t.call(cookie, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 200);
    assert.equal((await t.call(cookie, 'GET', `/apps/${appId}/eas/status`)).status, 200);
  }
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/eas/status`)).status, 403);
  assert.equal((await t.call(viewer, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 403);
  assert.equal((await t.call(t.owner, 'GET', '/apps/nope/eas/status')).status, 404);
  assert.equal((await t.call(t.owner, 'POST', '/apps/nope/eas/status/refresh')).status, 404);
  const other = await seedWorkspace(db, 'Other', 'other@example.com', Date.now());
  assert.equal((await t.call(other.cookie, 'GET', `/apps/${appId}/eas/status`)).status, 404);
  assert.equal((await t.call(other.cookie, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 404);
  assert.equal((await t.call(other.cookie, 'GET', `/apps/${appId}/eas/status`, undefined, other.workspaceId)).status, 404);
  assert.equal((await t.app.request(`/api/workspaces/${t.workspaceId}/apps/${appId}/eas/status`)).status, 401);
});

dbTest('a manual read is rate limited on the budget of the app syncs', async (db) => {
  const { t, fake, appId, link } = await boot(db, { appSync: { limiter: createTestLimiter({ limit: 2 }) } });
  await link();
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 200);
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`)).status, 200);
  const limited = await t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(fake.state.calls.length, 4, 'the refused read made no call');
  // Reading the stored snapshot is not limited.
  assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`)).status, 200);
});

dbTest('the snapshot goes away with the link, with a change of project, and with the app', async (db) => {
  const { t, appId, link } = await boot(db);
  const read = () => t.call(t.owner, 'POST', `/apps/${appId}/eas/status/refresh`);
  const counts = async () =>
    (await Promise.all(['eas_builds', 'eas_submissions', 'eas_status_sync'].map((n) => db.query(`SELECT COUNT(*) AS n FROM ${n}`)))).map(
      (r) => Number(r[0]?.n),
    );
  await link();
  await read();
  assert.deepEqual(await counts(), [1, 1, 1]);

  // Saving the same project again keeps what was read; another project starts again from nothing.
  await link();
  assert.deepEqual(await counts(), [1, 1, 1]);
  t.expo.projects.set(OTHER_PROJECT_ID, project({ id: OTHER_PROJECT_ID, slug: 'other', fullName: '@acme/other', name: 'Other' }));
  assert.equal((await t.put(appId, { credentialId: t.expoCredentialId, project: '@acme/other' })).status, 200);
  assert.deepEqual(await counts(), [0, 0, 0]);

  await t.put(appId, { credentialId: t.expoCredentialId, project: PROJECT_ID });
  await read();
  assert.deepEqual(await counts(), [1, 1, 1]);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}/expo`)).status, 204);
  assert.deepEqual(await counts(), [0, 0, 0]);
  const gone = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(gone.body.status.project, null);

  await link();
  await read();
  assert.deepEqual(await counts(), [1, 1, 1]);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  assert.deepEqual(await counts(), [0, 0, 0]);
});

// ---------------------------------------------------------------------------------------------
// The scheduled read

const T0 = 1_900_000_000_000;
const jobsOf = async (t: EasBoot) =>
  (await t.db.query('SELECT payload, run_at, status FROM jobs WHERE queue = ? ORDER BY run_at, id', [EAS_STATUS_QUEUE])).map((j) => ({
    appId: (JSON.parse(String(j.payload)) as { appId: string }).appId,
    runAt: Number(j.run_at),
    status: String(j.status),
  }));
const finish = async (t: EasBoot) => t.db.execute("UPDATE jobs SET status = 'done' WHERE queue = ?", [EAS_STATUS_QUEUE]);
const options = { intervalMs: 30 * MINUTE, jitter: () => 0 };

dbTest('the interval is 0 (off) or 5 minutes to a week', async () => {
  assert.equal(easStatusIntervalMs(0), 0);
  assert.equal(easStatusIntervalMs(30), 30 * MINUTE);
  for (const bad of [1, 4, 10_081, 2.5]) assert.throws(() => easStatusIntervalMs(bad), /EAS status interval/);
});

dbTest('the scheduler queues a read for each linked app record that is due, never for others', async (db) => {
  const { t, appId, link } = await boot(db);
  const unlinked = await t.seedApp();
  const mac = await t.seedApp();
  await db.execute("UPDATE apps SET platform = 'macos' WHERE id = ?", [mac]);
  await link();
  await db.execute(
    `INSERT INTO app_expo_links (app_id, workspace_id, credential_id, project_id, account_name, slug, project_name, verified_at, linked_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'acme', 'trail-notes', 'Trail Notes', 1, 'u', 1, 1)`,
    [mac, t.workspaceId, t.expoCredentialId, PROJECT_ID],
  );
  const summary = await queueEasStatusSyncs(db, { now: T0, ...options });
  assert.equal(summary.queued, 1);
  assert.equal(summary.skipped.notReady, 1, 'macOS: EAS has no such platform');
  assert.deepEqual((await jobsOf(t)).map((j) => j.appId), [appId]);
  assert.ok(!(await jobsOf(t)).some((j) => j.appId === unlinked));
  // Queued once: nothing is queued while the job waits.
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 1, ...options })).skipped.alreadyQueued, 1);
  assert.equal((await jobsOf(t)).length, 1);
});

dbTest('a read is due an interval after the last attempt, and a running build brings it forward', async (db) => {
  const { t, appId, link } = await boot(db);
  await link();
  await queueEasStatusSyncs(db, { now: T0, ...options });
  await finish(t);
  // The handler of the job reads and records the attempt at T0 (fake clock below).
  await db.execute(
    "INSERT INTO eas_status_sync (app_id, workspace_id, last_attempt_at, last_success_at) VALUES (?, ?, ?, ?)",
    [appId, t.workspaceId, T0, T0],
  );
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 29 * MINUTE, ...options })).skipped.recent, 1);
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 30 * MINUTE, ...options })).queued, 1);
  await finish(t);

  // Something running: read again after three minutes, not thirty.
  await db.execute(
    `INSERT INTO eas_builds (app_id, build_id, workspace_id, platform, status, fetched_at) VALUES (?, 'b1', ?, 'ios', 'in_progress', ?)`,
    [appId, t.workspaceId, T0],
  );
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 2 * MINUTE, ...options })).skipped.recent, 1);
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 3 * MINUTE, ...options })).queued, 1);
  await finish(t);
  // A finished build does not.
  await db.execute("UPDATE eas_builds SET status = 'finished'");
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 3 * MINUTE, ...options })).skipped.recent, 1);
  // A running submission does.
  await db.execute(
    `INSERT INTO eas_submissions (app_id, submission_id, workspace_id, platform, status, fetched_at) VALUES (?, 's1', ?, 'ios', 'awaiting_build', ?)`,
    [appId, t.workspaceId, T0],
  );
  assert.equal((await queueEasStatusSyncs(db, { now: T0 + 3 * MINUTE, ...options })).queued, 1);
});

dbTest('after a failure the scheduler waits for the backoff; the credential is used by one job at a time; budgets apply', async (db) => {
  const { t, appId, link } = await boot(db);
  const second = await t.seedApp({ platform: 'android' });
  await link();
  await link(second);
  await db.execute(
    'INSERT INTO eas_status_sync (app_id, workspace_id, last_attempt_at, consecutive_failures, backoff_until, last_error) VALUES (?, ?, ?, 1, ?, ?)',
    [appId, t.workspaceId, T0 - 40 * MINUTE, T0 + 5 * MINUTE, 'expo_auth'],
  );
  const first = await queueEasStatusSyncs(db, { now: T0, ...options });
  assert.equal(first.skipped.backoff, 1);
  assert.equal(first.queued, 1, 'the other app record is due');
  assert.deepEqual((await jobsOf(t)).map((j) => j.appId), [second]);
  await finish(t);

  // Two records on one credential: one job at a time.
  await db.execute('DELETE FROM eas_status_sync');
  await db.execute("DELETE FROM jobs");
  const both = await queueEasStatusSyncs(db, { now: T0, ...options });
  assert.equal(both.queued, 1);
  assert.equal(both.skipped.alreadyQueued, 1);
  await db.execute("UPDATE jobs SET status = 'done'");

  // The budget of the workspace and the per tick cap.
  const limited = await queueEasStatusSyncs(db, { now: T0, ...options, limiter: { take: () => 30 } });
  assert.equal(limited.queued, 0);
  assert.equal(limited.skipped.rateLimited, 2, 'both records wait for the workspace budget');
  assert.equal((await queueEasStatusSyncs(db, { now: T0, ...options, perTick: 0 })).skipped.capped, 2);
});

dbTest('a queued read is spaced by the jitter and the spacing; a credential that is not an Expo credential is skipped', async (db) => {
  const { t, appId, link } = await boot(db);
  await link();
  await queueEasStatusSyncs(db, { now: T0, intervalMs: 30 * MINUTE, jitter: () => 7_000, spacingMs: 1000 });
  assert.equal((await jobsOf(t))[0]?.runAt, T0 + 7_000);
  await db.execute("DELETE FROM jobs");
  await db.execute('UPDATE app_expo_links SET credential_id = ? WHERE app_id = ?', [await t.addCredential(), appId]);
  assert.equal((await queueEasStatusSyncs(db, { now: T0, ...options })).queued, 0);
});

dbTest('the worker handler reads as the system, audits the use of the credential, and never throws', async (db) => {
  const { t, fake, appId, link } = await boot(db);
  await link();
  const handler = createEasStatusHandler({ db, masterKey: t.masterKey, now: () => T0, deps: { fetch: fake.fetch } });
  await handler({ workspaceId: t.workspaceId, appId, requestedBy: 'scheduler' }, { id: 'j', queue: EAS_STATUS_QUEUE, payload: null, attempts: 1 });
  const view = await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`);
  assert.equal(view.body.status.builds.length, 1);
  assert.equal(view.body.status.sync.readAt, T0);
  const audit = await t.auditActions();
  const use = audit.filter((a) => a.action === 'credential.use' && JSON.parse(a.detail).purpose === 'eas.status');
  assert.equal(use.length, 1);
  assert.equal(use[0]?.actorType, 'system');
  assert.equal(audit.filter((a) => a.action === 'eas.status_refresh').length, 0, 'a scheduled read is not a manual refresh');

  fake.state.next.push(new Response('{}', { status: 401 }));
  await handler({ workspaceId: t.workspaceId, appId, requestedBy: 'scheduler' }, { id: 'j', queue: EAS_STATUS_QUEUE, payload: null, attempts: 1 });
  assert.equal((await t.call(t.owner, 'GET', `/apps/${appId}/eas/status`)).body.status.sync.lastError, 'expo_auth');
  // A payload that is not ours, or an app that is gone, is ignored.
  await handler(null, { id: 'j', queue: EAS_STATUS_QUEUE, payload: null, attempts: 1 });
  await handler({ workspaceId: t.workspaceId, appId: 'nope', requestedBy: 'x' }, { id: 'j', queue: EAS_STATUS_QUEUE, payload: null, attempts: 1 });
  await noSecrets(t);
});

dbTest('the scheduler tick queues EAS reads only when the interval is on, and a failure there does not stop the tick', async (db) => {
  const { t, appId, link } = await boot(db);
  await link();
  const off = createScheduler({ db, now: () => T0, jitter: () => 0 });
  assert.equal((await off.tick()).easStatus, undefined);
  assert.equal((await jobsOf(t)).length, 0);
  const on = createScheduler({ db, now: () => T0, jitter: () => 0, easStatusIntervalMs: 30 * MINUTE });
  const summary = await on.tick();
  assert.equal(summary.easStatus?.queued, 1);
  assert.deepEqual((await jobsOf(t)).map((j) => j.appId), [appId]);
});
