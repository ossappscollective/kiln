/**
 * App Store version strings (docs/api/store-version.md, docs/adr/0031-create-app-store-version.md): the pure rules for creating
 * the next version from this app. Apple's marketing version (`CFBundleShortVersionString`) is one to three numbers separated by
 * periods. Nothing here talks to a store; the server and the web app share it.
 */

import { compareVersions, isCreatableVersion } from '../versions/compare.ts';

/**
 * True for "3", "3.1" and "3.1.2": one to three whole numbers separated by periods, nothing else.
 * Same function as `isCreatableVersion` (versions/compare.ts), the one owner of the rule.
 */
export const isDottedVersion = (value: string): boolean => isCreatableVersion(value);

const partsOf = (value: string): number[] => value.split('.').map((p) => Number(p));

/**
 * Compares two dotted versions numerically, a missing part counting as 0 ("3.1" equals "3.1.0"). Negative: `a` is lower.
 * Strings that are not dotted versions are not ordered: the caller checks `isDottedVersion` first (NaN is returned otherwise).
 *
 * @deprecated Delegates to `compareVersions` / `tryCompareVersions` (versions/compare.ts), the one comparator. Kept for the server's
 * create-version checks until they import it directly.
 */
export function compareDottedVersions(a: string, b: string): number {
  if (!isDottedVersion(a) || !isDottedVersion(b)) return Number.NaN;
  return compareVersions(a, b);
}

/**
 * The version a person most likely wants next, from the newest version the store lists: the patch number goes up by one.
 * 3.1.1 -> 3.1.2, 3.1 -> 3.1.1, 2 -> 2.0.1. No version yet (null or empty): 1.0. A version that is not a dotted number
 * ("2.0-beta"): the empty string, so the person types one.
 */
export function nextVersion(live: string | null | undefined): string {
  const text = (live ?? '').trim();
  if (text === '') return '1.0';
  if (!isDottedVersion(text)) return '';
  const [major = 0, minor = 0, patch = 0] = partsOf(text);
  return `${major}.${minor}.${patch + 1}`;
}

/** The newest dotted version of a list (others are ignored), or null. */
export function newestDottedVersion(
  versions: readonly (string | null | undefined)[],
): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (typeof v !== 'string' || !isDottedVersion(v)) continue;
    if (best === null || compareDottedVersions(v, best) > 0) best = v;
  }
  return best;
}
