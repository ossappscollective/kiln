import { EXPO_LOCALES, isLocaleDir } from '@mrm/connectors';
import type { Platform } from '@mrm/core';

/**
 * Locale codes between the store and the repository, as pure functions.
 *
 * The stores and fastlane mostly use the same codes: App Store Connect and `deliver` share
 * `en-US`, `de-DE`, `zh-Hans`, `ja`; Google Play and `supply` share `en-US`, `zh-CN`, `ja-JP`,
 * `es-419`, `iw-IL`. The differences that remain are the reason this exists:
 *
 * - separator and case: `en_US` and `en-us` are `en-US`;
 * - the same language written the way the other store writes it (an App Store code in an Android
 *   folder or the other way round): `zh-Hans` and `zh-CN`, `ja` and `ja-JP`, `he` and `iw-IL`,
 *   `no` and `no-NO`, Latin American Spanish `es-MX` and `es-419`.
 *
 * The rules, in this order: an exact code; the same code ignoring case and `_`; one of the known
 * equivalents below. Nothing is guessed beyond that (`en` is not `en-US`: that would be a
 * different language variant). Two or more equivalent folders and no exact one is ambiguous and is
 * left to a person.
 */

/** The key two codes are compared by: lower case, `-` as separator. */
export const canonicalLocale = (code: string): string =>
  code.trim().replace(/_/g, '-').toLowerCase();

/**
 * Groups of canonical codes that name the same language in the two stores. Every group is
 * symmetric: any member matches any other.
 */
const EQUIVALENT_GROUPS: readonly (readonly string[])[] = [
  ['zh-hans', 'zh-cn'],
  ['zh-hant', 'zh-tw'],
  ['ja', 'ja-jp'],
  ['ko', 'ko-kr'],
  ['it', 'it-it'],
  ['ru', 'ru-ru'],
  ['tr', 'tr-tr'],
  ['pl', 'pl-pl'],
  ['sv', 'sv-se'],
  ['da', 'da-dk'],
  ['fi', 'fi-fi'],
  ['no', 'no-no', 'nb', 'nb-no'],
  ['cs', 'cs-cz'],
  ['el', 'el-gr'],
  ['hu', 'hu-hu'],
  ['he', 'he-il', 'iw', 'iw-il'],
  ['hi', 'hi-in'],
  ['ar-sa', 'ar'],
  ['ms', 'ms-my'],
  ['id', 'id-id', 'in-id'],
  ['th', 'th-th'],
  ['vi', 'vi-vn'],
  ['uk', 'uk-ua'],
  ['ro', 'ro-ro'],
  ['sk', 'sk-sk'],
  ['hr', 'hr-hr'],
  ['ca', 'ca-es'],
  ['nl-nl', 'nl'],
  ['es-mx', 'es-419'],
];

const GROUP_OF = new Map<string, readonly string[]>();
for (const group of EQUIVALENT_GROUPS) for (const code of group) GROUP_OF.set(code, group);

/** The canonical codes that mean the same as `code` (itself first). */
export function equivalentLocales(code: string): string[] {
  const key = canonicalLocale(code);
  const group = GROUP_OF.get(key);
  return group ? [key, ...group.filter((c) => c !== key)] : [key];
}

export type LocaleMatch =
  | { kind: 'match'; repoLocale: string; how: 'exact' | 'normalized' | 'equivalent' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * The repository's locale folder that holds the store's locale, if there is one. `repoLocales` are
 * the codes as the repository has them (never the `default` fallback folder).
 */
export function matchRepoLocale(storeLocale: string, repoLocales: readonly string[]): LocaleMatch {
  const exact = repoLocales.find((r) => r === storeLocale);
  if (exact !== undefined) return { kind: 'match', repoLocale: exact, how: 'exact' };
  const key = canonicalLocale(storeLocale);
  const same = repoLocales.filter((r) => canonicalLocale(r) === key);
  if (same.length === 1) return { kind: 'match', repoLocale: same[0] as string, how: 'normalized' };
  if (same.length > 1) return { kind: 'ambiguous', candidates: [...same].sort() };
  const wanted = new Set(equivalentLocales(storeLocale));
  const near = repoLocales.filter((r) => wanted.has(canonicalLocale(r)));
  if (near.length === 1) return { kind: 'match', repoLocale: near[0] as string, how: 'equivalent' };
  if (near.length > 1) return { kind: 'ambiguous', candidates: [...near].sort() };
  return { kind: 'none' };
}

export type NewLocale =
  | { ok: true; repoLocale: string }
  | { ok: false; reason: 'invalid' | 'unsupported' };

/**
 * The folder (or Expo `apple.info` key) to create for a store locale the repository does not have.
 * The store's own code with `_` written as `-`, which is what `deliver` and `supply` use for their
 * folders. It must be a code the fastlane reader would see as a locale folder (otherwise the next
 * read would ignore the folder), and for an Expo store config one that the EAS Metadata schema
 * knows (the writer refuses the others).
 */
export function newRepoLocale(
  _platform: Platform,
  storeLocale: string,
  source: 'fastlane' | 'expo-store-config',
): NewLocale {
  const code = storeLocale.trim().replace(/_/g, '-');
  if (!isLocaleDir(code)) return { ok: false, reason: 'invalid' };
  if (source === 'expo-store-config' && !EXPO_LOCALES.includes(code)) {
    // The EAS schema writes the code as it is listed there; a case difference is repaired.
    const listed = EXPO_LOCALES.find((l) => canonicalLocale(l) === canonicalLocale(code));
    if (listed === undefined) return { ok: false, reason: 'unsupported' };
    return { ok: true, repoLocale: listed };
  }
  return { ok: true, repoLocale: code };
}
