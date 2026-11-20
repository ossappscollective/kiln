import {
  type Pipeline,
  type PipelineStepRow,
  type PipelineStepStatus,
  type Platform,
  platformLabel,
  type StallStep,
} from '@mrm/core';
import type { AttentionItem } from './app-attention.ts';
import type { PlatformScope } from './app-scope.ts';
import { releaseStepHref, type StepId } from './release-stepper.ts';

/**
 * Where the release of an app stands between "a CI run succeeded" and "it is live", and whether it was left unfinished
 * (docs/api/release-pipeline.md). The server judges; this file words it for the screens: the five-step strip, "waiting for you"
 * or "waiting on the store", the "Release left unfinished" attention item with its evidence sentence, and the step of the
 * stepper each stall leads to. Pure. Written for the ES2017 web build.
 */

// ---------------------------------------------------------------------------------------------
// API shapes

export type StallEvidence = { kind: 'run' | 'build' | 'version'; id: string; at: number | null };

export type SummaryStall = {
  step: StallStep;
  label: string;
  message: string;
  hours: number;
  since: number;
  stale: boolean;
  evidence: StallEvidence[];
};

export type PipelineSummaryApp = {
  app: { id: string; name: string; platform: Platform; store: string };
  state: string;
  waitingOn: 'ci' | 'store' | 'you' | null;
  since: number | null;
  summary: string;
  lastSyncedAt: number | null;
  stalled: SummaryStall | null;
};

export type PipelineSummary = {
  stalledAfterHours: number;
  apps: PipelineSummaryApp[];
  totals: { apps: number; stalled: number; byState: Record<string, number> };
  generatedAt: number;
};

export type AppPipeline = {
  app: { id: string; name: string; platform: Platform; store: string };
  pipeline: Pipeline;
  lastSyncedAt: number | null;
  generatedAt: number;
};

// ---------------------------------------------------------------------------------------------
// Who has to act

export type Waiting = { who: 'you' | 'store' | 'ci'; text: string };

/** "Waiting for you" (a person has to act) or "Waiting on the store" (review, processing) or "Waiting on CI"; null when nobody is. */
export function waitingOf(waitingOn: 'ci' | 'store' | 'you' | null): Waiting | null {
  if (waitingOn === 'you') return { who: 'you', text: 'Waiting for you' };
  if (waitingOn === 'store') return { who: 'store', text: 'Waiting on the store' };
  if (waitingOn === 'ci') return { who: 'ci', text: 'Waiting on CI' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// The step of the stepper a state or a stall leads to

/** Where a person goes to deal with a stall. */
export function stepForStall(step: StallStep): StepId {
  switch (step) {
    case 'approved':
    case 'draft':
      return 'confirm';
    case 'rejected':
      return 'review';
    default:
      // ci_run, build_ready, build_invalid, build_processing: the build is what is missing or wrong.
      return 'build';
  }
}

/** Where a person goes for a state of the pipeline (the strip's link). */
export function stepForState(state: string): StepId {
  switch (state) {
    case 'draft':
    case 'approved':
    case 'in_review':
    case 'rolling_out':
    case 'halted':
      return 'confirm';
    case 'rejected':
      return 'review';
    default:
      return 'build';
  }
}

/** The version a stall is about, from its evidence (`2.4.0` or `2.4.0@production`); null for a stall about a build or a run. */
export function stallVersion(evidence: readonly StallEvidence[]): string | null {
  const hit = evidence.filter((e) => e.kind === 'version')[0];
  if (!hit) return null;
  const at = hit.id.indexOf('@');
  return at < 0 ? hit.id : hit.id.slice(0, at);
}

// ---------------------------------------------------------------------------------------------
// The strip

export const STRIP_LABELS: Readonly<Record<PipelineStepRow['id'], string>> = {
  ci: 'CI',
  build: 'Build',
  prepare: 'Prepare',
  review: 'Review',
  release: 'Release',
};

const STATUS_WORDS: Readonly<Record<PipelineStepStatus, string>> = {
  done: 'Done',
  current: 'Now',
  waiting: 'Waiting',
  failed: 'Failed',
  stalled: 'Stalled',
  todo: 'Not yet',
  unknown: 'Not known',
};

export type StripStep = {
  id: PipelineStepRow['id'];
  label: string;
  status: PipelineStepStatus;
  word: string;
  detail: string | null;
  current: boolean;
};

export type StripModel = {
  steps: StripStep[];
  waiting: Waiting | null;
  /** One sentence about the state. */
  summary: string;
  /** The step of the stepper the strip links to. */
  step: StepId;
};

const ACTIVE: readonly PipelineStepStatus[] = ['current', 'waiting', 'stalled', 'failed'];

/** The five steps of the strip, the one that matters now marked, and who is expected to act. */
export function stripModel(
  pipeline: Pick<Pipeline, 'steps' | 'waitingOn' | 'summary' | 'state'>,
): StripModel {
  let mark = pipeline.steps.findIndex((s) => ACTIVE.indexOf(s.status) >= 0);
  if (mark < 0) {
    // Nothing is active: the first step after the last one that is done.
    let lastDone = -1;
    pipeline.steps.forEach((s, i) => {
      if (s.status === 'done') lastDone = i;
    });
    mark = lastDone + 1 < pipeline.steps.length ? lastDone + 1 : -1;
  }
  return {
    steps: pipeline.steps.map((s, i) => ({
      id: s.id,
      label: STRIP_LABELS[s.id],
      status: s.status,
      word: STATUS_WORDS[s.status],
      detail: s.detail,
      current: i === mark,
    })),
    waiting: waitingOf(pipeline.waitingOn),
    summary: pipeline.summary,
    step: stepForState(pipeline.state),
  };
}

/** States in which a release is on its way: the strip is drawn. Idle, unknown and live draw nothing (quiet by default). */
const QUIET_STATES = ['idle', 'unknown', 'live'];
export const stripVisible = (pipeline: Pick<Pipeline, 'state'>): boolean =>
  QUIET_STATES.indexOf(pipeline.state) < 0;

// ---------------------------------------------------------------------------------------------
// "Release left unfinished"

const ACTIONS: Readonly<Record<StallStep, string>> = {
  approved: 'Release it',
  rejected: 'See what to fix',
  draft: 'Finish the release',
  build_ready: 'Create a version',
  build_invalid: 'See the build',
  build_processing: 'See the build',
  ci_run: 'Check for the build',
};

/**
 * What is left, in words: a release that was started and not finished, or, for a build (or a CI run) nobody has taken further, the
 * build. "Release left unfinished" for a build with no version was misleading: there is no release to finish yet.
 */
const HEADINGS: Readonly<Partial<Record<StallStep, string>>> = {
  build_ready: 'A new build has no version yet',
  build_processing: 'A build is still processing',
  build_invalid: 'A build failed processing',
  ci_run: 'A CI run produced no build',
};
export const unfinishedHeading = (step: StallStep): string =>
  HEADINGS[step] ?? 'Release left unfinished';

export type UnfinishedInput = {
  appId: string;
  platform: Platform;
  scope: PlatformScope | null;
  /** Several platforms are shown: name the platform in the line. */
  several: boolean;
  stalled: SummaryStall | null;
};

/**
 * The attention item for a stalled release: "Release left unfinished", the server's evidence sentence, and a link to the
 * step of the stepper where it is finished. Null when nothing is stalled. A stall older than 14 days is still shown, quieter.
 */
export function unfinishedItem(input: UnfinishedInput): AttentionItem | null {
  const s = input.stalled;
  if (s === null) return null;
  const who = input.several ? `${platformLabel(input.platform)}: ` : '';
  return {
    id: `${input.appId}:unfinished`,
    tone: s.stale ? 'info' : 'warn',
    icon: 'clock',
    text: `${who}${unfinishedHeading(s.step)}${s.stale ? ' (more than 14 days ago)' : ''}`,
    detail: s.message,
    href: releaseStepHref(input.appId, input.scope, stepForStall(s.step), stallVersion(s.evidence)),
    action: ACTIONS[s.step] ?? 'Open the release',
  };
}

/** Apps whose release is left unfinished and not stale: the count of the badges. */
export const stalledApps = (summary: Pick<PipelineSummary, 'apps'> | null): PipelineSummaryApp[] =>
  summary === null ? [] : summary.apps.filter((a) => a.stalled !== null && !a.stalled.stale);

/** The summary line of each app by its id. */
export function summaryByApp(
  summary: Pick<PipelineSummary, 'apps'> | null,
): Record<string, PipelineSummaryApp | undefined> {
  const out: Record<string, PipelineSummaryApp | undefined> = {};
  if (summary !== null) for (const a of summary.apps) out[a.app.id] = a;
  return out;
}

/** "Waiting 10 h" / "waiting 2 days" for a stall, from its hours. */
export function stalledFor(hours: number): string {
  if (hours < 48) return `${Math.max(0, Math.floor(hours))} h`;
  return `${Math.floor(hours / 24)} days`;
}
