// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// Where the downloads come from, by the main language of the country, set against the languages the store page is live in. Pure: the caller
// gives the downloads per country (what the analytics store holds) and the locales of the live store page (what the listing read holds).

import { languageKey, localeCovering, mainLanguageOf, normalizeCountryCode } from './countries.ts';

export type CountryCount = { country: string; count: number };

export type CoverageCountry = {
  /** Upper case two letter code. */
  country: string;
  count: number;
  /** The share of all counted downloads, 0..1. */
  share: number;
  /** The main language of the country, or null when the table does not know it. */
  language: string | null;
  /** The live store locale that covers that language, or null. */
  coveredBy: string | null;
};

export type CoverageLanguage = {
  language: string;
  count: number;
  share: number;
  /** The live store locale that covers the language, or null when there is none. */
  coveredBy: string | null;
  /** The countries of this language, biggest first. */
  countries: CoverageCountry[];
};

export type LanguageCoverage = {
  /** Downloads counted: the sum over countries the table knows or not. */
  total: number;
  /** Every language, biggest first. Countries the table does not know are in `unknown`, not here. */
  languages: CoverageLanguage[];
  /** Every country, biggest first. */
  countries: CoverageCountry[];
  /** The share of downloads in countries whose language the page does not cover (0..1). */
  uncoveredShare: number;
  /** Downloads of countries with no known language. */
  unknownCount: number;
};

/**
 * Joins downloads by country with the main language of each country and the locales of the store page. A country given twice is added up, a
 * count that is not a positive number is dropped, and a code that is not two letters is ignored. `storeLocales` empty means the page is read
 * and has no language: nothing is covered (the caller passes null and skips the view when the page was never read).
 */
export function languageCoverage(input: {
  countries: readonly CountryCount[];
  storeLocales: readonly string[];
  store?: 'app_store' | 'google_play';
}): LanguageCoverage {
  const store = input.store ?? 'app_store';
  const sums = new Map<string, number>();
  for (const row of input.countries) {
    const code = normalizeCountryCode(row.country);
    if (code === null || !(row.count > 0) || !Number.isFinite(row.count)) continue;
    sums.set(code, (sums.get(code) ?? 0) + row.count);
  }
  let total = 0;
  for (const count of sums.values()) total += count;
  const rows: CoverageCountry[] = [];
  for (const [country, count] of sums) {
    const language = mainLanguageOf(country, store);
    rows.push({
      country,
      count,
      share: total > 0 ? count / total : 0,
      language,
      coveredBy: language === null ? null : localeCovering(language, input.storeLocales),
    });
  }
  rows.sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

  const byLanguage = new Map<string, CoverageLanguage>();
  let unknownCount = 0;
  let uncovered = 0;
  for (const row of rows) {
    if (row.language === null) {
      unknownCount += row.count;
      continue;
    }
    if (row.coveredBy === null) uncovered += row.count;
    const entry = byLanguage.get(row.language) ?? {
      language: row.language,
      count: 0,
      share: 0,
      coveredBy: row.coveredBy,
      countries: [],
    };
    entry.count += row.count;
    entry.share += row.share;
    entry.countries.push(row);
    byLanguage.set(row.language, entry);
  }
  const languages = Array.from(byLanguage.values()).sort(
    (a, b) => b.count - a.count || a.language.localeCompare(b.language),
  );
  return {
    total,
    languages,
    countries: rows,
    uncoveredShare: total > 0 ? uncovered / total : 0,
    unknownCount,
  };
}

/** True when two locale lists name the same languages (used to tell whether a page changed in a way that matters here). */
export const sameLanguages = (a: readonly string[], b: readonly string[]): boolean => {
  const key = (list: readonly string[]) =>
    Array.from(new Set(list.map(languageKey).filter((x): x is string => x !== null)))
      .sort()
      .join(',');
  return key(a) === key(b);
};
