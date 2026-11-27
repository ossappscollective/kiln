import { type Platform, supports } from '../platform.ts';
import type { ReleaseState } from '../release/lifecycle.ts';
import {
  compareBuildNumbers,
  compareVersions,
  tryCompareReleases,
  tryCompareVersions,
} from './compare.ts';
import { isProductionTrack } from './tracks.ts';

/**
 * WHAT IS LIVE, and what is left behind by it: the one definition (docs/state-model.md, "Single owners (core)"). Before this file the
 * "live version" was computed ten times: only `live` (portfolio `liveRelease`, releases-table `newestLive`, the Overview "On store" tile),
 * live + rolling_out + halted (the candidates model, `SERVED` of the Play rollout offer), live + rolling_out (`SERVING` of play-promote),
 * the newest NON-editable version (the server's `liveVersionOf`), ordered by `status_since` instead of version (the pipeline). A phased
 * 1.19.0 was "On store: 1.18.0" on one screen and live on the next.
 *
 * THE SERVING SET. A release is SERVING when users can get it from the store now. Each status, and why:
 *  - `live`        serving. It is the store's current version.
 *  - `rolling_out` serving. A phased release (Apple) or a staged rollout (Google Play `inProgress`): some users have it, and it is the
 *                  version the store lists as current. A new version has to be higher than it, an older draft is behind it.
 *  - `halted`      serving. A paused rollout still is the current version for the users who got it, and its version number is taken.
 *                  Treating it as "not live" would make the build it was cut from look like a new candidate.
 *  - `propagating` NOT serving. Google Play only: the edit is committed but not visible yet (minutes to hours). It becomes
 *                  `rolling_out` or `live` on its own; until then it must not move the live version.
 *  - `approved`    NOT serving. Accepted by review, waiting for a release.
 *  - `in_review`, `rejected`  NOT serving. Past "Prepare", before the store shows it.
 *  - `draft`, `build_chosen`, `ready`  NOT serving; these are PREPARING (still editable and submittable).
 *  - `null`        (the store state has no mapping) NOT serving: never guessed.
 *
 * GOOGLE PLAY. Only the PRODUCTION track serves users at large; internal, closed and open testing releases reach testers only. An
 * internal release that is `live`/`completed` is therefore NOT what is live (the pipeline used to count it).
 *
 * ORDER. Newest first by VERSION (then build for Apple, then the highest version code for Play), and `statusSince` only breaks a tie. The
 * old `status_since` order let an old draft or a re-synced old release outrank a newer one.
 *
 * Pure. ES2017.
 */

/** The facts of one store release that these rules read. `ReleaseSummary` of the web app fits. */
export type ReleaseFact = {
  id?: string | undefined;
  appId?: string | undefined;
  version: string;
  /** The Play track; null on Apple. */
  track: string | null;
  build: string | null;
  status: ReleaseState | null;
  versionCodes: readonly string[] | null;
  /** When the server first saw the release in its current state. Only a tie-break. */
  statusSince?: number | null | undefined;
};

export const SERVING_STATUSES: readonly ReleaseState[] = ['live', 'rolling_out', 'halted'];
/** Still editable and submittable. */
export const PREPARING_STATUSES: readonly ReleaseState[] = ['draft', 'build_chosen', 'ready'];
/** Past "Prepare": submitted, decided or on its way out (the release pipeline's business, not the candidate's). */
export const PAST_PREPARE_STATUSES: readonly ReleaseState[] = [
  'in_review',
  'rejected',
  'approved',
  'propagating',
  ...SERVING_STATUSES,
];

export const isServingStatus = (status: ReleaseState | null): boolean =>
  status !== null && SERVING_STATUSES.indexOf(status) >= 0;
export const isPreparingStatus = (status: ReleaseState | null): boolean =>
  status !== null && PREPARING_STATUSES.indexOf(status) >= 0;
export const isPastPrepareStatus = (status: ReleaseState | null): boolean =>
  status !== null && PAST_PREPARE_STATUSES.indexOf(status) >= 0;

/** The version codes of a release as numbers (non-numeric codes are dropped). */
export const codesOfRelease = (r: Pick<ReleaseFact, 'versionCodes'>): number[] =>
  (r.versionCodes ?? []).map((c) => Number(c)).filter((n) => Number.isFinite(n));

/** The highest version code of a release, or null. */
export const topCodeOf = (r: Pick<ReleaseFact, 'versionCodes'>): number | null => {
  const codes = codesOfRelease(r);
  return codes.length === 0 ? null : Math.max(...codes);
};

/** The highest of these version codes (strings), or -1 when none is a number. */
export const topOfCodes = (codes: readonly string[]): number =>
  Math.max(-1, ...codes.map((c) => Number(c)).filter((n) => Number.isFinite(n)));

export type LiveRef = { version: string; build: string | null; codes: string[] };

export type LiveFacts<R extends ReleaseFact = ReleaseFact> = {
  platform: Platform;
  /** Every serving release (see the file comment), newest first. Google Play: production only. */
  serving: R[];
  /** The serving releases that are `live`, `rolling_out` and `halted`, each newest first. */
  live: R[];
  rollingOut: R[];
  halted: R[];
  /** The release that defines "what is live": the first of `serving`; null when nothing serves. */
  newestLive: R | null;
  /** `newestLive` as version, build and codes; null when nothing serves. */
  ref: LiveRef | null;
};

const since = (r: ReleaseFact): number => r.statusSince ?? 0;

/**
 * The serving releases of one record and which one is live. `platform` decides the rule (tracks: Google Play, production only).
 * Never mutates `releases`.
 */
export function liveOf<R extends ReleaseFact>(
  releases: readonly R[],
  options: { platform: Platform },
): LiveFacts<R> {
  const play = supports(options.platform, 'releaseTracks');
  const serving = releases
    .filter((r) => isServingStatus(r.status) && (!play || isProductionTrack(r.track)))
    .sort((a, b) => {
      if (play) {
        const byCode = (topCodeOf(b) ?? -1) - (topCodeOf(a) ?? -1);
        if (byCode !== 0) return byCode;
      }
      return (
        compareVersions(b.version, a.version) ||
        compareBuildNumbers(b.build, a.build) ||
        since(b) - since(a)
      );
    });
  const withStatus = (s: ReleaseState) => serving.filter((r) => r.status === s);
  const newest = serving[0] ?? null;
  return {
    platform: options.platform,
    serving,
    live: withStatus('live'),
    rollingOut: withStatus('rolling_out'),
    halted: withStatus('halted'),
    newestLive: newest,
    ref:
      newest === null
        ? null
        : {
            version: newest.version,
            build: newest.build,
            codes: (newest.versionCodes ?? []).slice(),
          },
  };
}

export type ObsoleteReason = 'older_than_live' | 'same_as_live';

/**
 * Why this release is LEFT BEHIND by what is live, or null. Only a release still in preparation (draft, build chosen, ready) can be
 * obsolete: it can never be submitted. Apple: its version is lower than (or the same as) the live version. Google Play: its version
 * codes are all lower than the live production codes (a draft with a lower top code can never roll out).
 */
export function obsoleteReasonOf(
  release: Pick<ReleaseFact, 'version' | 'status' | 'versionCodes'>,
  live: Pick<LiveFacts, 'platform' | 'ref'>,
): ObsoleteReason | null {
  if (live.ref === null || !isPreparingStatus(release.status)) return null;
  if (supports(live.platform, 'releaseTracks')) {
    const top = topCodeOf(release);
    const liveTop = topOfCodes(live.ref.codes);
    return top !== null && liveTop >= 0 && top < liveTop ? 'older_than_live' : null;
  }
  const cmp = tryCompareVersions(release.version, live.ref.version);
  return cmp === -1 ? 'older_than_live' : cmp === 0 ? 'same_as_live' : null;
}

/** Whether this release is left behind by what is live (see `obsoleteReasonOf`). */
export const isObsolete = (
  release: Pick<ReleaseFact, 'version' | 'status' | 'versionCodes'>,
  live: Pick<LiveFacts, 'platform' | 'ref'>,
): boolean => obsoleteReasonOf(release, live) !== null;

/**
 * Whether a bare VERSION number is not newer than what is live (Apple rule; no status, no codes): true when it is lower than or the same as
 * the live version. False when it cannot be read or nothing is live (never judged).
 */
export function isObsoleteVersion(version: string, live: Pick<LiveFacts, 'ref'>): boolean {
  if (live.ref === null) return false;
  const cmp = tryCompareVersions(version, live.ref.version);
  return cmp === -1 || cmp === 0;
}

/** Whether a build (version and number) is newer than what is live: true, false, or null when it cannot be told. */
export function isNewerThanLive(
  build: { version: string | null; buildNumber: string | null },
  live: Pick<LiveFacts, 'ref'>,
): boolean | null {
  if (live.ref === null) return true;
  const cmp = tryCompareReleases(
    { version: build.version, build: build.buildNumber },
    { version: live.ref.version, build: live.ref.build },
  );
  return cmp === null ? null : cmp === 1;
}
