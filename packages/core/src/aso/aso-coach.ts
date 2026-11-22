/**
 * ASO coaching, pure: how much of each listing field's budget is used, which tracked keywords sit in
 * which field, what is wasted, where locales are left unused, and a short ranked list of next actions
 * worked out from data the tool already holds. No network, no clock (the caller passes `now`), no
 * database. ES2017-safe so the web can share it (no `flatMap`, `fromEntries`, `matchAll`, `.at()`).
 *
 * Nothing here is a search volume, a popularity or an estimate of what a change will earn: every number
 * is a count of characters, keywords, places or days taken from the input. Facts about how the stores
 * index text that no official page checked here states are marked UNVERIFIED, here and in the text a
 * person reads (docs/adr/0011-aso-keywords-competitors.md).
 */

import {
  APP_STORE_FIELD_SPECS,
  countBytes,
  countCharacters,
  PLAY_FIELD_SPECS,
} from '../listing/listing.ts';
import { supports } from '../platform.ts';
import { type CoreText, coreText } from '../text.ts';
import {
  type AsoPlatform,
  checkTerm,
  defaultCountryFor,
  defaultLocaleFor,
  type FitField,
  type FitFields,
  type FitKeyword,
  type FitStatus,
  fitKeyword,
  foldWord,
  isBigMove,
  isStopWord,
  languageOf,
  matchWords,
  type RankChange,
  stem,
  words,
} from './aso.ts';

// ---------------------------------------------------------------------------------------------
// Locale helpers

const tagOf = (locale: string): string => locale.replace(/_/g, '-').toLowerCase();

/** `es-MX` against `es-mx`, and a bare language (`it`) against any locale of that language (`it-IT`). */
export function sameLocale(a: string, b: string): boolean {
  const x = tagOf(a);
  const y = tagOf(b);
  if (x === y) return true;
  const xs = x.split('-');
  const ys = y.split('-');
  if (xs[0] !== ys[0]) return false;
  return xs.length === 1 || ys.length === 1;
}

/** The listing locale that holds the text for a keyword locale: the same tag, else another locale of the language (as the fit view does). */
export function matchListingLocale<T extends { locale: string }>(
  listing: readonly T[],
  locale: string,
): T | undefined {
  const wanted = tagOf(locale);
  for (const l of listing) if (tagOf(l.locale) === wanted) return l;
  const language = languageOf(locale);
  for (const l of listing) if (languageOf(l.locale) === language) return l;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Budgets per field

export type BudgetUnit = 'characters' | 'bytes';
export type BudgetSpec = { field: FitField; label: string; limit: number; unit: BudgetUnit };

const appleSpecs = APP_STORE_FIELD_SPECS;
const playSpecs = PLAY_FIELD_SPECS;
const limitOf = (spec: { maxLength?: number }): number => spec.maxLength ?? 0;

const APPLE_BUDGETS: readonly BudgetSpec[] = [
  { field: 'title', label: 'Name', limit: limitOf(appleSpecs.name), unit: appleSpecs.name.unit },
  {
    field: 'subtitle',
    label: 'Subtitle',
    limit: limitOf(appleSpecs.subtitle),
    unit: appleSpecs.subtitle.unit,
  },
  {
    field: 'keywords',
    label: 'Keyword field',
    limit: limitOf(appleSpecs.keywords),
    unit: appleSpecs.keywords.unit,
  },
];

/**
 * The fields that have a budget, in the order a person fills them. Limits come from the listing specs
 * (core `listing.ts`, each with its source page): App Store name and subtitle 30 characters, keyword
 * field 100 bytes; Google Play title 30, short description 80, full description 4000 characters.
 */
export const BUDGET_SPECS: Record<AsoPlatform, readonly BudgetSpec[]> = {
  ios: APPLE_BUDGETS,
  macos: APPLE_BUDGETS,
  android: [
    { field: 'title', label: 'Title', limit: limitOf(playSpecs.title), unit: playSpecs.title.unit },
    {
      field: 'shortDescription',
      label: 'Short description',
      limit: limitOf(playSpecs.short_description),
      unit: playSpecs.short_description.unit,
    },
    {
      field: 'description',
      label: 'Full description',
      limit: limitOf(playSpecs.full_description),
      unit: playSpecs.full_description.unit,
    },
  ],
};

export const BUDGET_ASSUMPTIONS: Record<'apple' | 'google', readonly string[]> = {
  apple: [
    'Apple states the name and subtitle at 30 characters and the keyword field at 100 bytes. Whether the commas count toward the 100 is not stated, so the whole field is measured.',
    'UNVERIFIED: that the App Store reads name, subtitle and keyword field words together, so a word repeated across them adds nothing. Repeats are shown as likely waste, not as fact.',
    'UNVERIFIED: that singular and plural count as one word. Here English plurals (a trailing "s") are folded; other languages are matched by exact word.',
  ],
  google: [
    'Google Play limits used here: title 30, short description 80, full description 4000 characters.',
    'UNVERIFIED: how Google Play weights a term that is repeated across title, short and full description. Repeats are listed for information; no waste is counted.',
  ],
};

export type FieldBudget = {
  field: FitField;
  label: string;
  unit: BudgetUnit;
  limit: number;
  used: number;
  /** Negative when over the limit. */
  remaining: number;
  over: boolean;
  /** 0 to 100, capped. */
  percent: number;
  /** The field has no text. */
  empty: boolean;
  /** Tracked keywords whose words are all in this field. */
  keywords: { id: string; term: string }[];
};

export type WasteReason =
  | 'space'
  | 'empty_entry'
  | 'repeated_entry'
  | 'plural_variant'
  | 'in_title_or_subtitle';

export type WasteItem = {
  reason: WasteReason;
  /** The entry as it stands in the field (trimmed). */
  text: string;
  /** Bytes the entry costs that could be given back, with its separating comma where it has one. */
  bytes: number;
};

export type KeywordFieldWaste = {
  /** Exact: the bytes of the field minus the bytes of `compacted`. */
  totalBytes: number;
  items: WasteItem[];
  /** The field without spaces around commas, empty entries, repeats, plural variants and entries already in the name or subtitle. */
  compacted: string;
  compactedBytes: number;
};

export type RepeatedWord = {
  /** The word as written the first time it appears. */
  word: string;
  fields: FitField[];
  /** The word is part of a tracked keyword. */
  tracked: boolean;
  /** `waste`: App Store, a word the store already has from an earlier field (UNVERIFIED). `info`: Google Play. */
  severity: 'waste' | 'info';
  /** Characters the later occurrences cost (App Store only; 0 for info). */
  wastedCharacters: number;
};

export type UntrackedTerms = { field: FitField; label: string; terms: string[] };

export type MissingKeyword = { id: string; term: string; priority: number; status: FitStatus };

export type ListingBudget = {
  platform: AsoPlatform;
  locale: string;
  fields: FieldBudget[];
  /** App Store only, when the listing has a keyword field. */
  keywordField: KeywordFieldWaste | null;
  /** Words found in more than one field of this locale, after the waste of the keyword field was taken out. */
  repeated: RepeatedWord[];
  /** Words of the fields that no tracked keyword uses. Empty while nothing is tracked in this locale. */
  untracked: UntrackedTerms[];
  /** Tracked keywords that are in none of the searched fields. */
  missing: MissingKeyword[];
  /** Tracked keywords of which only some words are in the searched fields. */
  partial: MissingKeyword[];
  /** Characters (bytes for the keyword field) that could be given back: the keyword field waste plus repeated words. App Store only. */
  wastedTotal: number;
  assumptions: readonly string[];
};

type Token = { key: string; display: string; ignore: boolean };

const tokensOf = (text: string | undefined, language: string): Token[] =>
  text
    ? words(text).map((w) => ({
        key: stem(foldWord(w), language),
        display: w,
        // A stop word or a one or two character word is no keyword by itself (Apple asks for entries longer than two characters).
        ignore: isStopWord(language, w) || Array.from(w).length < 3,
      }))
    : [];

/** The keyword field without its waste, entry by entry. Pure; the order of the checks is the order of the reasons. */
export function keywordFieldWaste(
  value: string,
  options: { title?: string; subtitle?: string; language?: string } = {},
): KeywordFieldWaste {
  const language = options.language ?? 'en';
  const known = new Set<string>(
    matchWords(options.title, language).concat(matchWords(options.subtitle, language)),
  );
  const parts = value.split(',');
  const seenExact = new Set<string>();
  const seenStem = new Set<string>();
  const items: WasteItem[] = [];
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    const text = part.trim();
    const comma = parts.length > 1 ? 1 : 0;
    const drop = (reason: WasteReason): void => {
      items.push({ reason, text, bytes: countBytes(part) + comma });
    };
    if (text === '') {
      if (parts.length > 1) drop('empty_entry');
      continue;
    }
    const exact = words(text).join(' ');
    const key = matchWords(text, language).join(' ');
    if (key === '') {
      drop('empty_entry');
      continue;
    }
    if (seenExact.has(exact)) {
      drop('repeated_entry');
      continue;
    }
    if (seenStem.has(key)) {
      drop('plural_variant');
      continue;
    }
    seenExact.add(exact);
    seenStem.add(key);
    if (key.split(' ').every((w) => known.has(w))) {
      drop('in_title_or_subtitle');
      continue;
    }
    const spaces = countBytes(part) - countBytes(text);
    if (spaces > 0) items.push({ reason: 'space', text, bytes: spaces });
    keep.push(text);
  }
  const compacted = keep.join(',');
  const compactedBytes = countBytes(compacted);
  return {
    totalBytes: Math.max(0, countBytes(value) - compactedBytes),
    items,
    compacted,
    compactedBytes,
  };
}

const fieldValue = (fields: FitFields, field: FitField): string => fields[field] ?? '';

/**
 * The budget of every field of one locale of a listing, which tracked keywords sit in which field, the
 * waste, the repeats across fields, the words no tracked keyword uses and the tracked keywords the
 * searched fields lack. `keywords` are the ones tracked in this locale.
 */
export function listingBudget(input: {
  platform: AsoPlatform;
  locale: string;
  fields: FitFields;
  keywords: readonly FitKeyword[];
}): ListingBudget {
  const { platform, locale, fields } = input;
  const language = languageOf(locale);
  const isApple = supports(platform, 'keywordField');
  const specs = BUDGET_SPECS[platform];
  const tracked = input.keywords
    .map((k) => ({ k, words: Array.from(new Set(matchWords(k.term, language))) }))
    .filter((x) => x.words.length > 0);
  const trackedWords = new Set<string>();
  for (const t of tracked) for (const w of t.words) trackedWords.add(w);

  const waste =
    isApple && fields.keywords !== undefined
      ? keywordFieldWaste(fields.keywords, {
          ...(fields.title !== undefined ? { title: fields.title } : {}),
          ...(fields.subtitle !== undefined ? { subtitle: fields.subtitle } : {}),
          language,
        })
      : null;

  const budgets: FieldBudget[] = specs.map((spec) => {
    const text = fieldValue(fields, spec.field);
    const used = spec.unit === 'bytes' ? countBytes(text) : countCharacters(text);
    const set = new Set(matchWords(text, language));
    return {
      field: spec.field,
      label: spec.label,
      unit: spec.unit,
      limit: spec.limit,
      used,
      remaining: spec.limit - used,
      over: used > spec.limit,
      percent: spec.limit <= 0 ? 0 : Math.min(100, Math.round((used / spec.limit) * 100)),
      empty: text.trim() === '',
      keywords: tracked
        .filter((t) => t.words.every((w) => set.has(w)))
        .map((t) => ({ id: t.k.id, term: t.k.term })),
    };
  });

  // Repeats across fields. The keyword field is read without what `waste` already takes out, so an
  // entry is not counted twice.
  const repeatFields: FitField[] = isApple
    ? ['title', 'subtitle', 'keywords']
    : ['title', 'shortDescription', 'description'];
  const byWord = new Map<string, { display: string; fields: FitField[]; cost: number }>();
  for (const field of repeatFields) {
    const text =
      field === 'keywords' && waste !== null ? waste.compacted : fieldValue(fields, field);
    const seen = new Set<string>();
    for (const t of tokensOf(text, language)) {
      if (t.ignore || seen.has(t.key)) continue;
      seen.add(t.key);
      let entry = byWord.get(t.key);
      if (!entry) {
        entry = { display: t.display, fields: [], cost: 0 };
        byWord.set(t.key, entry);
      } else if (isApple) {
        entry.cost += Array.from(t.display).length + (field === 'keywords' ? 1 : 0);
      }
      entry.fields.push(field);
    }
  }
  const repeated: RepeatedWord[] = [];
  byWord.forEach((entry, key) => {
    if (entry.fields.length < 2) return;
    // Google Play: only words of tracked keywords; a full description repeats ordinary words all the time.
    if (!isApple && !trackedWords.has(key)) return;
    repeated.push({
      word: entry.display,
      fields: entry.fields,
      tracked: trackedWords.has(key),
      severity: isApple ? 'waste' : 'info',
      wastedCharacters: isApple ? entry.cost : 0,
    });
  });
  repeated.sort((a, b) => b.wastedCharacters - a.wastedCharacters || a.word.localeCompare(b.word));

  // Words in the fields that no tracked keyword uses.
  const untracked: UntrackedTerms[] = [];
  if (tracked.length > 0) {
    const labelOf = (field: FitField): string =>
      specs.find((s) => s.field === field)?.label ?? field;
    const scan: FitField[] = isApple
      ? ['title', 'subtitle', 'keywords']
      : ['title', 'shortDescription'];
    for (const field of scan) {
      const text =
        field === 'keywords' && waste !== null ? waste.compacted : fieldValue(fields, field);
      const found: string[] = [];
      if (field === 'keywords') {
        for (const entry of text.split(',')) {
          const t = entry.trim();
          const keys = tokensOf(t, language).filter((x) => !x.ignore);
          if (
            t !== '' &&
            keys.length > 0 &&
            keys.every((x) => !trackedWords.has(x.key)) &&
            found.indexOf(t) < 0
          )
            found.push(t);
        }
      } else {
        for (const t of tokensOf(text, language)) {
          if (!t.ignore && !trackedWords.has(t.key) && found.indexOf(t.display) < 0)
            found.push(t.display);
        }
      }
      if (found.length > 0) untracked.push({ field, label: labelOf(field), terms: found });
    }
  }

  const missing: MissingKeyword[] = [];
  const partial: MissingKeyword[] = [];
  for (const k of input.keywords) {
    const fit = fitKeyword(platform, locale, fields, k);
    const row = { id: k.id, term: k.term, priority: k.priority ?? 2, status: fit.status };
    if (fit.status === 'missing' || fit.status === 'description_only') missing.push(row);
    else if (fit.status === 'partial') partial.push(row);
  }
  const byImportance = (a: MissingKeyword, b: MissingKeyword) =>
    b.priority - a.priority || a.term.localeCompare(b.term);
  missing.sort(byImportance);
  partial.sort(byImportance);

  const wastedTotal = isApple
    ? (waste?.totalBytes ?? 0) + repeated.reduce((n, r) => n + r.wastedCharacters, 0)
    : 0;
  return {
    platform,
    locale,
    fields: budgets,
    keywordField: waste,
    repeated,
    untracked,
    missing,
    partial,
    wastedTotal,
    assumptions: isApple ? BUDGET_ASSUMPTIONS.apple : BUDGET_ASSUMPTIONS.google,
  };
}

// ---------------------------------------------------------------------------------------------
// Storefronts and locales

/**
 * Locales that ASO tools REPORT an App Store storefront also reads besides its own. Apple's own pages
 * checked here do not state this, so every use of it says UNVERIFIED. It is a hint about where more
 * keyword text might be read, never a promise. Only a few storefronts are listed; a storefront that is
 * not listed says nothing. (Source: a public list compiled by aso.dev, read 2026-11-19; not Apple.)
 */
export const REPORTED_EXTRA_LOCALES: Record<string, readonly string[]> = {
  us: ['es-MX', 'fr-FR', 'pt-BR', 'ru', 'ko', 'vi', 'zh-Hans', 'zh-Hant', 'ar-SA'],
  ca: ['fr-CA'],
  be: ['nl-NL', 'fr-FR'],
  ch: ['en-GB', 'fr-FR', 'it'],
  jp: ['en-US'],
  mx: ['en-GB'],
};

export const STOREFRONT_NOTE =
  'UNVERIFIED: tools report that some storefronts also read the keywords of other locales of the same listing. Apple does not state this on the pages checked here. Treat it as a hint and check it yourself.';

export type StorefrontLocale = { locale: string; kind: 'primary' | 'reported'; present: boolean };

/** For one storefront: its usual locale and the reported extra ones, each with whether the listing has that locale. */
export function storefrontCombos(
  country: string,
  listingLocales: readonly string[],
): { country: string; locales: StorefrontLocale[]; unverified: true; note: string } {
  const c = country.toLowerCase();
  const primary = defaultLocaleFor(c);
  const has = (l: string) => listingLocales.some((x) => sameLocale(x, l));
  const locales: StorefrontLocale[] = [{ locale: primary, kind: 'primary', present: has(primary) }];
  for (const l of REPORTED_EXTRA_LOCALES[c] ?? [])
    locales.push({ locale: l, kind: 'reported', present: has(l) });
  return { country: c, locales, unverified: true, note: STOREFRONT_NOTE };
}

/** A tracked keyword, as far as the listing views need it. */
export type TrackedRef = { term: string; country: string; locale: string };

/** The words of a term as the budgets compare them: lower case, accents folded, English plurals folded. */
export const termKeyOf = (term: string, locale: string): string =>
  matchWords(term, languageOf(locale)).join(' ');

export type LocaleStorefront = {
  /** The storefront (two letters) keywords of this locale are tracked in. */
  country: string;
  /** Storefronts that already have keywords of this locale, the one with most first. */
  tracked: string[];
  /** `tracked` plus the usual storefront of the locale, when that is not one of them. */
  options: string[];
};

/**
 * The storefront rank tracking uses for a listing locale: the one that already has the most tracked
 * keywords in that locale, else the usual storefront of the locale (`defaultCountryFor`), else `us`.
 */
export function storefrontFor(
  locale: string,
  tracked: readonly { country: string; locale: string }[],
): LocaleStorefront {
  const counts = new Map<string, number>();
  for (const t of tracked)
    if (sameLocale(t.locale, locale))
      counts.set(t.country.toLowerCase(), (counts.get(t.country.toLowerCase()) ?? 0) + 1);
  const list = Array.from(counts.keys()).sort(
    (a, b) => (counts.get(b) as number) - (counts.get(a) as number) || a.localeCompare(b),
  );
  const usual = defaultCountryFor(locale) || 'us';
  const options = list.indexOf(usual) >= 0 ? list : list.concat([usual]);
  return { country: list[0] ?? usual, tracked: list, options };
}

/** The keys (see `termKeyOf`) of the keywords tracked in this storefront in this locale. */
export function trackedKeys(
  tracked: readonly TrackedRef[],
  locale: string,
  country: string,
): Set<string> {
  const out = new Set<string>();
  const c = country.toLowerCase();
  for (const t of tracked) {
    if (t.country.toLowerCase() !== c || !sameLocale(t.locale, locale)) continue;
    const key = termKeyOf(t.term, locale);
    if (key !== '') out.add(key);
  }
  return out;
}

/** The entries of an App Store keyword field: split on commas, trimmed, empty ones dropped, the same words (plurals folded) once. */
export function keywordFieldEntries(
  value: string,
  locale: string,
): { term: string; key: string }[] {
  const out: { term: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const term = part.trim();
    const key = termKeyOf(term, locale);
    if (term === '' || key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ term, key });
  }
  return out;
}

export type UntrackedSetKeywords = { locale: string; country: string; terms: string[] };

/**
 * The keywords a person SET in the App Store keyword field of each listing locale that no tracked keyword
 * covers in the locale's storefront. Entries that cannot be tracked (too long, too many words) are left out.
 * Google Play has no keyword field, so nothing is "set" there and the answer is empty.
 */
export function untrackedSetKeywords(input: {
  platform: AsoPlatform;
  listingLocales: readonly { locale: string; fields: FitFields }[];
  tracked: readonly TrackedRef[];
}): UntrackedSetKeywords[] {
  if (!supports(input.platform, 'keywordField')) return [];
  const out: UntrackedSetKeywords[] = [];
  for (const l of input.listingLocales) {
    const value = l.fields.keywords;
    if (value === undefined || value.trim() === '') continue;
    const { country } = storefrontFor(l.locale, input.tracked);
    const have = trackedKeys(input.tracked, l.locale, country);
    const terms = keywordFieldEntries(value, l.locale)
      .filter((e) => !have.has(e.key) && checkTerm(e.term).ok)
      .map((e) => e.term);
    if (terms.length > 0) out.push({ locale: l.locale, country, terms });
  }
  return out.sort((a, b) => b.terms.length - a.terms.length || a.locale.localeCompare(b.locale));
}

export type UntappedKind = 'no_locale' | 'empty_keyword_field' | 'empty_short_description';

export type UntappedLocale = {
  locale: string;
  kind: UntappedKind;
  /** Storefronts (two letters) where keywords are tracked in this locale. */
  countries: string[];
  /** How many tracked keywords use this locale. */
  keywords: number;
};

/**
 * Locales the app is not using: a tracked locale that the listing has no text for, a locale whose App Store
 * keyword field is empty (Google Play: whose short description is empty). Uses what the tool already holds:
 * the tracked markets and the stored listing. Tracked ones come first, the most keywords first.
 */
export function untappedLocales(input: {
  platform: AsoPlatform;
  listingLocales: readonly { locale: string; fields: FitFields }[];
  tracked: readonly { country: string; locale: string }[];
}): UntappedLocale[] {
  const isApple = supports(input.platform, 'keywordField');
  const wanted = new Map<string, { locale: string; countries: string[]; keywords: number }>();
  for (const t of input.tracked) {
    const tag = tagOf(t.locale);
    let entry = wanted.get(tag);
    if (!entry) {
      entry = { locale: t.locale, countries: [], keywords: 0 };
      wanted.set(tag, entry);
    }
    entry.keywords += 1;
    const country = t.country.toLowerCase();
    if (entry.countries.indexOf(country) < 0) entry.countries.push(country);
  }
  const out: UntappedLocale[] = [];
  const emptyKind: UntappedKind = isApple ? 'empty_keyword_field' : 'empty_short_description';
  const isEmpty = (fields: FitFields): boolean =>
    ((isApple ? fields.keywords : fields.shortDescription) ?? '').trim() === '';
  const reported = new Set<string>();
  wanted.forEach((entry) => {
    const listing = matchListingLocale(input.listingLocales, entry.locale);
    entry.countries.sort();
    if (!listing) {
      out.push({
        locale: entry.locale,
        kind: 'no_locale',
        countries: entry.countries,
        keywords: entry.keywords,
      });
      return;
    }
    if (isEmpty(listing.fields)) {
      reported.add(tagOf(listing.locale));
      out.push({
        locale: listing.locale,
        kind: emptyKind,
        countries: entry.countries,
        keywords: entry.keywords,
      });
    }
  });
  for (const l of input.listingLocales) {
    if (reported.has(tagOf(l.locale)) || !isEmpty(l.fields)) continue;
    out.push({ locale: l.locale, kind: emptyKind, countries: [], keywords: 0 });
  }
  out.sort((a, b) => b.keywords - a.keywords || a.locale.localeCompare(b.locale));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The coach: a short ranked list of next actions

export type CoachKind =
  | 'track_keywords'
  | 'check_ranks'
  | 'rank_dropped'
  | 'not_in_listing'
  | 'untracked_set_keywords'
  | 'competitor_above'
  | 'keyword_field_waste'
  | 'unused_characters'
  | 'untapped_locale'
  | 'follow_competitors';

/** The order the actions are given in: first what blocks everything else, then what has moved, then tidying. */
export const COACH_ORDER: readonly CoachKind[] = [
  'track_keywords',
  'check_ranks',
  'rank_dropped',
  'not_in_listing',
  'untracked_set_keywords',
  'competitor_above',
  'keyword_field_waste',
  'unused_characters',
  'untapped_locale',
  'follow_competitors',
];

export type CoachKeyword = {
  id: string;
  term: string;
  country: string;
  locale: string;
  priority?: number;
  state: 'ranked' | 'not_ranked' | null;
  rank: number | null;
  lastCheckedAt: number | null;
  change: RankChange | null;
};

export type CoachCompetitorAbove = {
  keywordId: string;
  competitorId: string;
  competitorName: string;
  competitorRank: number;
};

export type CoachInput = {
  platform: AsoPlatform;
  now: number;
  keywords: readonly CoachKeyword[];
  competitors: readonly { id: string; name: string }[];
  /** Followed competitors that are in the stored results of a tracked keyword above the own app (or while it is not in them). */
  competitorsAbove: readonly CoachCompetitorAbove[];
  /** Every locale of the stored listing. */
  listingLocales: readonly { locale: string; fields: FitFields }[];
  /** When the last rank check succeeded; null: never. */
  lastCheckAt: number | null;
  /** The workspace's rank move threshold (places). */
  rankMoveThreshold: number;
  /** A check older than this is "not lately". Default 7 days. */
  staleAfterMs?: number;
  /** At most this many actions. Default 8. */
  limit?: number;
};

export type CoachLink = {
  to:
    | 'keywords'
    | 'keywords_add'
    | 'listing_keywords'
    | 'competitors'
    | 'fit'
    | 'ideas'
    | 'listing';
  /** Open this locale (the listing's locale drawer). */
  locale?: string;
  label: string;
};

export type CoachAction = {
  id: string;
  kind: CoachKind;
  /** 1 is first. */
  position: number;
  title: string;
  detail: string;
  /**
   * The title, the detail and the lines as keys with parameters (`CoreText`), for a client that shows
   * them in the reader's language. Keys start with `coach.`. `itemTexts` runs parallel to `items`.
   */
  titleText: CoreText;
  detailText: CoreText;
  itemTexts: CoreText[];
  /** The label of `link`: `coach.link.keywordsAdd`, `keywords`, `listingKeywords`, `competitors`, `listing`, `listingLocale` (parameter `locale`). */
  linkText: CoreText;
  /** What it is about, short lines (at most 5). */
  items: string[];
  /** How many more there are than `items` shows. */
  more: number;
  link: CoachLink;
};

const DAY_MS = 86_400_000;
const MAX_ITEMS = 5;

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Room is "left" when at least this share of the limit, and at least this many characters, are unused. */
const ROOM_SHARE = 0.15;
const ROOM_MIN = 5;

type Draft = Omit<CoachAction, 'position' | 'items' | 'itemTexts' | 'more' | 'linkText'> & {
  all: string[];
  allText: CoreText[];
};

const linkLabelText = (link: CoachLink): CoreText => {
  switch (link.to) {
    case 'keywords_add':
      return coreText('coach.link.keywordsAdd');
    case 'keywords':
      return coreText('coach.link.keywords');
    case 'listing_keywords':
      return coreText('coach.link.listingKeywords');
    case 'competitors':
      return coreText('coach.link.competitors');
    default:
      return link.locale === undefined
        ? coreText('coach.link.listing')
        : coreText('coach.link.listingLocale', { locale: link.locale });
  }
};

function dropSize(change: RankChange | null): number {
  if (!change) return 0;
  if (change.kind === 'down') return Math.abs(change.delta ?? 0);
  if (change.kind === 'dropped') return 1000;
  return 0;
}

function dropText(change: RankChange | null): string {
  if (!change) return '';
  if (change.kind === 'dropped') return `left the results (was ${change.from})`;
  return `${change.from} to ${change.to}`;
}

/** Up to `limit` (default 8) next actions in a fixed order of importance, from what the tool already holds; fewer, or none, when little applies. */
export function buildCoach(input: CoachInput): CoachAction[] {
  const { platform, keywords } = input;
  const isApple = supports(platform, 'keywordField');
  const drafts: Draft[] = [];
  const stale = input.staleAfterMs ?? 7 * DAY_MS;

  // 1. Nothing tracked.
  if (keywords.length === 0) {
    drafts.push({
      id: 'track_keywords',
      kind: 'track_keywords',
      title: 'Track your first keywords',
      detail:
        'A keyword is a word or phrase people might search for. Tracking one records where the app appears in the store results for it.',
      titleText: coreText('coach.trackKeywords.title'),
      detailText: coreText('coach.trackKeywords.detail'),
      all: [],
      allText: [],
      link: { to: 'keywords_add', label: 'Add keywords' },
    });
  }

  // 2. No rank check lately.
  if (keywords.length > 0) {
    const unchecked = keywords.filter((k) => k.lastCheckedAt === null).length;
    if (input.lastCheckAt === null || unchecked === keywords.length) {
      drafts.push({
        id: 'check_ranks',
        kind: 'check_ranks',
        title: 'Check the ranks for the first time',
        detail: `${count(unchecked, 'tracked keyword has', 'tracked keywords have')} not been checked yet. A check reads the public store; nothing is changed there.`,
        titleText: coreText('coach.checkRanksFirst.title'),
        detailText: coreText('coach.checkRanksFirst.detail', { count: unchecked }),
        all: [],
        allText: [],
        link: { to: 'keywords', label: 'Open keywords' },
      });
    } else if (input.now - input.lastCheckAt >= stale) {
      const days = Math.floor((input.now - input.lastCheckAt) / DAY_MS);
      drafts.push({
        id: 'check_ranks',
        kind: 'check_ranks',
        title: `Ranks were last checked ${days === 1 ? '1 day' : `${days} days`} ago`,
        detail: 'Ranks only change when a check runs. Run one to see where things stand now.',
        titleText: coreText('coach.checkRanksStale.title', { count: days }),
        detailText: coreText('coach.checkRanksStale.detail'),
        all: [],
        allText: [],
        link: { to: 'keywords', label: 'Open keywords' },
      });
    }
  }

  // 3. Rank dropped.
  const drops = keywords
    .filter(
      (k) =>
        k.change !== null &&
        (k.change.kind === 'down' || k.change.kind === 'dropped') &&
        isBigMove(k.change, input.rankMoveThreshold),
    )
    .sort((a, b) => dropSize(b.change) - dropSize(a.change) || a.term.localeCompare(b.term));
  if (drops.length > 0) {
    drafts.push({
      id: 'rank_dropped',
      kind: 'rank_dropped',
      title: `${count(drops.length, 'keyword', 'keywords')} dropped in rank`,
      detail: `Down at least ${count(input.rankMoveThreshold, 'place', 'places')}, or out of the top 10, between the last two checks.`,
      titleText: coreText('coach.rankDropped.title', { count: drops.length }),
      detailText: coreText('coach.rankDropped.detail', { count: input.rankMoveThreshold }),
      all: drops.map((k) => `${k.term} (${k.country.toUpperCase()}): ${dropText(k.change)}`),
      allText: drops.map((k) =>
        k.change?.kind === 'dropped'
          ? coreText('coach.rankDropped.left', {
              term: k.term,
              country: k.country.toUpperCase(),
              from: k.change.from ?? 0,
            })
          : coreText('coach.rankDropped.moved', {
              term: k.term,
              country: k.country.toUpperCase(),
              from: k.change?.from ?? 0,
              to: k.change?.to ?? 0,
            }),
      ),
      link: { to: 'keywords', label: 'Open keywords' },
    });
  }

  // Per locale analysis of the listing, shared by the next actions.
  const byLocale = new Map<string, { locale: string; list: CoachKeyword[] }>();
  for (const k of keywords) {
    const tag = tagOf(k.locale);
    const entry = byLocale.get(tag) ?? { locale: k.locale, list: [] };
    entry.list.push(k);
    byLocale.set(tag, entry);
  }
  const asFit = (list: readonly CoachKeyword[]): FitKeyword[] =>
    list.map((k) => ({
      id: k.id,
      term: k.term,
      ...(k.priority !== undefined ? { priority: k.priority } : {}),
    }));

  // 4. Tracked keywords that are not in the listing.
  const missingLines: {
    line: string;
    term: string;
    keywordLocale: string;
    locale: string;
    priority: number;
  }[] = [];
  byLocale.forEach((entry) => {
    const listing = matchListingLocale(input.listingLocales, entry.locale);
    if (!listing) return;
    const budget = listingBudget({
      platform,
      locale: entry.locale,
      fields: listing.fields,
      keywords: asFit(entry.list),
    });
    for (const m of budget.missing)
      missingLines.push({
        line: `${m.term} (${entry.locale})`,
        term: m.term,
        keywordLocale: entry.locale,
        locale: listing.locale,
        priority: m.priority,
      });
  });
  if (missingLines.length > 0) {
    missingLines.sort((a, b) => b.priority - a.priority || a.line.localeCompare(b.line));
    const first = missingLines[0] as { locale: string };
    const where = isApple ? 'name, subtitle or keyword field' : 'title, short or full description';
    drafts.push({
      id: 'not_in_listing',
      kind: 'not_in_listing',
      title: `${count(missingLines.length, 'tracked keyword is', 'tracked keywords are')} not in the listing`,
      detail: `None of their words appear in the ${where}, so the store has little reason to show the app for them.`,
      titleText: coreText('coach.notInListing.title', { count: missingLines.length }),
      detailText: coreText(isApple ? 'coach.notInListing.detailApple' : 'coach.notInListing.detailPlay'),
      all: missingLines.map((m) => m.line),
      allText: missingLines.map((m) =>
        coreText('coach.item.keywordLocale', { term: m.term, locale: m.keywordLocale }),
      ),
      link: { to: 'listing', locale: first.locale, label: `Open ${first.locale} in the listing` },
    });
  }

  // 4b. Keywords set in the App Store keyword field that are not tracked.
  const untrackedSet = untrackedSetKeywords({
    platform,
    listingLocales: input.listingLocales,
    tracked: keywords,
  });
  if (untrackedSet.length > 0) {
    const total = untrackedSet.reduce((n, u) => n + u.terms.length, 0);
    const first = untrackedSet[0] as UntrackedSetKeywords;
    drafts.push({
      id: 'untracked_set_keywords',
      kind: 'untracked_set_keywords',
      title: `${count(total, 'set keyword is', 'set keywords are')} not tracked`,
      detail:
        'These are in the keyword field of the listing, but no rank is recorded for them, so you cannot tell whether they help. Tracking one only reads the public store.',
      titleText: coreText('coach.untrackedSet.title', { count: total }),
      detailText: coreText('coach.untrackedSet.detail'),
      allText: untrackedSet.map((u) =>
        u.terms.length > 4
          ? coreText('coach.untrackedSet.itemMore', {
              locale: u.locale,
              country: u.country.toUpperCase(),
              terms: u.terms.slice(0, 4).join(', '),
              count: u.terms.length - 4,
            })
          : coreText('coach.untrackedSet.item', {
              locale: u.locale,
              country: u.country.toUpperCase(),
              terms: u.terms.join(', '),
            }),
      ),
      all: untrackedSet.map(
        (u) =>
          `${u.locale} (${u.country.toUpperCase()}): ${u.terms.slice(0, 4).join(', ')}${u.terms.length > 4 ? ` and ${u.terms.length - 4} more` : ''}`,
      ),
      link: { to: 'listing_keywords', locale: first.locale, label: 'See them in the listing' },
    });
  }

  // 5. A followed competitor ranks above.
  if (input.competitorsAbove.length > 0) {
    const kw = new Map<string, CoachKeyword>();
    for (const k of keywords) kw.set(k.id, k);
    const rows: { a: CoachCompetitorAbove; k: CoachKeyword }[] = [];
    for (const a of input.competitorsAbove) {
      const k = kw.get(a.keywordId);
      if (k) rows.push({ a, k });
    }
    rows.sort(
      (x, y) =>
        (y.k.priority ?? 2) - (x.k.priority ?? 2) ||
        x.a.competitorRank - y.a.competitorRank ||
        x.k.term.localeCompare(y.k.term),
    );
    if (rows.length > 0) {
      drafts.push({
        id: 'competitor_above',
        kind: 'competitor_above',
        title: `${count(rows.length, 'followed competitor ranks', 'followed competitors rank')} above you`,
        detail:
          'In the stored results for tracked keywords, a competitor you follow comes before this app. Compare their name and subtitle with yours.',
        titleText: coreText('coach.competitorAbove.title', { count: rows.length }),
        detailText: coreText('coach.competitorAbove.detail'),
        allText: rows.map(({ a, k }) =>
          k.state === 'ranked' && k.rank !== null
            ? coreText('coach.competitorAbove.itemRanked', {
                name: a.competitorName,
                competitorRank: a.competitorRank,
                term: k.term,
                rank: k.rank,
              })
            : coreText('coach.competitorAbove.itemUnranked', {
                name: a.competitorName,
                competitorRank: a.competitorRank,
                term: k.term,
              }),
        ),
        all: rows.map(
          ({ a, k }) =>
            `${a.competitorName} is ${a.competitorRank} for ${k.term}; ${k.state === 'ranked' && k.rank !== null ? `you are ${k.rank}` : 'you are not in the results'}`,
        ),
        link: { to: 'competitors', label: 'Open competitors' },
      });
    }
  }

  const budgets = input.listingLocales.map((l) => ({
    l,
    budget: listingBudget({
      platform,
      locale: l.locale,
      fields: l.fields,
      keywords: asFit(byLocale.get(tagOf(l.locale))?.list ?? []),
    }),
  }));

  // 6. Keyword field waste (App Store).
  if (isApple) {
    const wasteful = budgets.filter(
      (b) => b.budget.keywordField !== null && b.budget.keywordField.totalBytes > 0,
    );
    if (wasteful.length > 0) {
      const bytesOf = (b: (typeof wasteful)[number]): number =>
        b.budget.keywordField?.totalBytes ?? 0;
      const total = wasteful.reduce((n, b) => n + bytesOf(b), 0);
      wasteful.sort((a, b) => bytesOf(b) - bytesOf(a) || a.l.locale.localeCompare(b.l.locale));
      const first = (wasteful[0] as (typeof wasteful)[number]).l.locale;
      drafts.push({
        id: 'keyword_field_waste',
        kind: 'keyword_field_waste',
        title: `The keyword field wastes ${count(total, 'byte', 'bytes')}`,
        detail:
          'Spaces after commas, empty or repeated entries, and entries the name or subtitle already hold take room from words that could be added. UNVERIFIED that the store ignores repeats across fields.',
        titleText: coreText('coach.keywordFieldWaste.title', { count: total }),
        detailText: coreText('coach.keywordFieldWaste.detail'),
        all: wasteful.map((b) => `${b.l.locale}: ${count(bytesOf(b), 'byte', 'bytes')}`),
        allText: wasteful.map((b) =>
          coreText('coach.keywordFieldWaste.item', { locale: b.l.locale, count: bytesOf(b) }),
        ),
        link: { to: 'listing', locale: first, label: `Open ${first} in the listing` },
      });
    }
  }

  const untapped = untappedLocales({
    platform,
    listingLocales: input.listingLocales,
    tracked: keywords.map((k) => ({ country: k.country, locale: k.locale })),
  });
  const emptyKeywordLocales = new Set(
    untapped.filter((u) => u.kind !== 'no_locale').map((u) => tagOf(u.locale)),
  );

  // 7. Characters left unused in the fields a person writes (an empty keyword field is reported as an untapped locale instead).
  const room: {
    line: string;
    text: CoreText;
    locale: string;
    remaining: number;
  }[] = [];
  for (const { l, budget } of budgets) {
    for (const f of budget.fields) {
      if (f.field === 'description') continue;
      if (f.field === 'keywords' && emptyKeywordLocales.has(tagOf(l.locale))) continue;
      if (f.remaining >= Math.max(ROOM_MIN, Math.ceil(f.limit * ROOM_SHARE))) {
        room.push({
          line: `${l.locale} ${f.label.toLowerCase()}: ${f.used} of ${f.limit} ${f.unit} used`,
          text: coreText(
            f.unit === 'bytes' ? 'coach.unusedCharacters.itemBytes' : 'coach.unusedCharacters.itemCharacters',
            { locale: l.locale, field: f.field, used: f.used, limit: f.limit },
          ),
          locale: l.locale,
          remaining: f.remaining,
        });
      }
    }
  }
  if (room.length > 0) {
    room.sort((a, b) => b.remaining - a.remaining || a.line.localeCompare(b.line));
    const first = (room[0] as { locale: string }).locale;
    drafts.push({
      id: 'unused_characters',
      kind: 'unused_characters',
      title: `${count(room.length, 'field has', 'fields have')} room left`,
      detail:
        'Characters not used are words the store cannot match. Fill them only with words that describe the app.',
      titleText: coreText('coach.unusedCharacters.title', { count: room.length }),
      detailText: coreText('coach.unusedCharacters.detail'),
      all: room.map((r) => r.line),
      allText: room.map((r) => r.text),
      link: { to: 'listing', locale: first, label: `Open ${first} in the listing` },
    });
  }

  // 8. Untapped locales.
  if (untapped.length > 0) {
    const first = untapped[0] as UntappedLocale;
    const what = (u: UntappedLocale): string => {
      const markets =
        u.countries.length > 0
          ? ` (tracked in ${u.countries.map((c) => c.toUpperCase()).join(', ')})`
          : '';
      if (u.kind === 'no_locale') return `${u.locale}: no listing text${markets}`;
      return `${u.locale}: ${isApple ? 'the keyword field is empty' : 'the short description is empty'}${markets}`;
    };
    drafts.push({
      id: 'untapped_locale',
      kind: 'untapped_locale',
      title: `${count(untapped.length, 'locale has', 'locales have')} no ${isApple ? 'keyword' : 'search'} text`,
      detail:
        'A locale with no text gives the store nothing to match in that language. A storefront may also read other locales of the listing (UNVERIFIED).',
      titleText: coreText(
        isApple ? 'coach.untappedLocale.titleApple' : 'coach.untappedLocale.titlePlay',
        { count: untapped.length },
      ),
      detailText: coreText('coach.untappedLocale.detail'),
      all: untapped.map(what),
      allText: untapped.map((u) => {
        const base =
          u.kind === 'no_locale'
            ? 'coach.untappedLocale.itemNoLocale'
            : isApple
              ? 'coach.untappedLocale.itemEmptyKeywordField'
              : 'coach.untappedLocale.itemEmptyShortDescription';
        return u.countries.length > 0
          ? coreText(`${base}Markets`, {
              locale: u.locale,
              markets: u.countries.map((c) => c.toUpperCase()).join(', '),
            })
          : coreText(base, { locale: u.locale });
      }),
      link:
        first.kind === 'no_locale'
          ? { to: 'listing', label: 'Open the listing' }
          : { to: 'listing', locale: first.locale, label: `Open ${first.locale} in the listing` },
    });
  }

  // 9. Follow a competitor.
  if (keywords.length > 0 && input.competitors.length === 0) {
    drafts.push({
      id: 'follow_competitors',
      kind: 'follow_competitors',
      title: 'Follow a competitor',
      detail:
        'Seeing what a similar app puts in its name and subtitle shows words you may be missing. Apps that show up for several of your keywords can be suggested.',
      titleText: coreText('coach.followCompetitors.title'),
      detailText: coreText('coach.followCompetitors.detail'),
      all: [],
      allText: [],
      link: { to: 'competitors', label: 'Open competitors' },
    });
  }

  drafts.sort((a, b) => COACH_ORDER.indexOf(a.kind) - COACH_ORDER.indexOf(b.kind));
  return drafts.slice(0, Math.max(1, input.limit ?? 8)).map(({ all, allText, link, ...rest }, i) => ({
    ...rest,
    link,
    linkText: linkLabelText(link),
    position: i + 1,
    items: all.slice(0, MAX_ITEMS),
    itemTexts: allText.slice(0, MAX_ITEMS),
    more: Math.max(0, all.length - MAX_ITEMS),
  }));
}
