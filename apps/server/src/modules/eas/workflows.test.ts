import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { runJob } from '../../../../../packages/connectors/src/expo/workflows.fixtures.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { loadPipelineFacts } from '../planning/release-pipeline.ts';
import { alertsFromEvent } from '../alerts/catalog.ts';
import { run as githubRun, SHA_2 } from '../ci/test-helpers.ts';
import { refreshRuns } from '../ci/service.ts';
import { createScheduler } from '../../scheduler.ts';
import { getRepository } from '../../services/repositories.ts';
import { json } from './test-helpers.ts';
import {
  createEasPollHandler,
  EAS_POLL_QUEUE,
  type EasPollPayload,
  easPollDelayMs,
} from './workflows.ts';
import { bootEasWorkflows, EXPO_TOKEN, type EasWorkflowsBoot } from './workflows-test-helpers.ts';

const FIRST = '019d9d17-013a-7e05-89aa-4aa83ff68c30';
const SECOND = '019d9d17-013a-7e05-89aa-4aa83ff68c31';

/** Everything that could hold the Expo token, as one string. */
async function dump(t: EasWorkflowsBoot) {
  const parts: string[] = [];
  for (const table of [
    'credentials',
    'audit_events',
    'events',
    'workflow_runs',
    'jobs',
    'ci_run_apps',
  ]) {
    const rows = await t.db.query(`SELECT * FROM ${table}`);
    parts.push(JSON.stringify(rows.map(({ ciphertext: _c, ...rest }) => rest)));
  }
  return [...parts, ...t.texts].join('\n');
}
const noToken = async (t: EasWorkflowsBoot) =>
  assert.ok(!(await dump(t)).includes(EXPO_TOKEN), 'the Expo token leaked');

const events = async (t: EasWorkflowsBoot) =>
  (
    await t.db.query("SELECT type, app_id, payload FROM events WHERE type LIKE 'ci.%' ORDER BY id")
  ).map((r) => ({
    type: String(r.type),
    appId: r.app_id as string | null,
    payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
  }));
const storedRows = (t: EasWorkflowsBoot) =>
  t.db.query("SELECT * FROM workflow_runs WHERE provider = 'eas-workflows' ORDER BY started_at");
const pollJobs = (t: EasWorkflowsBoot) =>
  t.db.query('SELECT payload, run_at, status FROM jobs WHERE queue = ? ORDER BY run_at, id', [
    EAS_POLL_QUEUE,
  ]);

dbTest(
  'starting a workflow asks Expo, stores the run with the runs of the repository and follows it',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const res = await t.dispatch(appId, {
      workflow: '.eas/workflows/build.yml',
      inputs: { platform: 'ios', build_number: 42 },
    });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.dispatched, true);
    const run = res.body.run;
    assert.equal(run.id, FIRST);
    assert.equal(run.provider, 'eas-workflows');
    assert.equal(run.status, 'queued');
    assert.equal(run.active, true);
    assert.equal(run.workflow, 'build.yml');
    assert.equal(run.workflowPath, '.eas/workflows/build.yml');
    assert.equal(run.branch, 'main', 'the default branch of the repository');
    assert.equal(run.url, `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${FIRST}`);
    assert.deepEqual(run.inputs, { platform: 'ios', build_number: '42' });
    assert.deepEqual(run.appIds, [appId]);
    assert.equal(run.repositoryId, t.repositoryId);
    assert.equal(run.event, 'workflow_dispatch');

    // What Expo was asked: the documented request, with the project of the link and the token as a bearer.
    assert.equal(t.expo.rest.length, 1);
    const call = t.expo.rest[0];
    assert.equal(call?.url, 'https://api.expo.dev/v2/workflows/dispatch');
    assert.equal(call?.method, 'POST');
    assert.equal(call?.authorization, `Bearer ${EXPO_TOKEN}`);
    assert.deepEqual(call?.body, {
      appId: '2f1c8e5a-7b3d-4c9e-8a61-0d5b9e4f7a12',
      gitRef: 'main',
      fileName: 'build.yml',
      inputs: { platform: 'ios', build_number: 42 },
    });

    // Audited like a GitHub dispatch (names of the inputs, never their values), plus the use of the credential.
    const audit = await t.auditActions();
    const dispatched = audit.filter((a) => a.action === 'ci.dispatch');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.targetId, t.repositoryId);
    const detail = JSON.parse(String(dispatched[0]?.detail));
    assert.deepEqual(detail, {
      provider: 'eas-workflows',
      workflow: 'build.yml',
      ref: 'main',
      inputs: ['build_number', 'platform'],
      appId,
      ok: true,
      runId: FIRST,
    });
    const uses = audit.filter(
      (a) => a.action === 'credential.use' && a.detail.includes('eas.workflow'),
    );
    assert.equal(uses.length, 1);

    // `ci.run_started` is announced, and a read of the run is queued.
    assert.deepEqual(
      (await events(t)).map((e) => [e.type, e.appId, e.payload.runId]),
      [['ci.run_started', appId, FIRST]],
    );
    const queued = await pollJobs(t);
    assert.equal(queued.length, 1);
    assert.equal(JSON.parse(String(queued[0]?.payload)).runId, FIRST);
    await noToken(t);
  },
);

dbTest(
  'a ref and inputs can be given; the same run list shows the run with its provider',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const res = await t.dispatch(appId, {
      workflow: 'release.yml',
      ref: 'release/1.2',
      inputs: { profile: 'production' },
    });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.run.branch, 'release/1.2');
    assert.deepEqual(t.expo.rest[0]?.body, {
      appId: '2f1c8e5a-7b3d-4c9e-8a61-0d5b9e4f7a12',
      gitRef: 'release/1.2',
      fileName: 'release.yml',
      inputs: { profile: 'production' },
    });
    const list = await t.call(t.owner, 'GET', `/apps/${appId}/expo/workflows/runs`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.runs.map((r: { id: string; provider: string }) => [r.id, r.provider]),
      [[FIRST, 'eas-workflows']],
    );
  },
);

dbTest(
  'who may start a run: members and above, like a GitHub dispatch; not viewers, not outsiders',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const viewer = await t.addMember('viewer');
    const member = await t.addMember('member');
    assert.equal((await t.dispatch(appId, { workflow: 'build.yml' }, viewer)).status, 403);
    assert.equal(t.expo.rest.length, 0, 'a refused person never reaches Expo');
    assert.equal((await t.dispatch(appId, { workflow: 'build.yml' }, member)).status, 202);
    assert.equal((await t.dispatch('nope', { workflow: 'build.yml' })).status, 404);
    assert.equal(
      (await t.dispatch(appId, { workflow: 'build.yml' }, 'kiln_session=nobody')).status,
      401,
    );
    const audit = await t.auditActions();
    assert.equal(
      audit.filter((a) => a.action === 'ci.dispatch').length,
      1,
      'only the allowed start is audited',
    );
  },
);

dbTest('the body is checked before anything is sent', async (db) => {
  const t = await bootEasWorkflows(db);
  const appId = await t.seedLinkedApp();
  for (const body of [
    {},
    { workflow: '' },
    { workflow: 'build' },
    { workflow: '.eas/workflows/sub/build.yml' },
    { workflow: 'build.yml', ref: 'a..b' },
    { workflow: 'build.yml', inputs: { 'bad key': 'x' } },
    { workflow: 'build.yml', inputs: { a: { nested: true } } },
    { workflow: 'build.yml', extra: 1 },
  ]) {
    const res = await t.dispatch(appId, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'invalid_request');
  }
  const tooMany = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, 'x']));
  assert.equal((await t.dispatch(appId, { workflow: 'build.yml', inputs: tooMany })).status, 400);
  assert.equal(t.expo.rest.length, 0);
});

dbTest('an app needs an Expo link and a repository first', async (db) => {
  const t = await bootEasWorkflows(db);
  const unlinked = await t.seedLinkedApp({ link: false });
  const a = await t.dispatch(unlinked, { workflow: 'build.yml' });
  assert.equal(a.status, 422);
  assert.equal(a.body.error, 'expo_not_linked');
  const noRepo = await t.seedLinkedApp({ repositoryId: null });
  const b = await t.dispatch(noRepo, { workflow: 'build.yml' });
  assert.equal(b.status, 422);
  assert.equal(b.body.error, 'repository_required');
  assert.equal(t.expo.rest.length, 0);
  assert.equal((await storedRows(t)).length, 0);
});

dbTest('a deleted credential stops the start with a clear code', async (db) => {
  const t = await bootEasWorkflows(db);
  const appId = await t.seedLinkedApp();
  await t.db.execute('DELETE FROM credentials WHERE id = ?', [t.expoCredentialId]);
  const res = await t.dispatch(appId, { workflow: 'build.yml' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'credential_not_found');
  assert.equal(t.expo.rest.length, 0);
});

dbTest(
  'Expo errors become fixed answers, nothing is stored, the attempt is audited, the token never shows',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const cases: [() => void, number, string, RegExp | undefined][] = [
      [
        () => t.expo.next.push(json({ error: `no ${EXPO_TOKEN}` }, 401)),
        422,
        'expo_auth',
        undefined,
      ],
      [() => t.expo.next.push(json({}, 403)), 422, 'expo_forbidden', undefined],
      [() => t.expo.refs.delete('main'), 422, 'expo_not_found', /Git ref or workflow file/],
      [() => t.expo.next.push(json({}, 400)), 422, 'invalid_workflow', /inputs/],
      [() => t.expo.next.push(json({}, 500)), 502, 'expo_unavailable', undefined],
      [
        () =>
          t.expo.next.push(
            Object.assign(new Error(`slow ${EXPO_TOKEN}`), { name: 'TimeoutError' }),
          ),
        504,
        'timeout',
        /may still have started/,
      ],
      [() => t.expo.next.push(new Error('connection reset')), 502, 'expo_unavailable', undefined],
    ];
    for (const [arrange, status, code, message] of cases) {
      arrange();
      const res = await t.dispatch(appId, { workflow: 'build.yml' });
      assert.equal(res.status, status, `${code}: ${res.text}`);
      assert.equal(res.body.error, code);
      if (message) assert.match(String(res.body.message), message);
      assert.ok(!res.text.includes(EXPO_TOKEN));
    }
    // The 404 left `main` missing from Expo, so the same request keeps failing the same way.
    assert.equal((await storedRows(t)).length, 0);
    assert.equal((await pollJobs(t)).length, 0);
    assert.equal((await events(t)).length, 0);
    const failed = (await t.auditActions()).filter((a) => a.action === 'ci.dispatch');
    assert.equal(failed.length, cases.length);
    for (const a of failed) assert.equal(JSON.parse(a.detail).ok, false);
    assert.deepEqual(
      failed.map((a) => JSON.parse(a.detail).code),
      [
        'expo_auth',
        'expo_forbidden',
        'expo_not_found',
        'invalid_workflow',
        'expo_unavailable',
        'timeout',
        'expo_unavailable',
      ],
    );
    await noToken(t);
  },
);

dbTest(
  'Expo asking to slow down is a 429 with Retry-After; a start is never retried',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    t.expo.next.push(json({}, 429, { 'retry-after': '30' }));
    const res = await t.dispatch(appId, { workflow: 'build.yml' });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'rate_limited');
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(t.expo.rest.length, 1, 'one request, no retry');
  },
);

dbTest('starts share the CI budget of the workspace with GitHub dispatches', async (db) => {
  const t = await bootEasWorkflows(db, { limiter: createTestLimiter({ limit: 2 }) });
  const appId = await t.seedLinkedApp();
  const github = await t.call(t.owner, 'POST', `${t.base}/workflows/ios.yml/dispatches`, {
    ref: 'main',
  });
  assert.equal(github.status, 202, github.text);
  assert.equal((await t.dispatch(appId, { workflow: 'build.yml' })).status, 202);
  const third = await t.dispatch(appId, { workflow: 'build.yml' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal(t.expo.rest.length, 1, 'the refused start never reaches Expo');
});

dbTest(
  'refreshing a run reads Expo, stores it in CI words and returns the jobs; the finish is announced once',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    await t.dispatch(appId, { workflow: 'build.yml' });

    // Not refreshed: what is stored, no jobs, Expo is not asked.
    const calls = t.expo.rest.length;
    const stored = await t.call(t.owner, 'GET', t.runPath(appId, FIRST));
    assert.equal(stored.status, 200);
    assert.equal(stored.body.refreshed, false);
    assert.deepEqual(stored.body.jobs, []);
    assert.equal(t.expo.rest.length, calls);

    t.expo.setRun(FIRST, { status: 'in-progress', jobs: [runJob()] });
    const going = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
    assert.equal(going.status, 200, going.text);
    assert.equal(going.body.refreshed, true);
    assert.equal(going.body.run.status, 'in_progress');
    assert.equal(going.body.run.conclusion, null);
    assert.equal(going.body.run.active, true);
    assert.equal(going.body.run.headSha, '8c1f0a9d2e3b4c5d6e7f8091a2b3c4d5e6f70812');
    assert.equal(going.body.run.commitMessage, 'Bump build number');
    assert.deepEqual(going.body.jobs, [
      {
        key: 'build_ios',
        name: 'Build iOS',
        type: 'build',
        status: 'in-progress',
        buildId: '5b1c1d3e-9d5b-4f0e-9b1e-111111111111',
        submissionId: null,
      },
    ]);
    assert.ok(!going.text.includes('secrets'), 'outputs of a job are never returned');

    t.expo.setRun(FIRST, { status: 'success' });
    const done = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
    assert.equal(done.body.run.status, 'completed');
    assert.equal(done.body.run.conclusion, 'success');
    assert.equal(done.body.run.active, false);
    await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));

    const finished = (await events(t)).filter((e) => e.type === 'ci.run_finished');
    assert.equal(finished.length, 1, 'announced once, however often it is read');
    assert.deepEqual(finished[0]?.payload, {
      runId: FIRST,
      repositoryId: t.repositoryId,
      appId,
      conclusion: 'success',
    });
    await noToken(t);
  },
);

dbTest(
  'every Expo status maps onto the CI words; a failed run raises the same alert as a failed GitHub run',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const expected: [string, string, string | null][] = [
      ['new', 'queued', null],
      ['waiting', 'waiting', null],
      ['action-required', 'waiting', null],
      ['in-progress', 'in_progress', null],
    ];
    await t.dispatch(appId, { workflow: 'build.yml' });
    for (const [expo, status, conclusion] of expected) {
      t.expo.setRun(FIRST, { status: expo });
      const res = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
      assert.equal(res.body.run.status, status, expo);
      assert.equal(res.body.run.conclusion, conclusion);
      assert.equal(res.body.run.active, true, expo);
    }
    t.expo.setRun(FIRST, { status: 'failure' });
    const failed = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
    assert.equal(failed.body.run.status, 'completed');
    assert.equal(failed.body.run.conclusion, 'failure');

    const finish = (await events(t)).find((e) => e.type === 'ci.run_finished');
    assert.ok(finish);
    const alerts = alertsFromEvent({
      type: 'ci.run_finished',
      workspaceId: t.workspaceId,
      subject: { ...(finish.appId ? { appId: finish.appId } : {}), repositoryId: t.repositoryId },
      payload: finish.payload,
      createdAt: 1,
    });
    assert.deepEqual(
      alerts.map((a) => a.def.id),
      ['ci.run_failed'],
    );

    // A canceled run is completed and cancelled: no alert.
    await t.dispatch(appId, { workflow: 'build.yml' });
    t.expo.setRun(SECOND, { status: 'canceled' });
    const cancelled = await t.call(t.owner, 'GET', t.runPath(appId, SECOND, true));
    assert.equal(cancelled.body.run.conclusion, 'cancelled');
  },
);

dbTest('a status Expo does not document is refused, not guessed', async (db) => {
  const t = await bootEasWorkflows(db);
  const appId = await t.seedLinkedApp();
  await t.dispatch(appId, { workflow: 'build.yml' });
  t.expo.setRun(FIRST, { status: 'exploded' });
  const res = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'expo_unavailable');
  assert.equal((await storedRows(t))[0]?.status, 'queued', 'the stored run is untouched');
});

dbTest(
  'a run Expo no longer has settles as completed/unknown, so nothing waits for it',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    await t.dispatch(appId, { workflow: 'build.yml' });
    t.expo.runs.delete(FIRST);
    const res = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'expo_not_found');
    const row = (await storedRows(t))[0];
    assert.equal(row?.status, 'completed');
    assert.equal(row?.conclusion, 'unknown');
    const finish = (await events(t)).filter((e) => e.type === 'ci.run_finished');
    assert.equal(finish.length, 1);
    assert.equal(finish[0]?.payload.conclusion, 'unknown');
    assert.deepEqual(
      alertsFromEvent({
        type: 'ci.run_finished',
        workspaceId: t.workspaceId,
        subject: { appId },
        payload: finish[0]?.payload ?? {},
        createdAt: 1,
      }),
      [],
    );
  },
);

dbTest(
  'reading runs: viewers read what is stored but cannot ask Expo; unknown runs and other apps are 404',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    const other = await t.seedLinkedApp();
    await t.dispatch(appId, { workflow: 'build.yml' });
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', t.runPath(appId, FIRST))).status, 200);
    assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/expo/workflows/runs`)).status, 200);
    assert.equal((await t.call(viewer, 'GET', t.runPath(appId, FIRST, true))).status, 403);
    const before = t.expo.rest.length;
    assert.equal(
      (await t.call(t.owner, 'GET', t.runPath(other, FIRST))).status,
      404,
      'a run of another app',
    );
    assert.equal((await t.call(t.owner, 'GET', t.runPath(appId, SECOND))).status, 404);
    assert.equal((await t.call(t.owner, 'GET', t.runPath(appId, 'not-a-uuid'))).status, 400);
    assert.equal((await t.call(t.owner, 'GET', t.runPath('nope', FIRST))).status, 404);
    assert.equal((await t.call('kiln_session=nobody', 'GET', t.runPath(appId, FIRST))).status, 401);
    assert.equal(t.expo.rest.length, before);
    assert.deepEqual(
      (await t.call(t.owner, 'GET', `/apps/${other}/expo/workflows/runs`)).body.runs,
      [],
    );
  },
);

dbTest(
  'a run appears wherever runs appear: the runs of the repository, running now, the pipeline, the builds',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp({
      releases: [
        { version: '2.4.0', build: '42', status: 'rolling_out' },
        { version: '2.3.0', build: '41' },
      ],
    });
    await t.dispatch(appId, { workflow: 'build.yml', inputs: { build_number: '42' } });
    const member = await t.addMember('member');

    const runs = await t.call(t.owner, 'GET', `${t.base}/workflows/runs`);
    assert.deepEqual(
      runs.body.runs.map((r: { id: string; provider: string; workflow: string }) => [
        r.id,
        r.provider,
        r.workflow,
      ]),
      [[FIRST, 'eas-workflows', 'build.yml']],
    );
    assert.equal(runs.body.active, 1);
    const forApp = await t.call(
      t.owner,
      'GET',
      `${t.base}/workflows/runs?appId=${appId}&active=true`,
    );
    assert.equal(forApp.body.runs.length, 1);

    const active = await t.call(member, 'GET', '/ci/runs/active');
    assert.equal(active.status, 200, active.text);
    assert.deepEqual(
      active.body.runs.map((r: { id: string; provider: string }) => [r.id, r.provider]),
      [[FIRST, 'eas-workflows']],
    );
    assert.equal(active.body.runs[0].progress, null, 'there are no GitHub jobs to read for it');
    assert.equal(
      active.body.runs[0].url,
      `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${FIRST}`,
    );

    const facts = await loadPipelineFacts(db, { workspaceId: t.workspaceId, now: Date.now() });
    const mine = facts.facts.find((f) => f.appId === appId);
    assert.ok(mine, 'the pipeline knows the app');
    assert.deepEqual(
      mine.runs.map((r) => [r.id, r.url]),
      [[FIRST, `https://expo.dev/accounts/acme/projects/trail-notes/workflows/${FIRST}`]],
    );
    assert.equal(mine.runs[0]?.active, true);

    // The dispatch input names the build: once the run finishes, the build is linked to it.
    t.expo.setRun(FIRST, { status: 'success', updatedAt: new Date().toISOString() });
    await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
    const builds = await t.call(t.owner, 'GET', `/apps/${appId}/builds`);
    assert.equal(builds.status, 200, builds.text);
    const linked = builds.body.builds.find((b: { buildNumber: string }) => b.buildNumber === '42');
    assert.equal(linked?.link?.run?.id, FIRST);
    assert.equal(linked?.link?.source, 'dispatch_input');

    // A viewer reads with another cache key than the member did a moment ago.
    const recent = await t.call(await t.addMember('viewer'), 'GET', '/ci/runs/active');
    assert.deepEqual(
      recent.body.recent.map((r: { id: string; conclusion: string }) => [r.id, r.conclusion]),
      [[FIRST, 'success']],
    );
  },
);

dbTest(
  'the GitHub side never touches an EAS run: refresh, poll and the scheduler leave it alone',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    await t.dispatch(appId, { workflow: 'build.yml' });
    await db.execute("UPDATE jobs SET status = 'done'");
    t.fake.runs = [
      githubRun('3001', { status: 'in_progress', conclusion: undefined, headSha: SHA_2 }),
    ];
    const repository = await getRepository(db, t.workspaceId, t.repositoryId);
    assert.ok(repository);
    const ctx = t.context({ now: Date.now() });
    const done = await refreshRuns(
      ctx,
      { workspaceId: t.workspaceId, repository, force: true },
      { type: 'system', id: 'test' },
    );
    assert.ok(done.ok, JSON.stringify(done));

    const eas = (await storedRows(t))[0];
    assert.equal(eas?.status, 'queued', 'GitHub did not settle the EAS run');
    assert.equal(eas?.conclusion, null);
    assert.ok(
      !t.fake.calls.some((c) => c.name === 'getCiRun' && String(c.args[0]) === FIRST),
      'GitHub was never asked about the EAS run id',
    );

    // Only the GitHub run is polled by the scheduler; with only the EAS run going, nothing is queued.
    await db.execute(
      "UPDATE workflow_runs SET status = 'completed', conclusion = 'success' WHERE provider = 'github'",
    );
    const summary = await createScheduler({ db, now: () => Date.now() }).tick();
    assert.equal(summary.pollsQueued, 0);
  },
);

dbTest('eas.poll follows a run until it finishes, with a growing delay', async (db) => {
  const t = await bootEasWorkflows(db);
  const appId = await t.seedLinkedApp();
  await t.dispatch(appId, { workflow: 'build.yml' });
  const clock = { now: Date.now() };
  const handler = createEasPollHandler({
    db,
    masterKey: t.masterKey,
    now: () => clock.now,
    deps: { fetch: t.expo.fetch },
  });
  const payload = (attempt: number): EasPollPayload => ({
    workspaceId: t.workspaceId,
    appId,
    runId: FIRST,
    startedAt: clock.now,
    attempt,
    requestedBy: 'u',
  });
  const job = { id: 'j', queue: EAS_POLL_QUEUE, payload: null, attempts: 1 };
  await db.execute("UPDATE jobs SET status = 'done'");

  t.expo.setRun(FIRST, { status: 'in-progress' });
  await handler(payload(0), job);
  assert.equal((await storedRows(t))[0]?.status, 'in_progress');
  let queued = (await pollJobs(t)).filter((j) => j.status === 'queued');
  assert.equal(queued.length, 1, 'the next read is queued');
  assert.equal(Number(queued[0]?.run_at), clock.now + easPollDelayMs(0));
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map(easPollDelayMs),
    [15_000, 22_500, 33_750, 50_625, 60_000, 60_000],
  );

  await db.execute("UPDATE jobs SET status = 'done'");
  t.expo.setRun(FIRST, { status: 'success' });
  await handler(payload(1), job);
  assert.equal((await storedRows(t))[0]?.conclusion, 'success');
  queued = (await pollJobs(t)).filter((j) => j.status === 'queued');
  assert.equal(queued.length, 0, 'finished: nothing more is queued');

  // A finished run is not read again.
  const calls = t.expo.rest.length;
  await handler(payload(2), job);
  assert.equal(t.expo.rest.length, calls);
  await handler({ nonsense: true }, job);
});

dbTest(
  'eas.poll: a rate limit waits as long as Expo asks, a temporary failure retries, a permanent one is audited and ends',
  async (db) => {
    const t = await bootEasWorkflows(db);
    const appId = await t.seedLinkedApp();
    await t.dispatch(appId, { workflow: 'build.yml' });
    await db.execute("UPDATE jobs SET status = 'done'");
    const clock = { now: Date.now() };
    const handler = createEasPollHandler({
      db,
      masterKey: t.masterKey,
      now: () => clock.now,
      deps: { fetch: t.expo.fetch },
      pollMaxMs: 10 * 60_000,
    });
    const payload: EasPollPayload = {
      workspaceId: t.workspaceId,
      appId,
      runId: FIRST,
      startedAt: clock.now,
      attempt: 3,
      requestedBy: 'u',
    };
    const job = { id: 'j', queue: EAS_POLL_QUEUE, payload: null, attempts: 1 };
    const queued = async () => (await pollJobs(t)).filter((j) => j.status === 'queued');

    t.expo.next.push(json({}, 429, { 'retry-after': '120' }));
    await handler(payload, job);
    assert.equal(Number((await queued())[0]?.run_at), clock.now + 120_000);
    await db.execute("UPDATE jobs SET status = 'done'");

    t.expo.next.push(json({}, 500));
    await assert.rejects(() => handler(payload, job), /Expo had a problem/);
    assert.equal((await queued()).length, 0, 'the queue retries the job itself');

    // Past the maximum duration the chain ends, once, in the audit log.
    clock.now += 11 * 60_000;
    t.expo.setRun(FIRST, { status: 'in-progress' });
    await handler(payload, job);
    assert.equal((await queued()).length, 0);
    const ended = (await t.auditActions()).filter((a) => a.action === EAS_POLL_QUEUE);
    assert.equal(ended.length, 1);
    assert.equal(JSON.parse(ended[0]?.detail ?? '{}').ended, 'max_duration');

    // The link was removed: a permanent failure, audited, no further read.
    clock.now = Date.now();
    await db.execute('DELETE FROM app_expo_links WHERE app_id = ?', [appId]);
    await handler({ ...payload, startedAt: clock.now }, job);
    assert.equal((await queued()).length, 0);
    const audits = (await t.auditActions()).filter((a) => a.action === EAS_POLL_QUEUE);
    assert.equal(audits.length, 2);
    assert.ok(audits.some((a) => JSON.parse(a.detail).code === 'expo_not_linked'));
    await noToken(t);
  },
);

dbTest('removing the link of an app keeps its stored runs; they are read-only then', async (db) => {
  const t = await bootEasWorkflows(db);
  const appId = await t.seedLinkedApp();
  await t.dispatch(appId, { workflow: 'build.yml' });
  await db.execute('DELETE FROM app_expo_links WHERE app_id = ?', [appId]);
  const stored = await t.call(t.owner, 'GET', t.runPath(appId, FIRST));
  assert.equal(stored.status, 200);
  const refreshed = await t.call(t.owner, 'GET', t.runPath(appId, FIRST, true));
  assert.equal(refreshed.status, 422);
  assert.equal(refreshed.body.error, 'expo_not_linked');
});
