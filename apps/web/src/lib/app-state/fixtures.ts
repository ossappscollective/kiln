import type { Platform, Role } from '@kiln/core';
import type { LastPublish, RunStep } from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import type { StoreBuildFact } from './candidates.ts';
import type { AppFacts } from './types.ts';

/**
 * Hand-written facts for the tests of the model (and of the screens that wire it). Plain data, no clock: `NOW` is fixed.
 */

export const NOW = 1_700_000_000_000;

export const record = (platform: Platform, over: Partial<AppSummary> = {}): AppSummary => ({
  id: platform === 'android' ? 'android-1' : platform === 'ios' ? 'ios-1' : 'macos-1',
  name: 'Weather',
  platform,
  identifier: 'app.weather',
  storeAppId: platform === 'ios' ? '1234567' : null,
  credentialId: 'cred',
  repositoryId: 'repo-1',
  createdAt: NOW - 1_000_000,
  lastSyncedAt: NOW - 60_000,
  lastSyncAttemptAt: NOW - 60_000,
  lastSyncError: null,
  ...over,
});

export const IOS = record('ios');
export const ANDROID = record('android');

export const running = (over: Partial<Publishing> = {}): Publishing => ({
  startedAt: NOW - 180_000,
  steps: ['push_draft', 'submit'],
  currentStep: 'push_draft',
  stepStartedAt: NOW - 120_000,
  by: { id: 'u1', name: 'Alex' },
  ...over,
});

export const failedStep = (over: Partial<RunStep> = {}): RunStep => ({
  type: 'push_draft',
  status: 'failed',
  startedAt: NOW - 400_000,
  finishedAt: NOW - 390_000,
  error: 'draft_not_allowed',
  httpStatus: 409,
  outcome: 'refused',
  ...over,
});

export const failedRun = (
  platform: Platform = 'android',
  over: Partial<LastPublish> = {},
): LastPublish => ({
  id: `run-${platform}`,
  platform,
  startedAt: NOW - 400_000,
  finishedAt: NOW - 390_000,
  outcome: 'failed',
  completed: false,
  steps: ['push_draft'],
  results: [failedStep()],
  by: { id: 'u1', name: 'Alex' },
  dismissed: false,
  ...over,
});

/**
 * The user's case (an incident of 2026-11-26): the texts and graphics were sent for review (the push applied), then the release was
 * refused because changes were in review. In the store: texts and graphics in review, the release a draft.
 */
export const partlyRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, {
    outcome: 'partial',
    steps: ['push_and_submit', 'release'],
    results: [
      {
        type: 'push_and_submit',
        status: 'applied',
        startedAt: NOW - 400_000,
        finishedAt: NOW - 395_000,
      },
      failedStep({
        type: 'release',
        error: 'changes_in_review',
        httpStatus: 409,
        startedAt: NOW - 395_000,
        store: {
          kind: 'changes_in_review',
          httpStatus: 400,
          details: [
            { code: 'CHANGES_ALREADY_IN_REVIEW', detail: 'You already have changes in review.' },
          ],
        },
      }),
    ],
  });

/**
 * The user's case (an incident of 2026-11-26, OSS Document Scanner on iOS): the draft push applied (3 minutes 16 seconds), then the
 * submit was not run because the store's checks blocked it. The run keeps what blocked it.
 */
export const blockedRun = (
  platform: Platform = 'ios',
  blockers: NonNullable<RunStep['blockers']> = [
    { code: 'no_build', message: 'No build is attached to the App Store version.' },
    { code: 'missing_text', message: 'Description is empty in fr-FR.', locale: 'fr-FR' },
  ],
): LastPublish =>
  failedRun(platform, {
    outcome: 'partial',
    steps: ['push_draft', 'submit'],
    results: [
      {
        type: 'push_draft',
        status: 'applied',
        startedAt: NOW - 600_000,
        finishedAt: NOW - 404_000,
      },
      {
        type: 'submit',
        status: 'skipped',
        reason: 'blocked',
        startedAt: NOW - 404_000,
        finishedAt: NOW - 400_000,
        blockers,
      },
    ],
  });

export const dismissedRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, { dismissed: true });
export const unknownRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, {
    outcome: 'partial',
    results: [failedStep({ error: 'outcome_unknown', outcome: 'unknown' })],
  });
export const succeededRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, { outcome: 'completed', completed: true, results: [] });

const steps = (statuses: string[]) =>
  ['ci', 'build', 'prepare', 'review', 'release'].map((id, i) => ({
    id,
    status: statuses[i],
    detail: null,
  }));

/** A release pipeline of a record: in which state the release is. */
export type FlowKind = 'none' | 'needs_you' | 'in_review' | 'running' | 'rejected';
export function pipelineOf(rec: AppSummary, kind: FlowKind) {
  if (kind === 'none') return null;
  const base = {
    appId: rec.id,
    platform: rec.platform,
    since: NOW - 3_600_000,
    stalledAfterHours: 48,
    stalled: null,
    stalls: [],
    summary: 'summary',
  };
  const version = { version: '3.1.1', build: '168', versionCodes: ['168'] };
  const build = { buildNumber: '168', version: '3.1.1', state: 'processed' };
  const pick =
    kind === 'needs_you'
      ? {
          state: 'draft',
          waitingOn: 'you',
          steps: steps(['done', 'done', 'current', 'todo', 'todo']),
        }
      : kind === 'in_review'
        ? {
            state: 'in_review',
            waitingOn: 'store',
            steps: steps(['done', 'done', 'done', 'current', 'todo']),
          }
        : kind === 'running'
          ? {
              state: 'building',
              waitingOn: 'ci',
              steps: steps(['current', 'todo', 'todo', 'todo', 'todo']),
            }
          : {
              state: 'rejected',
              waitingOn: 'you',
              steps: steps(['done', 'done', 'done', 'failed', 'todo']),
            };
  return {
    app: {
      id: rec.id,
      name: rec.name,
      platform: rec.platform,
      store: rec.platform === 'android' ? 'googleplay' : 'appstoreconnect',
    },
    pipeline: { ...base, ...pick, latest: { run: null, build, version } },
  } as unknown as NonNullable<AppFacts['pipelines'][string]>;
}

/** A Google Play release in internal testing that can be promoted (build 167). */
export const internalTesting = (rec: AppSummary = ANDROID): ReleaseSummary => ({
  id: 'rel-167',
  appId: rec.id,
  platform: rec.platform,
  version: '2.9.0',
  track: 'internal',
  build: '167',
  status: 'live',
  rawState: 'completed',
  rolloutFraction: null,
  versionCodes: ['167'],
  storeUpdatedAt: NOW - 86_400_000,
  syncedAt: NOW - 60_000,
});

export const facts = (over: Partial<AppFacts> = {}): AppFacts => ({
  role: 'owner' as Role,
  records: [IOS, ANDROID],
  pending: {},
  pendingKnown: true,
  publishing: {},
  lastRun: {},
  releases: {},
  pipelines: {},
  attention: [],
  publishBatchEnabled: true,
  now: NOW,
  ...over,
});

/** The facts of the failing scenario the user hit: Android, 29 changes pending, the last publish refused (draft_not_allowed), build 167 promotable. */
export const failingAndroid = (over: Partial<AppFacts> = {}): AppFacts =>
  facts({
    records: [ANDROID],
    pending: { [ANDROID.id]: { count: 29, blocking: 0 } },
    lastRun: { [ANDROID.id]: failedRun('android') },
    releases: { [ANDROID.id]: [internalTesting()] },
    ...over,
  });

// ---------------------------------------------------------------------------------------------
// Candidates (candidates.ts): store versions, TestFlight builds and the scenario of the user's report

/** A store version of the iOS record. */
export const iosRelease = (over: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
  id: `rel-${over.version ?? '1.0.0'}`,
  appId: IOS.id,
  platform: 'ios',
  version: '1.0.0',
  track: null,
  build: null,
  status: 'live',
  rawState: 'READY_FOR_SALE',
  rolloutFraction: null,
  versionCodes: null,
  storeUpdatedAt: NOW - 30 * 86_400_000,
  syncedAt: NOW - 60_000,
  ...over,
});

/** A TestFlight build row (`app_builds`): processed (VALID), not expired, uploaded a day ago. */
export const testflight = (over: Partial<StoreBuildFact> = {}): StoreBuildFact => ({
  buildNumber: '95',
  version: '2.00.1',
  state: 'processed',
  expired: false,
  uploadedAt: NOW - 86_400_000,
  channel: 'testflight',
  tracks: [],
  ...over,
});

/** A pipeline of the iOS record whose newest version is `version` in `state` (the server's answer, as far as the model reads it). */
export function iosPipeline(
  state: 'draft' | 'build_ready' | 'in_review' | 'live' | 'idle',
  version: { version: string; build: string | null; status: string } | null,
  build: { buildNumber: string; version: string } | null,
) {
  return {
    app: { id: IOS.id, name: IOS.name, platform: 'ios', store: 'appstoreconnect' },
    pipeline: {
      appId: IOS.id,
      platform: 'ios',
      state,
      waitingOn:
        state === 'draft' || state === 'build_ready'
          ? 'you'
          : state === 'in_review'
            ? 'store'
            : null,
      since: NOW - 3_600_000,
      stalledAfterHours: 48,
      stalled: null,
      stalls: [],
      summary: 'summary',
      steps: steps(
        state === 'draft'
          ? ['done', 'done', 'current', 'todo', 'todo']
          : state === 'in_review'
            ? ['done', 'done', 'done', 'current', 'todo']
            : ['todo', 'todo', 'todo', 'todo', 'todo'],
      ),
      latest: {
        run: null,
        build:
          build === null
            ? null
            : {
                ...build,
                state: 'processed',
                expired: false,
                uploadedAt: NOW - 86_400_000,
                firstSeenAt: NOW - 86_400_000,
              },
        version:
          version === null
            ? null
            : {
                ...version,
                track: null,
                rawState: version.status,
                versionCodes: null,
                rolloutFraction: null,
                since: NOW - 3_600_000,
              },
      },
    },
  } as unknown as NonNullable<AppFacts['pipelines'][string]>;
}

/**
 * The user's report (2026-11-26, "OSS Document Scanner", iOS): 1.19.0 build 88 is LIVE; 1.11.6 is still in Prepare for Submission (build
 * 92 is there to attach); TestFlight holds 2.00.1 build 95 (VALID). The card must say "Create release 2.00.1 from TestFlight build 95".
 */
export const reportedIos = (over: Partial<AppFacts> = {}): AppFacts =>
  facts({
    records: [IOS],
    pending: { [IOS.id]: { count: 0, blocking: 0 } },
    releases: {
      [IOS.id]: [
        iosRelease({ id: 'rel-1.19.0', version: '1.19.0', build: '88', status: 'live' }),
        iosRelease({
          id: 'rel-1.11.6',
          version: '1.11.6',
          build: null,
          status: 'draft',
          rawState: 'PREPARE_FOR_SUBMISSION',
          storeUpdatedAt: null,
        }),
      ],
    },
    builds: {
      [IOS.id]: [
        testflight(),
        testflight({ buildNumber: '92', version: '1.11.6', uploadedAt: NOW - 200 * 86_400_000 }),
        testflight({ buildNumber: '88', version: '1.19.0', uploadedAt: NOW - 30 * 86_400_000 }),
      ],
    },
    pipelines: {
      [IOS.id]: iosPipeline(
        'draft',
        { version: '1.11.6', build: null, status: 'draft' },
        { buildNumber: '92', version: '1.11.6' },
      ),
    },
    ...over,
  });
