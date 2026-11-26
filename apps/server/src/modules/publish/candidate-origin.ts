import type { CodeCandidate, ReleaseCandidates } from '@kiln/connectors';

/**
 * Where a Google Play version code comes from: which version it is and when it was built (docs/api/releases-write.md, "origin of a
 * code"). Google Play gives a version code and its sha only, so this is a join of what Kiln knows, never a guess:
 *   1. `ci`: a CI artifact whose file was read by Kiln (`ci_artifact_meta`, read from the Test builds page) with this version code
 *      and this package. It gives the versionName; the date is when GitHub created the artifact (the build), and the run it came from.
 *   2. `store`: the store build Kiln synced (`app_builds`): its version and, when the store gave one, the upload time.
 *   3. `release`: the name of the release of the asked track that holds the code. A name somebody typed, not read from the file,
 *      and not a date: nothing here is a build date.
 * The version comes from the first of these that has one; the date from `ci`, else `store`. Pure: no database, no network.
 */

export type OriginCi = {
  runNumber: number | null;
  branch: string | null;
  /** The short commit of the run. */
  commit: string | null;
  url: string | null;
};

export type CodeOrigin = {
  /** versionName (`ci`, `store`) or the name of the release (`release`); null: not known. */
  version: string | null;
  /** Epoch milliseconds the build was made (`ci`: artifact created) or uploaded (`store`); null: not known. */
  builtAt: number | null;
  /**
   * Where `version` came from, else where `builtAt` came from; null when neither is known. Not called `source`: a code's own
   * `source` is `bundle` or `apk`.
   */
  origin: 'ci' | 'store' | 'release' | null;
  /** Where `builtAt` came from. */
  builtFrom: 'ci' | 'store' | null;
  /** The CI run that made the file, when a cache hit has it. */
  ci?: OriginCi;
};

/** One CI artifact whose file was read. `createdAt` and `run` are null when GitHub no longer lists the artifact. */
export type OriginArtifact = {
  artifactId: string;
  number: string;
  version: string | null;
  packageId: string | null;
  createdAt: number | null;
  run: OriginCi | null;
};

/** One store build Kiln synced (`app_builds`). */
export type OriginStoreBuild = {
  buildNumber: string;
  version: string | null;
  uploadedAt: number | null;
};

export type OriginSources = {
  artifacts: readonly OriginArtifact[];
  store: readonly OriginStoreBuild[];
};

export const NO_ORIGIN_SOURCES: OriginSources = { artifacts: [], store: [] };

const NONE: CodeOrigin = { version: null, builtAt: null, origin: null, builtFrom: null };

/** The origin of one version code. `packageId` is the app's package: an artifact of another package never matches. */
export function originOfCode(
  code: Pick<CodeCandidate, 'versionCode' | 'inTrack'>,
  sources: OriginSources,
  packageId: string,
): CodeOrigin {
  // Several artifacts can carry one code (a re-run): the earliest is the build that could have been uploaded first.
  const hits = sources.artifacts
    .filter((a) => a.number === code.versionCode && (a.packageId === null || a.packageId === packageId))
    .sort(
      (a, b) =>
        (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY) ||
        a.artifactId.localeCompare(b.artifactId),
    );
  const ci = hits.filter((a) => a.createdAt !== null)[0] ?? hits[0];
  const store = sources.store.filter((b) => b.buildNumber === code.versionCode)[0];
  const named = code.inTrack.map((r) => (r.name ?? '').trim()).filter((n) => n !== '')[0];

  const ciVersion = hits.map((a) => a.version).filter((v): v is string => v !== null && v !== '')[0];
  const builtAt = ci?.createdAt ?? null;
  const out: CodeOrigin = { ...NONE };
  if (builtAt !== null) {
    out.builtAt = builtAt;
    out.builtFrom = 'ci';
  } else if (store?.uploadedAt !== null && store?.uploadedAt !== undefined) {
    out.builtAt = store.uploadedAt;
    out.builtFrom = 'store';
  }
  if (ciVersion !== undefined) {
    out.version = ciVersion;
    out.origin = 'ci';
  } else if (store?.version) {
    out.version = store.version;
    out.origin = 'store';
  } else if (named !== undefined) {
    out.version = named;
    out.origin = 'release';
  } else {
    out.origin = out.builtFrom;
  }
  if (ci?.run) out.ci = ci.run;
  return out;
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
