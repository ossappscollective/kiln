import type { ListingStore } from '../listing/listing.ts';

/**
 * THE locale code module (docs/state-model.md, "Single owners (core)"). Before this file a "locale code" was validated by seven regexes
 * (fastlane `isLocaleDir`, staged `LOCALE {0,3}` twice, listing routes `[A-Za-z0-9_-]{1,35}`, `localeKey` of routes/repositories, core
 * `isPlanLocale`, `isNoteLocale` twice, `LANGUAGE` of release-fields, `{0,2}` of play-release-checks) and normalised by ten helpers
 * (`canonicalLocale`, three `norm`, two `tag`, `normalizeLocale` x2 with different case, three `sameLocale` meaning three things,
 * `languageKey`). A repository folder `fr_FR` was invisible to the reader but accepted as a note locale; `zh-Hans` (App Store) and `zh-CN`
 * (Google Play) matched only on the server, so the web matrix showed two rows. Everything below is the one answer.
 *
 * FORMS OF ONE LOCALE, and which one is written where:
 *  - the CODE: `language[-Script][-REGION]`, language lower case, script Title case, region upper case or 3 digits, `-` as separator:
 *    `fr-FR`, `fr`, `zh-Hans`, `es-419`, `pt-BR`. `normalizeLocaleCode('fr_fr')` is `fr-FR`. This is what Kiln stores and shows.
 *  - the KEY: the code lower-cased (`fr-fr`): what two codes are compared by (`localeKey`, total: also for text that is not a valid code).
 *  - the STORE CODE: the code written the way a store writes it (`storeCodeOf`): App Store `zh-Hans`, `ja`, `es-MX`, `he`; Google Play
 *    `zh-CN`, `ja-JP`, `es-419`, `iw-IL`. The pairs are the explicit table `LOCALE_EQUIVALENTS`; nothing is guessed beyond it (`en` is NOT
 *    `en-US`: another language variant).
 *  - the REPOSITORY FOLDER: fastlane writes `fr-FR` (deliver, supply) or `fr`; people also write `fr_FR`, `FR`, `Fr-fr`. A folder is a
 *    locale folder when its name reads as a code (`isRepoLocaleFolder`); `FR` alone is read as the LANGUAGE `fr`.
 *
 * `localesMatch(a, b, {mode})` is the one `sameLocale`: `exact` (same key), `equivalent` (exact, or the same language written the other
 * store's way), `language` (equivalent, or one side is the bare language of the other: `it` and `it-IT`).
 *
 * Pure. ES2017.
 */

export type LocaleParts = { language: string; script: string | null; region: string | null };

/** The longest locale code any surface accepts (the longest of the old validators). */
export const MAX_LOCALE_LENGTH = 35;

/** The fastlane fallback folder: not a locale. */
export const DEFAULT_LOCALE_FOLDER = 'default';

/** Folders of a repository that look like a code but are not a locale. */
const RESERVED_FOLDERS = ['ios', 'android', 'default'];

/** Reads a locale code in any case and with `_` or `-`; null when it is not `language[-Script][-REGION]` (at most three parts). */
export function parseLocale(raw: unknown): LocaleParts | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '' || text.length > MAX_LOCALE_LENGTH) return null;
  const parts = text.replace(/_/g, '-').split('-');
  if (parts.length > 3) return null;
  const language = parts[0] ?? '';
  if (!/^[A-Za-z]{2,3}$/.test(language)) return null;
  let script: string | null = null;
  let region: string | null = null;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (script === null && region === null && /^[A-Za-z]{4}$/.test(part)) {
      script = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } else if (region === null && (/^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part))) {
      region = part.toUpperCase();
    } else {
      return null;
    }
  }
  return { language: language.toLowerCase(), script, region };
}

/** The code of a locale: `fr_fr` is `fr-FR`, `ZH-hans` is `zh-Hans`. Null when it is not a locale code. */
export function normalizeLocaleCode(raw: unknown): string | null {
  const p = parseLocale(raw);
  if (p === null) return null;
  return [p.language, p.script, p.region].filter((x): x is string => x !== null).join('-');
}

/** Whether this is a locale code in any of its written forms (the ONE validator). */
export const isLocaleCode = (value: unknown): boolean => parseLocale(value) !== null;

/** A locale code or the fastlane `default` fallback (what a release plan's notes are keyed by). */
export const isLocaleOrDefault = (value: unknown): boolean =>
  value === DEFAULT_LOCALE_FOLDER || isLocaleCode(value);

/** The key two codes are compared by: lower case, `-` as separator. Total: any text has one. */
export const localeKey = (code: string): string => code.trim().replace(/_/g, '-').toLowerCase();

/** The language of a code (`pt-BR` is `pt`), or null. */
export const languageOfLocale = (code: string): string | null => parseLocale(code)?.language ?? null;

// ---------------------------------------------------------------------------------------------
// The mapping between the stores

/**
 * The same language written the way each store writes it, as an EXPLICIT table. `apple` and `play` are the store codes; `also` are other
 * spellings that mean the same (`nb`, `iw`, `in-ID`). Every row is one equivalence group: any member matches any other. Moved from the
 * server's `EQUIVALENT_GROUPS` (listing/locales.ts) so the web matrix merges `zh-Hans` and `zh-CN` into one row too.
 */
export const LOCALE_EQUIVALENTS: readonly { apple: string; play: string; also?: readonly string[] }[] = [
  { apple: 'zh-Hans', play: 'zh-CN' },
  { apple: 'zh-Hant', play: 'zh-TW' },
  { apple: 'ja', play: 'ja-JP' },
  { apple: 'ko', play: 'ko-KR' },
  { apple: 'it', play: 'it-IT' },
  { apple: 'ru', play: 'ru-RU' },
  { apple: 'tr', play: 'tr-TR' },
  { apple: 'pl', play: 'pl-PL' },
  { apple: 'sv', play: 'sv-SE' },
  { apple: 'da', play: 'da-DK' },
  { apple: 'fi', play: 'fi-FI' },
  { apple: 'no', play: 'no-NO', also: ['nb', 'nb-NO'] },
  { apple: 'cs', play: 'cs-CZ' },
  { apple: 'el', play: 'el-GR' },
  { apple: 'hu', play: 'hu-HU' },
  { apple: 'he', play: 'iw-IL', also: ['he-IL', 'iw'] },
  { apple: 'hi', play: 'hi-IN' },
  { apple: 'ar-SA', play: 'ar' },
  { apple: 'ms', play: 'ms-MY' },
  { apple: 'id', play: 'id', also: ['id-ID', 'in-ID'] },
  { apple: 'th', play: 'th-TH' },
  { apple: 'vi', play: 'vi-VN' },
  { apple: 'uk', play: 'uk-UA' },
  { apple: 'ro', play: 'ro-RO' },
  { apple: 'sk', play: 'sk-SK' },
  { apple: 'hr', play: 'hr-HR' },
  { apple: 'ca', play: 'ca-ES' },
  { apple: 'nl-NL', play: 'nl' },
  { apple: 'es-MX', play: 'es-419' },
];

type Row = (typeof LOCALE_EQUIVALENTS)[number];
const ROW_OF = new Map<string, Row>();
for (const row of LOCALE_EQUIVALENTS) {
  for (const code of [row.apple, row.play, ...(row.also ?? [])]) ROW_OF.set(localeKey(code), row);
}

/** The keys of every spelling that means the same as `code` (its own key first). */
export function equivalentLocaleKeys(code: string): string[] {
  const key = localeKey(code);
  const row = ROW_OF.get(key);
  if (row === undefined) return [key];
  const all = [row.apple, row.play, ...(row.also ?? [])].map(localeKey);
  return [key, ...all.filter((k) => k !== key)];
}

/**
 * A key that every spelling of one language shares across the stores (`zh-Hans` and `zh-CN` are both `zh-hans`): what rows of a matrix
 * merge by. A code that is in no row is its own key.
 */
export function localeGroupKey(code: string): string {
  const row = ROW_OF.get(localeKey(code));
  return row === undefined ? localeKey(code) : localeKey(row.apple);
}

/** The code written the way this store writes it (`zh-CN` -> `zh-Hans` for the App Store); a repository keeps the normalised code. */
export function storeCodeOf(code: string, store: ListingStore | 'repo'): string {
  const row = ROW_OF.get(localeKey(code));
  if (row !== undefined && store !== 'repo') return store === 'app_store' ? row.apple : row.play;
  return normalizeLocaleCode(code) ?? code.trim().replace(/_/g, '-');
}

export type LocaleMatchMode = 'exact' | 'equivalent' | 'language';

/**
 * The ONE "same locale?": `exact` is the same key (`fr_FR` and `fr-fr`); `equivalent` also accepts the other store's spelling (`zh-Hans` and
 * `zh-CN`, `ja` and `ja-JP`, `he` and `iw-IL`, `es-MX` and `es-419`); `language` also accepts a bare language against any variant of it
 * (`it` and `it-IT`), but never two different variants (`fr-CA` and `fr-FR`). Default `equivalent`.
 */
export function localesMatch(
  a: string,
  b: string,
  options: { mode?: LocaleMatchMode } = {},
): boolean {
  const mode = options.mode ?? 'equivalent';
  const x = localeKey(a);
  const y = localeKey(b);
  if (x === y) return true;
  if (mode === 'exact') return false;
  if (equivalentLocaleKeys(x).indexOf(y) >= 0) return true;
  if (mode === 'equivalent') return false;
  const xs = x.split('-');
  const ys = y.split('-');
  if (xs[0] !== ys[0]) return false;
  return xs.length === 1 || ys.length === 1;
}

/**
 * Merges the locale lists of several records (an iOS `zh-Hans` and an Android `zh-CN`) into rows: one row per language group, with every
 * code that fed it, in the order the groups first appear. The label code is the first one given.
 */
export function mergeLocales(
  lists: readonly (readonly string[])[],
): { key: string; code: string; codes: string[] }[] {
  const rows: { key: string; code: string; codes: string[] }[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const key = localeGroupKey(raw);
      const code = normalizeLocaleCode(raw) ?? raw.trim();
      const row = rows.filter((r) => r.key === key)[0];
      if (row === undefined) rows.push({ key, code, codes: [code] });
      else if (row.codes.indexOf(code) < 0) row.codes.push(code);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The repository

/**
 * Whether a repository folder name reads as a locale: `fr-FR`, `fr_FR`, `Fr-fr`, `FR` (the language), `zh-Hans`. Not `ios`, `android`,
 * `default` (the fastlane fallback, see `DEFAULT_LOCALE_FOLDER`). Deliberately loose like the fastlane reader it widens (`isLocaleDir` only
 * saw lower-case language and `-`): it rules out other folders, it does not check the stores' lists.
 */
export function isRepoLocaleFolder(name: string): boolean {
  return RESERVED_FOLDERS.indexOf(name.toLowerCase()) < 0 && isLocaleCode(name);
}

export type LocaleMatchResult =
  | { kind: 'match'; locale: string; how: 'exact' | 'normalized' | 'equivalent' | 'language' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * The entry of `candidates` (repository folders, a store's codes) that holds `code`. In this order: the same text; the same key (case and
 * `_`); a known equivalent of the other store; and ONLY when `languageFallback` is on, the bare language (a fastlane folder `fr` for the
 * App Store `fr-FR`; a folder `FR`). Two or more equal-rank matches are ambiguous and left to a person. The `default` folder is never a match.
 */
export function matchLocale(
  code: string,
  candidates: readonly string[],
  options: { languageFallback?: boolean } = {},
): LocaleMatchResult {
  const pool = candidates.filter((c) => c !== DEFAULT_LOCALE_FOLDER);
  const exact = pool.find((c) => c === code);
  if (exact !== undefined) return { kind: 'match', locale: exact, how: 'exact' };
  const rank = (
    test: (c: string) => boolean,
    how: 'normalized' | 'equivalent' | 'language',
  ): LocaleMatchResult | null => {
    const hits = pool.filter(test);
    if (hits.length === 1) return { kind: 'match', locale: hits[0] as string, how };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.slice().sort() };
    return null;
  };
  return (
    rank((c) => localesMatch(c, code, { mode: 'exact' }), 'normalized') ??
    rank((c) => localesMatch(c, code, { mode: 'equivalent' }), 'equivalent') ??
    (options.languageFallback === true
      ? rank((c) => localesMatch(c, code, { mode: 'language' }), 'language')
      : null) ?? { kind: 'none' }
  );
}

// ---------------------------------------------------------------------------------------------
// The primary (base) locale

export type BaseLocale = { locale: string; source: 'declared' | 'english' | 'first' } | null;

/**
 * The locale the others are compared with ("untranslated", fit, the publish summary's default language): the DECLARED one when the store
 * says it (Google Play `defaultLanguage`; the App Store's primary locale, once read) and it is among the locales (equivalents count);
 * else `en-US`; else another English; else the first in alphabetical order (the last resort, said by `source: 'first'`). Null for no locale.
 */
export function baseLocaleOf(
  locales: readonly string[],
  declared: string | null | undefined = null,
): BaseLocale {
  const list = locales.filter((l) => l !== DEFAULT_LOCALE_FOLDER);
  if (list.length === 0) return null;
  if (declared !== null && declared !== undefined && declared.trim() !== '') {
    const hit = list.find((l) => localesMatch(l, declared)) ;
    if (hit !== undefined) return { locale: hit, source: 'declared' };
  }
  const us = list.find((l) => localeKey(l) === 'en-us');
  if (us !== undefined) return { locale: us, source: 'english' };
  const english = list.slice().sort().find((l) => languageOfLocale(l) === 'en');
  if (english !== undefined) return { locale: english, source: 'english' };
  return { locale: list.slice().sort()[0] as string, source: 'first' };
}
