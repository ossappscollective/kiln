import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseReleaseWorkflow,
  dispatchHints,
  isStartedRun,
  matchingBuilds,
  prefillNote,
  prepareReleaseHref,
  startedLine,
} from './start-release.ts';
import type { AppBuild, CiWorkflow, WorkflowInputSpec } from './types.ts';
import { rankWorkflows } from './ci/workflows.ts';

const wf = (name: string, path: string, state = 'active'): CiWorkflow => ({
  id: path,
  name,
  path,
  state,
});
const spec = (name: string, extra: Partial<WorkflowInputSpec> = {}): WorkflowInputSpec => ({
  name,
  required: false,
  type: 'string',
  ...extra,
});

test('the release workflow of the build conventions is the one to start', () => {
  const list = [
    wf('CI', '.github/workflows/ci.yml'),
    wf('Ship it', '.github/workflows/ship.yml'),
    wf('Release iOS', '.github/workflows/release-ios.yml'),
  ];
  const entries = rankWorkflows(list, { configured: ['ship.yml'] });
  const chosen = chooseReleaseWorkflow(entries, ['ios']);
  assert.equal(chosen?.workflow.name, 'Ship it');
  assert.equal(chosen?.why, 'configured');
});

test('without a convention, the one workflow that says release is chosen, and only then', () => {
  const one = rankWorkflows([wf('CI', 'ci.yml'), wf('Release', 'release.yml')]);
  assert.equal(chooseReleaseWorkflow(one, ['ios', 'android'])?.workflow.name, 'Release');
  assert.equal(chooseReleaseWorkflow(one, ['ios'])?.why, 'release');
  const two = rankWorkflows([
    wf('Release iOS', 'release-ios.yml'),
    wf('Release Android', 'release-android.yml'),
  ]);
  assert.equal(chooseReleaseWorkflow(two, ['ios'])?.workflow.name, 'Release iOS');
  assert.equal(chooseReleaseWorkflow(two, ['ios', 'android']), null);
  assert.equal(chooseReleaseWorkflow(rankWorkflows([wf('Lint', 'lint.yml')]), ['ios']), null);
  assert.equal(chooseReleaseWorkflow([], ['ios']), null);
});

test('a disabled workflow is never chosen, and two configured ones are not guessed between', () => {
  const disabled = rankWorkflows([wf('Release', 'release.yml', 'disabled_manually')], {
    configured: ['release.yml'],
  });
  assert.equal(chooseReleaseWorkflow(disabled, ['ios']), null);
  const twice = rankWorkflows([wf('A', 'a.yml'), wf('B', 'b.yml')], {
    configured: ['a.yml', 'b.yml'],
  });
  assert.equal(chooseReleaseWorkflow(twice, ['ios']), null);
});

test('a platform input gets the platform in scope, a version input the selected version', () => {
  const specs = [
    spec('platform', { type: 'choice', options: ['iOS', 'Android', 'Both'] }),
    spec('version'),
    spec('dry_run', { type: 'boolean' }),
    spec('notes'),
  ];
  assert.deepEqual(dispatchHints(specs, { platforms: ['ios'], version: '2.4.0' }), {
    platform: 'iOS',
    version: '2.4.0',
  });
  assert.deepEqual(dispatchHints(specs, { platforms: ['android'] }), { platform: 'Android' });
  assert.deepEqual(dispatchHints(specs, { platforms: ['ios', 'android'], version: null }), {
    platform: 'Both',
  });
});

test('hints never invent a value a choice does not offer', () => {
  const choice = [spec('platform', { type: 'choice', options: ['production', 'staging'] })];
  assert.deepEqual(dispatchHints(choice, { platforms: ['ios'] }), {});
  assert.deepEqual(dispatchHints([spec('platform')], { platforms: ['ios'] }), { platform: 'ios' });
  assert.deepEqual(dispatchHints([spec('platform')], { platforms: ['ios', 'android'] }), {});
  assert.deepEqual(
    dispatchHints([spec('version', { type: 'choice', options: ['1'] })], {
      platforms: [],
      version: '2',
    }),
    {},
  );
  assert.deepEqual(dispatchHints([], { platforms: ['ios'] }), {});
});

test('the note says which workflow was chosen and why', () => {
  const chosen = { workflow: wf('Release', 'release.yml'), why: 'configured' as const };
  assert.equal(
    prefillNote(chosen, { platforms: ['ios'] }),
    'Release: the release workflow of this app for iOS.',
  );
  assert.equal(
    prefillNote({ ...chosen, why: 'release' }, { platforms: ['ios', 'android'] }),
    'Release: the only release workflow found.',
  );
});

const build = (over: Partial<AppBuild>): AppBuild => ({
  platform: 'ios',
  buildNumber: '10',
  version: '2.4.0',
  tracks: [],
  status: null,
  rawState: '',
  uploadedAt: null,
  syncedAt: 0,
  linkState: 'unlinked',
  link: null,
  diagnostic: null,
  ...over,
});
const linked = (runId: string): AppBuild['link'] =>
  ({
    state: 'linked',
    source: 'dispatch_input',
    run: {
      id: runId,
      workflow: 'Release',
      title: null,
      status: 'completed',
      conclusion: 'success',
      active: false,
      url: null,
      branch: null,
    },
  }) as AppBuild['link'];

test('a build matches by its run, or by being uploaded after the run started', () => {
  const started = { runId: '77', startedAt: 1000, platforms: ['ios' as const] };
  const builds = [
    build({ buildNumber: '9', uploadedAt: 500 }),
    build({ buildNumber: '10', uploadedAt: 1500 }),
    build({ buildNumber: '11', uploadedAt: 400, link: linked('77') }),
    build({ buildNumber: '12', uploadedAt: 2000, platform: 'android' }),
    build({ buildNumber: '13', uploadedAt: null, syncedAt: 9999 }),
    build({ buildNumber: '14', uploadedAt: 3000, link: linked('5') }),
  ];
  assert.deepEqual(
    matchingBuilds(builds, started).map((b) => b.buildNumber),
    ['14', '10', '11'],
  );
  assert.deepEqual(
    matchingBuilds(builds, { ...started, platforms: [] }).map((b) => b.buildNumber),
    ['14', '12', '10', '11'],
  );
  assert.deepEqual(matchingBuilds([], started), []);
});

test('Prepare release goes to the Build step of the releases tab with the version selected', () => {
  assert.equal(
    prepareReleaseHref('a1', { platform: 'ios', version: '2.4.0' }, false),
    '#/portfolio/a1/releases?platform=ios&version=2.4.0&step=build',
  );
  assert.equal(
    prepareReleaseHref('a1', { platform: 'ios', version: '2.4.0' }, true),
    '#/portfolio/a1/releases?platform=both&version=2.4.0&step=build',
  );
});

test('the started run has a line for each moment', () => {
  assert.equal(
    startedLine({ workflow: 'Release', running: true, build: null }),
    'Release was started. Waiting for it to produce a build.',
  );
  assert.equal(
    startedLine({ workflow: 'Release', running: false, build: null }),
    'Release has finished. No new build was found yet.',
  );
  assert.equal(
    startedLine({
      workflow: 'Release',
      running: false,
      build: { buildNumber: '412', version: '2.4.0' },
    }),
    'Build 412 (version 2.4.0) is ready.',
  );
});

test('the run that was started is found again, also while GitHub has not named it', () => {
  const run = (over: Record<string, unknown>) =>
    ({ repositoryId: 'r1', id: '77', workflow: 'Release', startedAt: 1000, ...over }) as Parameters<
      typeof isStartedRun
    >[0];
  const started = { repositoryId: 'r1', runId: '77', workflow: 'Release', startedAt: 1000 };
  assert.equal(isStartedRun(run({}), started), true);
  assert.equal(isStartedRun(run({ id: '78' }), started), false);
  assert.equal(isStartedRun(run({ repositoryId: 'r2' }), started), false);
  const pending = { ...started, runId: 'pending-abc', startedAt: 100_000 };
  assert.equal(isStartedRun(run({ id: '90', startedAt: 101_500 }), pending), true);
  assert.equal(isStartedRun(run({ id: '90', startedAt: 99_000 }), pending), true);
  assert.equal(isStartedRun(run({ id: '90', startedAt: 10_000 }), pending), false);
  assert.equal(isStartedRun(run({ id: '90', workflow: 'Other' }), pending), false);
});

test('a failed run says no build is expected', () => {
  assert.equal(
    startedLine({ workflow: 'Release', running: false, build: null, failed: true }),
    'Release did not succeed, so no build is expected from it.',
  );
});
