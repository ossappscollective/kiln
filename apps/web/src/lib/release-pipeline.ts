import {
  type Pipeline,
  type PipelineStepRow,
  type PipelineStepStatus,
  type Platform,
  platformLabel,
  type StallStep,
} from '@kiln/core';
import type { AttentionItem } from './app-attention.ts';
import { k, t } from './i18n/t.ts';
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
  if (waitingOn === 'you') return { who: 'you', text: t('release:waiting.you') };
  if (waitingOn === 'store') return { who: 'store', text: t('release:waiting.store') };
  if (waitingOn === 'ci') return { who: 'ci', text: t('release:waiting.ci') };
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

/** Message keys (not text): translate where the strip is built, so a change of language shows. */
export const STRIP_LABEL_KEYS: Readonly<Record<PipelineStepRow['id'], string>> = {
  ci: k('release:strip.ci'),
  build: k('release:strip.build'),
  prepare: k('release:strip.prepare'),
  review: k('release:strip.review'),
  release: k('release:strip.release'),
};
export const stripLabel = (id: PipelineStepRow['id']): string => t(STRIP_LABEL_KEYS[id]);

const STATUS_WORD_KEYS: Readonly<Record<PipelineStepStatus, string>> = {
  done: k('release:strip.word.done'),
  current: k('release:strip.word.current'),
  waiting: k('release:strip.word.waiting'),
  failed: k('release:strip.word.failed'),
  stalled: k('release:strip.word.stalled'),
  todo: k('release:strip.word.todo'),
  unknown: k('release:strip.word.unknown'),
};
/** The word of a step's status ("Done", "Now", "Waiting"). */
export const statusWord = (status: PipelineStepStatus): string => t(STATUS_WORD_KEYS[status]);

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
      label: stripLabel(s.id),
      status: s.status,
      word: statusWord(s.status),
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
  approved: k('release:unfinished.release'),
  rejected: k('release:lead.rejectedAction'),
  draft: k('release:lead.preparingAction'),
  build_ready: k('release:unfinished.createVersion'),
  build_invalid: k('release:unfinished.seeBuild'),
  build_processing: k('release:unfinished.seeBuild'),
  ci_run: k('release:unfinished.checkBuild'),
};

/**
 * What is left, in words: a release that was started and not finished, or, for a build (or a CI run) nobody has taken further, the
 * build. "Release left unfinished" for a build with no version was misleading: there is no release to finish yet.
 */
const HEADINGS: Readonly<Record<StallStep, string>> = {
  approved: k('release:unfinished.heading.default'),
  rejected: k('release:unfinished.heading.default'),
  draft: k('release:unfinished.heading.default'),
  build_ready: k('release:unfinished.heading.buildReady'),
  build_processing: k('release:unfinished.heading.buildProcessing'),
  build_invalid: k('release:unfinished.heading.buildInvalid'),
  ci_run: k('release:unfinished.heading.ciRun'),
};
/** A step this version does not know gets the plain heading, as before. */
export const unfinishedHeading = (step: StallStep): string =>
  t(HEADINGS[step] ?? k('release:unfinished.heading.default'));

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
  const heading = unfinishedHeading(s.step);
  const aged = s.stale ? t('release:unfinished.stale', { text: heading }) : heading;
  return {
    id: `${input.appId}:unfinished`,
    tone: s.stale ? 'info' : 'warn',
    icon: 'clock',
    text: input.several
      ? t('release:unfinished.withPlatform', {
          platform: platformLabel(input.platform),
          text: aged,
        })
      : aged,
    detail: s.message,
    href: releaseStepHref(input.appId, input.scope, stepForStall(s.step), stallVersion(s.evidence)),
    action: t(ACTIONS[s.step] ?? k('release:row.openRelease')),
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
  if (hours < 48) return t('release:stalledFor.hours', { count: Math.max(0, Math.floor(hours)) });
  return t('release:stalledFor.days', { count: Math.floor(hours / 24) });
}
