import type { BuildCandidate, ReleaseCandidates } from '@kiln/connectors';
import {
  analyzeCandidates,
  type CreateRefusal,
  createReleaseRules,
  type StoreBuildFact,
  storeVersionsOf,
} from '@kiln/core';
import type { AppRelease } from '../../services/apps.ts';

/**
 * What the rules of @kiln/core say about each App Store build of `GET release/candidates`, so the page never offers an action that ends in
 * a refusal (docs/state-model.md, "Single owners (core)"):
 *
 *  - `create`: whether a version named like the build can be CREATED now (`createReleaseRules`: the same function the web asks and the
 *    server's own checks use), with the refusal(s), the editable version in the way and the version it has to be higher than. A build
 *    with no editable version to attach to used to say only "create the next version in App Store Connect first".
 *  - `eligibility` turns `in_flight` (blocked: the build is already used by a version in review or approved) or `older_than_live`
 *    (a warning: the build is not newer than what is live) when `analyzeCandidates` says so. The rest of the connector's verdict
 *    (expired, processing, wrong version ...) stays as it is: it is judged first.
 *
 * The versions are the ones Kiln synced (an approximation of the store's list, see `storeVersionsOf`); the create call itself stays the
 * authority and refuses with the same codes. Google Play reads pass through.
 */

export type CreateVerdict = {
  /** The version of the build, which the verdict is about. */
  version: string;
  creatable: boolean;
  /** The first refusal, null when creatable. */
  refusal: CreateRefusal | null;
  reasons: CreateRefusal[];
  /** `editable_version_exists`: the version that can still be edited (attach the build there). */
  editableVersion: string | null;
  /** `not_higher`: the newest version that cannot be edited. */
  newestFixed: string | null;
};

/** The refusal in one plain sentence (the wording of the create call's own checks, shortened). */
export function refusalSentence(v: CreateVerdict): string {
  switch (v.refusal) {
    case 'editable_version_exists':
      return `Version ${v.editableVersion ?? 'being prepared'} can still be edited, so there is no need for another. Attach the build to it.`;
    case 'version_exists':
      return `Version ${v.version} already exists in App Store Connect.`;
    case 'not_higher':
      return `${v.version} must be higher than ${v.newestFixed ?? 'the newest version that cannot be edited'}, the newest version in App Store Connect that cannot be edited.`;
    case 'invalid_version':
      return `${v.version} is not a version App Store Connect accepts: use one to three numbers separated by periods, for example 3.1.2.`;
    default:
      return '';
  }
}

export type BuildWithRules = BuildCandidate & { create: CreateVerdict | null };

const factOf = (b: BuildCandidate): StoreBuildFact => ({
  buildNumber: b.buildNumber ?? '',
  version: b.version,
  state: b.processingState === 'VALID' ? 'processed' : b.processingState === 'PROCESSING' ? 'processing' : 'invalid',
  expired: b.expired,
  uploadedAt: b.uploadedDate !== null && Number.isFinite(Date.parse(b.uploadedDate)) ? Date.parse(b.uploadedDate) : null,
  channel: 'testflight',
  tracks: [],
});

export function createVerdictOf(version: string, releases: readonly AppRelease[]): CreateVerdict {
  const check = createReleaseRules(version, storeVersionsOf(releases));
  if (check.ok)
    return { version, creatable: true, refusal: null, reasons: [], editableVersion: null, newestFixed: null };
  return {
    version,
    creatable: false,
    refusal: check.reason,
    reasons: check.reasons,
    editableVersion: check.editableVersion ?? null,
    newestFixed: check.newestFixed ?? null,
  };
}

/** The App Store builds of the read with the rules of core applied; a Google Play read is returned as it is. */
export function withReleaseRules(
  read: ReleaseCandidates,
  input: { appId: string; releases: readonly AppRelease[] },
): ReleaseCandidates {
  if (read.store !== 'appstoreconnect') return read;
  const analysis = analyzeCandidates({
    appId: input.appId,
    platform: read.platform,
    releases: input.releases.map((r) => ({ ...r })),
    builds: read.builds.filter((b) => b.buildNumber !== null).map(factOf),
  });
  const builds: BuildWithRules[] = read.builds.map((b) => {
    const candidate = analysis.candidates.find((c) => c.buildNumber === b.buildNumber);
    let eligibility = b.eligibility;
    if (candidate !== undefined && candidate.obsolete === true && b.eligibility.eligible) {
      const name = b.buildNumber !== null ? `Build ${b.buildNumber}` : 'This build';
      if (candidate.reason === 'in_flight')
        eligibility = {
          eligible: false,
          severity: 'blocked',
          code: 'in_flight',
          message: `${name} is already used by a version that is in review or waiting to be released. Upload a new build.`,
        };
      else if (candidate.reason === 'older_than_live' || candidate.reason === 'same_as_live')
        eligibility = {
          eligible: true,
          severity: 'warning',
          code: 'older_than_live',
          message: `${name} is not newer than what is live${analysis.live !== null ? ` (${analysis.live.version}${analysis.live.build !== null ? `, build ${analysis.live.build}` : ''})` : ''}. It would not be an update for users.`,
        };
    }
    const create = b.version !== null && b.version !== '' ? createVerdictOf(b.version, input.releases) : null;
    // "Create the next version in App Store Connect first" was a dead end: say whether this app can create it, or why it cannot.
    if (eligibility.code === 'no_editable_version' && create !== null) {
      const name = b.buildNumber !== null ? `Build ${b.buildNumber}` : 'This build';
      eligibility = {
        ...eligibility,
        message: create.creatable
          ? `${name} is processed, but there is no version in "Prepare for Submission" to attach it to. Create version ${create.version} from this page first.`
          : `${name} is processed, but there is no version in "Prepare for Submission" to attach it to, and version ${create.version} cannot be created: ${refusalSentence(create)}`,
      };
    }
    return { ...b, eligibility, create };
  });
  return { ...read, builds };
}
