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
 *
 * When no build date is known the code says WHY (`builtGap`), in a fixed vocabulary, so the page can be specific instead of "not known":
 * no CI file read for the code (`not_read`), the file read but GitHub no longer has it and no date was kept (`file_gone`), GitHub
 * could not be read (`github_unreachable`, `github_no_access`), no repository linked (`no_repository`). `firstSeenAt` is when Kiln's
 * own store sync first saw the code: not a build date and never used as one. A file matched on its build number alone (its package is not
 * the app's) says so in `matchedBy`.
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
  /** Why `builtAt` is null (never set when it is known). */
  builtGap: BuiltGap | null;
  /** When the CI file is gone: when GitHub deleted (or deletes) it, if known. */
  ciExpiredAt: number | null;
  /** `package`: the file's package is the app's; `build_number_only`: only its build number matched (its package differs); null: no file. */
  matchedBy: 'package' | 'build_number_only' | null;
  /** Epoch milliseconds Kiln's store sync first saw this code. NOT a build date: Google Play gives none. Null: never synced. */
  firstSeenAt: number | null;
};

export type BuiltGap =
  | 'not_read'
  | 'file_gone'
  | 'github_unreachable'
  | 'github_no_access'
  | 'no_repository';

/** Why the artifact list could not be read, in the vocabulary of the builds module. */
export type ListingState = 'ok' | 'not_asked' | 'unreachable' | 'no_access' | 'no_repository';

/** One CI artifact whose file was read. `createdAt` and `run` are null when GitHub no longer lists the artifact. */
export type OriginArtifact = {
  artifactId: string;
  number: string;
  version: string | null;
  packageId: string | null;
  createdAt: number | null;
  run: OriginCi | null;
  /** When GitHub deletes (or deleted) the file, when known. */
  expiresAt?: number | null;
};

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
};

export const NO_ORIGIN_SOURCES: OriginSources = { artifacts: [], store: [] };

const NONE: CodeOrigin = {
  version: null,
  builtAt: null,
  origin: null,
  builtFrom: null,
  builtGap: null,
  ciExpiredAt: null,
  matchedBy: null,
  firstSeenAt: null,
};

const GAP_OF_LISTING: Record<Exclude<ListingState, 'ok'>, BuiltGap> = {
  not_asked: 'github_unreachable',
  unreachable: 'github_unreachable',
  no_access: 'github_no_access',
  no_repository: 'no_repository',
};

const samePackage = (a: string | null, b: string): boolean =>
  a === null || a.trim().toLowerCase() === b.trim().toLowerCase();

/** The origin of one version code. `packageId` is the app's package: an artifact of another package never matches. */
export function originOfCode(
  code: Pick<CodeCandidate, 'versionCode' | 'inTrack'>,
  sources: OriginSources,
  packageId: string,
): CodeOrigin {
  // Several artifacts can carry one code (a re-run): the earliest is the build that could have been uploaded first.
  const byEarliest = (a: OriginArtifact, b: OriginArtifact) =>
    (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY) ||
    a.artifactId.localeCompare(b.artifactId);
  const sameCode = sources.artifacts.filter((a) => a.number === code.versionCode);
  let hits = sameCode.filter((a) => samePackage(a.packageId, packageId)).sort(byEarliest);
  let matchedBy: CodeOrigin['matchedBy'] = hits.length > 0 ? 'package' : null;
  // The package of the file is not the app's (a flavor or suffix such as `.beta`): when exactly one file of the app has this code it
  // is still the best answer, said to be matched on the build number alone.
  if (hits.length === 0 && sameCode.length === 1) {
    hits = sameCode;
    matchedBy = 'build_number_only';
  }
  const ci = hits.filter((a) => a.createdAt !== null)[0] ?? hits[0];
  const store = sources.store.filter((b) => b.buildNumber === code.versionCode)[0];
  const named = code.inTrack.map((r) => (r.name ?? '').trim()).filter((n) => n !== '')[0];

  const ciVersion = hits
    .map((a) => a.version)
    .filter((v): v is string => v !== null && v !== '')[0];
  const builtAt = ci?.createdAt ?? null;
  const out: CodeOrigin = { ...NONE, matchedBy, firstSeenAt: store?.firstSeenAt ?? null };
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
  if (out.builtAt === null) {
    if (hits.length === 0) {
      out.builtGap = sources.ciLinked === false ? 'no_repository' : 'not_read';
    } else {
      const listing = sources.listing ?? 'ok';
      out.builtGap = listing === 'ok' ? 'file_gone' : GAP_OF_LISTING[listing];
      out.ciExpiredAt =
        hits.map((a) => a.expiresAt ?? null).filter((v): v is number => v !== null)[0] ?? null;
    }
  }
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
