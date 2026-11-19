import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiWorkflow, WorkflowRun } from './types.ts';
import {
  filterByPlatform,
  filterRows,
  isConfiguredWorkflow,
  lastRuns,
  matchesStatus,
  nameTokens,
  platformHints,
  rankWorkflows,
  readProblemLabel,
  rowsOf,
  runBlockedReason,
  runHints,
  runIsOf,
  scopeNote,
  sortRows,
  splitRelevant,
  suggestAppId,
  workflowsFromRuns,
} from './workflows.ts';

const wf = (id: string, name: string, file: string, state = 'active'): CiWorkflow => ({
  id,
  name,
  path: `.github/workflows/${file}`,
  state,
});

const run = (id: string, workflowFile: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  repositoryId: 'r1',
  appId: null,
  workflow: workflowFile,
  workflowPath: `.github/workflows/${workflowFile}`,
  title: null,
  status: 'completed',
  conclusion: 'success',
  active: false,
  headSha: null,
  commitMessage: null,
  branch: 'main',
  event: 'workflow_dispatch',
  runNumber: 1,
  url: null,
  inputs: null,
  dispatchedBy: null,
  startedAt: 1000,
  updatedAt: 2000,
  syncedAt: 2000,
  ...extra,
});

test('nameTokens splits words, paths and camel case', () => {
  assert.deepEqual(nameTokens('.github/workflows/iOS-Release.yml'), [
    'github',
    'workflows',
    'ios',
    'release',
    'yml',
  ]);
  assert.deepEqual(nameTokens('buildAndroid'), ['build', 'android']);
});

test('platformHints reads whole words only and treats both or none as any platform', () => {
  assert.deepEqual(platformHints(wf('1', 'iOS release', 'ios.yml')), ['ios']);
  assert.deepEqual(platformHints(wf('2', 'Play Store upload', 'android-release.yml')), ['android']);
  assert.deepEqual(platformHints(wf('3', 'macOS build', 'macos.yml')), ['macos']);
  assert.deepEqual(platformHints(wf('4', 'Release', 'release.yml')), []);
  assert.deepEqual(platformHints(wf('5', 'iOS and Android', 'mobile.yml')), ['ios', 'android']);
  assert.deepEqual(platformHints(wf('6', 'Machine learning', 'machine.yml')), []);
  assert.deepEqual(runHints(run('1', 'android.yml')), ['android']);
});

test('isConfiguredWorkflow takes a file, a path or a name', () => {
  const w = wf('1', 'iOS release', 'ios.yml');
  assert.ok(isConfiguredWorkflow(w, 'ios.yml'));
  assert.ok(isConfiguredWorkflow(w, '.github/workflows/ios.yml'));
  assert.ok(isConfiguredWorkflow(w, 'iOS release'));
  assert.ok(!isConfiguredWorkflow(w, 'android.yml'));
  assert.ok(!isConfiguredWorkflow(w, ' '));
});

test('runIsOf matches by file, else by name', () => {
  const w = wf('1', 'iOS release', 'ios.yml');
  assert.ok(runIsOf(run('1', 'ios.yml', { workflow: 'iOS release' }), w));
  assert.ok(!runIsOf(run('2', 'android.yml'), w));
  assert.ok(runIsOf({ workflow: 'iOS release', workflowPath: null }, w));
});

test('rankWorkflows puts the configured, then used, then named ones first; disabled last', () => {
  const list = [
    wf('1', 'Lint', 'lint.yml'),
    wf('2', 'Build Android', 'android-build.yml'),
    wf('3', 'Nightly', 'nightly.yml'),
    wf('4', 'Deploy', 'deploy.yml', 'disabled_manually'),
    wf('5', 'Ship iOS', 'ios.yml'),
    wf('6', 'Tests', 'tests.yml'),
  ];
  const ranked = rankWorkflows(list, {
    configured: ['ios.yml'],
    appIds: ['a1'],
    runs: [run('9', 'tests.yml', { appId: 'a1' }), run('8', 'lint.yml', { appId: 'other' })],
  });
  assert.deepEqual(
    ranked.map((e) => [e.workflow.id, e.relevance]),
    [
      ['5', 'configured'],
      ['6', 'used'],
      ['2', 'build'],
      ['3', 'build'],
      ['1', 'other'],
      ['4', 'release'],
    ],
  );
  assert.ok((ranked[0] as { reason: string }).reason.includes('build conventions'));
});

test('rankWorkflows without context falls back to name hints and keeps order stable', () => {
  const ranked = rankWorkflows([
    wf('1', 'Zeta', 'z.yml'),
    wf('2', 'Alpha', 'a.yml'),
    wf('3', 'Release', 'r.yml'),
  ]);
  assert.deepEqual(
    ranked.map((e) => e.workflow.id),
    ['3', '2', '1'],
  );
});

test('splitRelevant folds the unmarked ones only when there are many and some are marked', () => {
  const few = rankWorkflows([wf('1', 'Build', 'b.yml'), wf('2', 'Lint', 'l.yml')]);
  assert.equal(splitRelevant(few).rest.length, 0);
  const many = rankWorkflows([
    wf('0', 'Build', 'b.yml'),
    ...Array.from({ length: 9 }, (_, i) => wf(`o${i}`, `Other ${i}`, `o${i}.yml`)),
  ]);
  const split = splitRelevant(many);
  assert.equal(split.shown.length, 1);
  assert.equal(split.rest.length, 9);
  const unmarked = rankWorkflows(
    Array.from({ length: 12 }, (_, i) => wf(`o${i}`, `Other ${i}`, `o${i}.yml`)),
  );
  assert.equal(splitRelevant(unmarked).shown.length, 12);
});

test('filterByPlatform keeps generic items, hides the other platform, and never leaves nothing', () => {
  const items = [
    { n: 'ios', h: ['ios'] as const },
    { n: 'android', h: ['android'] as const },
    { n: 'any', h: [] as const },
  ];
  const hints = (i: (typeof items)[number]) => i.h;
  const ios = filterByPlatform(items, hints, ['ios'], ['ios', 'android']);
  assert.deepEqual(
    ios.shown.map((i) => i.n),
    ['ios', 'any'],
  );
  assert.deepEqual(
    ios.hidden.map((i) => i.n),
    ['android'],
  );
  assert.equal(ios.fellBack, false);
  const both = filterByPlatform(items, hints, ['ios', 'android'], ['ios', 'android']);
  assert.equal(both.shown.length, 3);
  const onlyAndroid = filterByPlatform(
    [items[0] as (typeof items)[number]],
    hints,
    ['android'],
    ['ios', 'android'],
  );
  assert.equal(onlyAndroid.shown.length, 1);
  assert.equal(onlyAndroid.fellBack, true);
  const empty = filterByPlatform([], hints, ['ios'], ['ios', 'android']);
  assert.deepEqual(empty, { shown: [], hidden: [], fellBack: false });
  // An app with a single platform is never filtered.
  assert.equal(filterByPlatform(items, hints, ['ios'], ['ios']).shown.length, 3);
});

test('scopeNote says what was left out, or that nothing matched', () => {
  assert.equal(scopeNote({ noun: 'workflow', scopeLabel: 'iOS', hidden: 0, fellBack: false }), '');
  assert.equal(
    scopeNote({ noun: 'workflow', scopeLabel: 'iOS', hidden: 1, fellBack: false }),
    '1 workflow for other platforms is hidden.',
  );
  assert.equal(
    scopeNote({ noun: 'workflow', scopeLabel: 'iOS', hidden: 3, fellBack: false }),
    '3 workflows for other platforms are hidden.',
  );
  assert.match(
    scopeNote({ noun: 'workflow', scopeLabel: 'iOS', hidden: 0, fellBack: true }),
    /No workflows are named for iOS/,
  );
});

test('lastRuns picks the newest run of each workflow', () => {
  const list = [
    wf('1', 'iOS', 'ios.yml'),
    wf('2', 'Android', 'android.yml'),
    wf('3', 'Never', 'never.yml'),
  ];
  const runs = [
    run('a', 'ios.yml', { startedAt: 10 }),
    run('b', 'ios.yml', { startedAt: 30 }),
    run('c', 'android.yml', { startedAt: 20 }),
  ];
  const last = lastRuns(list, runs);
  assert.equal(last['1']?.id, 'b');
  assert.equal(last['2']?.id, 'c');
  assert.equal(last['3'], undefined);
});

test('workflowsFromRuns lists each workflow once and cannot be started', () => {
  const found = workflowsFromRuns([
    run('a', 'ios.yml'),
    run('b', 'ios.yml'),
    run('c', 'android.yml'),
  ]);
  assert.equal(found.length, 2);
  assert.ok(found.every((w) => w.state === 'unknown'));
  assert.ok(runBlockedReason(found[0] as CiWorkflow, true)?.includes('unknown'));
});

test('runBlockedReason names the role or the state', () => {
  assert.equal(runBlockedReason({ state: 'active' }, true), null);
  assert.match(runBlockedReason({ state: 'active' }, false) ?? '', /member or admin/);
  assert.equal(
    runBlockedReason({ state: 'disabled_manually' }, true),
    'This workflow is disabled manually on GitHub.',
  );
});

test('suggestAppId picks only what is not a guess', () => {
  const apps = [
    { id: 'i', platform: 'ios' as const, repositoryId: 'r1' },
    { id: 'a', platform: 'android' as const, repositoryId: 'r1' },
    { id: 'x', platform: 'ios' as const, repositoryId: 'r2' },
  ];
  assert.equal(suggestAppId(apps, 'r1', ['android']), 'a');
  assert.equal(suggestAppId(apps, 'r1', []), '');
  assert.equal(suggestAppId(apps, 'r2', []), 'x');
  assert.equal(suggestAppId(apps, 'r3', ['ios']), '');
});

test('status filters and rows for the workspace list', () => {
  const r1 = { id: 'r1', owner: 'acme', repo: 'app', name: 'acme/app', defaultBranch: 'main' };
  const r2 = { id: 'r2', owner: 'acme', repo: 'web', name: 'acme/web', defaultBranch: 'main' };
  const rows = [
    ...rowsOf(r2, rankWorkflows([wf('9', 'Deploy', 'deploy.yml')]), [
      run('z', 'deploy.yml', { status: 'in_progress', conclusion: null, active: true }),
    ]),
    ...rowsOf(r1, rankWorkflows([wf('1', 'iOS release', 'ios.yml'), wf('2', 'Lint', 'lint.yml')]), [
      run('a', 'ios.yml', { conclusion: 'failure' }),
    ]),
  ];
  assert.deepEqual(
    sortRows(rows).map((r) => r.entry.workflow.id),
    ['9', '1', '2'],
  );
  assert.deepEqual(
    filterRows(rows, { repositoryId: 'r1', status: 'all' })
      .map((r) => r.entry.workflow.id)
      .sort(),
    ['1', '2'],
  );
  assert.deepEqual(
    filterRows(rows, { repositoryId: '', status: 'running' }).map((r) => r.entry.workflow.id),
    ['9'],
  );
  assert.deepEqual(
    filterRows(rows, { repositoryId: '', status: 'failed' }).map((r) => r.entry.workflow.id),
    ['1'],
  );
  assert.deepEqual(
    filterRows(rows, { repositoryId: '', status: 'never' }).map((r) => r.entry.workflow.id),
    ['2'],
  );
  assert.equal(matchesStatus(null, 'succeeded'), false);
  assert.equal(matchesStatus(run('s', 'a.yml'), 'succeeded'), true);
});

test('readProblemLabel says whether the connection or GitHub is the problem', () => {
  assert.equal(readProblemLabel('github_forbidden'), 'The GitHub connection cannot read Actions');
  assert.equal(readProblemLabel('github_unavailable'), 'GitHub did not answer');
  assert.equal(readProblemLabel('rate_limited'), 'GitHub asked for a pause');
  assert.equal(readProblemLabel(undefined, 403), 'You cannot read workflows here');
  assert.equal(readProblemLabel('x'), 'Workflows could not be read');
});
