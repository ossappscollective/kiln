import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseTrains, type TrainInput, trainInputOf } from './release-trains.ts';

const rows = (statuses: string[]) =>
  ['ci', 'build', 'prepare', 'review', 'release'].map((id, i) => ({
    id,
    status: statuses[i],
    detail: null,
  })) as TrainInput['steps'];

const draftIos: TrainInput = {
  appId: 'ios',
  platform: 'ios',
  state: 'draft',
  waitingOn: 'you',
  summary: 's',
  version: '3.1.1',
  steps: rows(['done', 'done', 'current', 'todo', 'todo']),
  build: { number: '168', version: '3.1.1', processed: true, attached: true },
};
const buildMac: TrainInput = {
  appId: 'mac',
  platform: 'macos',
  state: 'build_ready',
  waitingOn: 'you',
  summary: 's',
  version: null,
  steps: rows(['done', 'done', 'todo', 'todo', 'todo']),
  build: { number: '169', version: null, processed: true, attached: false },
};

test('a version being prepared and a build nobody has are one train, with the build as a step inside it', () => {
  const trains = releaseTrains([draftIos, buildMac]);
  assert.equal(trains.length, 1);
  const t = trains[0]!;
  assert.equal(t.title, 'Version 3.1.1');
  assert.deepEqual(t.lines.length, 2);
  assert.match(t.lines[1]!, /Build 169 is ready: attach it to 3.1.1/);
  assert.equal(t.button.label, 'Attach build 169');
  assert.equal(t.button.step, 'build');
  assert.equal(t.waiting?.who, 'you');
});

test('a build with no version in sight is its own train: create or pick a version', () => {
  const t = releaseTrains([buildMac])[0]!;
  assert.equal(t.title, 'New build 169');
  assert.match(t.lines[0]!, /create a version for it or pick an existing one/);
  assert.equal(t.button.label, 'Create or pick a version');
});

test('two records that ship the same version are one train; different versions are two', () => {
  const mac = { ...draftIos, appId: 'mac', platform: 'macos' as const };
  assert.equal(releaseTrains([draftIos, mac]).length, 1);
  assert.deepEqual(releaseTrains([draftIos, mac])[0]!.platforms, ['ios', 'macos']);
  assert.equal(releaseTrains([draftIos, { ...mac, version: '3.2.0' }]).length, 2);
});

test('a build that names its version goes to that train; with two versions and no name it stays its own train', () => {
  const second = { ...draftIos, appId: 'a2', version: '3.2.0' };
  const named = { ...buildMac, build: { ...buildMac.build!, version: '3.2.0' } };
  const trains = releaseTrains([draftIos, second, named]);
  assert.equal(trains.length, 2);
  assert.match(
    trains.filter((t) => t.version === '3.2.0')[0]!.lines.join(' '),
    /Build 169 is ready/,
  );
  assert.equal(releaseTrains([draftIos, second, buildMac]).length, 3);
});

test('a build already attached to its version adds nothing; idle and live records draw nothing', () => {
  const sameBuild = { ...buildMac, build: { ...buildMac.build!, attached: true } };
  assert.equal(releaseTrains([draftIos, { ...sameBuild, state: 'idle' }]).length, 1);
  assert.equal(
    releaseTrains([
      { ...draftIos, state: 'live' },
      { ...buildMac, state: 'unknown' },
    ]).length,
    0,
  );
});

test('review, rejection and approval say who acts and offer one button', () => {
  assert.match(
    releaseTrains([{ ...draftIos, state: 'in_review', waitingOn: 'store' }])[0]!.lines[0]!,
    /Waiting on the store/,
  );
  const rejected = releaseTrains([{ ...draftIos, state: 'rejected' }])[0]!;
  assert.deepEqual([rejected.button.label, rejected.button.step], ['See what to fix', 'review']);
  const approved = releaseTrains([{ ...draftIos, state: 'approved' }])[0]!;
  assert.deepEqual([approved.button.label, approved.button.step], ['Release it', 'confirm']);
});

test('the merged strip shows the least advanced status of each step and marks the one that matters', () => {
  const t = releaseTrains([draftIos, buildMac])[0]!;
  assert.deepEqual(
    t.steps.map((s) => s.label),
    ['CI', 'Build', 'Prepare', 'Review', 'Release'],
  );
  assert.equal(t.steps.filter((s) => s.current)[0]?.label, 'Prepare');
});

test('trainInputOf reads a pipeline: the attached build is told from a free one', () => {
  const pipeline = {
    platform: 'ios',
    state: 'draft',
    waitingOn: 'you',
    steps: rows(['done', 'done', 'current', 'todo', 'todo']),
    summary: 'x',
    latest: {
      run: null,
      build: { buildNumber: '169', version: null, state: 'processed' },
      version: { version: '3.1.1', build: '168', versionCodes: null },
    },
  };
  const input = trainInputOf({ app: { id: 'ios' }, pipeline } as never);
  assert.equal(input.version, '3.1.1');
  assert.deepEqual(input.build, { number: '169', version: null, processed: true, attached: false });
});

test('the newest build of the same record counts as free when the version does not have it', () => {
  const own = {
    ...draftIos,
    build: { number: '169', version: null, processed: true, attached: false },
  };
  const t = releaseTrains([own])[0]!;
  assert.equal(t.lines.length, 2);
  assert.equal(t.button.label, 'Attach build 169');
  assert.equal(releaseTrains([{ ...own, state: 'in_review' }])[0]!.lines.length, 1);
});
