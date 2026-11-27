/**
 * THE version and build comparator (docs/state-model.md, "Single owners (core)"). Before this file there were six: candidates.ts
 * `compareVersionStrings`, portfolio `compareVersions`, core `compareDottedVersions`, insights `parseInt` parts, `localeCompare`
 * with `numeric: true` and `Number(buildNumber)` subtractions. They disagreed (`2.0.0-beta` vs `2.0.0` was older, unknown, NaN and
 * equal). Every ordering of versions or builds goes through here.
 *
 * WHAT A VERSION IS. Optional `v` (only before a digit), one to four dotted numbers (`2`, `2.0`, `2.00.1`, `2.0.1.90`), then an
 * optional pre-release after `-` (`-beta`, `-rc.1`) and an optional build metadata after `+` (ignored, as in semver). Numbers are
 * compared as numbers (`2.00.1` is `2.0.1`), a missing part is 0 (`1.0` equals `1.0.0`). A pre-release is LOWER than the same
 * version without one (`1.0.0-beta < 1.0.0`); pre-releases compare identifier by identifier (numbers as numbers, numbers before
 * words, words by text, a shorter list before a longer one that starts with it). Anything else (`beta`, `1.2.3.4.5`, `1.x`, an empty
 * string, null) is NOT READABLE.
 *
 * TWO FUNCTIONS, because two questions are asked:
 *  - `compareVersions(a, b)` is a TOTAL order for sorting: never null, never NaN. Unreadable values sort before every readable one
 *    (and among themselves by natural text order), so a list with an odd entry still has one stable order.
 *  - `tryCompareVersions(a, b)` is for JUDGING ("is this build newer than what is live"): null when either side is not readable, and
 *    the caller treats null as "neither older nor newer" (never obsolete, never a candidate).
 *
 * BUILD NUMBERS are whole numbers (`90`), dotted numbers (`1.2.3`) or, rarely, text (`b12`). `compareBuildNumbers` is total (numbers
 * as numbers, dotted as dotted numbers, else natural text order, null/empty lowest); `tryCompareBuildNumbers` is null when either is
 * missing or not numeric. Never subtract `Number(buildNumber)` again: it is NaN for `1.2.3` and 0 for `b12`.
 *
 * `compareReleases` orders by version, then build (the tie-break between two builds of one version).
 *
 * Pure. Written for the ES2017 web build (no flatMap, fromEntries, at()).
 */

export type Ordering = -1 | 0 | 1;

const sign = (n: number): Ordering => (n < 0 ? -1 : n > 0 ? 1 : 0);

export type ParsedVersion = {
  /** One to four numbers, trailing zeros kept (`2.00.1` is [2, 0, 1]). */
  parts: number[];
  /** The pre-release identifiers (`beta.2` is ['beta', '2']); empty for a release. */
  pre: string[];
};

const MAX_PARTS = 4;
const VERSION =
  /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i;

/** The readable parts of a version string, or null when it is not a version (see the file comment). */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (value === null || value === undefined) return null;
  const m = VERSION.exec(value.trim());
  if (m === null) return null;
  const parts = (m[1] as string).split('.').map((p) => Number(p));
  if (parts.length > MAX_PARTS || parts.some((n) => !Number.isFinite(n))) return null;
  return { parts, pre: m[2] === undefined ? [] : m[2].split('.') };
}

/** Whether `compareVersions` can order this string as a version (`tryCompareVersions` will not answer null for it). */
export const isReadableVersion = (value: string | null | undefined): boolean =>
  parseVersion(value) !== null;

const NUMERIC = /^\d+$/;

function comparePre(a: readonly string[], b: readonly string[]): Ordering {
  // No pre-release is HIGHER than any pre-release.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
    }
  }
  return sign(a.length - b.length);
}

function compareParsed(x: ParsedVersion, y: ParsedVersion): Ordering {
  const n = Math.max(x.parts.length, y.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return sign(d);
  }
  return comparePre(x.pre, y.pre);
}

/** Natural text order: digit runs as numbers, the rest case-insensitive. Total. */
export function naturalCompare(a: string, b: string): Ordering {
  const x =
    a
      .trim()
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  const y =
    b
      .trim()
      .toLowerCase()
      .match(/\d+|\D+/g) ?? [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] as string;
    const q = y[i] as string;
    if (p === q) continue;
    if (NUMERIC.test(p) && NUMERIC.test(q)) {
      const d = Number(p) - Number(q);
      if (d !== 0) return sign(d);
    } else {
      return p < q ? -1 : 1;
    }
  }
  return sign(x.length - y.length);
}

const blank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v.trim() === '';

/**
 * Orders two versions, for sorting: a TOTAL order (-1, 0, 1). Unreadable and empty values sort lowest. Use `tryCompareVersions` to
 * judge "newer than".
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): Ordering {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x !== null && y !== null) return compareParsed(x, y);
  if (x !== null) return 1;
  if (y !== null) return -1;
  if (blank(a) || blank(b)) return blank(a) && blank(b) ? 0 : blank(a) ? -1 : 1;
  return naturalCompare(a as string, b as string);
}

/** Orders two versions for a JUDGEMENT: -1, 0 or 1, or null when either is not readable (then nothing is decided about it). */
export function tryCompareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): Ordering | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x === null || y === null ? null : compareParsed(x, y);
}

/** The same version written alike or not (`2.00.1` and `2.0.1`, `2.1` and `2.1.0`). Unreadable: the trimmed texts are equal. */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const c = tryCompareVersions(a, b);
  if (c !== null) return c === 0;
  return (a ?? '').trim() === (b ?? '').trim() && !blank(a);
}

/** Newest first, for `Array.sort`: `versions.sort(newestVersionFirst)`. */
export const newestVersionFirst = (
  a: string | null | undefined,
  b: string | null | undefined,
): number => compareVersions(b, a);

// ---------------------------------------------------------------------------------------------
// Build numbers

const DOTTED_BUILD = /^\d+(\.\d+)*$/;

const buildParts = (value: string | null | undefined): number[] | null => {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!DOTTED_BUILD.test(text)) return null;
  const parts = text.split('.').map((p) => Number(p));
  return parts.some((n) => !Number.isFinite(n)) ? null : parts;
};

function comparePartLists(x: readonly number[], y: readonly number[]): Ordering {
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return sign(d);
  }
  return 0;
}

/** Orders two build numbers, for sorting (total): numbers as numbers, dotted numbers part by part, else natural text order; missing lowest. */
export function compareBuildNumbers(
  a: string | null | undefined,
  b: string | null | undefined,
): Ordering {
  const x = buildParts(a);
  const y = buildParts(b);
  if (x !== null && y !== null) return comparePartLists(x, y);
  if (x !== null) return 1;
  if (y !== null) return -1;
  if (blank(a) || blank(b)) return blank(a) && blank(b) ? 0 : blank(a) ? -1 : 1;
  return naturalCompare(a as string, b as string);
}

/** Orders two build numbers for a JUDGEMENT: null when either is missing or not a number (or dotted numbers). */
export function tryCompareBuildNumbers(
  a: string | null | undefined,
  b: string | null | undefined,
): Ordering | null {
  const x = buildParts(a);
  const y = buildParts(b);
  return x === null || y === null ? null : comparePartLists(x, y);
}

/** Newest first, for `Array.sort`. */
export const newestBuildFirst = (
  a: string | null | undefined,
  b: string | null | undefined,
): number => compareBuildNumbers(b, a);

// ---------------------------------------------------------------------------------------------
// Version and build together

export type VersionBuild = { version: string | null | undefined; build: string | null | undefined };

/** Total order of two releases or builds: the version first, the build number as the tie-break between two builds of one version. */
export function compareReleases(a: VersionBuild, b: VersionBuild): Ordering {
  const v = compareVersions(a.version, b.version);
  return v !== 0 ? v : compareBuildNumbers(a.build, b.build);
}

/**
 * Judges `a` against `b` by version, then build. Null when the versions cannot be read; two equal versions whose builds cannot be read
 * (a missing build) are a tie (0), never newer.
 */
export function tryCompareReleases(a: VersionBuild, b: VersionBuild): Ordering | null {
  const v = tryCompareVersions(a.version, b.version);
  if (v === null) return null;
  if (v !== 0) return v;
  return tryCompareBuildNumbers(a.build, b.build) ?? 0;
}

/** Newest first, for `Array.sort`. */
export const newestReleaseFirst = (a: VersionBuild, b: VersionBuild): number =>
  compareReleases(b, a);

// ---------------------------------------------------------------------------------------------
// What the stores accept as a NEW version

const CREATABLE = /^[0-9]{1,9}(\.[0-9]{1,9}){0,2}$/;

/**
 * Whether the store takes this string as the marketing version of a NEW App Store version: one to three whole numbers separated by
 * periods, nothing else (no `v`, no suffix, no fourth part). The server refuses anything else (`invalid_version`), so a screen asks
 * this before offering "create". (`isReadableVersion` is wider: 4 parts and pre-releases can be ordered but not created.)
 */
export const isCreatableVersion = (value: string): boolean => CREATABLE.test(value);
