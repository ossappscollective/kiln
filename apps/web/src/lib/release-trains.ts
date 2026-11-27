import {
  type Pipeline,
  type PipelineStepRow,
  type PipelineStepStatus,
  type Platform,
  platformLabel,
} from '@kiln/core';
import { formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type { AppPipeline, StripStep, Waiting } from './release-pipeline.ts';
import {
  statusWord,
  stepForState,
  stripLabel,
  stripVisible,
  waitingOf,
} from './release-pipeline.ts';
import type { StepId } from './release-stepper.ts';

/**
 * Release trains: what the Releases tab shows for a release on its way. One strip per train, never one per record or one per
 * fact. A train is the version of an app (its iOS and macOS records are one train when they ship the same version); a processed
 * build that no version has yet is a step inside the train of the version it can go to ("Build 169 is ready: attach it to 3.1.1"),
 * or its own train when no version is being prepared ("New build 169: create or pick a version"). Each train says in plain words
 * what is waiting for whom and offers one button. Pure; written for the ES2017 web build.
 */

export type TrainInput = {
  appId: string;
  platform: Platform;
  state: Pipeline['state'];
  waitingOn: Pipeline['waitingOn'];
  steps: Pick<PipelineStepRow, 'id' | 'status' | 'detail'>[];
  summary: string;
  /** The version being prepared, in review or rolling out (the store's version record), or null. */
  version: string | null;
  /** The newest build the store has, and whether the version already has it. */
  build: { number: string; version: string | null; processed: boolean; attached: boolean } | null;
};

/** The facts of a pipeline the trains need. Pure. */
export function trainInputOf(data: Pick<AppPipeline, 'app' | 'pipeline'>): TrainInput {
  const { pipeline } = data;
  const version = pipeline.latest.version;
  const build = pipeline.latest.build;
  return {
    appId: data.app.id,
    platform: pipeline.platform,
    state: pipeline.state,
    waitingOn: pipeline.waitingOn,
    steps: pipeline.steps,
    summary: pipeline.summary,
    version: version ? version.version : null,
    build: build
      ? {
          number: build.buildNumber,
          version: build.version,
          processed: build.state === 'processed',
          attached:
            version !== null &&
            ((version.build ?? '') === build.buildNumber ||
              (version.versionCodes ?? []).indexOf(build.buildNumber) >= 0),
        }
      : null,
  };
}

/** `page: 'release'`: the button opens the release page of the version (its state), not a step of Prepare release. */
export type TrainButton = {
  label: string;
  appId: string;
  step: StepId;
  page?: 'release';
  /** "Follow the review": the screen links to the store's own page for the review (lib/store-links.ts) when it can build one. */
  review?: true;
  /** "Create release 2.0.1 from TestFlight build 95" (app-state/candidate-trains.ts): the button opens the create-version step with `version` and `build` filled in. */
  action?: 'create_release';
  /** The build number the button carries (create release). */
  build?: string;
};

export type Train = {
  /** `version:3.1.1`, or `build:<app id>` for a build with no version. */
  key: string;
  version: string | null;
  platforms: Platform[];
  /** The records in the train. */
  appIds: string[];
  /** "Version 3.1.1" or "New build 169". */
  title: string;
  steps: StripStep[];
  waiting: Waiting | null;
  /** What is going on and what is waiting for whom, one or two short sentences. */
  lines: string[];
  /** The one thing to do now. */
  button: TrainButton;
  /** Set when the train comes from a release candidate (a newer build) and not from the release pipeline: what it asks for. */
  candidate?: 'create_release' | 'attach_build' | 'submit' | 'blocked';
};

const RANK: Readonly<Record<PipelineStepStatus, number>> = {
  done: 0,
  unknown: 1,
  todo: 2,
  current: 3,
  waiting: 4,
  stalled: 5,
  failed: 6,
};
const STEP_ORDER: readonly PipelineStepRow['id'][] = [
  'ci',
  'build',
  'prepare',
  'review',
  'release',
];

/** What each of the five steps means, for the hover text and the "About these steps" tip. Message keys: translate where drawn. */
export const STEP_HELP: Readonly<Record<PipelineStepRow['id'], string>> = {
  ci: k('release:strip.help.ci'),
  build: k('release:strip.help.build'),
  prepare: k('release:strip.help.prepare'),
  review: k('release:strip.help.review'),
  release: k('release:strip.help.release'),
};

const WHO_RANK: Readonly<Record<'you' | 'store' | 'ci', number>> = { you: 3, store: 2, ci: 1 };

function mergeSteps(items: readonly TrainInput[]): StripStep[] {
  const merged = STEP_ORDER.map((id) => {
    let status: PipelineStepStatus = 'unknown';
    let rank = -1;
    let detail: string | null = null;
    for (const item of items) {
      const row = item.steps.filter((s) => s.id === id)[0];
      if (!row) continue;
      if (RANK[row.status] > rank) {
        rank = RANK[row.status];
        status = row.status;
        detail = row.detail;
      }
    }
    return { id, label: stripLabel(id), status, word: statusWord(status), detail, current: false };
  });
  const active = merged.findIndex(
    (s) =>
      s.status === 'current' ||
      s.status === 'waiting' ||
      s.status === 'stalled' ||
      s.status === 'failed',
  );
  let mark = active;
  if (mark < 0) {
    let lastDone = -1;
    merged.forEach((s, i) => {
      if (s.status === 'done') lastDone = i;
    });
    mark = lastDone + 1 < merged.length ? lastDone + 1 : -1;
  }
  return merged.map((s, i) => ({ ...s, current: i === mark }));
}

/** "Android", or "iOS and macOS" when the train has several platforms: the platform parameter of the sentences below. */
const names = (items: readonly TrainInput[]): string =>
  formatList(Array.from(new Set(items.map((i) => platformLabel(i.platform)))));

/** The version a build with no version of its own could go to: the only version on its way in the same app, else none. */
function carrierOf(item: TrainInput, versions: readonly string[]): string | null {
  if (item.build?.version && versions.indexOf(item.build.version) >= 0) return item.build.version;
  return versions.length === 1 ? (versions[0] as string) : null;
}

/** Releases on their way as trains. Records whose release is idle, live or unknown are left out (quiet by default). */
export function releaseTrains(all: readonly TrainInput[]): Train[] {
  const items = all.filter((i) => stripVisible({ state: i.state }));
  const withVersion = items.filter((i) => i.version !== null);
  const versions: string[] = [];
  for (const i of withVersion)
    if (versions.indexOf(i.version as string) < 0) versions.push(i.version as string);

  const trains: {
    key: string;
    version: string | null;
    items: TrainInput[];
    spare: TrainInput[];
  }[] = [];
  for (const v of versions)
    trains.push({
      key: `version:${v}`,
      version: v,
      items: withVersion.filter((i) => i.version === v),
      spare: [],
    });

  // A build nobody has yet: a step in a version's train, or a train of its own.
  for (const i of items.filter((x) => x.version === null)) {
    const into = carrierOf(i, versions);
    const target = trains.filter((t) => t.version === into)[0];
    if (into !== null && target) target.spare.push(i);
    else trains.push({ key: `build:${i.appId}`, version: null, items: [i], spare: [] });
  }

  return trains.map((t) => describe(t));
}

function describe(train: {
  key: string;
  version: string | null;
  items: TrainInput[];
  spare: TrainInput[];
}): Train {
  const members = [...train.items, ...train.spare];
  const steps = mergeSteps(members);
  const who =
    members
      .map((m) => m.waitingOn)
      .filter((w): w is 'you' | 'store' | 'ci' => w !== null)
      .sort((a, b) => WHO_RANK[b] - WHO_RANK[a])[0] ?? null;
  const lines: string[] = [];
  let button: TrainButton;
  const first = members[0] as TrainInput;

  if (train.version === null) {
    // Only a build: no version in the store takes it yet.
    const b = first.build;
    const number = b ? b.number : '';
    if (first.state === 'ci_running') {
      lines.push(t('release:train.ciBuilding'));
      button = { label: t('release:lead.openSteps'), appId: first.appId, step: 'build' };
    } else if (first.state === 'ci_failed') {
      lines.push(t('release:train.ciFailed'));
      button = { label: t('release:unfinished.seeBuild'), appId: first.appId, step: 'build' };
    } else if (b && !b.processed) {
      lines.push(t('release:train.buildProcessing', { number }));
      button = { label: t('release:unfinished.seeBuild'), appId: first.appId, step: 'build' };
    } else {
      lines.push(t('release:train.buildReady', { number }));
      button = { label: t('release:train.createOrPick'), appId: first.appId, step: 'build' };
    }
  } else {
    const v = train.version;
    // A processed build the version does not have: from a record with no version, or the newest build of the version's own record
    // while that version can still take it (draft or build ready).
    const unattached = [
      ...train.spare,
      ...train.items.filter((i) => i.state === 'draft' || i.state === 'build_ready'),
    ].filter((s) => s.build?.processed && !s.build.attached);
    const own = train.items.filter(
      (i) => i.state === 'draft' || i.state === 'build_ready' || i.state === 'build_processing',
    );
    const state = train.items.map((i) => i.state)[0] as string;
    const stateOf = (s: string) => train.items.some((i) => i.state === s);
    const platform = names(train.items);
    if (stateOf('rejected')) {
      lines.push(t('release:train.rejected', { version: v, platform }));
      button = {
        label: t('release:lead.rejectedAction'),
        appId: (train.items.filter((i) => i.state === 'rejected')[0] as TrainInput).appId,
        step: 'review',
      };
    } else if (stateOf('approved')) {
      lines.push(t('release:train.approved', { version: v, platform }));
      button = {
        label: t('release:lead.approvedAction'),
        appId: (train.items.filter((i) => i.state === 'approved')[0] as TrainInput).appId,
        step: 'confirm',
      };
    } else if (stateOf('in_review')) {
      lines.push(t('release:train.inReview', { version: v, platform }));
      button = {
        label: t('release:train.followReview'),
        appId: (train.items.filter((i) => i.state === 'in_review')[0] as TrainInput).appId,
        step: 'confirm',
        // Nothing is left to do in Prepare release: the release page shows where the review stands.
        page: 'release',
        review: true,
      };
    } else if (own.length > 0) {
      const mine = own[0] as TrainInput;
      lines.push(t('release:train.preparing', { version: v, platform }));
      button = { label: t('release:lead.preparingAction'), appId: mine.appId, step: 'confirm' };
    } else {
      lines.push(
        t('release:train.onItsWay', { version: v, platform, state: state.replace(/_/g, ' ') }),
      );
      button = {
        label: t('release:lead.openSteps'),
        appId: first.appId,
        step: stepForState(state),
      };
    }
    if (unattached.length > 0) {
      const b = (unattached[0] as TrainInput).build as NonNullable<TrainInput['build']>;
      lines.push(t('release:train.buildReadyAttach', { number: b.number, version: v }));
      // The build is what blocks the version, so it is the one button.
      button = {
        label: t('release:train.attachBuild', { number: b.number }),
        appId: (unattached[0] as TrainInput).appId,
        step: 'build',
      };
    }
  }

  return {
    key: train.key,
    version: train.version,
    platforms: Array.from(new Set(members.map((m) => m.platform))),
    appIds: members.map((m) => m.appId),
    title:
      train.version !== null
        ? t('release:train.title.versionOn', {
            version: train.version,
            platform: names(train.items),
          })
        : first.build
          ? t('release:train.title.build', { number: first.build.number })
          : t('release:train.title.release'),
    steps,
    waiting: waitingOf(who),
    lines,
    button,
  };
}

/**
 * The trains of each platform on its own. An app that ships on iOS, macOS and Android has one release per store, and each one has
 * its own next step, so they are never merged into a single train (a merged one could only point at one of them).
 */
export function releaseTrainsByPlatform(all: readonly TrainInput[]): Train[] {
  const platforms: Platform[] = [];
  for (const i of all) if (platforms.indexOf(i.platform) < 0) platforms.push(i.platform);
  const out: Train[] = [];
  for (const p of platforms)
    for (const t of releaseTrains(all.filter((i) => i.platform === p)))
      out.push({ ...t, key: `${p}:${t.key}` });
  return out;
}
