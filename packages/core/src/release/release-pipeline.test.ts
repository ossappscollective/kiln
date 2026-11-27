import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agoText,
  evaluatePipeline,
  HOUR_MS,
  type PipelineBuildFact,
  type PipelineFacts,
  type PipelineRunFact,
  type PipelineVersionFact,
  STALL_STALE_AFTER_MS,
} from './release-pipeline.ts';

const NOW = Date.UTC(2027, 0, 10, 12, 0, 0);
const ago = (hours: number) => NOW - hours * HOUR_MS;

const run = (id: string, extra: Partial<PipelineRunFact> = {}): PipelineRunFact => ({
  id,
  workflow: 'iOS release',
  runNumber: Number(id),
  status: 'completed',
  conclusion: 'success',
  active: false,
  startedAt: ago(8),
  updatedAt: ago(7),
  url: `https://github.com/acme/app/actions/runs/${id}`,
  ...extra,
});
const build = (n: string, extra: Partial<PipelineBuildFact> = {}): PipelineBuildFact => ({
  buildNumber: n,
  version: '2.4.0',
  state: 'processed',
  rawState: 'VALID',
  expired: false,
  uploadedAt: ago(6),
  firstSeenAt: ago(5),
  runId: null,
  ...extra,
});
const version = (v: string, extra: Partial<PipelineVersionFact> = {}): PipelineVersionFact => ({
  version: v,
  track: null,
  status: 'draft',
  rawState: 'PREPARE_FOR_SUBMISSION',
  build: null,
  versionCodes: null,
  rolloutFraction: null,
  since: ago(30),
  ...extra,
});
const facts = (extra: Partial<PipelineFacts> = {}): PipelineFacts => ({
  appId: 'a1',
  platform: 'ios',
  now: NOW,
  stalledAfterHours: 6,
  lastSyncedAt: ago(1),
  runs: [],
  builds: [],
  versions: [],
  ...extra,
});

test('agoText rounds down to minutes, hours and days', () => {
  assert.equal(agoText(30_000), '0 min');
  assert.equal(agoText(59 * 60_000), '59 min');
  assert.equal(agoText(6 * HOUR_MS + 40 * 60_000), '6 h');
  assert.equal(agoText(47 * HOUR_MS), '47 h');
  assert.equal(agoText(72 * HOUR_MS), '3 days');
  assert.equal(agoText(-5), '0 min');
});

test('the worked example: a build uploaded by run 88, version 2.4.0 still in Prepare, no submission', () => {
  const p = evaluatePipeline(
    facts({
      runs: [run('88', { startedAt: ago(7), updatedAt: ago(6.5) })],
      builds: [build('412', { runId: '88', uploadedAt: ago(6) })],
      versions: [version('2.4.0', { build: '412', status: 'build_chosen', since: ago(6) })],
    }),
  );
  assert.equal(p.state, 'draft');
  assert.equal(p.waitingOn, 'you');
  assert.ok(p.stalled);
  assert.equal(p.stalled.step, 'draft');
  assert.equal(p.stalled.key, 'draft:2.4.0');
  assert.equal(p.stalled.hours, 6);
  assert.equal(p.stalled.stale, false);
  assert.equal(
    p.stalled.message,
    'Build 412 was uploaded 6 h ago by run #88; version 2.4.0 is still in Prepare for submission with its build and has not been submitted for review.',
  );
  assert.deepEqual(
    p.stalled.evidence.map((e) => [e.kind, e.id]),
    [
      ['run', '88'],
      ['build', '412'],
      ['version', '2.4.0'],
    ],
  );
  assert.equal(p.stalled.evidence[0]?.url, 'https://github.com/acme/app/actions/runs/88');
  assert.deepEqual(
    p.steps.map((s) => s.status),
    ['done', 'done', 'stalled', 'todo', 'todo'],
  );
});

test('before the threshold nothing is stalled; 0 turns the signal off but keeps the state', () => {
  const base = {
    runs: [run('88', { updatedAt: ago(5.9) })],
    builds: [build('412', { uploadedAt: ago(5.5) })],
    versions: [version('2.4.0', { build: '412', since: ago(5.5) })],
  };
  const early = evaluatePipeline(facts(base));
  assert.equal(early.stalled, null);
  assert.equal(early.state, 'draft');
  const late = evaluatePipeline(facts({ ...base, now: NOW + HOUR_MS }));
  assert.equal(late.stalled?.step, 'draft');
  const off = evaluatePipeline(facts({ ...base, now: NOW + 100 * HOUR_MS, stalledAfterHours: 0 }));
  assert.equal(off.stalled, null);
  assert.deepEqual(off.stalls, []);
  assert.equal(off.state, 'draft');
});

test('a version in Prepare with nothing built for it is not a forgotten release', () => {
  const p = evaluatePipeline(facts({ versions: [version('2.5.0', { since: ago(100) })] }));
  assert.equal(p.state, 'draft');
  assert.equal(p.stalled, null);
});

test('a new run or build is movement: the clock restarts', () => {
  const versions = [version('2.4.0', { build: '412', since: ago(40) })];
  const builds = [build('412', { uploadedAt: ago(39) })];
  assert.equal(evaluatePipeline(facts({ versions, builds })).stalled?.step, 'draft');
  assert.equal(
    evaluatePipeline(
      facts({
        versions,
        builds,
        runs: [
          run('90', {
            active: true,
            status: 'in_progress',
            conclusion: null,
            startedAt: ago(1),
            updatedAt: ago(0.5),
          }),
        ],
      }),
    ).stalled,
    null,
  );
  assert.equal(
    evaluatePipeline(facts({ versions, builds, runs: [run('90', { updatedAt: ago(2) })] })).stalled,
    null,
  );
});

test('a processed build that no version has is reported with the run that made it', () => {
  const p = evaluatePipeline(
    facts({
      runs: [run('88')],
      builds: [build('412', { runId: '88', uploadedAt: ago(9) })],
      versions: [
        version('2.3.0', {
          status: 'live',
          rawState: 'READY_FOR_SALE',
          build: '410',
          since: ago(200),
        }),
      ],
    }),
  );
  assert.equal(p.state, 'build_ready');
  assert.equal(p.stalled?.step, 'build_ready');
  assert.equal(
    p.stalled?.message,
    'Build 412 (version 2.4.0) was uploaded 9 h ago by run #88; no version has been prepared for it.',
  );
  assert.deepEqual(
    p.stalled?.evidence.map((e) => e.id),
    ['88', '412'],
  );
});

test('older builds and builds of versions that are past Prepare are not left behind', () => {
  const p = evaluatePipeline(
    facts({
      builds: [
        build('411', { uploadedAt: ago(50) }),
        build('412', { uploadedAt: ago(40), version: '2.4.0' }),
        build('413', { uploadedAt: ago(30), version: '2.4.0' }),
      ],
      versions: [
        version('2.4.0', {
          status: 'in_review',
          rawState: 'WAITING_FOR_REVIEW',
          build: '412',
          since: ago(35),
        }),
      ],
    }),
  );
  assert.equal(p.state, 'in_review');
  assert.equal(p.waitingOn, 'store');
  assert.equal(p.stalled, null);
  // 411 is older than the used build 412, 413 belongs to a version that is already in review.
  assert.deepEqual(p.stalls, []);
});

test('a build still processing, and a build that failed processing', () => {
  const processing = evaluatePipeline(
    facts({
      builds: [build('412', { state: 'processing', rawState: 'PROCESSING', uploadedAt: ago(7) })],
    }),
  );
  assert.equal(processing.state, 'build_processing');
  assert.equal(processing.stalled?.step, 'build_processing');
  assert.match(processing.stalled?.message ?? '', /still shows it as processing/);
  const invalid = evaluatePipeline(
    facts({
      builds: [build('412', { state: 'invalid', rawState: 'INVALID', uploadedAt: ago(7) })],
    }),
  );
  assert.equal(invalid.stalled?.step, 'build_invalid');
  assert.match(invalid.stalled?.message ?? '', /failed processing \(INVALID\)/);
  // Expired builds are not considered at all.
  assert.equal(
    evaluatePipeline(facts({ builds: [build('412', { expired: true, uploadedAt: ago(70) })] }))
      .stalled,
    null,
  );
});

test('approved and waiting for release, rejected and not fixed', () => {
  const approved = evaluatePipeline(
    facts({
      versions: [
        version('2.4.0', {
          status: 'approved',
          rawState: 'PENDING_DEVELOPER_RELEASE',
          since: ago(9),
        }),
      ],
    }),
  );
  assert.equal(approved.state, 'approved');
  assert.equal(approved.stalled?.step, 'approved');
  assert.equal(
    approved.stalled?.message,
    'Version 2.4.0 was approved 9 h ago and is waiting for you to release it.',
  );
  assert.deepEqual(
    approved.steps.map((s) => s.status),
    ['done', 'done', 'done', 'done', 'stalled'],
  );
  const rejected = evaluatePipeline(
    facts({
      versions: [version('2.4.0', { status: 'rejected', rawState: 'REJECTED', since: ago(7) })],
    }),
  );
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.stalled?.step, 'rejected');
  assert.equal(rejected.stalled?.label, 'Rejected, not fixed');
});

test('a successful release run with no build after it, only when the store was read after the run', () => {
  const runs = [run('88', { startedAt: ago(8), updatedAt: ago(7) })];
  const p = evaluatePipeline(facts({ runs }));
  assert.equal(p.stalled?.step, 'ci_run');
  assert.equal(
    p.stalled?.message,
    'Run #88 (iOS release) succeeded 7 h ago, but no new build has appeared in the store.',
  );
  // The store was last read before the run ended: we cannot say no build appeared.
  assert.equal(evaluatePipeline(facts({ runs, lastSyncedAt: ago(7.5) })).stalled, null);
  assert.equal(evaluatePipeline(facts({ runs, lastSyncedAt: null })).stalled, null);
  // A build after it (or made by it) explains it.
  assert.equal(
    evaluatePipeline(
      facts({
        runs,
        builds: [build('1', { uploadedAt: ago(7.2), version: '1.0.0' })],
        versions: [
          version('1.0.0', {
            status: 'live',
            build: '1',
            rawState: 'READY_FOR_SALE',
            since: ago(5),
          }),
        ],
      }),
    ).stalled,
    null,
  );
  // A failed run is not a success that nothing followed.
  const failed = evaluatePipeline(
    facts({ runs: [run('89', { conclusion: 'failure', updatedAt: ago(7) })] }),
  );
  assert.equal(failed.state, 'ci_failed');
  assert.equal(failed.stalled, null);
});

test('the most advanced stall is the headline and the others are listed', () => {
  const p = evaluatePipeline(
    facts({
      builds: [
        build('412', { uploadedAt: ago(20), version: '2.5.0' }),
        build('300', { uploadedAt: ago(90), version: '2.3.0' }),
      ],
      versions: [
        version('2.4.0', {
          status: 'approved',
          rawState: 'PENDING_DEVELOPER_RELEASE',
          build: '300',
          since: ago(10),
        }),
      ],
    }),
  );
  assert.deepEqual(
    p.stalls.map((s) => s.step),
    ['approved', 'build_ready'],
  );
  assert.equal(p.stalled?.step, 'approved');
  assert.equal(p.state, 'approved');
});

test('a stall older than two weeks is stale: it loses to a fresh one and is flagged', () => {
  const old = evaluatePipeline(
    facts({
      versions: [
        version('2.4.0', {
          status: 'approved',
          rawState: 'PENDING_DEVELOPER_RELEASE',
          since: NOW - STALL_STALE_AFTER_MS - HOUR_MS,
        }),
      ],
    }),
  );
  assert.equal(old.stalled?.stale, true);
  const mixed = evaluatePipeline(
    facts({
      builds: [build('412', { uploadedAt: ago(9) })],
      versions: [
        version('2.3.0', {
          status: 'approved',
          rawState: 'PENDING_DEVELOPER_RELEASE',
          since: NOW - STALL_STALE_AFTER_MS - HOUR_MS,
        }),
      ],
    }),
  );
  assert.equal(mixed.stalled?.step, 'build_ready');
  assert.equal(mixed.stalls.length, 2);
  assert.equal(mixed.stalls[1]?.stale, true);
});

test('Google Play: a draft release with version codes that was never started', () => {
  const p = evaluatePipeline(
    facts({
      platform: 'android',
      builds: [
        build('241', { version: null, uploadedAt: null, firstSeenAt: ago(9), rawState: 'draft' }),
      ],
      versions: [
        version('2.4.0', {
          track: 'production',
          status: 'draft',
          rawState: 'draft',
          build: '241',
          versionCodes: ['241'],
          since: ago(9),
        }),
        version('2.3.0', {
          track: 'production',
          status: 'live',
          rawState: 'completed',
          build: '230',
          versionCodes: ['230'],
          since: ago(300),
        }),
      ],
    }),
  );
  assert.equal(p.state, 'draft');
  assert.equal(p.stalled?.step, 'draft');
  assert.equal(p.stalled?.key, 'draft:2.4.0@production');
  assert.match(
    p.stalled?.message ?? '',
    /^Build 241 was uploaded 9 h ago; version 2\.4\.0 \(production\) is still a draft release on the production track and has not been started\.$/,
  );
});

test('rolling out, halted and live are states, never stalls', () => {
  const rolling = evaluatePipeline(
    facts({
      versions: [
        version('2.4.0', {
          status: 'rolling_out',
          rawState: 'inProgress',
          rolloutFraction: 0.1,
          since: ago(100),
        }),
      ],
    }),
  );
  assert.equal(rolling.state, 'rolling_out');
  assert.equal(rolling.stalled, null);
  assert.equal(rolling.summary, 'Version 2.4.0 is rolling out to 10% of users.');
  assert.equal(
    evaluatePipeline(
      facts({
        versions: [version('2.4.0', { status: 'halted', rawState: 'halted', since: ago(100) })],
      }),
    ).state,
    'halted',
  );
  const live = evaluatePipeline(
    facts({
      versions: [version('2.4.0', { status: 'live', rawState: 'READY_FOR_SALE', since: ago(100) })],
    }),
  );
  assert.equal(live.state, 'live');
  assert.deepEqual(
    live.steps.map((s) => s.status),
    ['done', 'done', 'done', 'done', 'done'],
  );
});

test('an active run is ci_running; no data at all is unknown, a synced empty app is idle', () => {
  const going = evaluatePipeline(
    facts({
      runs: [
        run('91', {
          active: true,
          status: 'in_progress',
          conclusion: null,
          startedAt: ago(1),
          updatedAt: ago(1),
        }),
      ],
    }),
  );
  assert.equal(going.state, 'ci_running');
  assert.equal(going.waitingOn, 'ci');
  assert.equal(going.stalled, null);
  assert.equal(evaluatePipeline(facts({ lastSyncedAt: null })).state, 'unknown');
  assert.equal(evaluatePipeline(facts()).state, 'idle');
});

// ---------------------------------------------------------------------------------------------
// What is live leaves things behind: the pipeline never talks about them

const phasedWithOldDraft = (extra: Partial<PipelineFacts> = {}): PipelineFacts =>
  facts({
    versions: [
      version('1.19.0', {
        status: 'rolling_out',
        rawState: 'READY_FOR_SALE',
        build: '88',
        rolloutFraction: 0.2,
        since: ago(20),
      }),
      // The old draft was touched LATER than the live release: the old order (status priority, then time) made it the release.
      version('1.11.6', { status: 'draft', build: '92', since: ago(10) }),
    ],
    builds: [
      build('88', { version: '1.19.0', uploadedAt: ago(200), firstSeenAt: ago(200) }),
      build('92', { version: '1.11.6', uploadedAt: ago(40), firstSeenAt: ago(40) }),
      build('95', { version: '2.00.1', uploadedAt: ago(30), firstSeenAt: ago(30) }),
    ],
    ...extra,
  });

test('an obsolete draft (1.11.6 under a live 1.19.0) is not the release, the state or a stall', () => {
  const p = evaluatePipeline(phasedWithOldDraft());
  assert.equal(p.latest.version?.version, '1.19.0');
  assert.equal(
    p.state,
    'build_ready',
    'the TestFlight 2.00.1 build 95 is the news, not the old draft',
  );
  assert.equal(p.latest.build?.buildNumber, '95');
  assert.equal(
    p.stalls.some((s) => s.evidence.some((e) => e.kind === 'version' && e.id === '1.11.6')),
    false,
  );
});

test('a build that is not newer than the live release is never the latest build or an orphan', () => {
  const p = evaluatePipeline(
    phasedWithOldDraft({
      builds: [
        build('88', { version: '1.19.0', uploadedAt: ago(200), firstSeenAt: ago(200) }),
        // A hotfix of the 1.18 branch uploaded after 1.19.0.
        build('120', { version: '1.18.1', uploadedAt: ago(30), firstSeenAt: ago(30) }),
      ],
    }),
  );
  assert.equal(p.latest.build?.buildNumber, '88');
  assert.equal(p.state, 'rolling_out');
  assert.equal(p.stalls.length, 0);
});

test('the newest version wins by version, not by the time it was first seen', () => {
  const p = evaluatePipeline(
    facts({
      versions: [
        version('2.5.0', { status: 'draft', since: ago(50) }),
        version('2.4.0', { status: 'draft', since: ago(2) }),
      ],
    }),
  );
  assert.equal(p.latest.version?.version, '2.5.0');
});

test('Google Play: only the production track is live; a lower draft is left behind', () => {
  const play = (extra: Partial<PipelineFacts> = {}) => facts({ platform: 'android', ...extra });
  const p = evaluatePipeline(
    play({
      versions: [
        version('5.0.0', {
          track: 'production',
          status: 'live',
          rawState: 'completed',
          build: '500',
          versionCodes: ['500'],
          since: ago(90),
        }),
        version('5.1.0', {
          track: 'internal',
          status: 'live',
          rawState: 'completed',
          build: '510',
          versionCodes: ['510'],
          since: ago(10),
        }),
        version('4.9.0', {
          track: 'internal',
          status: 'draft',
          rawState: 'draft',
          build: '480',
          versionCodes: ['480'],
          since: ago(10),
        }),
      ],
    }),
  );
  assert.equal(p.state, 'live');
  assert.equal(p.latest.version?.version, '5.0.0');
});
