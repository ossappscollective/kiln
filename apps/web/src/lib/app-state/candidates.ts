import { type Platform, supports } from '@kiln/core';
import { type PromoteOption, promoteOptions } from '../play-promote.ts';
import type { AppPipeline } from '../release-pipeline.ts';
import type { ReleaseSummary } from '../types.ts';

/**
 * The release candidate: the ONE answer to "which build could be released next, and which versions are left over" (docs/state-model.md,
 * "Candidates and obsolete versions"). A pure function of the synced facts: the store versions of a record (with their state), the live
 * version and build, and the store builds (TestFlight rows, or the version codes on the Play tracks). Both platforms read it:
 * iOS and macOS take the newest TestFlight build that is newer than what is live ("Create release 2.0.1 from TestFlight build 95"),
 * Google Play takes the release in a testing track that is newer than production ("Promote to production"). No screen compares versions.
 *
 * The rules:
 *  - a build is IGNORED (`obsolete`) when its version is lower than the live version, or the same version with a build number that is not
 *    higher than the live build. A version that cannot be read as numbers is never judged: it is `unknown`, not stale, and never a candidate
 *    while something is live;
 *  - a store version still in a preparable state (draft, build chosen, ready, or a rejection that is editable again) whose version is lower
 *    than the live one (or the same) is OBSOLETE: it can never be submitted, it is never the next step;
 *  - Google Play: a draft whose version codes are all lower than the live production codes is obsolete; a release in a testing track whose
 *    codes are not higher than production's is not a candidate.
 *
 * Pure; written for the ES2017 web build (no flatMap, no fromEntries).
 */

// ---------------------------------------------------------------------------------------------
// Comparing versions

const DOTTED = /^\d+(\.\d+)*$/;

/** The numeric parts of `2.00.1`, `v1.26.2` or `2.00.1.90`; null when it is not dotted numbers (then nothing is judged about it). */
function partsOf(value: string | null | undefined): number[] | null {
  if (value === null || value === undefined) return null;
  const text = value.trim().replace(/^v(?=\d)/i, '');
  if (!DOTTED.test(text)) return null;
  const parts = text.split('.').map((p) => Number(p));
  return parts.some((n) => !Number.isFinite(n)) ? null : parts;
}

/**
 * -1, 0 or 1 when both read as dotted numbers (`2.00.1` is 2.0.1, `1.0` equals `1.0.0`, `2.00.1.90` is after `2.00.1`); null when either does
 * not (a pre-release word, an empty string): the caller treats "unknown" as neither older nor newer.
 */
export function compareVersionStrings(a: string | null, b: string | null): -1 | 0 | 1 | null {
  const left = partsOf(a);
  const right = partsOf(b);
  if (left === null || right === null) return null;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A build number compared with another: whole numbers, else dotted numbers; null when unknown. */
export function compareBuildNumbers(a: string | null, b: string | null): -1 | 0 | 1 | null {
  if (a === null || b === null) return null;
  return compareVersionStrings(a, b);
}

// ---------------------------------------------------------------------------------------------
// The facts

/** A build the store holds (a TestFlight row, or the version codes of a Play track), as the Builds page reads it (`app_builds`). */
export type StoreBuildFact = {
  buildNumber: string;
  version: string | null;
  /** `processed` is VALID for the store: the build can be attached. */
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  expired: boolean | null;
  /** The store's upload time; null when it does not say. */
  uploadedAt: number | null;
  /** `testflight` (App Store Connect) or `play` (version codes on tracks). */
  channel: 'testflight' | 'play';
  tracks: string[];
};

export type CandidateChannel =
  | 'testflight'
  | 'play_internal'
  | 'play_closed'
  | 'play_open'
  | 'play_other';

/** Why a candidate is, or is not, one. */
export type CandidateReason =
  | 'newer_version'
  | 'newer_build'
  | 'first_release'
  | 'older_than_live'
  | 'same_as_live'
  | 'processing'
  | 'expired'
  | 'invalid'
  | 'in_flight'
  | 'unreadable_version';

export type ReleaseCandidate = {
  platform: Platform;
  appId: string;
  version: string;
  buildNumber: string;
  channel: CandidateChannel;
  /** When the build was made (the store's upload time), or null. */
  builtAt: number | null;
  /** When the store finished processing it (TestFlight tells only that it is processed: the upload time stands in), or null. */
  processedAt?: number | null | undefined;
  /** Not newer than what is live (or in flight already): ignored, never a next step. */
  obsolete?: boolean | undefined;
  reason: CandidateReason;
  /** The build can be attached now (processed, not expired). A build still processing is a candidate that waits. */
  ready: boolean;
  /** Google Play: the track the release is in and its version codes. */
  track?: string | null | undefined;
  codes?: string[] | undefined;
};

/** A store version left behind: still preparable, but not newer than what is live. */
export type ObsoleteVersion = {
  releaseId: string;
  appId: string;
  platform: Platform;
  version: string;
  track: string | null;
  build: string | null;
  /** What is live instead. */
  liveVersion: string;
  reason: 'older_than_live' | 'same_as_live';
};

export type LiveRef = { version: string; build: string | null; codes: string[] };

/** What the next step of a record is, from the candidate (iOS and macOS). */
export type CandidatePlan =
  | { kind: 'create_release'; candidate: ReleaseCandidate; release: null }
  | { kind: 'attach_build'; candidate: ReleaseCandidate; release: ReleaseSummary }
  | { kind: 'submit'; candidate: ReleaseCandidate; release: ReleaseSummary };

export type CandidateAnalysis = {
  appId: string;
  platform: Platform;
  live: LiveRef | null;
  /** Every build looked at, newest first: obsolete ones are flagged, not dropped. */
  candidates: ReleaseCandidate[];
  /** The newest candidate that is ready and not obsolete, or null. */
  best: ReleaseCandidate | null;
  /** A newer build that is still processing (said quietly, never the headline). */
  processing: ReleaseCandidate | null;
  obsolete: ObsoleteVersion[];
  /** The next step the candidate asks for on a platform that creates versions (iOS, macOS), or null. */
  plan: CandidatePlan | null;
  /** Google Play: the releases in a testing track that can go to production (newer than production), newest codes first. */
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

// ---------------------------------------------------------------------------------------------
// The rules

const SERVING = ['live', 'rolling_out', 'halted'] as const;
/** The states a version can still be edited and submitted in. */
const PREPARING = ['draft', 'build_chosen', 'ready'] as const;
/** A version that is past "Prepare": submitted, decided or on its way out (the release pipeline's business, not the candidate's). */
const PAST_PREPARE = ['in_review', 'rejected', 'approved', 'propagating', ...SERVING] as const;

const isIn = (list: readonly string[], status: string | null): boolean =>
  status !== null && list.indexOf(status) >= 0;

const PRODUCTION = 'production';
const isProduction = (r: Pick<ReleaseSummary, 'track'>): boolean =>
  (r.track ?? '').toLowerCase() === PRODUCTION;

/** The highest of these version codes, or -1 when none is a number. */
const topOf = (codes: readonly string[]): number =>
  Math.max(-1, ...codes.map((c) => Number(c)).filter((n) => Number.isFinite(n)));

const codesOf = (r: Pick<ReleaseSummary, 'versionCodes'>): number[] =>
  (r.versionCodes ?? []).map((c) => Number(c)).filter((n) => Number.isFinite(n));
const topCode = (r: Pick<ReleaseSummary, 'versionCodes'>): number | null => {
  const codes = codesOf(r);
  return codes.length === 0 ? null : Math.max(...codes);
};

/** What is live on this record: the newest serving version (iOS, macOS), or the codes in production (Google Play). */
export function liveOf(
  platform: Platform,
  releases: readonly ReleaseSummary[],
): LiveRef | null {
  if (supports(platform, 'releaseTracks')) {
    const prod = releases.filter((r) => isProduction(r) && isIn(SERVING, r.status));
    if (prod.length === 0) return null;
    const best = prod
      .slice()
      .sort((a, b) => (topCode(b) ?? -1) - (topCode(a) ?? -1))[0] as ReleaseSummary;
    return { version: best.version, build: best.build, codes: (best.versionCodes ?? []).slice() };
  }
  let best: ReleaseSummary | null = null;
  for (const r of releases) {
    if (!isIn(SERVING, r.status)) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const cmp = compareVersionStrings(r.version, best.version);
    if (cmp === 1) best = r;
    else if (cmp === 0 && compareBuildNumbers(r.build, best.build) === 1) best = r;
  }
  return best === null ? null : { version: best.version, build: best.build, codes: [] };
}

/** Whether this build is newer than what is live: `true`, `false`, or `null` when it cannot be told (never a candidate then). */
function newerThanLive(
  build: Pick<StoreBuildFact, 'version' | 'buildNumber'>,
  live: LiveRef,
): { newer: boolean; reason: CandidateReason } {
  const byVersion = compareVersionStrings(build.version, live.version);
  if (byVersion === null) return { newer: false, reason: 'unreadable_version' };
  if (byVersion === 1) return { newer: true, reason: 'newer_version' };
  if (byVersion === -1) return { newer: false, reason: 'older_than_live' };
  const byBuild = compareBuildNumbers(build.buildNumber, live.build);
  if (byBuild === 1) return { newer: true, reason: 'newer_build' };
  return { newer: false, reason: 'same_as_live' };
}

/** Newest version first, then the higher build, then the later upload. */
function newestFirst(a: ReleaseCandidate, b: ReleaseCandidate): number {
  const v = compareVersionStrings(b.version, a.version);
  if (v !== null && v !== 0) return v;
  const n = compareBuildNumbers(b.buildNumber, a.buildNumber);
  if (n !== null && n !== 0) return n;
  return (b.builtAt ?? 0) - (a.builtAt ?? 0);
}

function channelOf(tracks: readonly string[]): CandidateChannel {
  const names = tracks.map((x) => x.toLowerCase());
  if (names.indexOf('internal') >= 0) return 'play_internal';
  if (names.indexOf('alpha') >= 0) return 'play_closed';
  if (names.indexOf('beta') >= 0) return 'play_open';
  return 'play_other';
}

/** The store versions that are left behind (iOS, macOS: not newer than live; Google Play: codes below production's). */
export function obsoleteVersions(
  platform: Platform,
  appId: string,
  releases: readonly ReleaseSummary[],
  live: LiveRef | null,
): ObsoleteVersion[] {
  if (live === null) return [];
  const out: ObsoleteVersion[] = [];
  const play = supports(platform, 'releaseTracks');
  const liveTop = play ? topOf(live.codes) : -1;
  for (const r of releases) {
    if (!isIn(PREPARING, r.status)) continue;
    let reason: ObsoleteVersion['reason'] | null = null;
    if (play) {
      const top = topCode(r);
      if (top !== null && liveTop >= 0 && top < liveTop) reason = 'older_than_live';
    } else {
      const cmp = compareVersionStrings(r.version, live.version);
      if (cmp === -1) reason = 'older_than_live';
      else if (cmp === 0) reason = 'same_as_live';
    }
    if (reason !== null)
      out.push({
        releaseId: r.id,
        appId,
        platform,
        version: r.version,
        track: r.track,
        build: r.build,
        liveVersion: live.version,
        reason,
      });
  }
  return out.sort((a, b) => compareVersionStrings(b.version, a.version) ?? 0);
}

/**
 * The candidates of one record and the step they ask for. This is the only place that decides which build is newer, which version is
 * left behind and what the next step of the release is on a platform that creates versions.
 */
export function analyzeCandidates(input: CandidateInput): CandidateAnalysis {
  const { appId, platform, releases, builds } = input;
  const play = supports(platform, 'releaseTracks');
  const live = liveOf(platform, releases);
  const obsolete = obsoleteVersions(platform, appId, releases, live);
  const base = { appId, platform, live, obsolete };

  if (play) {
    const obsoleteCodes = (o: PromoteOption): boolean => {
      const liveTop = live === null ? -1 : topOf(live.codes);
      const top = topOf(o.codes);
      return liveTop >= 0 && top <= liveTop;
    };
    const options = promoteOptions(releases);
    const promote = options.filter((o) => !obsoleteCodes(o));
    const candidates: ReleaseCandidate[] = options.map((o) => {
      const release = releases.find(
        (r) => r.appId === o.appId && r.track === o.from && r.version === o.version,
      );
      const dead = obsoleteCodes(o);
      return {
        platform,
        appId,
        version: o.version,
        buildNumber: o.codes.slice().sort((a, b) => Number(b) - Number(a))[0] ?? '',
        channel: channelOf([o.from]),
        builtAt: release?.storeUpdatedAt ?? release?.statusSince ?? null,
        processedAt: release?.storeUpdatedAt ?? null,
        obsolete: dead || undefined,
        reason: dead ? 'older_than_live' : live === null ? 'first_release' : 'newer_build',
        ready: !dead,
        track: o.from,
        codes: o.codes.slice(),
      };
    });
    const best = candidates.find((c) => c.obsolete !== true) ?? null;
    return { ...base, candidates, best, processing: null, plan: null, promote };
  }

  const inFlightVersions = releases.filter(
    (r) => isIn(PAST_PREPARE, r.status) && !isIn(SERVING, r.status),
  );
  const attachedElsewhere = (b: StoreBuildFact): boolean =>
    releases.some((r) => r.build === b.buildNumber && isIn(PAST_PREPARE, r.status));
  const candidates: ReleaseCandidate[] = [];
  for (const b of builds) {
    if (b.channel !== 'testflight' || b.version === null || b.version === '') continue;
    let obsoleteBuild = false;
    let reason: CandidateReason = live === null ? 'first_release' : 'newer_version';
    if (live !== null) {
      const verdict = newerThanLive(b, live);
      obsoleteBuild = !verdict.newer;
      reason = verdict.reason;
    }
    const taken =
      !obsoleteBuild &&
      (attachedElsewhere(b) ||
        inFlightVersions.some((r) => compareVersionStrings(r.version, b.version) === 0));
    if (taken) {
      obsoleteBuild = true;
      reason = 'in_flight';
    }
    let ready = true;
    if (b.expired === true) {
      ready = false;
      if (!obsoleteBuild) reason = 'expired';
    } else if (b.state === 'processing') {
      ready = false;
      if (!obsoleteBuild) reason = 'processing';
    } else if (b.state !== 'processed') {
      ready = false;
      if (!obsoleteBuild) reason = b.state === 'invalid' ? 'invalid' : 'processing';
    }
    candidates.push({
      platform,
      appId,
      version: b.version,
      buildNumber: b.buildNumber,
      channel: 'testflight',
      builtAt: b.uploadedAt,
      processedAt: ready ? b.uploadedAt : null,
      obsolete: obsoleteBuild || undefined,
      reason,
      ready,
    });
  }
  candidates.sort(newestFirst);
  const usable = candidates.filter((c) => c.obsolete !== true);
  const best = usable.find((c) => c.ready) ?? null;
  const processing =
    usable.find(
      (c) => c.reason === 'processing' && (best === null || newestFirst(c, best) < 0),
    ) ?? null;

  let plan: CandidatePlan | null = null;
  if (best !== null) {
    const gone = new Set(obsolete.map((o) => o.releaseId));
    const prepared = releases.find(
      (r) =>
        isIn(PREPARING, r.status) &&
        !gone.has(r.id) &&
        compareVersionStrings(r.version, best.version) === 0,
    );
    if (prepared === undefined) plan = { kind: 'create_release', candidate: best, release: null };
    else if (prepared.build !== best.buildNumber)
      plan = { kind: 'attach_build', candidate: best, release: prepared };
    else plan = { kind: 'submit', candidate: best, release: prepared };
  }
  return { ...base, candidates, best, processing, plan, promote: [] };
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
 * The pipeline's own subject, when it is left behind: its draft is one of the obsolete versions, or the build it waits on is not newer than
 * what is live ("it should ignore old builds"). Such a pipeline must never be the release flow.
 */
export function pipelineIsObsolete(
  pipeline: PipelineFact,
  analysis: Pick<CandidateAnalysis, 'obsolete' | 'candidates'>,
): boolean {
  const state = pipeline.pipeline.state;
  const v = pipeline.pipeline.latest.version;
  if (
    (state === 'draft' || state === 'build_ready') &&
    v !== null &&
    v !== undefined &&
    analysis.obsolete.some(
      (o) => o.version === v.version && (o.track ?? null) === (v.track ?? null),
    )
  )
    return true;
  const b = pipeline.pipeline.latest.build;
  if ((state === 'build_ready' || state === 'build_processing') && b !== null && b !== undefined)
    return analysis.candidates.some((c) => c.buildNumber === b.buildNumber && c.obsolete === true);
  return false;
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

/**
 * Whether a stall of the release pipeline ("Release left unfinished") is about something left behind: its version is one of the obsolete
 * versions, or (a stall about a build) its build is not newer than what is live. Such a stall is not news and is never counted or listed.
 */
export function stallLeftBehind(
  stall: { evidence: readonly { kind: 'run' | 'build' | 'version'; id: string }[] },
  analysis: Pick<CandidateAnalysis, 'obsolete' | 'candidates'>,
): boolean {
  const version = stall.evidence.filter((e) => e.kind === 'version')[0];
  if (version !== undefined) {
    const at = version.id.indexOf('@');
    const name = at < 0 ? version.id : version.id.slice(0, at);
    return analysis.obsolete.some((o) => o.version === name);
  }
  const build = stall.evidence.filter((e) => e.kind === 'build')[0];
  return (
    build !== undefined &&
    analysis.candidates.some((c) => c.buildNumber === build.id && c.obsolete === true)
  );
}
