import type { Platform, Role } from '@kiln/core';
import type { LastPublish, RunStep } from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
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

const failedStep = (over: Partial<RunStep> = {}): RunStep => ({
  type: 'push_draft',
  status: 'failed',
  startedAt: NOW - 400_000,
  finishedAt: NOW - 390_000,
  error: 'draft_not_allowed',
  httpStatus: 409,
  outcome: 'refused',
  ...over,
});

export const failedRun = (platform: Platform = 'android', over: Partial<LastPublish> = {}): LastPublish => ({
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

export const dismissedRun = (platform: Platform = 'android'): LastPublish => failedRun(platform, { dismissed: true });
export const unknownRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, { outcome: 'partial', results: [failedStep({ error: 'outcome_unknown', outcome: 'unknown' })] });
export const succeededRun = (platform: Platform = 'android'): LastPublish =>
  failedRun(platform, { outcome: 'completed', completed: true, results: [] });

const steps = (statuses: string[]) =>
  ['ci', 'build', 'prepare', 'review', 'release'].map((id, i) => ({ id, status: statuses[i], detail: null }));

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
      ? { state: 'draft', waitingOn: 'you', steps: steps(['done', 'done', 'current', 'todo', 'todo']) }
      : kind === 'in_review'
        ? { state: 'in_review', waitingOn: 'store', steps: steps(['done', 'done', 'done', 'current', 'todo']) }
        : kind === 'running'
          ? { state: 'building', waitingOn: 'ci', steps: steps(['current', 'todo', 'todo', 'todo', 'todo']) }
          : { state: 'rejected', waitingOn: 'you', steps: steps(['done', 'done', 'done', 'failed', 'todo']) };
  return {
    app: { id: rec.id, name: rec.name, platform: rec.platform, store: rec.platform === 'android' ? 'googleplay' : 'appstoreconnect' },
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
