import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowRun } from '../types.ts';
import { failingRunIds, orderRuns, workflowsLead } from './lead.ts';
import type { WorkflowRow } from './workflows.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  repositoryId: 'r1',
  appId: null,
  workflow: 'iOS release',
  workflowPath: '.github/workflows/ios.yml',
  title: null,
  status: 'completed',
  conclusion: 'success',
  active: false,
  headSha: null,
  commitMessage: null,
  branch: 'main',
  event: null,
  runNumber: 1,
  url: null,
  inputs: null,
  dispatchedBy: null,
  startedAt: NOW - HOUR,
  updatedAt: NOW - HOUR + 60_000,
  syncedAt: NOW,
  ...over,
});

const row = (
  id: string,
  relevance: 'configured' | 'used' | 'release' | 'build' | 'other',
  last: WorkflowRun | null,
  state = 'active',
): WorkflowRow => ({
  repository: { id: 'r1', owner: 'o', repo: 'r', name: 'r', defaultBranch: 'main' },
  entry: {
    workflow: { id, name: `Flow ${id}`, path: `.github/workflows/${id}.yml`, state },
    relevance,
    reason: '',
    platforms: [],
  },
  last,
});

test('failing runs come first, then the runs going now, then the rest newest first', () => {
  const runs = [
    run('a', { workflowPath: 'a.yml', startedAt: NOW - 1 * HOUR }),
    run('b', { workflowPath: 'b.yml', conclusion: 'failure', startedAt: NOW - 5 * HOUR }),
    run('c', {
      workflowPath: 'c.yml',
      status: 'in_progress',
      conclusion: null,
      active: true,
      startedAt: NOW - 2 * HOUR,
    }),
  ];
  assert.deepEqual(
    orderRuns(runs).map((r) => r.id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    runs.map((r) => r.id),
    ['a', 'b', 'c'],
  );
});

test('an old failure of a workflow that has run well since is not failing', () => {
  const runs = [
    run('new', { startedAt: NOW - 1 * HOUR }),
    run('old', { conclusion: 'failure', startedAt: NOW - 9 * HOUR }),
  ];
  assert.equal(failingRunIds(runs).size, 0);
  assert.deepEqual(
    orderRuns(runs).map((r) => r.id),
    ['new', 'old'],
  );
});

test('the lead says the last run failed, with when and where, and offers to open it', () => {
  const failed = run('f', { conclusion: 'failure', startedAt: NOW - 2 * HOUR });
  const lead = workflowsLead({
    rows: [row('ios', 'configured', failed), row('b', 'build', run('x')), row('c', 'other', null)],
    runs: [failed, run('x', { startedAt: NOW - 8 * HOUR })],
    now: NOW,
    canDispatch: true,
  });
  assert.equal(lead.headline, 'Last run failed 2 hours ago on main');
  assert.equal(lead.hint, '3 workflows, 1 failing.');
  assert.equal(lead.tone, 'bad');
  assert.deepEqual(lead.primary, { kind: 'open', runId: 'f', label: 'Open the run' });
});

test('after a good run the one action is to start the release workflow, when it can be run', () => {
  const ok = run('ok');
  const rows = [row('ios', 'configured', ok)];
  const lead = workflowsLead({ rows, runs: [ok], now: NOW, canDispatch: true });
  assert.equal(lead.headline, 'Last run succeeded 1 hour ago on main');
  assert.equal(lead.tone, 'ok');
  assert.equal(lead.hint, '1 workflow, none failing.');
  assert.deepEqual(lead.primary, {
    kind: 'start',
    workflowId: 'ios',
    repositoryId: 'r1',
    label: 'Start release',
  });
  // No right to dispatch, or a disabled workflow: the run is the one thing to open.
  assert.equal(
    workflowsLead({ rows, runs: [ok], now: NOW, canDispatch: false }).primary?.kind,
    'open',
  );
  const off = [row('ios', 'configured', ok, 'disabled_manually')];
  assert.equal(
    workflowsLead({ rows: off, runs: [ok], now: NOW, canDispatch: true }).primary?.kind,
    'open',
  );
});

test('a run going now is followed; a pending run has no page to open', () => {
  const going = run('g', { status: 'in_progress', conclusion: null, active: true });
  const two = workflowsLead({
    rows: [],
    runs: [going, run('g2', { active: true, status: 'queued', conclusion: null })],
    now: NOW,
    canDispatch: true,
  });
  assert.equal(two.headline, '2 runs are going now');
  assert.deepEqual(two.primary, { kind: 'open', runId: 'g', label: 'Follow the run' });
  const pending = run('pending-1', { status: 'pending', conclusion: null, active: true });
  const lead = workflowsLead({ rows: [], runs: [pending], now: NOW, canDispatch: true });
  assert.equal(lead.headline, '1 run is going now');
  assert.equal(lead.primary, null);
});

test('no runs: say so, and offer the release workflow only when there is one', () => {
  assert.equal(
    workflowsLead({ rows: [], runs: [], now: NOW, canDispatch: true }).headline,
    'No workflows to run yet',
  );
  const lead = workflowsLead({
    rows: [row('ios', 'release', null)],
    runs: [],
    now: NOW,
    canDispatch: true,
  });
  assert.equal(lead.headline, 'No run has been read yet');
  assert.equal(lead.primary?.kind, 'start');
  assert.equal(
    workflowsLead({ rows: [row('o', 'other', null)], runs: [], now: NOW, canDispatch: true })
      .primary,
    null,
  );
});

test('a cancelled last run reads as cancelled, with a neutral tone', () => {
  const c = run('c', { conclusion: 'cancelled' });
  const lead = workflowsLead({ rows: [], runs: [c], now: NOW, canDispatch: false });
  assert.equal(lead.headline, 'Last run was cancelled 1 hour ago on main');
  assert.equal(lead.tone, 'neutral');
});
