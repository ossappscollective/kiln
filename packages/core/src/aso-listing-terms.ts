/**
 * The terms a listing already sets, pure: for one locale of a stored listing, the entries of the App Store
 * keyword field and the significant words of the name and subtitle, or (Google Play, which has no keyword field)
 * the words of the title and short description and, when asked, the frequent words of the full description.
 * Each term says where it appears, whether it is wasted or repeated (the same logic as the keyword budget) and,
 * given the tracked keywords, whether it is tracked and at which rank. No network, no clock, no database.
 * ES2017-safe so the web can share it (no `flatMap`, `fromEntries`, `matchAll`, `.at()`).
 *
 * Google Play has no hidden keyword field: every Play term here is EXTRACTED from text and says so
 * (`LocaleTerms.extracted`). Which fields a store searches is UNVERIFIED (docs/adr/0011-aso-keywords-competitors.md).
 */

import {
  APP_STORE_KEYWORD_BYTES,
  type AsoPlatform,
  checkTerm,
  type FitFields,
  foldWord,
  isStopWord,
  languageOf,
  normalizeLocale,
  stem,
  words,
} from './aso.ts';
import {
  keywordFieldEntries,
  keywordFieldWaste,
  listingBudget,
  sameLocale,
  storefrontFor,
  type TrackedRef,
  termKeyOf,
  type WasteReason,
} from './aso-coach.ts';
import { countBytes } from './listing.ts';
import { isApplePlatform } from './platform.ts';

export type TermSource = 'keywords' | 'title' | 'subtitle' | 'shortDescription' | 'description';

export type ListingTerm = {
  /** As written in the keyword field, or an extracted word in lower case. */
  term: string;
  /** What two terms are compared by (`termKeyOf`): folded words, English plurals folded. */
  key: string;
  /** The fields it appears in, in the order a person fills them. */
  sources: TermSource[];
  /** An entry someone typed into the keyword field (App Store). False: a word taken out of a text. */
  set: boolean;
  /** Why the keyword field entry is wasted (the first reason, from `keywordFieldWaste`), else null. */
  waste: WasteReason | null;
  /** The word is in more than one searched field and is not already counted as waste (App Store: from `listingBudget`; Play: title and short description). */
  duplicate: boolean;
  /** How many keyword field entries have these words (more than 1: a repeat or a plural variant). */
  entries: number;
  /** Times the word occurs in the full description (Google Play with `includeDescription`), else 0. */
  occurrences: number;
};

export type KeywordFieldSummary = {
  /** The field as stored. */
  value: string;
  bytes: number;
  limit: number;
  remaining: number;
  over: boolean;
  /** Distinct entries (`keywordFieldEntries`). */
  entries: number;
  /** Bytes that could be given back (spaces, empty or repeated entries, entries the name or subtitle hold). */
  wastedBytes: number;
};

export type LocaleTerms = {
  platform: AsoPlatform;
  locale: string;
  terms: ListingTerm[];
  /** App Store only, when the locale has a keyword field. */
  keywordField: KeywordFieldSummary | null;
  /** Google Play: there is no keyword field, every term is taken out of text. */
  extracted: boolean;
  /** The locale has text in a field these terms are read from. */
  hasText: boolean;
};

export type TermOptions = {
  /** Google Play only: add the frequent words of the full description. Default false. */
  includeDescription?: boolean;
  /** A description word counts from this many occurrences. Default 3. */
  minDescriptionOccurrences?: number;
  /** At most this many description words. Default 8. */
  maxDescriptionTerms?: number;
};

export const DEFAULT_DESCRIPTION_OCCURRENCES = 3;
export const DEFAULT_DESCRIPTION_TERMS = 8;

const isKeywordWord = (language: string, w: string): boolean =>
  !isStopWord(language, w) && Array.from(w).length >= 3 && !/^[0-9]+$/.test(w);

/** The words of a text that could be a keyword: no stop word, at least 3 characters, not only digits; each once, with its key. */
export function significantWords(
  text: string | undefined,
  language: string,
): { term: string; key: string }[] {
  if (!text) return [];
  const out: { term: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const w of words(text)) {
    if (!isKeywordWord(language, w)) continue;
    const key = stem(foldWord(w), language);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term: w, key });
  }
  return out;
}

/** The terms a locale of a stored listing sets. */
export function listingTerms(input: {
  platform: AsoPlatform;
  locale: string;
  fields: FitFields;
  options?: TermOptions;
}): LocaleTerms {
  const { platform, locale, fields } = input;
  const options = input.options ?? {};
  const language = languageOf(locale);
  const apple = isApplePlatform(platform);
  const byKey = new Map<string, ListingTerm>();
  const order: ListingTerm[] = [];
  const touch = (term: string, key: string, source: TermSource, set: boolean): ListingTerm => {
    let t = byKey.get(key);
    if (!t) {
      t = {
        term,
        key,
        sources: [],
        set: false,
        waste: null,
        duplicate: false,
        entries: 0,
        occurrences: 0,
      };
      byKey.set(key, t);
      order.push(t);
    }
    if (t.sources.indexOf(source) < 0) t.sources.push(source);
    if (set) t.set = true;
    return t;
  };

  let keywordField: KeywordFieldSummary | null = null;
  if (apple && fields.keywords !== undefined) {
    const value = fields.keywords;
    const waste = keywordFieldWaste(value, {
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.subtitle !== undefined ? { subtitle: fields.subtitle } : {}),
      language,
    });
    const entries = keywordFieldEntries(value, locale);
    for (const e of entries) touch(e.term, e.key, 'keywords', true);
    // Every entry counts toward `entries`, a repeat or a plural variant too; the first reason a key was dropped is its mark.
    for (const part of value.split(',')) {
      const key = termKeyOf(part.trim(), locale);
      const t = key === '' ? undefined : byKey.get(key);
      if (t) t.entries += 1;
    }
    for (const item of waste.items) {
      if (item.reason === 'space' || item.reason === 'empty_entry') continue;
      const t = byKey.get(termKeyOf(item.text, locale));
      if (t && t.waste === null) t.waste = item.reason;
    }
    const bytes = countBytes(value);
    keywordField = {
      value,
      bytes,
      limit: APP_STORE_KEYWORD_BYTES,
      remaining: APP_STORE_KEYWORD_BYTES - bytes,
      over: bytes > APP_STORE_KEYWORD_BYTES,
      entries: entries.length,
      wastedBytes: waste.totalBytes,
    };
  }

  const textFields: { field: TermSource; text: string | undefined }[] = apple
    ? [
        { field: 'title', text: fields.title },
        { field: 'subtitle', text: fields.subtitle },
      ]
    : [
        { field: 'title', text: fields.title },
        { field: 'shortDescription', text: fields.shortDescription },
      ];
  for (const f of textFields)
    for (const w of significantWords(f.text, language)) touch(w.term, w.key, f.field, false);

  if (!apple && options.includeDescription === true && fields.description) {
    const min = options.minDescriptionOccurrences ?? DEFAULT_DESCRIPTION_OCCURRENCES;
    const counts = new Map<string, { term: string; n: number }>();
    for (const w of words(fields.description)) {
      if (!isKeywordWord(language, w)) continue;
      const key = stem(foldWord(w), language);
      const c = counts.get(key);
      if (c) c.n += 1;
      else counts.set(key, { term: w, n: 1 });
    }
    const frequent = Array.from(counts.entries())
      .filter(([, c]) => c.n >= min)
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .slice(0, options.maxDescriptionTerms ?? DEFAULT_DESCRIPTION_TERMS);
    for (const [key, c] of frequent) touch(c.term, key, 'description', false).occurrences = c.n;
  }

  // Repeats across fields. App Store: the budget's own list (the keyword field is read without what is already waste, so an
  // entry is not marked twice). Google Play: a word in both the title and the short description (information, not waste).
  if (apple) {
    const budget = listingBudget({ platform, locale, fields, keywords: [] });
    for (const r of budget.repeated) {
      const t = byKey.get(stem(foldWord(r.word), language));
      if (t && t.waste === null) t.duplicate = true;
    }
  } else {
    for (const t of order)
      if (t.sources.indexOf('title') >= 0 && t.sources.indexOf('shortDescription') >= 0)
        t.duplicate = true;
  }

  const filled = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';
  const hasText = apple
    ? [fields.title, fields.subtitle, fields.keywords].some(filled)
    : [fields.title, fields.shortDescription].some(filled);
  return { platform, locale, terms: order, keywordField, extracted: !apple, hasText };
}

// ---------------------------------------------------------------------------------------------
// Tracked or not

export type TrackedRank = TrackedRef & {
  id?: string;
  state?: 'ranked' | 'not_ranked' | null;
  rank?: number | null;
};

export type TermTracking = {
  tracked: boolean;
  /** The id of the tracked keyword, when it has one. */
  keywordId: string | null;
  state: 'ranked' | 'not_ranked' | null;
  /** The rank today when ranked. */
  rank: number | null;
};

/** Whether a term is tracked in this locale and storefront, with the rank today. */
export function trackingOf(
  term: Pick<ListingTerm, 'key'>,
  locale: string,
  country: string,
  tracked: readonly TrackedRank[],
): TermTracking {
  const c = country.toLowerCase();
  for (const t of tracked) {
    if (
      t.country.toLowerCase() !== c ||
      !sameLocale(t.locale, locale) ||
      termKeyOf(t.term, locale) !== term.key
    )
      continue;
    return {
      tracked: true,
      keywordId: t.id ?? null,
      state: t.state ?? null,
      rank: t.state === 'ranked' ? (t.rank ?? null) : null,
    };
  }
  return { tracked: false, keywordId: null, state: null, rank: null };
}

export type ListingRowTerm = ListingTerm & TermTracking;

export type ListingRow = {
  locale: string;
  /** The storefront the row is tracked in, and the others to choose from. */
  country: string;
  storefronts: string[];
  /** The locale is a language tag the keywords API accepts. */
  trackable: boolean;
  terms: LocaleTerms;
  rows: ListingRowTerm[];
  /** The terms not tracked in the storefront that the keywords API would accept. */
  untracked: ListingRowTerm[];
};

/**
 * One row per listing locale, with its terms marked tracked or not in the locale's storefront. `countries`
 * overrides the storefront of a locale (the person picked another one of `storefronts`).
 */
export function listingRows(input: {
  platform: AsoPlatform;
  locales: readonly { locale: string; fields: FitFields }[];
  tracked: readonly TrackedRank[];
  options?: TermOptions;
  countries?: Readonly<Record<string, string | undefined>>;
}): ListingRow[] {
  return input.locales.map((l) => {
    const sf = storefrontFor(l.locale, input.tracked);
    const chosen = input.countries?.[l.locale];
    const country = chosen !== undefined && sf.options.indexOf(chosen) >= 0 ? chosen : sf.country;
    const terms = listingTerms({
      platform: input.platform,
      locale: l.locale,
      fields: l.fields,
      ...(input.options ? { options: input.options } : {}),
    });
    const rows: ListingRowTerm[] = terms.terms.map((t) => ({
      ...t,
      ...trackingOf(t, l.locale, country, input.tracked),
    }));
    return {
      locale: l.locale,
      country,
      storefronts: sf.options,
      trackable: normalizeLocale(l.locale) !== undefined,
      terms,
      rows,
      untracked: rows.filter((t) => !t.tracked && checkTerm(t.term).ok),
    };
  });
}
