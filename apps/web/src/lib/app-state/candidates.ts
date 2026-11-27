import {
  type CandidateChannel,
  type CandidateReason,
  type CandidateAnalysis as CoreAnalysis,
  type CandidateInput as CoreInput,
  type CandidatePlan as CorePlan,
  analyzeCandidates as coreAnalyzeCandidates,
  type LiveRef,
  type ObsoleteVersion,
  type Platform,
  pipelineIsObsolete,
  type ReleaseCandidate,
  type StoreBuildFact,
  stallLeftBehind,
  supports,
} from '@kiln/core';
import { type PromoteOption, promoteOptionOf } from '../play-promote.ts';
import type { AppPipeline, PipelineSummaryApp } from '../release-pipeline.ts';
import type { ReleaseSummary } from '../types.ts';

/**
 * The release candidate: the ONE answer to "which build could be released next, and which versions are left over" (docs/state-model.md,
 * "Candidates and obsolete versions"). The rules live in @kiln/core (`analyzeCandidates`, shared with the server: one comparator, one
 * serving set, one promotion rule, the create-release refusals of `createReleaseRules`); this file only types them for the web's
 * `ReleaseSummary` and puts words on the Google Play promotion. No screen compares versions.
 *
 * Written for the ES2017 web build (no flatMap, no fromEntries).
 */

export type {
  CandidateChannel,
  CandidateReason,
  LiveRef,
  ObsoleteVersion,
  ReleaseCandidate,
  StoreBuildFact,
};
export { pipelineIsObsolete, stallLeftBehind };

/** What the next step of a record is, from the candidate (iOS and macOS); `blocked`: the store would refuse to create the version. */
export type CandidatePlan = CorePlan<ReleaseSummary>;

export type CandidateAnalysis = Omit<CoreAnalysis<ReleaseSummary>, 'promote'> & {
  /** Google Play: the releases in a testing track that can go to production (newer than production), newest codes first, with their words. */
  promote: PromoteOption[];
};

export type CandidateInput = {
  appId: string;
  platform: Platform;
  /** The releases of THIS record (store versions with their state). */
  releases: readonly ReleaseSummary[];
  /** The store builds of this record. */
  builds: readonly StoreBuildFact[];
};

/** The candidates of one record and the step they ask for (the core's analysis, with the promotion worded). */
export function analyzeCandidates(input: CandidateInput): CandidateAnalysis {
  const core: CoreInput<ReleaseSummary> = {
    appId: input.appId,
    platform: input.platform,
    releases: input.releases,
    builds: input.builds,
  };
  const analysis = coreAnalyzeCandidates(core);
  return { ...analysis, promote: analysis.promote.map(promoteOptionOf) };
}

// ---------------------------------------------------------------------------------------------
// From the other facts the model has to the inputs above

type PipelineFact = Pick<AppPipeline, 'app' | 'pipeline'>;

const STATE_STATUS: Readonly<Record<string, ReleaseSummary['status']>> = {
  draft: 'draft',
  in_review: 'in_review',
  rejected: 'rejected',
  approved: 'approved',
  rolling_out: 'rolling_out',
  halted: 'halted',
  live: 'live',
};

/**
 * The store versions of a record: the releases the page loaded, plus the version the release pipeline names when the page did not load
 * it (a screen that never loaded releases still knows what is live or in preparation, from the same sync).
 */
export function releasesWithPipeline(
  appId: string,
  platform: Platform,
  releases: readonly ReleaseSummary[] | undefined,
  pipeline: PipelineFact | null | undefined,
): ReleaseSummary[] {
  const list = (releases ?? []).slice();
  const v = pipeline?.pipeline.latest.version ?? null;
  if (pipeline == null || v === null || v === undefined) return list;
  const track = v.track ?? null;
  if (list.some((r) => r.version === v.version && (r.track ?? null) === track)) return list;
  const status = v.status ?? STATE_STATUS[pipeline.pipeline.state] ?? null;
  list.push({
    id: `pipeline:${v.version}${track === null ? '' : `@${track}`}`,
    appId,
    platform,
    version: v.version,
    track,
    build: v.build ?? null,
    status,
    rawState: v.rawState ?? '',
    rolloutFraction: v.rolloutFraction ?? null,
    versionCodes: v.versionCodes ?? null,
    storeUpdatedAt: null,
    statusSince: v.since ?? null,
    syncedAt: pipeline.pipeline.since ?? 0,
  });
  return list;
}

/** The store builds of a record: the ones the loader read, else the newest build of the release pipeline (the only one it knows). */
export function buildsWithPipeline(
  platform: Platform,
  builds: readonly StoreBuildFact[] | null | undefined,
  pipeline: PipelineFact | null | undefined,
): StoreBuildFact[] {
  if (builds !== null && builds !== undefined) return builds.slice();
  const b = pipeline?.pipeline.latest.build ?? null;
  if (pipeline == null || b === null || b === undefined) return [];
  return [
    {
      buildNumber: b.buildNumber,
      version: b.version ?? null,
      state: b.state,
      expired: b.expired ?? null,
      uploadedAt: b.uploadedAt ?? b.firstSeenAt ?? null,
      channel: supports(platform, 'releaseTracks') ? 'play' : 'testflight',
      tracks: [],
    },
  ];
}

/**
 * The apps of the workspace pipeline summary that are left unfinished: a stall about a version or a build that is left behind (not
 * newer than what is live) is not news, so it comes back with `stalled` null (`stallLeftBehind` of @kiln/core, from the candidates). The
 * ONE body of "unfinished": the rune store's `unfinished(workspaceId)` and the consistency harness both call it.
 */
export function unfinishedApps(input: {
  apps: readonly PipelineSummaryApp[];
  releases: Readonly<Record<string, readonly ReleaseSummary[] | undefined>>;
  pipelineOf: (appId: string) => PipelineFact | null | undefined;
  buildsOf: (appId: string) => readonly StoreBuildFact[] | null | undefined;
}): PipelineSummaryApp[] {
  return input.apps.map((a) => {
    if (a.stalled === null) return a;
    const id = a.app.id;
    const p = input.pipelineOf(id);
    const analysis = analyzeCandidates({
      appId: id,
      platform: a.app.platform,
      releases: releasesWithPipeline(id, a.app.platform, input.releases[id], p),
      builds: buildsWithPipeline(a.app.platform, input.buildsOf(id), p),
    });
    return stallLeftBehind(a.stalled, analysis) ? { ...a, stalled: null } : a;
  });
}

/** The same pipeline with nothing in preparation: the release flow of a record whose only draft is obsolete is quiet. */
export function quietPipeline(pipeline: PipelineFact): PipelineFact {
  const p = pipeline.pipeline;
  return {
    app: pipeline.app,
    pipeline: {
      ...p,
      state: 'idle',
      waitingOn: null,
      since: null,
      stalled: null,
      stalls: [],
      summary: '',
      steps: p.steps.map((s) => ({ ...s, status: 'todo' as const, at: null, detail: null })),
      latest: { ...p.latest, version: null },
    },
  };
}

/** The states in which the pipeline's train is replaced by the candidate's step (a version in Prepare, a build nobody took): one step, not two. */
export const SUPERSEDED_STATES: readonly string[] = ['draft', 'build_ready'];
