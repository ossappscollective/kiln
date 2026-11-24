import type { ReleaseSummary } from '../types.ts';
import type { EasBuildView, EasStatusView, EasSubmissionView, EasUpdateView } from './eas-status.ts';

/**
 * The EAS build and store submission of a release (docs/ux-ia.md, docs/api/eas-builds.md): which stored EAS build is the one of a store
 * release, and the steps it gives (build finished, submitted, in store review). Matching is by platform and version, then by build number
 * (App Store: the build of the release; Google Play: one of its version codes). When that does not single out ONE build, there is no match
 * and nothing is shown: a guess would put the wrong build in a release. Pure; written for the ES2017 web build.
 */

export type ReleaseEasStepId = 'built' | 'submitted' | 'review';
export type ReleaseEasStepState = 'done' | 'current' | 'failed' | 'todo';
export type ReleaseEasStep = { id: ReleaseEasStepId; state: ReleaseEasStepState; at: number | null };

export type ReleaseEasMatch = {
  build: EasBuildView;
  submission: EasSubmissionView | null;
  steps: ReleaseEasStep[];
  /** The OTA update that shipped with this runtime version on the build's channel, only when that is certain; else null. */
  ota: EasUpdateView | null;
};

type ReleaseLike = Pick<ReleaseSummary, 'platform' | 'version' | 'build' | 'versionCodes' | 'status'>;

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.trim() !== '' && a.trim() === b.trim();

const newest = <T extends { createdAt: number | null }>(list: readonly T[]): T | null =>
  list.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;

/** Builds that could be the store build: same platform and version, made for a store (not internal, not a simulator). */
function candidates(release: ReleaseLike, builds: readonly EasBuildView[]): EasBuildView[] {
  return builds.filter(
    (b) =>
      b.platform === release.platform &&
      same(b.appVersion, release.version) &&
      !b.internal &&
      b.simulator !== true &&
      b.distribution !== 'internal' &&
      b.distribution !== 'simulator',
  );
}

/** The build numbers the release names: the build of an App Store release, the version codes of a Google Play one. */
const releaseNumbers = (release: ReleaseLike): string[] => {
  const out: string[] = [];
  if (release.build) out.push(release.build);
  for (const code of release.versionCodes ?? []) out.push(code);
  return out;
};

/** The one EAS build of the release, or null when none is certain. */
export function matchBuild(release: ReleaseLike, builds: readonly EasBuildView[]): EasBuildView | null {
  const list = candidates(release, builds);
  const numbers = releaseNumbers(release);
  if (numbers.length > 0) {
    const named = list.filter((b) => numbers.some((n) => same(n, b.buildNumber)));
    // Finished builds first: a retried build number may have an errored attempt next to the good one.
    const finished = named.filter((b) => b.status === 'finished');
    return newest(finished.length > 0 ? finished : named);
  }
  // The release names no number: only a version that has exactly one build number (among builds that finished or are running) is certain.
  const live = list.filter((b) => b.status === 'finished' || b.active);
  const distinct: string[] = [];
  for (const b of live) {
    if (!b.buildNumber) return null;
    if (distinct.indexOf(b.buildNumber) < 0) distinct.push(b.buildNumber);
  }
  if (distinct.length !== 1) return null;
  return newest(live);
}

/** The submission of this build (by build id: never by version alone). A finished one wins over an older failed attempt. */
export function matchSubmission(
  build: EasBuildView,
  submissions: readonly EasSubmissionView[],
): EasSubmissionView | null {
  const mine = submissions.filter((s) => s.buildId === build.id && s.platform === build.platform);
  const done = mine.filter((s) => s.status === 'finished');
  return newest(done.length > 0 ? done : mine);
}

const IN_REVIEW_DONE: readonly string[] = ['approved', 'propagating', 'rolling_out', 'live', 'halted'];

/** The three steps. Review comes from the store state of the release (read by the sync), not from Expo. */
export function releaseSteps(
  release: Pick<ReleaseLike, 'status'>,
  build: EasBuildView,
  submission: EasSubmissionView | null,
): ReleaseEasStep[] {
  const built: ReleaseEasStepState =
    build.status === 'finished' ? 'done' : build.status === 'errored' || build.status === 'canceled' ? 'failed' : 'current';
  let submitted: ReleaseEasStepState = 'todo';
  if (submission) {
    submitted =
      submission.status === 'finished'
        ? 'done'
        : submission.status === 'errored' || submission.status === 'canceled'
          ? 'failed'
          : 'current';
  }
  let review: ReleaseEasStepState = 'todo';
  if (release.status === 'in_review') review = 'current';
  else if (release.status === 'rejected') review = 'failed';
  else if (release.status !== null && IN_REVIEW_DONE.indexOf(release.status) >= 0) review = 'done';
  return [
    { id: 'built', state: built, at: build.completedAt ?? build.createdAt },
    { id: 'submitted', state: submitted, at: submission ? (submission.completedAt ?? submission.createdAt) : null },
    { id: 'review', state: review, at: null },
  ];
}

/**
 * The stored OTA update of the matched build: the current update of the channel baked into the build, when it is for the platform of the build
 * and has exactly the runtime version of the build. A build without a channel or a runtime version, a channel with no stored current update, or
 * an update of another runtime version (it reaches no binary of this release) give null: nothing is shown rather than a guess.
 */
export function matchOta(build: EasBuildView, status: EasStatusView): EasUpdateView | null {
  if (!build.channel || build.channel.trim() === '' || !build.runtimeVersion || build.runtimeVersion.trim() === '') return null;
  const channel = (status.updates?.channels ?? []).filter((c) => same(c.channel, build.channel));
  if (channel.length !== 1) return null;
  const update = channel[0]?.current ?? null;
  if (update === null || update.platform !== build.platform || !same(update.runtimeVersion, build.runtimeVersion)) return null;
  return update;
}

/**
 * The match of a release in a stored snapshot, or null: no snapshot, an app that is not linked to Expo, an unsupported platform, or no
 * single confident build.
 */
export function matchRelease(release: ReleaseLike, status: EasStatusView | null | undefined): ReleaseEasMatch | null {
  if (!status || status.project === null || !status.supported) return null;
  if (release.platform !== 'ios' && release.platform !== 'android') return null;
  const build = matchBuild(release, status.builds);
  if (build === null) return null;
  const submission = matchSubmission(build, status.submissions);
  return { build, submission, steps: releaseSteps(release, build, submission), ota: matchOta(build, status) };
}
