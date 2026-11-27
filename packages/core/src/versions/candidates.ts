import { type Platform, supports } from '../platform.ts';
import {
  compareBuildNumbers,
  compareVersions,
  newestVersionFirst,
  tryCompareVersions,
} from './compare.ts';
import {
  isNewerThanLive,
  isPastPrepareStatus,
  isPreparingStatus,
  isServingStatus,
  type LiveFacts,
  type LiveRef,
  liveOf,
  type ObsoleteReason,
  obsoleteReasonOf,
  type ReleaseFact,
  topOfCodes,
} from './live.ts';
import { type CreateRefusal, createReleaseRules, storeVersionsOf } from './rules.ts';
import { isProductionTrack, type PlayChannel, playChannelOf, sameTrack } from './tracks.ts';

/**
 * The release candidate: the ONE answer to "which build could be released next, and which versions are left over" (moved here from
 * apps/web/src/lib/app-state/candidates.ts so the server can ask it too; the web file delegates, docs/state-model.md "Single owners").
 * A pure function of the synced facts: the store versions of a record (with their state), what is live (`liveOf`), and the store builds
 * (TestFlight rows, or the version codes on the Play tracks). iOS and macOS take the newest TestFlight build that is newer than what is
 * live ("Create release 2.0.1 from TestFlight build 95"), Google Play takes the release in a testing track that is newer than
 * production ("Promote to production").
 *
 * The rules:
 *  - a build is IGNORED (`obsolete`) when its version is lower than the live version, or the same version with a build number that is not
 *    higher than the live build. A version that cannot be read is never judged (`unreadable_version`), never a candidate while
 *    something is live;
 *  - a store version still in a preparable state whose version is lower than the live one (or the same) is OBSOLETE: it can never be
 *    submitted, it is never the next step;
 *  - Google Play: a draft whose version codes are all lower than the live production codes is obsolete; a release in a testing track
 *    whose codes are not higher than production's is not a candidate (and cannot be promoted);
 *  - NEW (was only a server refusal): a plan "create release" that the server would refuse (`createReleaseRules`: an editable version
 *    exists, not higher than the newest non-editable version, not 1-3 numbers) is `blocked` with the reasons, never offered.
 *
 * Differences from the web copy, on purpose: version comparison is the shared comparator (a pre-release is judged, not unknown; a fifth
 * part is unreadable), the serving set is `liveOf`'s, and promotion has ONE rule (`promoteOptionsOf`).
 *
 * Pure. ES2017.
 */

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

export type CandidateChannel = 'testflight' | PlayChannel;

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
  reason: ObsoleteReason;
};

/** A release of a Google Play testing track that can go to another track (production by default). Words are the web's business. */
export type PromoteFact = {
  appId: string;
  /** The track the release is in now. */
  from: string;
  /** The track to release in. */
  to: string;
  /** The version codes of the release. */
  codes: string[];
  /** The release name or version. */
  version: string;
};

/** What the next step of a record is, from the candidate (iOS and macOS). */
export type CandidatePlan<R extends ReleaseFact = ReleaseFact> =
  | { kind: 'create_release'; candidate: ReleaseCandidate; release: null }
  | { kind: 'attach_build'; candidate: ReleaseCandidate; release: R }
  | { kind: 'submit'; candidate: ReleaseCandidate; release: R }
  /** The next step would be to create the version, but the store refuses it (see `createReleaseRules`): said, never offered. */
  | {
      kind: 'blocked';
      candidate: ReleaseCandidate;
      release: null;
      refusal: CreateRefusal[];
      /** `editable_version_exists`: the version that can still be edited (put the build there instead). */
      editableVersion: string | null;
      /** The editable version is itself left behind (not newer than live): the build must NOT be attached to it. */
      editableObsolete: boolean;
      /** `not_higher`: the newest version that cannot be edited (the new one has to be higher). */
      newestFixed: string | null;
    };

export type CandidateAnalysis<R extends ReleaseFact = ReleaseFact> = {
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
  plan: CandidatePlan<R> | null;
  /** Google Play: the releases in a testing track that can go to production (newer than production), newest codes first. */
  promote: PromoteFact[];
};

export type CandidateInput<R extends ReleaseFact = ReleaseFact> = {
  appId: string;
  platform: Platform;
  /** The releases of THIS record (store versions with their state). They need an `id` to be listed as obsolete. */
  releases: readonly (R & { id: string })[];
  /** The store builds of this record. */
  builds: readonly StoreBuildFact[];
};

// ---------------------------------------------------------------------------------------------
// Promotion: the ONE rule

/**
 * The releases of a Google Play record that can be promoted: a track that is not production, serving its testers (`live` or
 * `rolling_out`; a `halted` testing release is resumed, not promoted), with version codes, not already in production with all of those
 * codes in any state, and NOT obsolete: its top code is higher than production's (a release whose codes are all at or below the live
 * production codes can never replace it). Newest codes first. (The web had two rules: `promoteOption` without the codes rule and
 * `obsoleteCodes` without the halted rule.)
 */
export function promoteOptionsOf(
  releases: readonly ReleaseFact[],
  options: { appId: string; live?: LiveRef | null | undefined; to?: string | undefined },
): PromoteFact[] {
  const liveTop =
    options.live === undefined || options.live === null ? -1 : topOfCodes(options.live.codes);
  const out: PromoteFact[] = [];
  for (const r of releases) {
    if (r.track === null || isProductionTrack(r.track)) continue;
    if (r.status !== 'live' && r.status !== 'rolling_out') continue;
    const codes = (r.versionCodes ?? []).slice();
    if (codes.length === 0) continue;
    const inProduction = releases.some(
      (s) =>
        isProductionTrack(s.track) && codes.every((c) => (s.versionCodes ?? []).indexOf(c) >= 0),
    );
    if (inProduction) continue;
    if (liveTop >= 0 && topOfCodes(codes) <= liveTop) continue;
    out.push({
      appId: options.appId,
      from: r.track,
      to: options.to ?? 'production',
      codes,
      version: r.version,
    });
  }
  return out.sort((a, b) => topOfCodes(b.codes) - topOfCodes(a.codes));
}

// ---------------------------------------------------------------------------------------------
// Obsolete versions

/** The store versions that are left behind (Apple: not newer than live; Google Play: codes below production's). Newest first. */
export function obsoleteVersionsOf<R extends ReleaseFact & { id: string }>(
  releases: readonly R[],
  live: Pick<LiveFacts, 'platform' | 'ref'>,
  appId: string,
): ObsoleteVersion[] {
  const out: ObsoleteVersion[] = [];
  for (const r of releases) {
    const reason = obsoleteReasonOf(r, live);
    if (reason === null || live.ref === null) continue;
    out.push({
      releaseId: r.id,
      appId,
      platform: live.platform,
      version: r.version,
      track: r.track,
      build: r.build,
      liveVersion: live.ref.version,
      reason,
    });
  }
  return out.sort((a, b) => newestVersionFirst(a.version, b.version));
}

// ---------------------------------------------------------------------------------------------
// The analysis

/** Newest version first, then the higher build, then the later upload. */
function newestFirst(a: ReleaseCandidate, b: ReleaseCandidate): number {
  const v = compareVersions(b.version, a.version);
  if (v !== 0) return v;
  const n = compareBuildNumbers(b.buildNumber, a.buildNumber);
  if (n !== 0) return n;
  return (b.builtAt ?? 0) - (a.builtAt ?? 0);
}

const sameVersionNumber = (a: string, b: string): boolean => tryCompareVersions(a, b) === 0;

/** The same build number (`090` and `90` are one build); a missing number is never the same as anything. */
const sameBuild = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.trim() !== '' && b.trim() !== '' && compareBuildNumbers(a, b) === 0;

/**
 * The candidates of one record and the step they ask for. This is the only place that decides which build is newer, which version is
 * left behind and what the next step of the release is on a platform that creates versions.
 */
export function analyzeCandidates<R extends ReleaseFact & { id: string }>(
  input: CandidateInput<R>,
): CandidateAnalysis<R> {
  const { appId, platform, releases, builds } = input;
  const play = supports(platform, 'releaseTracks');
  const liveFacts = liveOf(releases, { platform });
  const live = liveFacts.ref;
  const obsolete = obsoleteVersionsOf(releases, liveFacts, appId);
  const base = { appId, platform, live, obsolete };

  if (play) {
    const liveTop = live === null ? -1 : topOfCodes(live.codes);
    const options = promoteOptionsOf(releases, { appId, live });
    // Every promotable-looking release, obsolete ones flagged, for the candidate list.
    const all = promoteOptionsOf(releases, { appId, live: null });
    const candidates: ReleaseCandidate[] = all.map((o) => {
      const release = releases.find(
        (r) =>
          sameTrack(r.track, o.from) &&
          r.version === o.version &&
          o.codes.every((c) => (r.versionCodes ?? []).indexOf(c) >= 0),
      );
      const dead = liveTop >= 0 && topOfCodes(o.codes) <= liveTop;
      const stamp = release as
        | (R & { storeUpdatedAt?: number | null; statusSince?: number | null })
        | undefined;
      return {
        platform,
        appId,
        version: o.version,
        buildNumber: o.codes.slice().sort((a, b) => Number(b) - Number(a))[0] ?? '',
        channel: playChannelOf([o.from]),
        builtAt: stamp?.storeUpdatedAt ?? stamp?.statusSince ?? null,
        processedAt: stamp?.storeUpdatedAt ?? null,
        obsolete: dead || undefined,
        reason: dead ? 'older_than_live' : live === null ? 'first_release' : 'newer_build',
        ready: !dead,
        track: o.from,
        codes: o.codes.slice(),
      } satisfies ReleaseCandidate;
    });
    const best = candidates.find((c) => c.obsolete !== true) ?? null;
    return { ...base, candidates, best, processing: null, plan: null, promote: options };
  }

  const inFlightVersions = releases.filter(
    (r) => isPastPrepareStatus(r.status) && !isServingStatus(r.status),
  );
  const attachedElsewhere = (b: StoreBuildFact): boolean =>
    releases.some((r) => r.build === b.buildNumber && isPastPrepareStatus(r.status));
  const candidates: ReleaseCandidate[] = [];
  for (const b of builds) {
    if (b.channel !== 'testflight' || b.version === null || b.version === '') continue;
    let obsoleteBuild = false;
    let reason: CandidateReason = live === null ? 'first_release' : 'newer_version';
    if (live !== null) {
      const newer = isNewerThanLive(b, liveFacts);
      if (newer === null) {
        obsoleteBuild = true;
        reason = 'unreadable_version';
      } else if (newer) {
        reason =
          tryCompareVersions(b.version, live.version) === 1 ? 'newer_version' : 'newer_build';
      } else {
        obsoleteBuild = true;
        reason =
          tryCompareVersions(b.version, live.version) === -1 ? 'older_than_live' : 'same_as_live';
      }
    }
    const taken =
      !obsoleteBuild &&
      (attachedElsewhere(b) ||
        inFlightVersions.some((r) => sameVersionNumber(r.version, b.version as string)));
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
    usable.find((c) => c.reason === 'processing' && (best === null || newestFirst(c, best) < 0)) ??
    null;

  let plan: CandidatePlan<R> | null = null;
  if (best !== null) {
    const gone = new Set(obsolete.map((o) => o.releaseId));
    const prepared = releases.find(
      (r) =>
        isPreparingStatus(r.status) &&
        !gone.has(r.id) &&
        sameVersionNumber(r.version, best.version),
    );
    if (prepared === undefined) {
      const check = createReleaseRules(best.version, storeVersionsOf(releases));
      plan = check.ok
        ? { kind: 'create_release', candidate: best, release: null }
        : {
            kind: 'blocked',
            candidate: best,
            release: null,
            refusal: check.reasons,
            editableVersion: check.editableVersion ?? null,
            editableObsolete:
              check.editableVersion != null &&
              obsolete.some((o) => o.version === check.editableVersion),
            newestFixed: check.newestFixed ?? null,
          };
    } else if (!sameBuild(prepared.build, best.buildNumber))
      plan = { kind: 'attach_build', candidate: best, release: prepared };
    else plan = { kind: 'submit', candidate: best, release: prepared };
  }
  return { ...base, candidates, best, processing, plan, promote: [] };
}

// ---------------------------------------------------------------------------------------------
// Patches over a pipeline read (structural: any pipeline with these fields)

type PipelineLike = {
  pipeline: {
    state: string;
    latest: {
      version?: { version: string; track?: string | null | undefined } | null | undefined;
      build?: { buildNumber: string } | null | undefined;
    };
  };
};

/**
 * The pipeline's own subject, when it is left behind: its draft is one of the obsolete versions, or the build it waits on is not newer than
 * what is live ("it should ignore old builds"). Such a pipeline must never be the release flow.
 */
export function pipelineIsObsolete(
  pipeline: PipelineLike,
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

/**
 * Whether a stall of the release pipeline ("Release left unfinished") is about something left behind: its version is one of the
 * obsolete versions, or (a stall about a build) its build is not newer than what is live. Such a stall is not news and is never
 * counted or listed.
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
