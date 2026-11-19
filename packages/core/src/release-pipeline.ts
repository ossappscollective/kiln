import type { ReleaseState } from './lifecycle.ts';
import type { Platform } from './platform.ts';

/**
 * The release pipeline of one app and platform, from facts only (no I/O): where a release is between "a CI run succeeded" and
 * "it is live", and whether it is STALLED (a run succeeded or a build appeared and nothing moved to the next step for a while).
 * The server collects the facts from its own tables (stored runs, the builds and releases of the last store sync) and the web
 * app shows the answer. Docs: docs/api/release-pipeline.md.
 *
 * ES2017 only (the web app imports this package): no flatMap, fromEntries or other newer library calls.
 */

export const HOUR_MS = 60 * 60 * 1000;
/** Workspace setting `release.stalledAfterHours`: default, and the largest value (30 days). 0 turns the signal off. */
export const DEFAULT_STALLED_AFTER_HOURS = 6;
export const MAX_STALLED_AFTER_HOURS = 720;
/** A stall older than this is shown as `stale` and is never reminded: it is an abandoned release, not news. */
export const STALL_STALE_AFTER_MS = 14 * 24 * HOUR_MS;
/** A build uploaded this long before a run started still counts as that run's build (clocks differ). */
const RUN_BUILD_SLACK_MS = 5 * 60_000;

/** The steps a release can stall at, most advanced first. */
export const STALL_STEPS = [
  'approved',
  'rejected',
  'draft',
  'build_ready',
  'build_invalid',
  'build_processing',
  'ci_run',
] as const;
export type StallStep = (typeof STALL_STEPS)[number];

export type PipelineState =
  | 'unknown'
  | 'idle'
  | 'ci_running'
  | 'ci_failed'
  | 'build_processing'
  | 'build_ready'
  | 'draft'
  | 'in_review'
  | 'rejected'
  | 'approved'
  | 'rolling_out'
  | 'halted'
  | 'live';

export type PipelineRunFact = {
  /** GitHub's run id. */
  id: string;
  workflow: string;
  runNumber: number | null;
  status: string;
  conclusion: string | null;
  active: boolean;
  startedAt: number;
  updatedAt: number;
  url: string | null;
};

export type PipelineBuildFact = {
  buildNumber: string;
  /** The marketing version (App Store Connect); null on Android and when unknown. */
  version: string | null;
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  rawState: string | null;
  expired: boolean | null;
  /** The store's upload time; null when the store does not say (Android). */
  uploadedAt: number | null;
  /** When this server first saw the build. */
  firstSeenAt: number;
  /** The CI run that made it (a build link), when one is known. */
  runId: string | null;
};

export type PipelineVersionFact = {
  version: string;
  /** The Play track; null on Apple. */
  track: string | null;
  status: ReleaseState | null;
  rawState: string;
  /** The build number attached (Apple) or the version codes, comma separated (Android). */
  build: string | null;
  versionCodes: string[] | null;
  rolloutFraction: number | null;
  /** When this server first saw the version in this state (or with this build). */
  since: number;
};

export type PipelineFacts = {
  appId: string;
  platform: Platform;
  now: number;
  /** 0 turns stall detection off (the state is still computed). */
  stalledAfterHours: number;
  /** When the store was last read for this app; null when never. */
  lastSyncedAt: number | null;
  /** Runs that count for this app and look like a release run (the server decides which). Newest first or any order. */
  runs: readonly PipelineRunFact[];
  builds: readonly PipelineBuildFact[];
  versions: readonly PipelineVersionFact[];
};

export type PipelineEvidence = {
  kind: 'run' | 'build' | 'version';
  /** The run id, the build number, or `version` / `version@track`. */
  id: string;
  /** Epoch milliseconds the evidence is about (finish, upload, state change), or null. */
  at: number | null;
  label: string;
  url?: string | null;
};

export type PipelineStall = {
  step: StallStep;
  /** The thing that is stuck, so a new one is a new episode: `step:anchor`. */
  key: string;
  /** What is stuck: a run id, a build number, or a version. */
  anchor: string;
  /** When the last thing moved (the stall began after this). */
  since: number;
  hours: number;
  /** Older than STALL_STALE_AFTER_MS: shown, never reminded. */
  stale: boolean;
  /** A sentence for a person, with the evidence in words. */
  message: string;
  /** A few words for a chip. */
  label: string;
  evidence: PipelineEvidence[];
};

export type PipelineStepStatus =
  | 'done'
  | 'current'
  | 'waiting'
  | 'failed'
  | 'stalled'
  | 'todo'
  | 'unknown';
export type PipelineStepRow = {
  id: 'ci' | 'build' | 'prepare' | 'review' | 'release';
  status: PipelineStepStatus;
  at: number | null;
  detail: string | null;
};

export type Pipeline = {
  appId: string;
  platform: Platform;
  state: PipelineState;
  /** Who has to act next: the CI, the store, a person (you), or nobody. */
  waitingOn: 'ci' | 'store' | 'you' | null;
  /** When the thing the state is about last moved; null when unknown. */
  since: number | null;
  stalledAfterHours: number;
  /** The most advanced stall that is not stale (else the most advanced stale one); null when nothing is stalled or detection is off. */
  stalled: PipelineStall | null;
  stalls: PipelineStall[];
  steps: PipelineStepRow[];
  /** A sentence about the state (not only about a stall), for a card. */
  summary: string;
  latest: {
    run: PipelineRunFact | null;
    build: PipelineBuildFact | null;
    version: PipelineVersionFact | null;
  };
};

// ---------------------------------------------------------------------------------------------
// Words

/** "5 min", "6 h", "2 days": for a sentence, rounded down, never negative. */
export function agoText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

const DRAFT_WORDS: Record<string, string> = {
  draft: 'Prepare for submission',
  build_chosen: 'Prepare for submission with its build',
  ready: 'Ready for review',
};

const runName = (r: PipelineRunFact) =>
  r.runNumber !== null ? `run #${r.runNumber}` : `run ${r.id}`;
const buildName = (b: PipelineBuildFact) => `build ${b.buildNumber}`;
const versionName = (v: PipelineVersionFact) =>
  v.track ? `version ${v.version} (${v.track})` : `version ${v.version}`;
const buildAt = (b: PipelineBuildFact) => b.uploadedAt ?? b.firstSeenAt;

const runEvidence = (r: PipelineRunFact): PipelineEvidence => ({
  kind: 'run',
  id: r.id,
  at: r.updatedAt,
  label: `${r.workflow} ${runName(r)} ${r.conclusion ?? r.status}`,
  url: r.url,
});
const buildEvidence = (b: PipelineBuildFact): PipelineEvidence => ({
  kind: 'build',
  id: b.buildNumber,
  at: buildAt(b),
  label: `${buildName(b)}${b.version ? ` (${b.version})` : ''}${b.rawState ? `, ${b.rawState}` : ''}`,
});
const versionEvidence = (v: PipelineVersionFact): PipelineEvidence => ({
  kind: 'version',
  id: v.track ? `${v.version}@${v.track}` : v.version,
  at: v.since,
  label: `${versionName(v)} ${v.rawState}`,
});

// ---------------------------------------------------------------------------------------------
// Evaluation

const IN_FLIGHT: readonly ReleaseState[] = [
  'draft',
  'build_chosen',
  'ready',
  'in_review',
  'rejected',
  'approved',
  'propagating',
];
const DRAFT_FAMILY: readonly ReleaseState[] = ['draft', 'build_chosen', 'ready'];
const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

const newest = <T>(list: readonly T[], at: (item: T) => number): T | null => {
  let best: T | null = null;
  for (const item of list) if (best === null || at(item) > at(best)) best = item;
  return best;
};

export function evaluatePipeline(f: PipelineFacts): Pipeline {
  const now = f.now;
  const afterMs = Math.max(0, Math.trunc(f.stalledAfterHours)) * HOUR_MS;
  const off = afterMs === 0;
  const age = (at: number) => Math.max(0, now - at);
  const stalledFor = (at: number) => !off && age(at) >= afterMs;

  const runs = f.runs;
  const activeRun = newest(
    runs.filter((r) => r.active),
    (r) => r.startedAt,
  );
  const lastRun = newest(runs, (r) => r.startedAt);
  const lastSuccess = newest(
    runs.filter((r) => !r.active && r.conclusion === 'success'),
    (r) => r.updatedAt,
  );

  const inFlight = f.versions.filter(
    (v) => v.status !== null && IN_FLIGHT.indexOf(v.status) !== -1,
  );
  const usedBuilds = new Set<string>();
  for (const v of f.versions) {
    if (v.build) {
      if (v.track === null) usedBuilds.add(v.build);
      else for (const code of v.versionCodes ?? []) usedBuilds.add(code);
    }
  }
  const builds = f.builds.filter((b) => b.expired !== true);
  let newestUsedAt = 0;
  for (const b of builds)
    if (usedBuilds.has(b.buildNumber)) newestUsedAt = Math.max(newestUsedAt, buildAt(b));
  const unused = builds.filter((b) => !usedBuilds.has(b.buildNumber) && buildAt(b) > newestUsedAt);
  // A newer build of a version string that is already past "Prepare" cannot be attached to it: it is not a release left behind.
  const pastPrepare = new Set<string>();
  for (const v of f.versions) {
    if (v.status !== null && DRAFT_FAMILY.indexOf(v.status) === -1) pastPrepare.add(v.version);
  }
  const hasDraftFor = (version: string | null) =>
    version !== null &&
    f.versions.some(
      (v) => v.version === version && v.status !== null && DRAFT_FAMILY.indexOf(v.status) !== -1,
    );
  const orphans = unused.filter(
    (b) => !(b.version !== null && pastPrepare.has(b.version)) && !hasDraftFor(b.version),
  );
  const runOf = (b: PipelineBuildFact) =>
    b.runId ? (runs.find((r) => r.id === b.runId) ?? null) : null;
  const buildByRun = (b: PipelineBuildFact): string => {
    const r = runOf(b);
    return r ? ` by ${runName(r)}` : '';
  };

  // ----- stalls -------------------------------------------------------------------------------
  const stalls: PipelineStall[] = [];
  const add = (
    step: StallStep,
    anchor: string,
    since: number,
    message: string,
    label: string,
    evidence: PipelineEvidence[],
  ) => {
    stalls.push({
      step,
      key: `${step}:${anchor}`,
      anchor,
      since,
      hours: Math.floor(age(since) / HOUR_MS),
      stale: age(since) > STALL_STALE_AFTER_MS,
      message,
      label,
      evidence,
    });
  };

  if (!off) {
    for (const v of inFlight) {
      if (v.status === 'approved' && stalledFor(v.since)) {
        add(
          'approved',
          `${v.version}${v.track ? `@${v.track}` : ''}`,
          v.since,
          `${capital(versionName(v))} was approved ${agoText(age(v.since))} ago and is waiting for you to release it.`,
          'Approved, not released',
          [versionEvidence(v)],
        );
      } else if (v.status === 'rejected' && stalledFor(v.since)) {
        add(
          'rejected',
          `${v.version}${v.track ? `@${v.track}` : ''}`,
          v.since,
          `${capital(versionName(v))} was rejected ${agoText(age(v.since))} ago and nothing has changed since.`,
          'Rejected, not fixed',
          [versionEvidence(v)],
        );
      } else if (v.status !== null && DRAFT_FAMILY.indexOf(v.status) !== -1) {
        // "Something was built for it": a build of this version (or the attached one), or the codes of a Play draft.
        const mine = builds.filter(
          (b) => b.buildNumber === v.build || (v.track === null && b.version === v.version),
        );
        const attachedCodes = v.track !== null && (v.versionCodes ?? []).length > 0;
        const built = newest(mine, buildAt);
        if (built === null && !attachedCodes) continue;
        let activityAt = v.since;
        if (built) activityAt = Math.max(activityAt, buildAt(built));
        if (activeRun) activityAt = Math.max(activityAt, activeRun.updatedAt, activeRun.startedAt);
        if (lastSuccess) activityAt = Math.max(activityAt, lastSuccess.updatedAt);
        if (!stalledFor(activityAt)) continue;
        const where = v.track ? `the ${v.track} track` : (DRAFT_WORDS[v.status] ?? v.rawState);
        const subject = built
          ? `${capital(buildName(built))} was uploaded ${agoText(age(buildAt(built)))} ago${buildByRun(built)}; `
          : '';
        const verb =
          v.track !== null
            ? `${versionName(v)} is still a draft release on ${where} and has not been started.`
            : v.status === 'ready'
              ? `${versionName(v)} is ready for review but has not been submitted.`
              : `${versionName(v)} is still in ${where} and has not been submitted for review.`;
        const evidence: PipelineEvidence[] = [];
        const r = built ? runOf(built) : null;
        if (r) evidence.push(runEvidence(r));
        else if (lastSuccess) evidence.push(runEvidence(lastSuccess));
        if (built) evidence.push(buildEvidence(built));
        evidence.push(versionEvidence(v));
        add(
          'draft',
          `${v.version}${v.track ? `@${v.track}` : ''}`,
          activityAt,
          `${subject}${subject === '' ? capital(verb) : verb}`,
          'Prepared, not submitted',
          evidence,
        );
      }
    }
    for (const b of orphans) {
      const at = buildAt(b);
      if (!stalledFor(at)) continue;
      if (b.state === 'processing') {
        add(
          'build_processing',
          b.buildNumber,
          at,
          `${capital(buildName(b))} was uploaded ${agoText(age(at))} ago and the store still shows it as processing.`,
          'Build still processing',
          [buildEvidence(b)],
        );
      } else if (b.state === 'invalid') {
        add(
          'build_invalid',
          b.buildNumber,
          at,
          `${capital(buildName(b))} was uploaded ${agoText(age(at))} ago and failed processing${b.rawState ? ` (${b.rawState})` : ''}.`,
          'Build failed processing',
          [buildEvidence(b)],
        );
      } else if (b.state === 'processed') {
        const r = runOf(b);
        const ev = r ? [runEvidence(r), buildEvidence(b)] : [buildEvidence(b)];
        add(
          'build_ready',
          b.buildNumber,
          at,
          `${capital(buildName(b))}${b.version ? ` (version ${b.version})` : ''} was uploaded ${agoText(age(at))} ago${buildByRun(b)}; no version has been prepared for it.`,
          'Build uploaded, no version',
          ev,
        );
      }
    }
    // A successful release run with no build after it. The store must have been read after the run ended, else "no build" may
    // only mean "not looked yet".
    if (
      lastSuccess &&
      stalledFor(lastSuccess.updatedAt) &&
      f.lastSyncedAt !== null &&
      f.lastSyncedAt >= lastSuccess.updatedAt
    ) {
      const produced = builds.some(
        (b) =>
          buildAt(b) >= lastSuccess.startedAt - RUN_BUILD_SLACK_MS || b.runId === lastSuccess.id,
      );
      const moved = f.versions.some((v) => v.since >= lastSuccess.startedAt);
      if (!produced && !moved) {
        add(
          'ci_run',
          lastSuccess.id,
          lastSuccess.updatedAt,
          `${capital(runName(lastSuccess))} (${lastSuccess.workflow}) succeeded ${agoText(age(lastSuccess.updatedAt))} ago, but no new build has appeared in the store.`,
          'Run succeeded, no build',
          [runEvidence(lastSuccess)],
        );
      }
    }
  }
  const order = (s: PipelineStall) => STALL_STEPS.indexOf(s.step);
  stalls.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) ||
      order(a) - order(b) ||
      a.since - b.since ||
      a.key.localeCompare(b.key),
  );
  const stalled = stalls[0] ?? null;

  // ----- state --------------------------------------------------------------------------------
  const live = f.versions.filter(
    (v) => v.status === 'live' || v.status === 'rolling_out' || v.status === 'halted',
  );
  const processing = newest(
    builds.filter((b) => b.state === 'processing'),
    buildAt,
  );
  const orphanReady = newest(
    orphans.filter((b) => b.state === 'processed'),
    buildAt,
  );
  const pick = (status: ReleaseState) =>
    newest(
      inFlight.filter((v) => v.status === status),
      (v) => v.since,
    );
  const approved = pick('approved');
  const inReview = pick('in_review');
  const rejected = pick('rejected');
  let draft: PipelineVersionFact | null = null;
  for (const s of DRAFT_FAMILY) draft = draft ?? pick(s);
  const rolling = newest(
    live.filter((v) => v.status === 'rolling_out'),
    (v) => v.since,
  );
  const halted = newest(
    live.filter((v) => v.status === 'halted'),
    (v) => v.since,
  );

  let state: PipelineState;
  let since: number | null = null;
  if (approved) [state, since] = ['approved', approved.since];
  else if (inReview) [state, since] = ['in_review', inReview.since];
  else if (rejected) [state, since] = ['rejected', rejected.since];
  else if (draft) [state, since] = ['draft', draft.since];
  else if (processing) [state, since] = ['build_processing', buildAt(processing)];
  else if (orphanReady) [state, since] = ['build_ready', buildAt(orphanReady)];
  else if (activeRun) [state, since] = ['ci_running', activeRun.startedAt];
  else if (halted) [state, since] = ['halted', halted.since];
  else if (rolling) [state, since] = ['rolling_out', rolling.since];
  else if (
    lastRun &&
    !lastRun.active &&
    lastRun.conclusion !== null &&
    FAILED_CONCLUSIONS.indexOf(lastRun.conclusion) !== -1
  )
    [state, since] = ['ci_failed', lastRun.updatedAt];
  else if (live.length > 0) [state, since] = ['live', newest(live, (v) => v.since)?.since ?? null];
  else if (
    f.lastSyncedAt === null &&
    runs.length === 0 &&
    f.builds.length === 0 &&
    f.versions.length === 0
  )
    [state, since] = ['unknown', null];
  else [state, since] = ['idle', null];
  // A run still going beside a version in Prepare is progress, not idleness; it shows in the steps and the summary.

  const waitingOn: Pipeline['waitingOn'] =
    state === 'ci_running'
      ? 'ci'
      : state === 'build_processing' || state === 'in_review' || state === 'rolling_out'
        ? 'store'
        : state === 'draft' ||
            state === 'build_ready' ||
            state === 'approved' ||
            state === 'rejected' ||
            state === 'halted' ||
            state === 'ci_failed'
          ? 'you'
          : null;

  const latestVersion =
    approved ?? inReview ?? rejected ?? draft ?? rolling ?? halted ?? newest(live, (v) => v.since);
  const latestBuild = newest(builds, buildAt);
  const summary = summarize(state, {
    activeRun,
    lastRun,
    latestBuild,
    version: latestVersion,
    now,
  });

  return {
    appId: f.appId,
    platform: f.platform,
    state,
    waitingOn,
    since,
    stalledAfterHours: f.stalledAfterHours,
    stalled,
    stalls,
    steps: stepRows(state, stalled, { lastRun, lastSuccess, latestBuild, version: latestVersion }),
    summary,
    latest: { run: lastRun, build: latestBuild, version: latestVersion },
  };
}

const capital = (s: string) => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

function summarize(
  state: PipelineState,
  x: {
    activeRun: PipelineRunFact | null;
    lastRun: PipelineRunFact | null;
    latestBuild: PipelineBuildFact | null;
    version: PipelineVersionFact | null;
    now: number;
  },
): string {
  const v = x.version ? versionName(x.version) : 'a version';
  switch (state) {
    case 'unknown':
      return 'Nothing is known about this app yet: sync it first.';
    case 'idle':
      return 'No release is in progress.';
    case 'ci_running':
      return x.activeRun
        ? `${capital(runName(x.activeRun))} (${x.activeRun.workflow}) is running.`
        : 'A CI run is going.';
    case 'ci_failed':
      return x.lastRun
        ? `${capital(runName(x.lastRun))} (${x.lastRun.workflow}) ${x.lastRun.conclusion ?? 'failed'}.`
        : 'The last CI run failed.';
    case 'build_processing':
      return 'The store is processing a new build.';
    case 'build_ready':
      return x.latestBuild
        ? `${capital(buildName(x.latestBuild))} is processed and no version has it yet.`
        : 'A processed build has no version yet.';
    case 'draft':
      return `${capital(v)} is being prepared and has not been submitted.`;
    case 'in_review':
      return `${capital(v)} is waiting for the store's review.`;
    case 'rejected':
      return `${capital(v)} was rejected.`;
    case 'approved':
      return `${capital(v)} is approved and waiting to be released.`;
    case 'rolling_out':
      return `${capital(v)} is rolling out${x.version?.rolloutFraction != null ? ` to ${Math.round(x.version.rolloutFraction * 100)}% of users` : ''}.`;
    case 'halted':
      return `The rollout of ${v} is halted.`;
    case 'live':
      return `${capital(v)} is live.`;
  }
}

function stepRows(
  state: PipelineState,
  stalled: PipelineStall | null,
  x: {
    lastRun: PipelineRunFact | null;
    lastSuccess: PipelineRunFact | null;
    latestBuild: PipelineBuildFact | null;
    version: PipelineVersionFact | null;
  },
): PipelineStepRow[] {
  const ids: PipelineStepRow['id'][] = ['ci', 'build', 'prepare', 'review', 'release'];
  // The step each state is at, and how it is at it.
  const at: Record<PipelineState, [number, PipelineStepStatus] | null> = {
    unknown: null,
    idle: null,
    ci_running: [0, 'current'],
    ci_failed: [0, 'failed'],
    build_processing: [1, 'current'],
    build_ready: [2, 'waiting'],
    draft: [2, 'current'],
    in_review: [3, 'current'],
    rejected: [3, 'failed'],
    approved: [4, 'waiting'],
    rolling_out: [4, 'current'],
    halted: [4, 'failed'],
    live: [5, 'done'],
  };
  const here = at[state];
  const stalledStep = stalled
    ? {
        approved: 4,
        rejected: 3,
        draft: 2,
        build_ready: 2,
        build_invalid: 1,
        build_processing: 1,
        ci_run: 1,
      }[stalled.step]
    : -1;
  return ids.map((id, i): PipelineStepRow => {
    let status: PipelineStepStatus;
    if (here === null) status = state === 'unknown' ? 'unknown' : 'todo';
    else if (i < here[0]) status = 'done';
    else if (i === here[0]) status = here[1];
    else status = 'todo';
    if (
      stalled &&
      i === stalledStep &&
      (status === 'current' || status === 'waiting' || status === 'done' || status === 'failed')
    )
      status = 'stalled';
    let when: number | null = null;
    let detail: string | null = null;
    if (id === 'ci' && x.lastRun) {
      when = x.lastRun.updatedAt;
      detail = `${runName(x.lastRun)} ${x.lastRun.conclusion ?? x.lastRun.status}`;
    } else if (id === 'build' && x.latestBuild) {
      when = buildAt(x.latestBuild);
      detail = `${buildName(x.latestBuild)}${x.latestBuild.rawState ? `, ${x.latestBuild.rawState}` : ''}`;
    } else if ((id === 'prepare' || id === 'review' || id === 'release') && x.version) {
      const mine =
        id === 'prepare'
          ? state === 'draft'
          : id === 'review'
            ? state === 'in_review' || state === 'rejected'
            : state === 'approved' ||
              state === 'rolling_out' ||
              state === 'halted' ||
              state === 'live';
      if (mine) {
        when = x.version.since;
        detail = `${versionName(x.version)} ${x.version.rawState}`;
      }
    }
    return { id, status, at: when, detail };
  });
}
