import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from '../i18n/test-setup.ts';
import type { AppBuild, WorkflowInputSpec, WorkflowRun } from '../types.ts';
import {
  buildLinkLabel,
  buildName,
  confidenceBadge,
  canDispatchWorkflow,
  changesHeadline,
  dispatchInputs,
  dispatchSummary,
  hasActiveRun,
  initialInputValues,
  inputProblems,
  isPending,
  linkSourceLabel,
  parseFreeFormInputs,
  pollDelay,
  previousLinkedBuild,
  runBadge,
  runDuration,
  runTitle,
  shortSha,
  sortRuns,
  workflowKey,
} from './ci.ts';

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: '1',
  repositoryId: 'r',
  appId: null,
  workflow: 'iOS release',
  workflowPath: '.github/workflows/ios.yml',
  title: null,
  status: 'completed',
  conclusion: 'success',
  active: false,
  headSha: 'a'.repeat(40),
  commitMessage: null,
  branch: 'main',
  event: 'workflow_dispatch',
  runNumber: 12,
  url: 'https://github.com/acme/app/actions/runs/1',
  inputs: null,
  dispatchedBy: null,
  startedAt: 1_000,
  updatedAt: 61_000,
  syncedAt: 61_000,
  ...over,
});

const build = (platform: 'ios' | 'android', buildNumber: string, linked: boolean): AppBuild => ({
  platform,
  buildNumber,
  version: '2.4.0',
  tracks: [],
  status: 'live',
  rawState: 'x',
  uploadedAt: null,
  syncedAt: 1,
  linkState: linked ? 'linked' : 'unlinked',
  diagnostic: null,
  link: linked
    ? {
        state: 'linked',
        source: 'run_title',
        confidence: 'high',
        evidence: null,
        manual: false,
        reason: '',
        candidates: 1,
        linkedAt: null,
        linkedBy: null,
        run: null,
        commit: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: null, url: null },
      }
    : null,
});

test('runBadge says the state in words for every status and conclusion', () => {
  const label = (status: string, conclusion: string | null = null) =>
    runBadge({ status, conclusion });
  assert.deepEqual(label('pending'), { label: 'Starting', tone: 'info', dot: true });
  assert.equal(label('queued').label, 'Queued');
  assert.equal(label('waiting').label, 'Queued');
  assert.deepEqual(label('in_progress'), { label: 'Running', tone: 'info', dot: true });
  assert.deepEqual(label('completed', 'success'), { label: 'Succeeded', tone: 'ok', dot: false });
  assert.equal(label('completed', 'failure').tone, 'bad');
  assert.equal(label('completed', 'timed_out').label, 'Timed out');
  assert.equal(label('completed', 'startup_failure').label, 'Failed to start');
  assert.equal(label('completed', 'cancelled').tone, 'neutral');
  assert.equal(label('completed', 'action_required').tone, 'warn');
  assert.equal(label('completed', null).label, 'Finished');
  assert.equal(label('completed', 'something_new').label, 'Finished');
  assert.equal(label('unknown').label, 'Unknown');
  assert.equal(label('???').label, 'Unknown');
});

test('hasActiveRun, isPending, runTitle, sortRuns, runDuration', () => {
  assert.equal(hasActiveRun([run(), run({ active: true })]), true);
  assert.equal(hasActiveRun([run()]), false);
  assert.equal(hasActiveRun([]), false);
  assert.equal(isPending(run({ id: 'pending-abc' })), true);
  assert.equal(isPending(run()), false);

  assert.equal(runTitle(run({ title: ' Release 2.4.0 ' })), 'Release 2.4.0');
  assert.equal(runTitle(run()), 'iOS release #12');
  assert.equal(runTitle(run({ runNumber: null })), 'iOS release');

  const sorted = sortRuns([
    run({ id: '1', startedAt: 5 }),
    run({ id: '2', startedAt: 1, active: true }),
    run({ id: '3', startedAt: 9 }),
  ]);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['2', '3', '1'],
    'running first, then the newest',
  );

  assert.equal(runDuration(run({ startedAt: 0, updatedAt: 45_000 })), '45 sec');
  assert.equal(runDuration(run({ startedAt: 0, updatedAt: 200_000 })), '3 min 20 sec');
  assert.equal(runDuration(run({ startedAt: 0, updatedAt: 180_000 })), '3 min');
  assert.equal(runDuration(run({ startedAt: 0, updatedAt: 3_900_000 })), '1 hr 5 min');
  assert.equal(runDuration(run({ active: true })), null);
  assert.equal(runDuration(run({ startedAt: 10, updatedAt: 5 })), null);
});

test('pollDelay: steady, then doubling to a cap', () => {
  assert.equal(pollDelay(0), 15_000);
  assert.equal(pollDelay(1), 30_000);
  assert.equal(pollDelay(2), 60_000);
  assert.equal(pollDelay(100), 60_000);
  assert.equal(pollDelay(-3), 15_000);
});

const specs: WorkflowInputSpec[] = [
  { name: 'build_number', required: true, type: 'string' },
  { name: 'track', required: true, type: 'choice', options: ['internal', 'beta'] },
  { name: 'notes', required: false, type: 'string' },
  { name: 'dry_run', required: false, type: 'boolean' },
  { name: 'retries', required: false, type: 'number', default: '2' },
];

test('the dispatch form starts from defaults and says what is wrong', () => {
  const values = initialInputValues(specs);
  assert.deepEqual(values, {
    build_number: '',
    track: 'internal',
    notes: '',
    dry_run: 'false',
    retries: '2',
  });
  assert.deepEqual(inputProblems(specs, values), { build_number: 'build_number is required.' });

  assert.deepEqual(inputProblems(specs, { ...values, build_number: '241' }), {});
  const bad = inputProblems(specs, {
    ...values,
    build_number: '241',
    track: 'prod',
    dry_run: 'maybe',
    retries: 'many',
  });
  assert.deepEqual(Object.keys(bad).sort(), ['dry_run', 'retries', 'track']);
  assert.match(bad.track ?? '', /internal, beta/);
  assert.match(
    inputProblems(specs, { ...values, build_number: 'x'.repeat(5000) }).build_number ?? '',
    /too long/,
  );
  assert.deepEqual(inputProblems(specs, { ...values, build_number: '   ' }), {
    build_number: 'build_number is required.',
  });
});

test('dispatchInputs sends what has a value, trimmed, and leaves empty optional fields out', () => {
  const sent = dispatchInputs(specs, {
    build_number: ' 241 ',
    track: 'beta',
    notes: '',
    dry_run: 'true',
    retries: '2',
  });
  assert.deepEqual(sent, { build_number: '241', track: 'beta', dry_run: 'true', retries: '2' });
  assert.deepEqual(dispatchInputs([], {}), {});
  assert.deepEqual(
    dispatchInputs(specs, { stray: 'x' }),
    {},
    'a value that no input declares is not sent',
  );
});

test('free-form inputs: name=value lines with a clear message for each bad one', () => {
  const ok = parseFreeFormInputs('build_number=241\n\n# a comment\n notes = a=b, c \r\ntrack=beta');
  assert.deepEqual(ok, {
    inputs: { build_number: '241', notes: 'a=b, c', track: 'beta' },
    problems: [],
  });
  assert.deepEqual(parseFreeFormInputs('').inputs, {});

  const bad = parseFreeFormInputs('novalue\n=x\nbad name=1\nok=1\nok=2');
  assert.deepEqual(bad.inputs, { ok: '1' });
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems[0] ?? '', /^Line 1: write name=value/);
  assert.match(bad.problems[1] ?? '', /^Line 2/);
  assert.match(bad.problems[2] ?? '', /bad name/);
  assert.match(bad.problems[3] ?? '', /ok is given twice/);

  const many = parseFreeFormInputs(Array.from({ length: 26 }, (_, i) => `k${i}=v`).join('\n'));
  assert.match(many.problems.join(' '), /at most 25/);
  assert.match(parseFreeFormInputs(`k=${'v'.repeat(5000)}`).problems[0] ?? '', /too long/);
});

test('dispatchSummary names the workflow, the ref, the repository and how many inputs', () => {
  assert.equal(
    dispatchSummary({ workflow: 'ios.yml', ref: 'main', repository: 'acme/app', inputs: {} }),
    'Run ios.yml on main in acme/app with no inputs.',
  );
  assert.equal(
    dispatchSummary({
      workflow: 'ios.yml',
      ref: 'main',
      repository: 'acme/app',
      inputs: { a: '1' },
    }),
    'Run ios.yml on main in acme/app with 1 input.',
  );
  assert.match(
    dispatchSummary({ workflow: 'w', ref: 'r', repository: 'o/r', inputs: { a: '1', b: '2' } }),
    /with 2 inputs\.$/,
  );
});

test('build helpers', () => {
  assert.equal(linkSourceLabel('manual'), 'Linked by hand');
  assert.equal(linkSourceLabel('run_title'), 'Matched by the run title');
  assert.equal(linkSourceLabel('dispatch_input'), 'Matched by the dispatch input');
  assert.equal(linkSourceLabel('custom'), 'Matched by custom');
  assert.equal(linkSourceLabel('tag'), 'Found through the tag');
  assert.equal(linkSourceLabel('release'), 'Found through the GitHub release');
  assert.equal(buildLinkLabel(build('ios', '1', true)), 'Linked');
  assert.equal(buildLinkLabel(build('ios', '1', false)), 'Unlinked');
  assert.equal(buildLinkLabel({ linkState: 'tag' }), 'Tag found');
  assert.equal(shortSha('0123456789abcdef'), '0123456');
  assert.equal(buildName(build('ios', '240', true)), '2.4.0 (240)');
});

test('previousLinkedBuild skips unlinked builds and other platforms', () => {
  const builds = [
    build('android', '9', true),
    build('ios', '240', true),
    build('ios', '239', false),
    build('ios', '238', true),
    build('ios', '237', true),
  ];
  assert.equal(
    previousLinkedBuild(builds, { platform: 'ios', buildNumber: '240' })?.buildNumber,
    '238',
  );
  assert.equal(previousLinkedBuild(builds, { platform: 'ios', buildNumber: '237' }), undefined);
  assert.equal(previousLinkedBuild(builds, { platform: 'ios', buildNumber: '1' }), undefined);
  assert.equal(previousLinkedBuild(builds, { platform: 'android', buildNumber: '9' }), undefined);
});

test('changesHeadline reads well for each relation', () => {
  const end = (buildNumber: string) => ({
    buildNumber,
    version: '2.4.0',
    sha: 'c'.repeat(40),
    shortSha: 'ccccccc',
  });
  const h = (status: string, totalCommits: number, behindBy = 0) =>
    changesHeadline({ base: end('238'), head: end('240'), status, totalCommits, behindBy });
  assert.equal(h('ahead', 2), '2 commits in build 240 since build 238.');
  assert.equal(h('ahead', 1), '1 commit in build 240 since build 238.');
  assert.match(h('identical', 0), /same commit/);
  assert.match(h('behind', 0, 3), /behind it by 3 commits/);
  assert.match(h('diverged', 4), /only in build 240/);
});

test('workflowKey is the file name, and only active workflows can be started', () => {
  assert.equal(workflowKey({ id: '5', path: '.github/workflows/ios.yml' }), 'ios.yml');
  assert.equal(workflowKey({ id: '5', path: 'ios.yml' }), 'ios.yml');
  assert.equal(workflowKey({ id: '5', path: '' }), '5');
  assert.equal(canDispatchWorkflow({ state: 'active' }), true);
  assert.equal(canDispatchWorkflow({ state: 'disabled_manually' }), false);
});

test('run states, durations, plurals and inputs follow the active language', () => {
  useLocale('fr');
  assert.equal(runBadge({ status: 'in_progress', conclusion: null }).label, 'En cours');
  assert.equal(runBadge({ status: 'completed', conclusion: 'failure' }).label, 'Échoué');
  assert.match(runDuration(run({ startedAt: 0, updatedAt: 200_000 })) ?? '', /^3.min.20.s$/u);
  assert.equal(
    dispatchSummary({ workflow: 'w', ref: 'r', repository: 'o/r', inputs: { a: '1', b: '2' } }),
    'Lancer w sur r dans o/r avec 2 paramètres d’entrée.',
  );
  assert.deepEqual(inputProblems([{ name: 'x', required: true, type: 'string' }], {}), {
    x: 'x est obligatoire.',
  });
  useLocale('de');
  assert.equal(confidenceBadge('low').label, 'Geringe Sicherheit');
  useLocale('en');
});
