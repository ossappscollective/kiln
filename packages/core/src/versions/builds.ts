/**
 * Where a store build comes from: its version name, its number (build number / version code), when it was built and by whom. ONE join
 * for TestFlight builds and Google Play version codes (docs/state-model.md, "Single owners (core)"). Moved here from the server's
 * `candidate-origin.ts` (`originOfCode`, Play only, exposed on one route) so the Test builds page, the Publish summary, the build picker and
 * the candidate train read the same answer; before, five surfaces answered "Build date not known" from five different joins.
 *
 * A store gives a build number and (Apple) an upload time, or (Google Play) a code and a sha only, so this is a join of what Kiln
 * knows, never a guess:
 *   1. `ci`: a CI artifact whose file was read by Kiln (`ci_artifact_meta`) with this build number and this package. It gives the
 *      version name; the date is when GitHub created the artifact (the build), and the run it came from.
 *   2. `store`: the store build Kiln synced (`app_builds`): its version and, when the store gave one, the upload time.
 *   3. `release`: the name of the release that holds the code (Play). A name somebody typed, not read from the file, and never a date.
 * The version comes from the first of these that has one; the date from `ci`, else `store`. `firstSeenAt` (when Kiln's own sync first saw
 * the build) is NOT a build date and is never used as one.
 *
 * When no build date is known the result says WHY (`builtGap`), in a fixed vocabulary, so a page can be specific instead of "not known".
 *
 * Pure: no database, no network. ES2017.
 */

export type BuildCi = {
  runNumber: number | null;
  branch: string | null;
  /** The short commit of the run. */
  commit: string | null;
  url: string | null;
};

export type BuiltGap =
  | 'not_read'
  /** No CI file was read for this build AND this server does not read builds (`KILN_BUILDS_DOWNLOAD_ENABLED` is off): enabling it is the way to a date. */
  | 'reads_disabled'
  | 'file_gone'
  | 'github_unreachable'
  | 'github_no_access'
  | 'no_repository';

/** Why the artifact list could not be read. */
export type ArtifactListingState =
  | 'ok'
  | 'not_asked'
  | 'unreachable'
  | 'no_access'
  | 'no_repository';

/** One CI artifact whose file was read (`ci_artifact_meta`). `createdAt` and `run` are null when GitHub no longer lists the artifact. */
export type ArtifactMeta = {
  artifactId: string;
  /** The build number or version code read from inside the file. */
  number: string;
  version: string | null;
  packageId: string | null;
  createdAt: number | null;
  run: BuildCi | null;
  /** When GitHub deletes (or deleted) the file, when known. */
  expiresAt?: number | null | undefined;
};

/** One store build row Kiln synced (`app_builds`) or one version code of a Play track. */
export type BuildRowFact = {
  /** The build number (TestFlight) or version code (Google Play). */
  buildNumber: string;
  version: string | null;
  uploadedAt: number | null;
  /** When Kiln's sync first saw the build. */
  firstSeenAt?: number | null | undefined;
  /** Google Play: the names of the releases (in the asked track) that hold the code. */
  releaseNames?: readonly (string | null)[] | undefined;
};

export type BuildOriginSources = {
  artifacts: readonly ArtifactMeta[];
  /** Whether the artifact list could be read. Default `not_asked`. */
  listing?: ArtifactListingState | undefined;
  /** The app has a CI repository linked. Default true. */
  ciLinked?: boolean | undefined;
  /** The app's package or bundle id: an artifact of another package does not match (unless it is the only one with the number). */
  packageId?: string | null | undefined;
  /**
   * Whether this server reads builds from CI at all (`KILN_BUILDS_DOWNLOAD_ENABLED`). Default true. When false and no file was read for a
   * build, the gap is `reads_disabled`, never the vaguer `not_read`: nothing will ever fill the date until it is turned on.
   */
  readsEnabled?: boolean | undefined;
};

export const NO_ORIGIN_SOURCES: BuildOriginSources = { artifacts: [] };

export type BuildOrigin = {
  buildNumber: string;
  /** versionName (`ci`, `store`) or the name of the release (`release`); null: not known. */
  version: string | null;
  /** Epoch milliseconds the build was made (`ci`) or uploaded (`store`); null: not known. */
  builtAt: number | null;
  /** Where `version` came from, else where `builtAt` came from; null when neither is known. */
  origin: 'ci' | 'store' | 'release' | null;
  /** Where `builtAt` came from. */
  builtFrom: 'ci' | 'store' | null;
  ci?: BuildCi | undefined;
  /** Why `builtAt` is null (never set when it is known). */
  builtGap: BuiltGap | null;
  /** When the CI file is gone: when GitHub deleted (or deletes) it, if known. */
  ciExpiredAt: number | null;
  /** `package`: the file's package is the app's; `build_number_only`: only its number matched; null: no file. */
  matchedBy: 'package' | 'build_number_only' | null;
  /** When Kiln's store sync first saw this build. NOT a build date. */
  firstSeenAt: number | null;
};

const GAP_OF_LISTING: Record<Exclude<ArtifactListingState, 'ok'>, BuiltGap> = {
  not_asked: 'github_unreachable',
  unreachable: 'github_unreachable',
  no_access: 'github_no_access',
  no_repository: 'no_repository',
};

const samePackage = (a: string | null, b: string | null | undefined): boolean =>
  a === null || b === null || b === undefined || a.trim().toLowerCase() === b.trim().toLowerCase();

/** The origin of ONE store build (a TestFlight row or a Play version code). */
export function originOfBuild(
  row: BuildRowFact,
  sources: BuildOriginSources = NO_ORIGIN_SOURCES,
): BuildOrigin {
  // Several artifacts can carry one number (a re-run): the earliest is the build that could have been uploaded first.
  const byEarliest = (a: ArtifactMeta, b: ArtifactMeta) =>
    (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY) ||
    (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0);
  const sameNumber = sources.artifacts.filter((a) => a.number === row.buildNumber);
  let hits = sameNumber.filter((a) => samePackage(a.packageId, sources.packageId)).sort(byEarliest);
  let matchedBy: BuildOrigin['matchedBy'] = hits.length > 0 ? 'package' : null;
  // The package of the file is not the app's (a flavor or suffix such as `.beta`): when exactly one file has this number it is still the
  // best answer, said to be matched on the number alone.
  if (hits.length === 0 && sameNumber.length === 1) {
    hits = sameNumber;
    matchedBy = 'build_number_only';
  }
  const ci = hits.filter((a) => a.createdAt !== null)[0] ?? hits[0];
  const named = (row.releaseNames ?? []).map((n) => (n ?? '').trim()).filter((n) => n !== '')[0];
  const ciVersion = hits
    .map((a) => a.version)
    .filter((v): v is string => v !== null && v !== '')[0];
  const out: BuildOrigin = {
    buildNumber: row.buildNumber,
    version: null,
    builtAt: null,
    origin: null,
    builtFrom: null,
    builtGap: null,
    ciExpiredAt: null,
    matchedBy,
    firstSeenAt: row.firstSeenAt ?? null,
  };
  if (ci?.createdAt !== null && ci?.createdAt !== undefined) {
    out.builtAt = ci.createdAt;
    out.builtFrom = 'ci';
  } else if (row.uploadedAt !== null) {
    out.builtAt = row.uploadedAt;
    out.builtFrom = 'store';
  }
  if (ciVersion !== undefined) {
    out.version = ciVersion;
    out.origin = 'ci';
  } else if (row.version !== null && row.version !== '') {
    out.version = row.version;
    out.origin = 'store';
  } else if (named !== undefined) {
    out.version = named;
    out.origin = 'release';
  } else {
    out.origin = out.builtFrom;
  }
  if (ci?.run) out.ci = ci.run;
  if (out.builtAt === null) {
    if (hits.length === 0) {
      out.builtGap =
        sources.ciLinked === false
          ? 'no_repository'
          : sources.readsEnabled === false
            ? 'reads_disabled'
            : 'not_read';
    } else {
      const listing = sources.listing ?? 'ok';
      out.builtGap = listing === 'ok' ? 'file_gone' : GAP_OF_LISTING[listing];
      out.ciExpiredAt =
        hits.map((a) => a.expiresAt ?? null).filter((v): v is number => v !== null)[0] ?? null;
    }
  }
  return out;
}

/**
 * The origin of every build row: each row with its origin joined on (version name, number, date, where each came from, why a date is
 * missing). The one function TestFlight rows and Play version codes both go through. Order of `rows` is kept.
 */
export function joinBuildOrigin<T extends BuildRowFact>(
  rows: readonly T[],
  sources: BuildOriginSources = NO_ORIGIN_SOURCES,
): (T & BuildOrigin)[] {
  return rows.map((row) => ({ ...row, ...originOfBuild(row, sources) }) as T & BuildOrigin);
}

/**
 * The build number of a build row, from its STRUCTURED fields only: `buildNumber`, else `versionCode`, else `number`. NEVER parsed out of
 * a title: titles are translated ("Build 240", "Compilación 240") and the old `buildNumberOfTitle` silently returned null in Spanish.
 * Null when the row has none (a CI artifact whose file was not read) or it is blank.
 */
export function buildNumberOfBuild(build: {
  buildNumber?: string | number | null | undefined;
  versionCode?: string | number | null | undefined;
  number?: string | number | null | undefined;
}): string | null {
  for (const value of [build.buildNumber, build.versionCode, build.number]) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
}
