import { EXPO_LOCALES } from '@kiln/connectors';
import { equivalentLocaleKeys, isRepoLocaleFolder, localeKey, matchLocale, type Platform } from '@kiln/core';

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

/**
 * The key two codes are compared by: lower case, `-` as separator. THE locale module of core owns it (`localeKey`); the equivalence table
 * (`LOCALE_EQUIVALENTS`) lives there too, so the web matrix and this repository matching read the same one.
 */
export const canonicalLocale = localeKey;

/** The canonical codes that mean the same as `code` (itself first). */
export const equivalentLocales = equivalentLocaleKeys;

export type LocaleMatch =
  | { kind: 'match'; repoLocale: string; how: 'exact' | 'normalized' | 'equivalent' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * The repository's locale folder that holds the store's locale, if there is one. `repoLocales` are
 * the codes as the repository has them (never the `default` fallback folder). The rules are core's `matchLocale` without the language
 * fallback: the same text, the same key, a known equivalent of the other store; nothing else.
 */
export function matchRepoLocale(storeLocale: string, repoLocales: readonly string[]): LocaleMatch {
  const found = matchLocale(storeLocale, repoLocales);
  if (found.kind === 'match') {
    // `language` is only produced with `languageFallback`, which is off here.
    return {
      kind: 'match',
      repoLocale: found.locale,
      how: found.how === 'language' ? 'equivalent' : found.how,
    };
  }
  return found;
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
  // A store writes its language in lower case (`fr-FR`): `FR` is something a repository folder may be called, not a code to create.
  if (!isRepoLocaleFolder(code) || !/^[a-z]/.test(code)) return { ok: false, reason: 'invalid' };
  if (source === 'expo-store-config' && !EXPO_LOCALES.includes(code)) {
    // The EAS schema writes the code as it is listed there; a case difference is repaired.
    const listed = EXPO_LOCALES.find((l) => canonicalLocale(l) === canonicalLocale(code));
    if (listed === undefined) return { ok: false, reason: 'unsupported' };
    return { ok: true, repoLocale: listed };
  }
  return { ok: true, repoLocale: code };
}
