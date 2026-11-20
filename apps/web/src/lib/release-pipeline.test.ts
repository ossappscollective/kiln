import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type PipelineSummaryApp,
  type SummaryStall,
  stalledApps,
  stalledFor,
  stallVersion,
  stepForStall,
  stepForState,
  stripModel,
  stripVisible,
  summaryByApp,
  unfinishedItem,
  waitingOf,
} from './release-pipeline.ts';

const steps = (statuses: string[]) =>
  ['ci', 'build', 'prepare', 'review', 'release'].map((id, i) => ({
    id,
    status: statuses[i],
    at: null,
    detail: null,
  })) as never;

const stall = (extra: Partial<SummaryStall> = {}): SummaryStall => ({
  step: 'draft',
  label: 'Prepared, not submitted',
  message:
    'Build 412 was uploaded 10 h ago by run #88; version 2.4.0 is still in Prepare for submission with its build and has not been submitted for review.',
  hours: 10,
  since: 1,
  stale: false,
  evidence: [
    { kind: 'run', id: '1001', at: 1 },
    { kind: 'version', id: '2.4.0', at: 1 },
  ],
  ...extra,
});

test('waiting for you and waiting on the store are told apart', () => {
  assert.deepEqual(waitingOf('you'), { who: 'you', text: 'Waiting for you' });
  assert.deepEqual(waitingOf('store'), { who: 'store', text: 'Waiting on the store' });
  assert.equal(waitingOf('ci')?.text, 'Waiting on CI');
  assert.equal(waitingOf(null), null);
});

test('every stall leads to a step of the stepper', () => {
  assert.equal(stepForStall('draft'), 'confirm');
  assert.equal(stepForStall('approved'), 'confirm');
  assert.equal(stepForStall('rejected'), 'review');
  assert.equal(stepForStall('build_ready'), 'build');
  assert.equal(stepForStall('ci_run'), 'build');
  assert.equal(stepForState('in_review'), 'confirm');
  assert.equal(stepForState('build_ready'), 'build');
  assert.equal(stepForState('ci_failed'), 'build');
});

test('the version of a stall comes from its evidence, without the track', () => {
  assert.equal(stallVersion(stall().evidence), '2.4.0');
  assert.equal(stallVersion([{ kind: 'version', id: '2.4.0@production', at: null }]), '2.4.0');
  assert.equal(stallVersion([{ kind: 'build', id: '412', at: null }]), null);
});

test('the strip marks the step that matters now and says who is expected to act', () => {
  const model = stripModel({
    steps: steps(['done', 'done', 'stalled', 'todo', 'todo']),
    waitingOn: 'you',
    summary: 'Prepared, not submitted.',
    state: 'draft',
  });
  assert.deepEqual(
    model.steps.map((s) => s.current),
    [false, false, true, false, false],
  );
  assert.deepEqual(
    model.steps.map((s) => s.label),
    ['CI', 'Build', 'Prepare', 'Review', 'Release'],
  );
  assert.equal(model.steps[2]?.word, 'Stalled');
  assert.equal(model.waiting?.text, 'Waiting for you');
  assert.equal(model.step, 'confirm');
  const store = stripModel({
    steps: steps(['done', 'done', 'done', 'waiting', 'todo']),
    waitingOn: 'store',
    summary: 'In review.',
    state: 'in_review',
  });
  assert.equal(store.steps[3]?.current, true);
  assert.equal(store.waiting?.text, 'Waiting on the store');
  // Nothing active: the step after the last done one.
  const between = stripModel({
    steps: steps(['done', 'done', 'todo', 'todo', 'todo']),
    waitingOn: 'you',
    summary: '',
    state: 'build_ready',
  });
  assert.equal(between.steps[2]?.current, true);
  // All done: nothing to mark.
  assert.equal(
    stripModel({
      steps: steps(['done', 'done', 'done', 'done', 'done']),
      waitingOn: null,
      summary: '',
      state: 'live',
    }).steps.some((s) => s.current),
    false,
  );
});

test('the strip is quiet when nothing is on its way', () => {
  assert.equal(stripVisible({ state: 'idle' }), false);
  assert.equal(stripVisible({ state: 'unknown' }), false);
  assert.equal(stripVisible({ state: 'live' }), false);
  assert.equal(stripVisible({ state: 'draft' }), true);
  assert.equal(stripVisible({ state: 'ci_running' }), true);
});

test('a stalled release becomes "Release left unfinished" with the evidence sentence and a deep link', () => {
  const item = unfinishedItem({
    appId: 'a1',
    platform: 'ios',
    scope: 'ios',
    several: false,
    stalled: stall(),
  });
  assert.equal(item?.text, 'Release left unfinished');
  assert.match(item?.detail ?? '', /Build 412 was uploaded 10 h ago by run #88/);
  assert.equal(item?.href, '#/portfolio/a1/releases?platform=ios&version=2.4.0&step=confirm');
  assert.equal(item?.action, 'Finish the release');
  assert.equal(item?.tone, 'warn');
  const named = unfinishedItem({
    appId: 'a2',
    platform: 'android',
    scope: 'both',
    several: true,
    stalled: stall({ step: 'build_ready', evidence: [{ kind: 'build', id: '9', at: null }] }),
  });
  assert.equal(named?.text, 'Android: A new build has no version yet');
  assert.equal(named?.action, 'Create a version');
  assert.equal(named?.href, '#/portfolio/a2/releases?platform=both&step=build');
  const old = unfinishedItem({
    appId: 'a1',
    platform: 'ios',
    scope: null,
    several: false,
    stalled: stall({ stale: true }),
  });
  assert.equal(old?.tone, 'info');
  assert.match(old?.text ?? '', /more than 14 days ago/);
  assert.equal(
    unfinishedItem({ appId: 'a1', platform: 'ios', scope: null, several: false, stalled: null }),
    null,
  );
});

test('only fresh stalls count for the badges', () => {
  const app = (id: string, s: SummaryStall | null): PipelineSummaryApp => ({
    app: { id, name: id, platform: 'ios', store: 'appstoreconnect' },
    state: 'draft',
    waitingOn: 'you',
    since: null,
    summary: '',
    lastSyncedAt: null,
    stalled: s,
  });
  const summary = { apps: [app('a', stall()), app('b', stall({ stale: true })), app('c', null)] };
  assert.deepEqual(
    stalledApps(summary).map((a) => a.app.id),
    ['a'],
  );
  assert.equal(stalledApps(null).length, 0);
  assert.equal(summaryByApp(summary).b?.app.id, 'b');
  assert.equal(summaryByApp(null).a, undefined);
});

test('a stall is told in hours, then days', () => {
  assert.equal(stalledFor(10), '10 h');
  assert.equal(stalledFor(47.9), '47 h');
  assert.equal(stalledFor(72), '3 days');
});
