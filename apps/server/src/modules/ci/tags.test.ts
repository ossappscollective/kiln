import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RELEASE_PATTERNS, DEFAULT_TAG_PATTERNS } from '@mrm/core';
import {
  type BuildKey,
  type CommitFacts,
  compileConventions,
  explainNoCandidate,
  findCandidates,
  matchCommitToRun,
  type ReleaseRef,
  RUN_WINDOW_SLACK,
  type RunFacts,
  resolveTagLink,
  type TagData,
} from './tags.ts';

// Fixtures modelled on a real fastlane lane: the build number is decided inside the run, the lane
// commits the bump ("chore: new build") and tags it `<platform>/<flavor>/<version>/<versionCode>`.

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const sha = (c: string) => c.repeat(40);
const H = sha('a'); // the commit the run started from (before the bump)
const BUMP_IOS = sha('b');
const BUMP_ANDROID = sha('c');

const conventions = (
  over: Partial<{
    tagPatterns: string[];
    releasePatterns: string[];
    prefix: string;
    workflow: string | null;
  }> = {},
) =>
  compileConventions({
    tagPatterns: [...DEFAULT_TAG_PATTERNS],
    releasePatterns: [...DEFAULT_RELEASE_PATTERNS],
    prefix: '',
    workflow: null,
    ...over,
  });

const ios: BuildKey = { platform: 'ios', buildNumber: '312', version: '1.4.0' };
const android: BuildKey = { platform: 'android', buildNumber: '312', version: '1.4.0' };

const release = (over: Partial<ReleaseRef> & { tagName: string }): ReleaseRef => ({
  name: null,
  targetCommitish: 'main',
  draft: false,
  createdAt: T0 + 5 * MIN,
  publishedAt: T0 + 5 * MIN,
  url: null,
  ...over,
});

const data = (over: Partial<TagData> = {}): TagData => ({
  tags: [
    { name: 'ios/appstore/1.3.0/300', sha: sha('1') },
    { name: 'ios/appstore/1.4.0/312', sha: BUMP_IOS },
    { name: 'android/playstore/1.4.0/312', sha: BUMP_ANDROID },
    { name: 'android/github/1.4.0/312', sha: BUMP_ANDROID },
    { name: 'v1.4.0', sha: sha('2') },
  ],
  releases: [],
  ...over,
});

const runFacts = (id: string, over: Partial<RunFacts> = {}): RunFacts => ({
  id,
  workflow: 'release',
  workflowPath: '.github/workflows/release.yml',
  headSha: H,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  active: false,
  startedAt: T0,
  updatedAt: T0 + 15 * MIN,
  ...over,
});

// ---------------------------------------------------------------------------------------------
// Build number -> tag

test('the maintainer layout: each platform finds its own tag for the same number', () => {
  const c = conventions();
  const [first, ...rest] = findCandidates(ios, data(), c);
  assert.equal(first?.tag, 'ios/appstore/1.4.0/312');
  assert.equal(first?.kind, 'tag');
  assert.equal(first?.sha, BUMP_IOS);
  assert.equal(first?.versionMatch, true);
  assert.equal(first?.pattern, '{prefix}{platform}/{flavor}/{version}/{buildNumber}');
  assert.deepEqual(rest, []);
  assert.deepEqual(
    findCandidates(android, data(), c).map((x) => x.tag),
    ['android/github/1.4.0/312', 'android/playstore/1.4.0/312'],
  );
});

test('a tag for the other platform is never a candidate', () => {
  const only = data({ tags: [{ name: 'android/playstore/1.4.0/312', sha: BUMP_ANDROID }] });
  assert.deepEqual(findCandidates(ios, only, conventions()), []);
  const why = explainNoCandidate(ios, only, conventions());
  assert.equal(why.code, 'other_platform');
  assert.match(why.message, /another platform/);
});

test('a tag with another version is a candidate, after the ones whose version agrees', () => {
  const tags = {
    tags: [
      { name: 'ios/appstore/1.4.1/312', sha: sha('3') },
      { name: 'ios/appstore/1.4.0/312', sha: sha('4') },
    ],
    releases: [],
  };
  const found = findCandidates(ios, tags, conventions());
  assert.deepEqual(
    found.map((x) => [x.tag, x.versionMatch]),
    [
      ['ios/appstore/1.4.0/312', true],
      ['ios/appstore/1.4.1/312', false],
    ],
  );
});

test('names without a platform fit both platforms; a number is compared as a whole', () => {
  const tags = {
    tags: [
      { name: 'v1.4.0+312', sha: sha('3') },
      { name: 'v1.4.0+3120', sha: sha('4') },
      { name: 'build-31', sha: sha('5') },
    ],
    releases: [],
  };
  assert.deepEqual(
    findCandidates(ios, tags, conventions()).map((x) => x.tag),
    ['v1.4.0+312'],
  );
  assert.deepEqual(
    findCandidates(android, tags, conventions()).map((x) => x.tag),
    ['v1.4.0+312'],
  );
  // Leading zeros do not make a different number.
  assert.deepEqual(
    findCandidates(
      ios,
      { tags: [{ name: 'build-0312', sha: sha('6') }], releases: [] },
      conventions(),
    ).length,
    1,
  );
});

test('a release name carries the number too: "<app>(<platform>): v<version> Build <n>"', () => {
  const rel = release({
    tagName: 'ios/production/1.4.0/312',
    name: 'Trail Notes(ios): v1.4.0 Build 312',
  });
  // The tag is in the list: the release only adds its name and time.
  const withTag = findCandidates(
    ios,
    data({ tags: [{ name: 'ios/production/1.4.0/312', sha: BUMP_IOS }], releases: [rel] }),
    conventions(),
  );
  assert.equal(withTag.length, 1);
  assert.equal(withTag[0]?.kind, 'tag');
  assert.equal(withTag[0]?.releaseName, 'Trail Notes(ios): v1.4.0 Build 312');
  assert.equal(withTag[0]?.releaseAt, T0 + 5 * MIN);
  // The tag was not read (a long tag list): the release's own tag name still fits.
  const noTag = findCandidates(
    ios,
    data({ tags: [], releases: [{ ...rel, targetCommitish: BUMP_IOS }] }),
    conventions(),
  );
  assert.equal(noTag[0]?.sha, BUMP_IOS);
  // A tag name that fits no pattern: the release name is what carries the number.
  const odd = release({
    tagName: 'weird-tag',
    name: 'Trail Notes(ios): v1.4.0 Build 312',
    targetCommitish: BUMP_IOS,
  });
  const byName = findCandidates(ios, data({ tags: [], releases: [odd] }), conventions());
  assert.equal(byName[0]?.kind, 'release');
  assert.equal(byName[0]?.tag, 'weird-tag');
  assert.equal(byName[0]?.sha, BUMP_IOS);
  // A release for the other platform, and a draft, are skipped.
  const other = release({ tagName: 'weird-2', name: 'Trail Notes(android): v1.4.0 Build 312' });
  const draft = release({
    tagName: 'weird-3',
    name: 'Trail Notes(ios): v1.4.0 Build 312',
    draft: true,
  });
  assert.deepEqual(
    findCandidates(ios, data({ tags: [], releases: [other, draft] }), conventions()),
    [],
  );
});

test('a branch name as target is not a commit', () => {
  const odd = release({
    tagName: 'weird-tag',
    name: 'Trail Notes(ios): v1.4.0 Build 312',
    targetCommitish: 'main',
  });
  assert.equal(
    findCandidates(ios, data({ tags: [], releases: [odd] }), conventions())[0]?.sha,
    null,
  );
});

test('why nothing was found, in the order a person would check', () => {
  const c = conventions();
  assert.equal(explainNoCandidate(ios, { tags: [], releases: [] }, c).code, 'no_tags');
  const none = explainNoCandidate(
    ios,
    {
      tags: [
        { name: 'nightly', sha: sha('1') },
        { name: 'latest', sha: sha('2') },
      ],
      releases: [],
    },
    c,
  );
  assert.equal(none.code, 'no_pattern_fit');
  assert.match(none.message, /nightly/);
  const old = explainNoCandidate(
    ios,
    data({
      tags: [
        { name: 'ios/appstore/1.3.0/300', sha: sha('1') },
        { name: 'ios/appstore/1.3.5/305', sha: sha('2') },
      ],
    }),
    c,
  );
  assert.equal(old.code, 'number_not_found');
  assert.deepEqual(old.newestFit, { name: 'ios/appstore/1.3.5/305', buildNumber: '305' });
  assert.match(old.message, /highest for ios is 305/);
  assert.equal(old.fitting, 2);
});

test('a prefix keeps the apps of a monorepo apart', () => {
  const tags = {
    tags: [
      { name: 'scanner-ios/appstore/1.4.0/312', sha: sha('1') },
      { name: 'wallet-ios/appstore/1.4.0/312', sha: sha('2') },
    ],
    releases: [],
  };
  assert.deepEqual(
    findCandidates(ios, tags, conventions({ prefix: 'scanner-' })).map((x) => x.sha),
    [sha('1')],
  );
  assert.deepEqual(
    findCandidates(ios, tags, conventions({ prefix: 'wallet-' })).map((x) => x.sha),
    [sha('2')],
  );
  assert.deepEqual(
    findCandidates(ios, tags, conventions()),
    [],
    'no prefix: neither fits the default patterns',
  );
  // A team that names its pattern itself.
  assert.equal(
    findCandidates(
      ios,
      tags,
      conventions({ tagPatterns: ['wallet-{platform}/{flavor}/{version}/{buildNumber}'] }),
    ).length,
    1,
  );
});

// ---------------------------------------------------------------------------------------------
// Commit -> run

const at = (minutes: number) => T0 + minutes * MIN;

test('the bump commit is a child of the run head and was made during the run: high', () => {
  const found = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' },
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.equal(found.run.id, '1');
  assert.equal(found.confidence, 'high');
  assert.match(found.reason, /parent of the tag's commit/);
  assert.match(found.reason, /while the run ran/);
});

test('the second platform job commits on top of the first: no parent link, the time window decides', () => {
  // android's bump commit has the iOS bump as its parent, not the run head.
  const found = matchCommitToRun({
    commit: { sha: BUMP_ANDROID, parents: [BUMP_IOS], at: at(11), atSource: 'commit' },
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.equal(found.confidence, 'medium');
  assert.match(found.reason, /while the run ran/);
});

test('a parent link alone (the commit time outside the window) is medium', () => {
  const found = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(300), atSource: 'commit' },
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.equal(found.confidence, 'medium');
});

test('a tag on the run head itself (the lane tags what it built) links to that run', () => {
  const found = matchCommitToRun({
    commit: { sha: H, parents: [sha('9')], at: at(-30), atSource: 'commit' },
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.equal(found.run.id, '1');
  assert.match(found.reason, /is the run's commit/);
});

test('the run a push of the bump commit triggers is not taken for the release run', () => {
  const ci = runFacts('2', {
    workflow: 'CI',
    workflowPath: '.github/workflows/ci.yml',
    headSha: BUMP_IOS,
    event: 'push',
    startedAt: at(8) + 3_000,
    updatedAt: at(12),
  });
  const found = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' },
    runs: [ci, runFacts('1')],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.equal(found.run.id, '1', 'the workflow named release wins over CI');
  assert.equal(found.candidates, 1);
  // Without a release-looking name the CI run is only a low-confidence guess, and says so.
  const renamed = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' },
    runs: [runFacts('1', { workflow: 'Build', workflowPath: '.github/workflows/build.yml' })],
    workflow: null,
  });
  assert.ok('run' in renamed);
  assert.equal(renamed.confidence, 'low');
  assert.match(renamed.reason, /not recognised as a release workflow/);
});

test('a configured release workflow decides, by file name, path or name', () => {
  const other = runFacts('2', {
    workflow: 'Nightly',
    workflowPath: '.github/workflows/nightly.yml',
    startedAt: at(1),
    updatedAt: at(20),
  });
  const commit = { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' as const };
  for (const workflow of ['release.yml', '.github/workflows/release.yml', 'Release', 'release']) {
    const found = matchCommitToRun({ commit, runs: [other, runFacts('1')], workflow });
    assert.ok('run' in found, workflow);
    assert.equal(found.run.id, '1', workflow);
  }
  const none = matchCommitToRun({ commit, runs: [other, runFacts('1')], workflow: 'deploy.yml' });
  assert.ok('reason' in none && !('run' in none));
  assert.match(none.reason, /none belongs to the workflow "deploy.yml"/);
});

test('several release runs: the one whose window holds the time wins, medium; when several do, low', () => {
  const older = runFacts('1', { startedAt: at(-300), updatedAt: at(-285) });
  const mine = runFacts('2');
  const commit = { sha: BUMP_IOS, parents: [sha('9')], at: at(8), atSource: 'commit' as const };
  const one = matchCommitToRun({ commit, runs: [older, mine], workflow: null });
  assert.ok('run' in one);
  assert.equal(one.run.id, '2');
  assert.equal(one.confidence, 'medium');
  // Two dispatches ran side by side: nothing tells them apart.
  const twin = runFacts('3', { startedAt: at(2), updatedAt: at(14) });
  const both = matchCommitToRun({ commit, runs: [mine, twin], workflow: null });
  assert.ok('run' in both);
  assert.equal(both.confidence, 'low');
  assert.equal(both.candidates, 2);
  // ... unless the parent tells them apart.
  const related = matchCommitToRun({
    commit: { ...commit, parents: [H] },
    runs: [mine, runFacts('3', { headSha: sha('8'), startedAt: at(2), updatedAt: at(14) })],
    workflow: null,
  });
  assert.ok('run' in related);
  assert.equal(related.run.id, '2');
  assert.equal(related.confidence, 'medium');
});

test('a run that is still going has no end: a commit after its last update still falls inside', () => {
  const going = runFacts('1', {
    status: 'in_progress',
    conclusion: null,
    active: true,
    updatedAt: at(2),
  });
  const found = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [], at: at(40), atSource: 'commit' },
    runs: [going],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.match(found.reason, /to now\)/);
});

test('the window slack is small before the start and a minute after the end', () => {
  const run = runFacts('1', { headSha: sha('5') });
  const at0 = (ms: number) =>
    matchCommitToRun({
      commit: { sha: BUMP_IOS, parents: [], at: ms, atSource: 'commit' },
      runs: [run],
      workflow: null,
    });
  assert.ok('run' in at0(T0 - RUN_WINDOW_SLACK.beforeMs + 1));
  assert.ok(
    'reason' in at0(T0 - RUN_WINDOW_SLACK.beforeMs - 1) &&
      !('run' in at0(T0 - RUN_WINDOW_SLACK.beforeMs - 1)),
  );
  assert.ok('run' in at0(T0 + 15 * MIN + RUN_WINDOW_SLACK.afterMs - 1));
  assert.ok(!('run' in at0(T0 + 15 * MIN + RUN_WINDOW_SLACK.afterMs + 1)));
  // The slack is a parameter.
  const wide = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [], at: T0 - 5 * MIN, atSource: 'commit' },
    runs: [run],
    workflow: null,
    slack: { beforeMs: 10 * MIN, afterMs: 0 },
  });
  assert.ok('run' in wide);
});

test('no run: the reason says what was looked at', () => {
  const none = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' },
    runs: [],
    workflow: null,
  });
  assert.ok(!('run' in none));
  assert.match(none.reason, /No CI run is stored/);
  const elsewhere = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(900), atSource: 'commit' },
    runs: [runFacts('1', { headSha: sha('7') })],
    workflow: null,
  });
  assert.ok(!('run' in elsewhere));
  assert.match(elsewhere.reason, /No stored run has bbbbbbb or its parent/);
  const unknownTime = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [], at: null, atSource: null },
    runs: [runFacts('1', { headSha: sha('7') })],
    workflow: null,
  });
  assert.match((unknownTime as { reason: string }).reason, /commit time is not known/);
  // A pending dispatch and a run without a commit never count.
  const pending = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [H], at: at(8), atSource: 'commit' },
    runs: [runFacts('p', { status: 'pending' }), runFacts('q', { headSha: null })],
    workflow: null,
  });
  assert.ok(!('run' in pending));
});

test('the release time stands in for the commit time when the commit could not be read', () => {
  const found = matchCommitToRun({
    commit: { sha: BUMP_IOS, parents: [], at: at(5), atSource: 'release' },
    runs: [runFacts('1', { headSha: sha('5') })],
    workflow: null,
  });
  assert.ok('run' in found);
  assert.match(found.reason, /the release was made at/);
});

// ---------------------------------------------------------------------------------------------
// The whole chain for one build

const facts = (shaValue: string, parents: string[], atMs: number | null): CommitFacts => ({
  sha: shaValue,
  parents,
  committedAt: atMs,
  message: 'chore: new build',
  author: 'github-actions',
  url: null,
});

test('resolveTagLink: tag, commit, run, with the evidence a person can read', () => {
  const candidates = findCandidates(ios, data(), conventions());
  const link = resolveTagLink({
    candidates,
    factsOf: (s) => (s === BUMP_IOS ? facts(BUMP_IOS, [H], at(8)) : undefined),
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.ok(link?.run);
  assert.equal(link.run.run.id, '1');
  assert.equal(link.evidence.tag, 'ios/appstore/1.4.0/312');
  assert.equal(link.evidence.sha, BUMP_IOS);
  assert.equal(link.evidence.runId, '1');
  assert.equal(link.evidence.confidence, 'high');
  assert.equal(link.evidence.noRunReason, null);
  assert.match(link.evidence.reason, /tag "ios\/appstore\/1.4.0\/312" has the number/);
});

test('resolveTagLink: a tag whose run is not known is still a link ("tag found")', () => {
  const link = resolveTagLink({
    candidates: findCandidates(ios, data(), conventions()),
    factsOf: (s) => (s === BUMP_IOS ? facts(BUMP_IOS, [H], at(8)) : undefined),
    runs: [],
    workflow: null,
  });
  assert.ok(link);
  assert.equal(link.run, null);
  assert.equal(link.evidence.runId, null);
  assert.match(link.evidence.noRunReason ?? '', /No CI run is stored/);
  assert.equal(
    link.evidence.confidence,
    'high',
    'the tag itself is exact: only the run is missing',
  );
  assert.match(link.evidence.reason, /No run found/);
});

test('resolveTagLink: the candidate that leads to a run beats an earlier one that does not; a version difference lowers confidence', () => {
  const two = [
    ...findCandidates(
      ios,
      {
        tags: [
          { name: 'ios/appstore/1.4.0/312', sha: sha('d') },
          { name: 'ios/beta/1.4.0/312', sha: BUMP_IOS },
        ],
        releases: [],
      },
      conventions(),
    ),
  ];
  const link = resolveTagLink({
    candidates: two,
    factsOf: (s) => (s === BUMP_IOS ? facts(BUMP_IOS, [H], at(8)) : facts(s, [sha('e')], at(900))),
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.equal(link?.evidence.tag, 'ios/beta/1.4.0/312');
  const mismatch = resolveTagLink({
    candidates: findCandidates(
      ios,
      { tags: [{ name: 'ios/appstore/1.4.1/312', sha: BUMP_IOS }], releases: [] },
      conventions(),
    ),
    factsOf: () => facts(BUMP_IOS, [H], at(8)),
    runs: [runFacts('1')],
    workflow: null,
  });
  assert.equal(mismatch?.evidence.confidence, 'medium');
  assert.match(mismatch?.evidence.reason ?? '', /version 1\.4\.1 differs/);
  assert.equal(
    resolveTagLink({ candidates: [], factsOf: () => undefined, runs: [], workflow: null }),
    undefined,
  );
});
