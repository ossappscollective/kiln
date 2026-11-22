import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Timers, Visibility } from './poll.ts';
import {
  createRunsFeed,
  elapsedText,
  endsFeed,
  failedFirst,
  finishedCounts,
  IDLE_POLL_MS,
  MAX_POLL_MS,
  problemPill,
  progressInfo,
  RUNNING_POLL_MS,
  runAppIds,
  runAppNames,
  runElapsedMs,
  scopeRunsToApps,
  showsSteps,
  sortActive,
  spanMs,
  stateVisual,
} from './running.ts';
import type { ActiveRun, ActiveRuns } from './types.ts';

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  id: '1',
  repositoryId: 'r1',
  appId: null,
  workflow: 'iOS release',
  workflowPath: '.github/workflows/ios.yml',
  title: null,
  status: 'in_progress',
  conclusion: null,
  active: true,
  headSha: null,
  commitMessage: null,
  branch: 'main',
  event: 'workflow_dispatch',
  runNumber: 1,
  url: 'https://github.com/acme/app/actions/runs/1',
  inputs: null,
  dispatchedBy: null,
  startedAt: 1_000,
  updatedAt: 2_000,
  syncedAt: 2_000,
  repository: { id: 'r1', owner: 'acme', repo: 'app' },
  actor: null,
  progress: null,
  ...over,
});

const answer = (runs: ActiveRun[]): ActiveRuns => ({
  runs,
  recent: [],
  repositories: [],
  problems: [],
  refreshedAt: null,
  live: true,
  cached: false,
});

test('elapsedText: seconds, minutes and hours; never negative', () => {
  assert.equal(elapsedText(-5), '0 sec');
  assert.equal(elapsedText(45_000), '45 sec');
  assert.equal(elapsedText(185_000), '3 min 5 sec');
  assert.equal(elapsedText(3_900_000), '1 hr 5 min');
});

test('runElapsedMs ticks against now while active and stops at the last update when finished', () => {
  assert.equal(runElapsedMs({ active: true, startedAt: 1_000, updatedAt: 2_000 }, 61_000), 60_000);
  assert.equal(runElapsedMs({ active: false, startedAt: 1_000, updatedAt: 2_000 }, 61_000), 1_000);
  assert.equal(runElapsedMs({ active: true, startedAt: 5_000, updatedAt: 5_000 }, 1_000), 0);
});

test('sortActive: in progress before queued, newest first', () => {
  const rows = sortActive([
    run({ id: 'q', status: 'queued', startedAt: 9 }),
    run({ id: 'a', startedAt: 1 }),
    run({ id: 'b', startedAt: 5 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b', 'a', 'q'],
  );
});

test('progressInfo: says what a run waits for, and where a running one is', () => {
  assert.deepEqual(progressInfo(run({ status: 'pending' })), { percent: null, label: 'Starting' });
  assert.deepEqual(progressInfo(run({ status: 'queued' })), {
    percent: null,
    label: 'Waiting for a runner',
  });
  assert.deepEqual(progressInfo(run({ status: 'waiting' })), {
    percent: null,
    label: 'Waiting for approval',
  });
  assert.deepEqual(progressInfo(run({ progress: null })), { percent: null, label: 'In progress' });
  const p = {
    jobsTotal: 3,
    jobsDone: 1,
    job: 'test',
    step: 'Run tests',
    stepsDone: 2,
    stepsTotal: 5,
    fraction: 0.4444,
    readAt: 1,
  };
  assert.deepEqual(progressInfo(run({ progress: p })), {
    percent: 44,
    label: 'test · Run tests · job 2 of 3',
  });
  assert.equal(
    progressInfo(run({ progress: { ...p, jobsTotal: 1, jobsDone: 0, step: null, fraction: 1.7 } }))
      .percent,
    100,
  );
  assert.equal(
    progressInfo(run({ progress: { ...p, jobsTotal: 1, jobsDone: 0, job: null, step: null } }))
      .label,
    'In progress',
  );
});

test('scopeRunsToApps: runs tied to the app alone; else the repository’s runs, said to be so', () => {
  const runs = [
    run({ id: '1', appId: 'ios' }),
    run({
      id: '2',
      appId: null,
      workflow: 'Android release',
      workflowPath: '.github/workflows/android.yml',
    }),
    run({ id: '3', appId: null }),
    run({
      id: '4',
      repositoryId: 'r2',
      repository: { id: 'r2', owner: 'acme', repo: 'other' },
      appId: 'ios',
    }),
  ];
  const ios = { id: 'ios', repositoryId: 'r1', workflow: null };
  const android = { id: 'android', repositoryId: 'r1', workflow: 'android.yml' };

  assert.deepEqual(scopeRunsToApps(runs, [ios]), { runs: [runs[0]], linked: true });
  assert.deepEqual(
    scopeRunsToApps(runs, [android]).runs.map((r) => r.id),
    ['2'],
    'the release workflow of the conventions',
  );
  assert.deepEqual(
    scopeRunsToApps(runs, [ios, android]).runs.map((r) => r.id),
    ['1', '2'],
    'both platforms of one product',
  );
  const none = scopeRunsToApps(runs.slice(2, 3), [ios]);
  assert.deepEqual(none, { runs: [runs[2]], linked: false });
  assert.deepEqual(scopeRunsToApps(runs, [{ id: 'x', repositoryId: null, workflow: null }]), {
    runs: [],
    linked: false,
  });
});

test('failedFirst and finishedCounts', () => {
  const runs = [
    run({ id: 'a', conclusion: 'success', updatedAt: 9 }),
    run({ id: 'b', conclusion: 'failure', updatedAt: 1 }),
    run({ id: 'c', conclusion: 'timed_out', updatedAt: 5 }),
    run({ id: 'd', conclusion: 'cancelled', updatedAt: 7 }),
    run({ id: 'e', conclusion: 'skipped', updatedAt: 8 }),
  ];
  assert.deepEqual(
    failedFirst(runs).map((r) => r.id),
    ['c', 'b', 'a', 'e', 'd'],
  );
  assert.equal(finishedCounts(runs), '2 failed, 1 succeeded, 1 cancelled, and 1 other');
  assert.equal(finishedCounts([]), '');
});

test('problemPill: nothing when fine, one quiet line otherwise, without GitHub’s own words', () => {
  const repos = [
    { id: 'r1', owner: 'acme', repo: 'app' },
    { id: 'r2', owner: 'acme', repo: 'web' },
  ];
  assert.equal(problemPill([], repos), null);
  const one = problemPill([{ repositoryId: 'r1', reason: 'no_access' }], repos);
  assert.equal(one?.label, 'Runs of acme/app cannot be read');
  assert.equal(one?.tone, 'warn');
  assert.match(one?.lines[0] ?? '', /^acme\/app: the GitHub connection cannot read Actions runs/);
  const two = problemPill(
    [
      { repositoryId: 'r1', reason: 'rate_limited' },
      { repositoryId: 'r2', reason: 'unavailable' },
    ],
    repos,
  );
  assert.equal(two?.label, 'Runs of 2 repositories cannot be read');
  assert.equal(two?.tone, 'info', 'a pause is not a warning');
});

test('endsFeed: only "may not read" ends the loop', () => {
  assert.equal(endsFeed({ status: 403 }), true);
  assert.equal(endsFeed({ status: 404 }), true);
  assert.equal(endsFeed({ status: 429 }), false);
  assert.equal(endsFeed({ status: 500 }), false);
  assert.equal(endsFeed(new Error('x')), false);
});

// ---------------------------------------------------------------------------------------------
// The feed

function harness() {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    set(fn, ms) {
      const id = next++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clear(handle) {
      scheduled.delete(handle as number);
    },
  };
  let visible = true;
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    visible: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    timers,
    visibility,
    pending: () => [...scheduled.values()],
    async fire() {
      const [entry] = [...scheduled.entries()];
      assert.ok(entry, 'a timer is pending');
      scheduled.delete(entry[0]);
      entry[1].fn();
      await flush();
    },
    async show(value: boolean) {
      visible = value;
      for (const l of [...listeners]) l();
      await flush();
    },
  };
}

test('the feed: 15 seconds while a run goes, a minute when none does, and it never stops by itself', async () => {
  const h = harness();
  const answers = [answer([run()]), answer([run()]), answer([]), answer([]), answer([run()])];
  const got: number[] = [];
  const feed = createRunsFeed({
    load: async () => answers.shift() as ActiveRuns,
    onData: (d) => got.push(d.runs.length),
    onError: () => undefined,
    timers: h.timers,
    visibility: h.visibility,
  });
  feed.start(true);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [0],
    'the first read is at once',
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [RUNNING_POLL_MS],
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [RUNNING_POLL_MS],
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [IDLE_POLL_MS],
    'nothing going: a minute',
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [IDLE_POLL_MS],
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [RUNNING_POLL_MS],
    'a run was noticed: quick again',
  );
  assert.deepEqual(got, [1, 1, 0, 0, 1]);
  feed.stop();
});

test('the feed: a failure backs off and goes on; "may not read" ends it; a hidden page waits', async () => {
  const h = harness();
  let fail: unknown = { status: 500 };
  const errors: unknown[] = [];
  let reads = 0;
  const feed = createRunsFeed({
    load: async () => {
      reads++;
      if (fail) throw fail;
      return answer([run()]);
    },
    onData: () => undefined,
    onError: (e) => errors.push(e),
    fatal: endsFeed,
    timers: h.timers,
    visibility: h.visibility,
  });
  feed.start(true);
  await h.fire();
  assert.equal(errors.length, 1);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [IDLE_POLL_MS * 2],
    'doubled after a failure',
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [IDLE_POLL_MS * 4],
  );
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [MAX_POLL_MS],
    'capped',
  );

  fail = undefined;
  await h.fire();
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [RUNNING_POLL_MS],
    'healed',
  );

  await h.show(false);
  const before = reads;
  await h.fire();
  assert.equal(reads, before, 'a hidden page does not read');
  assert.equal(h.pending().length, 0);
  await h.show(true);
  assert.deepEqual(
    h.pending().map((p) => p.ms),
    [0],
    'shown again: it reads at once',
  );
  await h.fire();
  assert.equal(reads, before + 1);

  fail = { status: 403 };
  await h.fire();
  assert.equal(feed.running, false, 'forbidden ends the loop');
  assert.equal(errors.length, 4, 'three failures and the one that ended it');
});

test('stateVisual says the state in words; spanMs and showsSteps', () => {
  assert.deepEqual(stateVisual('completed', 'success'), {
    icon: 'check-circle',
    tone: 'ok',
    label: 'Succeeded',
  });
  assert.equal(stateVisual('completed', 'failure').label, 'Failed');
  assert.equal(stateVisual('completed', 'timed_out').tone, 'bad');
  assert.equal(stateVisual('completed', 'skipped').label, 'Skipped');
  assert.equal(stateVisual('in_progress', null).label, 'Running');
  assert.equal(stateVisual('queued', null).label, 'Queued');
  assert.equal(spanMs({ startedAt: null, completedAt: null }, 10), null);
  assert.equal(spanMs({ startedAt: 1_000, completedAt: null }, 6_000), 5_000);
  assert.equal(spanMs({ startedAt: 1_000, completedAt: 3_000 }, 99_000), 2_000);
  assert.equal(showsSteps({ status: 'completed', conclusion: 'success' }), false);
  assert.equal(showsSteps({ status: 'completed', conclusion: 'failure' }), true);
  assert.equal(showsSteps({ status: 'in_progress', conclusion: null }), true);
});

test('a run is tied to every app it was started for (appIds), else to its one appId', () => {
  assert.deepEqual(runAppIds({ appId: null }), []);
  assert.deepEqual(runAppIds({ appId: 'a' }), ['a']);
  assert.deepEqual(runAppIds({ appId: 'a', appIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(runAppIds({ appId: null, appIds: [] }), []);
  const apps = [
    { id: 'b', name: 'Beta' },
    { id: 'a', name: 'Alpha' },
    { id: 'c', name: 'Gamma' },
  ];
  assert.deepEqual(runAppNames({ appId: 'a', appIds: ['a', 'b'] }, apps), ['Beta', 'Alpha']);
  const two = [
    { id: 'a', repositoryId: 'r1', workflow: null },
    { id: 'b', repositoryId: 'r1', workflow: null },
  ];
  const runs = [
    run({ id: '1', appId: 'a', appIds: ['a', 'b'] }),
    run({ id: '2', appId: 'z', appIds: ['z'] }),
  ];
  assert.deepEqual(
    scopeRunsToApps(runs, [two[1]!]).runs.map((r) => r.id),
    ['1'],
  );
});
