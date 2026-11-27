import type { CodeCandidate, ReleaseCandidates } from '@kiln/connectors';
import {
  type ArtifactListingState,
  type ArtifactMeta,
  type BuildCi,
  type BuildOrigin,
  type BuiltGap,
  originOfBuild,
} from '@kiln/core';

/**
 * Where a Google Play version code comes from: which version it is and when it was built (docs/api/releases-write.md, "origin of a
 * code"). The JOIN itself is `originOfBuild` / `joinBuildOrigin` of @kiln/core (the one owner for TestFlight builds and Play codes:
 * docs/state-model.md, "Single owners (core)"; its file comment explains the three sources and the vocabulary of `builtGap`). This file
 * only maps what the server reads (`ci_artifact_meta`, `app_builds`, the release names of a track) onto it and keeps the flat shape the
 * candidates route has always returned.
 */

export type OriginCi = BuildCi;
export type BuiltGapCode = BuiltGap;
export type { BuiltGap };

/** The origin of a code: the shared join without the number (the code carries its own). */
export type CodeOrigin = Omit<BuildOrigin, 'buildNumber'>;

/** Why the artifact list could not be read, in the vocabulary of the builds module. */
export type ListingState = ArtifactListingState;

/** One CI artifact whose file was read. `createdAt` and `run` are null when GitHub no longer lists the artifact. */
export type OriginArtifact = ArtifactMeta;

/** One store build Kiln synced (`app_builds`). */
export type OriginStoreBuild = {
  buildNumber: string;
  version: string | null;
  uploadedAt: number | null;
  /** When Kiln's sync first saw the code. */
  firstSeenAt?: number | null;
};

export type OriginSources = {
  artifacts: readonly OriginArtifact[];
  store: readonly OriginStoreBuild[];
  /** Whether the artifact list could be read (it is asked when at least one file was read). Default `not_asked`. */
  listing?: ListingState;
  /** The app has a CI repository linked. Default true. */
  ciLinked?: boolean;
  /** This server reads builds from CI (`KILN_BUILDS_DOWNLOAD_ENABLED`). Default true. */
  readsEnabled?: boolean;
};

export const NO_ORIGIN_SOURCES: OriginSources = { artifacts: [], store: [] };

/** The origin of one version code. `packageId` is the app's package: an artifact of another package never matches. */
export function originOfCode(
  code: Pick<CodeCandidate, 'versionCode' | 'inTrack'>,
  sources: OriginSources,
  packageId: string,
): CodeOrigin {
  const store = sources.store.filter((b) => b.buildNumber === code.versionCode)[0];
  const { buildNumber: _number, ...origin } = originOfBuild(
    {
      buildNumber: code.versionCode,
      version: store?.version ? store.version : null,
      uploadedAt: store?.uploadedAt ?? null,
      firstSeenAt: store?.firstSeenAt ?? null,
      releaseNames: code.inTrack.map((r) => r.name ?? null),
    },
    {
      artifacts: sources.artifacts,
      listing: sources.listing,
      ciLinked: sources.ciLinked,
      readsEnabled: sources.readsEnabled,
      packageId,
    },
  );
  return origin;
}

/** The candidates of a Google Play read with the origin of each code added (flat, additive). App Store reads pass through. */
export function withOrigins(
  read: ReleaseCandidates,
  sources: OriginSources,
  packageId: string,
): ReleaseCandidates {
  if (read.store !== 'googleplay') return read;
  return {
    ...read,
    codes: read.codes.map((c) => ({ ...c, ...originOfCode(c, sources, packageId) })),
  };
}
