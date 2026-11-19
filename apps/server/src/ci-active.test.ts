import assert from 'node:assert/strict';
import { GithubError, GithubRateLimitError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { bootCi, job, run } from './ci-test-helpers.ts';
import { dispatchRun, JOBS_TTL_ACTIVE_MS, MIN_REFRESH_MS, readRunJobs } from './services/ci.ts';
import {
  ACTIVE_CACHE_TTL_MS,
  IDLE_REFRESH_MS,
  listActiveRuns,
  PROBLEM_BACKOFF_MS,
  summarizeJobs,
} from './services/ci-active.ts';
import { createTestLimiter } from './services/credential-tests.ts';
import { listEvents } from './services/events.ts';
import { getRepository } from './services/repositories.ts';

// Everything here runs against a fake GitHub: no live GitHub call is ever made.

const T0 = 1_900_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const actor = { type: 'user' as const, id: 'u' };
const times = (startedAgo: number, tookMs = 5_000) => ({
  createdAt: T0 - startedAgo,
  startedAt: T0 - startedAgo,
  updatedAt: T0 - startedAgo + tookMs,
});
const going = (id: string, agoMs: number, extra = {}) =>
  run(id, { status: 'in_progress', conclusion: undefined, ...times(agoMs), ...extra });
const done = (id: string, finishedAgoMs: number, conclusion: string, extra = {}) =>
  run(id, { status: 'completed', conclusion, ...times(finishedAgoMs + 5_000), ...extra });

type Boot = Awaited<ReturnType<typeof bootCi>>;
const repoOf = async (t: Boot) =>
  (await getRepository(t.db, t.workspaceId, t.repositoryId)) as NonNullable<
    Awaited<ReturnType<typeof getRepository>>
  >;
const listCalls = (t: Boot) => t.fake.calls.filter((c) => c.name === 'listCiRuns');

dbTest('summarizeJobs: jobs done, the job and step now, a fraction over all jobs', async () => {
  assert.equal(summarizeJobs([], 1), null);
  const p = summarizeJobs(
    [
      job('a', 'build', 'completed'),
      job('b', 'test', 'in_progress', [
        ['Set up', 'completed'],
        ['Run tests', 'in_progress'],
        ['Upload', 'queued'],
      ]),
      job('c', 'ship', 'queued'),
    ],
    7,
  );
  assert.deepEqual(
    { ...p, fraction: Number((p?.fraction ?? 0).toFixed(3)) },
    {
      jobsTotal: 3,
      jobsDone: 1,
      job: 'test',
      step: 'Run tests',
      stepsDone: 1,
      stepsTotal: 3,
      fraction: 0.444,
      readAt: 7,
    },
  );
  const idle = summarizeJobs([job('a', 'build', 'queued')], 1);
  assert.equal(idle?.job, null);
  assert.equal(idle?.fraction, 0);
});

dbTest(
  'active runs: going now (with progress and who started it), and finished in the last 24 hours, failed first',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    t.fake.runs = [
      going('1', 2 * MIN, { actor: 'octocat' }),
      run('2', { status: 'queued', conclusion: undefined, ...times(30_000) }),
      done('3', HOUR, 'failure'),
      done('4', 2 * HOUR, 'success'),
      done('5', 30 * HOUR, 'failure'),
      done('6', 10 * MIN, 'cancelled'),
      done('7', 3 * HOUR, 'timed_out'),
    ];
    t.fake.jobs.set('1', [
      job('a', 'build', 'completed'),
      job('b', 'test', 'in_progress', [
        ['Set up', 'completed'],
        ['Run tests', 'in_progress'],
        ['Upload', 'queued'],
      ]),
    ]);

    const answer = await listActiveRuns(ctx, { workspaceId: t.workspaceId, canScan: true }, actor);
    assert.deepEqual(
      answer.runs.map((r) => r.id),
      ['2', '1'],
      'newest first',
    );
    const one = answer.runs.find((r) => r.id === '1');
    assert.equal(one?.actor, 'octocat');
    assert.equal(one?.repository.repo, 'app');
    assert.deepEqual(
      {
        job: one?.progress?.job,
        step: one?.progress?.step,
        done: one?.progress?.jobsDone,
        total: one?.progress?.jobsTotal,
      },
      { job: 'test', step: 'Run tests', done: 1, total: 2 },
    );
    assert.equal(
      answer.runs.find((r) => r.id === '2')?.progress,
      null,
      'a queued run has no progress',
    );
    assert.deepEqual(
      answer.recent.map((r) => r.id),
      ['3', '7', '6', '4'],
      'failures first, then the newest; 30 hours ago is out',
    );
    assert.deepEqual(answer.repositories, [{ id: t.repositoryId, owner: 'acme', repo: 'app' }]);
    assert.deepEqual(answer.problems, []);
    assert.equal(answer.live, true);
    assert.equal(answer.cached, false);
    assert.equal(answer.refreshedAt, T0);
    assert.equal(t.fake.count('listRunJobs'), 1, 'jobs are read only for runs in progress');
    assert.ok(!JSON.stringify(answer).includes('runner'), 'no runner details, no logs');
  },
);

dbTest(
  'active runs: cached for seconds, concurrent requests share one read, a quiet repository is looked at rarely',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const input = { workspaceId: t.workspaceId, canScan: true };
    t.fake.runs = [going('1', MIN)];
    t.fake.jobs.set('1', [job('a', 'build', 'in_progress', [['x', 'in_progress']])]);

    const [a, b] = await Promise.all([
      listActiveRuns(ctx, input, actor),
      listActiveRuns(ctx, input, actor),
    ]);
    assert.equal(listCalls(t).length, 1, 'one read of GitHub for two requests');
    assert.deepEqual([a.cached, b.cached].sort(), [false, true]);

    clock.now += ACTIVE_CACHE_TTL_MS - 1;
    assert.equal((await listActiveRuns(ctx, input, actor)).cached, true);
    assert.equal(listCalls(t).length, 1);

    // Past the cache, but the run sync of a repository is spaced: nothing new is asked of GitHub.
    clock.now += 2;
    assert.equal((await listActiveRuns(ctx, input, actor)).cached, false);
    assert.equal(
      listCalls(t).length,
      1,
      `a repository with a run going is read at most every ${MIN_REFRESH_MS / 1000} s`,
    );
    assert.equal(t.fake.count('listRunJobs'), 1, 'jobs are kept 10 seconds too');

    clock.now += MIN_REFRESH_MS;
    await listActiveRuns(ctx, input, actor);
    assert.equal(listCalls(t).length, 2);
    assert.equal(
      t.fake.count('listRunJobs'),
      2,
      `jobs are read again after ${JOBS_TTL_ACTIVE_MS / 1000} s`,
    );

    // Nothing is going any more: now the repository is only looked at once a minute.
    t.fake.runs = [done('1', 0, 'success')];
    clock.now += MIN_REFRESH_MS;
    await listActiveRuns(ctx, input, actor);
    assert.equal(listCalls(t).length, 3);
    clock.now += 20_000;
    await listActiveRuns(ctx, input, actor);
    assert.equal(listCalls(t).length, 3, 'idle: no read');
    clock.now += IDLE_REFRESH_MS;
    await listActiveRuns(ctx, input, actor);
    assert.equal(listCalls(t).length, 4);
  },
);

dbTest(
  'active runs: conditional reads, a 304 changes nothing and does not ask for runs one by one',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const input = { workspaceId: t.workspaceId, canScan: true };
    t.fake.etagging = true;
    t.fake.runs = [going('1', MIN)];

    await listActiveRuns(ctx, input, actor);
    assert.equal(
      listCalls(t)[0]?.args[0] && (listCalls(t)[0]?.args[0] as { etag?: string }).etag,
      undefined,
      'the first read is not conditional',
    );
    clock.now += 10_000;
    const second = await listActiveRuns(ctx, input, actor);
    const sent = (listCalls(t)[1]?.args[0] as { etag?: string }).etag;
    assert.ok(sent, 'the next read sends the ETag');
    assert.equal(second.runs.length, 1, 'the stored run is still there after a 304');
    assert.equal(
      t.fake.count('getCiRun'),
      0,
      'a 304 does not send every active run to be asked for by id',
    );

    t.fake.runs = [done('1', 0, 'success')];
    clock.now += 10_000;
    const third = await listActiveRuns(ctx, input, actor);
    assert.equal(third.runs.length, 0);
    assert.deepEqual(
      third.recent.map((r) => r.id),
      ['1'],
    );
  },
);

dbTest(
  'active runs: a repository GitHub will not let us read is a problem entry, left alone for a while',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const input = { workspaceId: t.workspaceId, canScan: true };
    t.fake.errors.runs.push(
      new GithubError('forbidden', 'Resource not accessible by personal access token', 403),
    );

    const first = await listActiveRuns(ctx, input, actor);
    assert.deepEqual(first.problems, [{ repositoryId: t.repositoryId, reason: 'no_access' }]);
    assert.deepEqual(first.runs, []);
    assert.ok(
      !JSON.stringify(first).includes('Resource not accessible'),
      'GitHub text is not passed on',
    );

    t.fake.runs = [going('1', MIN)];
    clock.now += MIN_REFRESH_MS + ACTIVE_CACHE_TTL_MS;
    const again = await listActiveRuns(ctx, input, actor);
    assert.equal(listCalls(t).length, 1, 'not asked again during the back-off');
    assert.equal(again.problems.length, 1);

    clock.now += PROBLEM_BACKOFF_MS;
    const healed = await listActiveRuns(ctx, input, actor);
    assert.deepEqual(healed.problems, []);
    assert.equal(healed.runs.length, 1);

    // A rate limit waits for what GitHub asked, and says so.
    t.fake.errors.runs.push(new GithubRateLimitError(403, 'primary', 90));
    clock.now += MIN_REFRESH_MS + ACTIVE_CACHE_TTL_MS;
    const limited = await listActiveRuns(ctx, input, actor);
    assert.deepEqual(limited.problems, [{ repositoryId: t.repositoryId, reason: 'rate_limited' }]);
    assert.equal(limited.runs.length, 1, 'the stored runs are still listed');
  },
);

dbTest(
  'the route: rights, a viewer reads what is stored, validation and the per workspace limit',
  async (db) => {
    const t = await bootCi(db, { activeLimiter: createTestLimiter({ limit: 3 }) });
    const viewer = await t.addMember('viewer');
    t.fake.runs = [
      going('1', MIN, {
        createdAt: Date.now() - MIN,
        startedAt: Date.now() - MIN,
        updatedAt: Date.now(),
      }),
    ];
    t.fake.jobs.set('1', [job('a', 'build', 'in_progress', [['Run tests', 'in_progress']])]);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.call(outsider, 'GET', '/ci/runs/active')).status, 404);

    const owner = await t.call(t.owner, 'GET', '/ci/runs/active');
    assert.equal(owner.status, 200);
    assert.equal(owner.body.live, true);
    assert.equal(owner.body.runs[0].progress.step, 'Run tests');
    const calls = t.fake.calls.length;

    const seen = await t.call(viewer, 'GET', '/ci/runs/active');
    assert.equal(seen.status, 200);
    assert.equal(seen.body.live, false);
    assert.equal(seen.body.runs.length, 1, 'a viewer reads the stored runs');
    assert.equal(
      seen.body.runs[0].progress.step,
      'Run tests',
      'and the progress somebody read lately',
    );
    assert.equal(t.fake.calls.length, calls, 'a viewer never makes a GitHub read');

    assert.equal(
      (await t.call(t.owner, 'GET', `/ci/runs/active?repositoryId=${'x,'.repeat(51)}x`)).status,
      400,
    );
    assert.equal((await t.call(t.owner, 'GET', '/ci/runs/active?repositoryId=')).status, 400);
    const scoped = await t.call(t.owner, 'GET', '/ci/runs/active?repositoryId=nope');
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body.repositories, [], 'an unknown repository is simply not covered');

    const limited = await t.call(t.owner, 'GET', '/ci/runs/active');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  },
);

dbTest(
  'an API token limited to some apps sees the runs of their repositories that belong to none or to them',
  async (db) => {
    const t = await bootCi(db);
    const appA = await t.seedApp('ios', [{ version: '1.0.0', build: '1' }]);
    const appB = await t.seedApp('android', [{ version: '1.0.0', build: '1' }]);
    const lonely = await t.seedApp('ios', [], {
      repositoryId: null,
      identifier: 'com.acme.lonely',
    });
    t.fake.runs = [going('1', MIN), going('2', 2 * MIN), going('3', 3 * MIN)];
    await t.call(t.owner, 'GET', '/ci/runs/active');
    await db.execute("UPDATE workflow_runs SET app_id = ? WHERE run_id = '1'", [appA]);
    await db.execute("UPDATE workflow_runs SET app_id = ? WHERE run_id = '3'", [appB]);

    const make = async (appIds: string[]) => {
      const res = await t.call(t.owner, 'POST', '/tokens', { name: 'CI', role: 'viewer', appIds });
      return res.body.token as string;
    };
    const get = async (token: string, path: string) => {
      const res = await t.app.request(`/api/workspaces/${t.workspaceId}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return {
        status: res.status,
        body: (await res.json()) as { runs?: { id: string }[]; repositories?: unknown[] },
      };
    };
    const forA = await get(await make([appA]), '/ci/runs/active');
    assert.equal(forA.status, 200);
    assert.deepEqual(
      forA.body.runs?.map((r) => r.id).sort(),
      ['1', '2'],
      'its own run and the repository-wide one, not the other app’s',
    );
    const forLonely = await get(await make([lonely]), '/ci/runs/active');
    assert.equal(forLonely.status, 200);
    assert.deepEqual(forLonely.body.runs, [], 'an app without a repository has no runs');
    assert.deepEqual(forLonely.body.repositories, []);
    // The jobs of a run are repository wide: closed to an app limited token.
    assert.equal(
      (await get(await make([appA]), `/repositories/${t.repositoryId}/workflows/runs/1/jobs`))
        .status,
      403,
    );
  },
);

dbTest(
  'jobs: names, states and times of jobs and steps; read once for ten seconds; a viewer sees what was read',
  async (db) => {
    const t = await bootCi(db);
    const viewer = await t.addMember('viewer');
    t.fake.runs = [going('1', MIN, { createdAt: Date.now() - MIN, startedAt: Date.now() - MIN })];
    t.fake.jobs.set('1', [
      job('a', 'build', 'in_progress', [
        ['Set up job', 'completed'],
        ['Run tests', 'in_progress'],
      ]),
    ]);
    await t.call(t.owner, 'GET', `${t.base}/workflows/runs?refresh=true`);

    assert.equal(
      (await t.call(viewer, 'GET', `${t.base}/workflows/runs/1/jobs`)).body.jobs.length,
      0,
      'nobody read them yet',
    );
    const read = await t.call(t.owner, 'GET', `${t.base}/workflows/runs/1/jobs`);
    assert.equal(read.status, 200);
    assert.equal(read.body.live, true);
    assert.equal(read.body.cached, false);
    assert.deepEqual(Object.keys(read.body.jobs[0]).sort(), [
      'completedAt',
      'conclusion',
      'id',
      'name',
      'startedAt',
      'status',
      'steps',
      'url',
    ]);
    assert.deepEqual(Object.keys(read.body.jobs[0].steps[0]).sort(), [
      'completedAt',
      'conclusion',
      'name',
      'number',
      'startedAt',
      'status',
    ]);
    assert.equal(
      (await t.call(t.owner, 'GET', `${t.base}/workflows/runs/1/jobs`)).body.cached,
      true,
    );
    assert.equal(t.fake.count('listRunJobs'), 1);

    const seen = await t.call(viewer, 'GET', `${t.base}/workflows/runs/1/jobs`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.live, false);
    assert.equal(seen.body.jobs[0].name, 'build');
    assert.equal(t.fake.count('listRunJobs'), 1);

    assert.equal(
      (await t.call(viewer, 'GET', `${t.base}/workflows/runs/999/jobs`)).status,
      404,
      'a viewer cannot make us read a run we do not store',
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `${t.base}/workflows/runs/999/jobs`)).status,
      404,
      'GitHub has no such run',
    );
    assert.equal(
      (await t.call(t.owner, 'GET', `${t.base}/workflows/runs/pending-abc/jobs`)).status,
      400,
    );
    assert.equal(
      (await t.call(t.owner, 'GET', '/repositories/nope/workflows/runs/1/jobs')).status,
      404,
    );
    const text = JSON.stringify(read.body);
    assert.ok(!/log|runner/i.test(text.replace(/Run tests/g, '')), 'no logs');
  },
);

dbTest('jobs: a read is conditional, and an unchanged answer keeps the copy', async (db) => {
  const clock = { now: T0 };
  const t = await bootCi(db);
  const ctx = t.context(clock);
  const repository = await repoOf(t);
  t.fake.etagging = true;
  t.fake.jobs.set('1', [job('a', 'build', 'in_progress', [['x', 'in_progress']])]);
  const input = { workspaceId: t.workspaceId, repository, runId: '1', active: true };
  const first = await readRunJobs(ctx, input, actor);
  assert.ok(first.ok && !first.cached);
  clock.now += JOBS_TTL_ACTIVE_MS + 1;
  const second = await readRunJobs(ctx, input, actor);
  assert.ok(second.ok && !second.cached);
  assert.ok(t.fake.calls.filter((c) => c.name === 'listRunJobs')[1]?.args[1], 'the ETag was sent');
  assert.ok(
    second.ok && first.ok && second.jobs.readAt > first.jobs.readAt,
    'a 304 refreshes the read time',
  );
  assert.equal(second.ok && second.jobs.jobs.length, 1);
  // A finished run is kept longer.
  clock.now += JOBS_TTL_ACTIVE_MS + 1;
  const finishedRead = await readRunJobs(ctx, { ...input, active: false }, actor);
  assert.ok(finishedRead.ok && finishedRead.cached);
});

dbTest(
  'events: ci.run_started and ci.run_finished carry ids only, once, and old history is not announced',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const input = { workspaceId: t.workspaceId, canScan: true };
    const events = async () =>
      (await listEvents(db, t.workspaceId, { since: 0 })).events.filter((e) =>
        e.type.startsWith('ci.'),
      );

    // History seen for the first time: nothing happened now.
    t.fake.runs = [done('90', 5 * HOUR, 'success')];
    await listActiveRuns(ctx, input, actor);
    assert.deepEqual(await events(), []);

    t.fake.runs = [going('1', MIN), done('90', 5 * HOUR, 'success')];
    clock.now += IDLE_REFRESH_MS + 1;
    await listActiveRuns(ctx, input, actor);
    let seen = await events();
    assert.deepEqual(
      seen.map((e) => [e.type, e.payload.runId]),
      [['ci.run_started', '1']],
    );
    assert.deepEqual(seen[0]?.subject, { repositoryId: t.repositoryId });
    assert.deepEqual(Object.keys(seen[0]?.payload ?? {}).sort(), [
      'appId',
      'repositoryId',
      'runId',
    ]);

    // Seen again, still going: nothing new.
    clock.now += MIN_REFRESH_MS + 1;
    await listActiveRuns(ctx, input, actor);
    assert.equal((await events()).length, 1);

    t.fake.runs = [
      run('1', { status: 'completed', conclusion: 'failure', ...times(MIN, MIN) }),
      done('90', 5 * HOUR, 'success'),
    ];
    clock.now += MIN_REFRESH_MS + 1;
    await listActiveRuns(ctx, input, actor);
    seen = await events();
    assert.deepEqual(
      seen.map((e) => e.type),
      ['ci.run_started', 'ci.run_finished'],
    );
    assert.deepEqual(seen[1]?.payload, {
      runId: '1',
      repositoryId: t.repositoryId,
      appId: null,
      conclusion: 'failure',
    });
    clock.now += MIN_REFRESH_MS + 1;
    await listActiveRuns(ctx, input, actor);
    assert.equal((await events()).length, 2, 'a finished run is announced once');

    // A run that ran between two reads is announced as started and finished.
    t.fake.runs = [done('2', MIN, 'success', {}), ...t.fake.runs];
    clock.now += IDLE_REFRESH_MS + 1;
    await listActiveRuns(ctx, input, actor);
    assert.deepEqual(
      (await events()).slice(2).map((e) => [e.type, e.payload.runId]),
      [
        ['ci.run_started', '2'],
        ['ci.run_finished', '2'],
      ],
    );
  },
);

dbTest(
  'events: a dispatch that GitHub names, and a pending one that a run adopts, announce the start with the app',
  async (db) => {
    const clock = { now: T0 };
    const t = await bootCi(db);
    const ctx = t.context(clock);
    const appId = await t.seedApp('ios', [{ version: '1.0.0', build: '1' }]);
    const events = async () =>
      (await listEvents(db, t.workspaceId, { since: 0 })).events.filter((e) =>
        e.type.startsWith('ci.'),
      );
    t.fake.dispatchResult = { runId: '55', runUrl: 'https://github.com/acme/app/actions/runs/55' };
    const sent = await dispatchRun(
      ctx,
      { workspaceId: t.workspaceId, repositoryId: t.repositoryId, workflow: 'ios.yml', appId },
      actor,
    );
    assert.ok(sent.ok);
    let seen = await events();
    assert.deepEqual(
      seen.map((e) => e.type),
      ['ci.run_started'],
    );
    assert.deepEqual(seen[0]?.subject, { repositoryId: t.repositoryId, appId });
    assert.equal(seen[0]?.payload.runId, '55');

    t.fake.dispatchResult = {};
    await dispatchRun(
      ctx,
      { workspaceId: t.workspaceId, repositoryId: t.repositoryId, workflow: 'ios.yml', appId },
      actor,
    );
    assert.equal(
      (await events()).length,
      1,
      'a placeholder is not announced: it has no run id yet',
    );
    t.fake.runs = [going('56', 1_000, { createdAt: T0 + 1_000, startedAt: T0 + 1_000 })];
    clock.now += 10_000;
    await listActiveRuns(ctx, { workspaceId: t.workspaceId, canScan: true }, actor);
    seen = await events();
    assert.deepEqual(
      seen.map((e) => [e.type, e.payload.runId, e.payload.appId]),
      [
        ['ci.run_started', '55', appId],
        ['ci.run_started', '56', appId],
      ],
    );
  },
);
