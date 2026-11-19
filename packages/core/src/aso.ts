/**
 * App Store Optimization (ASO) logic, pure: keyword normalization, rank change and trend, how well
 * a store listing covers tracked keywords, ideas mined from texts, what changed at a competitor, and
 * candidate competitors from search results. No network, no clock, no database: the server feeds it.
 *
 * Written for the web as well (ES2017: no `flatMap`, `fromEntries`, `matchAll`, `.at()` and no
 * Unicode property escapes in regular expressions).
 *
 * What this module does NOT have, on purpose: search volume, popularity or difficulty. No free
 * official source provides them (docs/adr/0011-aso-keywords-competitors.md). `Idea.localScore` is
 * a frequency in texts you gave it, nothing more, and is labelled so wherever it is shown.
 *
 * Facts about how the stores index text that no official page checked here states are marked
 * UNVERIFIED in comments and in the ADR; the fit result carries them as `assumptions`.
 */

import { isApplePlatform, type Platform } from './platform.ts';

// ---------------------------------------------------------------------------------------------
// Terms

export type AsoPlatform = Platform;

export const MAX_TERM_CHARACTERS = 80;
export const MAX_TERM_WORDS = 8;
export const MAX_TAG_CHARACTERS = 40;
export const MAX_NOTES_CHARACTERS = 500;

// Everything that separates words: white space, ASCII and Latin-1 punctuation and symbols, general
// punctuation and symbols, CJK and full-width punctuation, variation selectors and surrogates
// (emoji outside the BMP). Digits and letters of every script are not in it. An apostrophe is
// removed first, so `don't` is one word. UNVERIFIED how the stores treat these characters.
const SEPARATORS =
  /[\s\u0000-/:-@[-`{-¿×÷ -⁯←-⯿　-〿＀-／：-＠［-｀｛-･︀-️\ud800-\udfff]+/;
const APOSTROPHES = /['’‘ʼ`]/g;
const MARKS = /[̀-ͯ]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Lower case, NFKC, apostrophes removed; the words keep their accents. */
export function words(text: string): string[] {
  const cleaned = text.normalize('NFKC').toLowerCase().replace(APOSTROPHES, '');
  return cleaned.split(SEPARATORS).filter((w) => w !== '');
}

/** A word without accents, for matching only (`für` and `fur` are one word there). */
export function foldWord(word: string): string {
  return word.normalize('NFKD').replace(MARKS, '').normalize('NFKC');
}

/** The words of a text, folded. */
export function foldedWords(text: string): string[] {
  return words(text).map(foldWord);
}

export type TermCheck = { ok: true; term: string; key: string; words: number } | { ok: false; reason: string };

/**
 * A keyword as a person types it. `term` is what is shown (white space collapsed, case kept); `key`
 * is what makes two terms the same: folded words joined by one space, so `Habit-Tracker`, `habit  tracker`
 * and `Hàbit tracker` are one keyword.
 */
export function checkTerm(raw: unknown): TermCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'A keyword is text.' };
  if (CONTROL.test(raw)) return { ok: false, reason: 'A keyword has no control characters.' };
  const term = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (term === '') return { ok: false, reason: 'A keyword is not empty.' };
  if (Array.from(term).length > MAX_TERM_CHARACTERS) {
    return { ok: false, reason: `A keyword has at most ${MAX_TERM_CHARACTERS} characters.` };
  }
  const parts = foldedWords(term);
  if (parts.length === 0) return { ok: false, reason: 'A keyword needs at least one letter or digit.' };
  if (parts.length > MAX_TERM_WORDS) return { ok: false, reason: `A keyword has at most ${MAX_TERM_WORDS} words.` };
  return { ok: true, term, key: parts.join(' '), words: parts.length };
}

/** A storefront: two letters, lower case. */
export function normalizeCountry(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z]{2}$/.test(raw.trim()) ? raw.trim().toLowerCase() : undefined;
}

/** A language tag such as `en`, `en-US`, `pt-BR`, `zh-Hans-CN`; `_` reads as `-`. */
export function normalizeLocale(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.trim().replace(/_/g, '-').split('-');
  if (parts.length === 0 || parts.length > 3) return undefined;
  const language = parts[0] ?? '';
  if (!/^[A-Za-z]{2,3}$/.test(language)) return undefined;
  let script: string | undefined;
  let region: string | undefined;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (script === undefined && region === undefined && /^[A-Za-z]{4}$/.test(part)) {
      script = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } else if (region === undefined && (/^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part))) {
      region = part.toUpperCase();
    } else {
      return undefined;
    }
  }
  return [language.toLowerCase(), script, region].filter((p): p is string => p !== undefined).join('-');
}

const COUNTRY_LOCALE: Record<string, string> = {
  us: 'en-US', gb: 'en-GB', au: 'en-AU', ca: 'en-CA', ie: 'en-IE', nz: 'en-NZ', in: 'en-IN', za: 'en-ZA', sg: 'en-SG',
  de: 'de-DE', at: 'de-AT', ch: 'de-CH', fr: 'fr-FR', be: 'nl-BE', nl: 'nl-NL', es: 'es-ES', mx: 'es-MX', ar: 'es-AR',
  co: 'es-CO', cl: 'es-CL', it: 'it-IT', pt: 'pt-PT', br: 'pt-BR', se: 'sv-SE', no: 'nb-NO', dk: 'da-DK', fi: 'fi-FI',
  pl: 'pl-PL', cz: 'cs-CZ', hu: 'hu-HU', ro: 'ro-RO', gr: 'el-GR', tr: 'tr-TR', ru: 'ru-RU', ua: 'uk-UA', il: 'he-IL',
  sa: 'ar-SA', ae: 'ar-AE', eg: 'ar-EG', jp: 'ja-JP', kr: 'ko-KR', cn: 'zh-Hans-CN', tw: 'zh-Hant-TW', hk: 'zh-Hant-HK',
  th: 'th-TH', vn: 'vi-VN', id: 'id-ID', my: 'ms-MY', ph: 'en-PH',
};

/** The listing locale a storefront most likely uses, for a keyword added without one. `en` for a country not in the list. */
export function defaultLocaleFor(country: string): string {
  return COUNTRY_LOCALE[country.toLowerCase()] ?? 'en';
}

/**
 * The storefront (two letters) a listing locale most likely belongs to: the reverse of `defaultLocaleFor`.
 * An exact match of the table wins, then the region of the tag (`fr-CA` gives `ca`), then a script match
 * (`zh-Hans` gives `cn`), then the first storefront of the language (`ja` gives `jp`). '' when none is known.
 */
export function defaultCountryFor(locale: string): string {
  const tag = locale.trim().replace(/_/g, '-').toLowerCase();
  if (tag === '') return '';
  const countries = Object.keys(COUNTRY_LOCALE);
  const tagOf = (c: string): string => (COUNTRY_LOCALE[c] as string).toLowerCase();
  for (const c of countries) if (tagOf(c) === tag) return c;
  const parts = tag.split('-');
  const last = parts[parts.length - 1] ?? '';
  if (parts.length > 1 && /^[a-z]{2}$/.test(last)) return last;
  for (const c of countries) if (tagOf(c).indexOf(`${tag}-`) === 0) return c;
  const language = parts[0] === 'no' ? 'nb' : (parts[0] ?? '');
  for (const c of countries) if ((tagOf(c).split('-')[0] ?? '') === language) return c;
  return '';
}

/** `pt-BR` gives `pt`. */
export function languageOf(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Rank change and trend

/** One rank check: `rank` is the 1-based position, null when the app is not in the first `total` results. */
export type RankPoint = { rank: number | null; total: number };

export type RankChangeKind = 'first' | 'same' | 'up' | 'down' | 'entered' | 'dropped' | 'still_unranked';
export type RankChange = {
  kind: RankChangeKind;
  /** Places gained (positive) or lost (negative) when both checks ranked; undefined otherwise. */
  delta?: number;
  /** The change is large enough to tell somebody (see `isBigMove`). */
  from: number | null;
  to: number | null;
};

/** The rank of the position that counts as "in the top" when an app enters or leaves the results. */
export const DEFAULT_EDGE_TOP = 10;

export function rankChange(previous: RankPoint | undefined, current: RankPoint): RankChange {
  if (!previous) return { kind: 'first', from: null, to: current.rank };
  const from = previous.rank;
  const to = current.rank;
  if (from === null && to === null) return { kind: 'still_unranked', from, to };
  if (from === null) return { kind: 'entered', from, to };
  if (to === null) return { kind: 'dropped', from, to };
  const delta = from - to;
  return { kind: delta === 0 ? 'same' : delta > 0 ? 'up' : 'down', delta, from, to };
}

/**
 * Whether a change is worth an event. Between two ranked checks: at least `threshold` places either
 * way. Entering or leaving the results: only when the ranked position is within `edgeTop` (an app
 * that flickers at position 48 and 51 is not news). The first check and "same" never are.
 */
export function isBigMove(change: RankChange, threshold: number, edgeTop: number = DEFAULT_EDGE_TOP): boolean {
  if (change.kind === 'up' || change.kind === 'down') return Math.abs(change.delta ?? 0) >= threshold;
  if (change.kind === 'entered') return (change.to ?? Number.POSITIVE_INFINITY) <= edgeTop;
  if (change.kind === 'dropped') return (change.from ?? Number.POSITIVE_INFINITY) <= edgeTop;
  return false;
}

export type RankTrend = {
  direction: 'up' | 'down' | 'flat' | 'unknown';
  /** Places gained (positive) from the oldest to the latest check, counting "not ranked" as one past the deepest result seen. */
  delta: number | null;
  latest: number | null;
  best: number | null;
  worst: number | null;
  samples: number;
  /** Checks in which the app was in the results. */
  ranked: number;
};

/** The trend of checks given oldest first. Fewer than two checks: direction `unknown`. */
export function rankTrend(points: readonly RankPoint[]): RankTrend {
  const ranked = points.filter((p) => p.rank !== null).map((p) => p.rank as number);
  const last = points[points.length - 1];
  const base = {
    latest: last ? last.rank : null,
    best: ranked.length > 0 ? Math.min(...ranked) : null,
    worst: ranked.length > 0 ? Math.max(...ranked) : null,
    samples: points.length,
    ranked: ranked.length,
  };
  if (points.length < 2 || !last) return { direction: 'unknown', delta: null, ...base };
  const out = Math.max(...points.map((p) => p.total), ...ranked) + 1;
  const first = points[0] as RankPoint;
  const delta = (first.rank ?? out) - (last.rank ?? out);
  return { direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down', delta, ...base };
}

// ---------------------------------------------------------------------------------------------
// Listing keyword fit

export type FitField = 'title' | 'subtitle' | 'keywords' | 'shortDescription' | 'description';

/** The text of one locale of a listing, whatever the store calls the fields. */
export type FitFields = {
  /** App Store `name`, Google Play `title`. */
  title?: string;
  /** App Store only. */
  subtitle?: string;
  /** App Store only: the hidden keyword field (comma separated). */
  keywords?: string;
  /** Google Play only: `short_description`. */
  shortDescription?: string;
  /** App Store `description`, Google Play `full_description`. */
  description?: string;
};

/**
 * Which fields the store searches. UNVERIFIED for both stores here (Apple's and Google's help
 * pages were not part of what was checked): Apple is widely documented to use name, subtitle and
 * the keyword field and not the description; Google Play uses title, short and full description.
 */
export const INDEXED_FIELDS: Record<AsoPlatform, readonly FitField[]> = {
  ios: ['title', 'subtitle', 'keywords'],
  macos: ['title', 'subtitle', 'keywords'],
  android: ['title', 'shortDescription', 'description'],
};

/** The fields where a phrase counts as "strong" (a high weight in the store's ranking: UNVERIFIED). */
const STRONG_FIELDS: Record<AsoPlatform, readonly FitField[]> = {
  ios: ['title', 'subtitle'],
  macos: ['title', 'subtitle'],
  android: ['title', 'shortDescription'],
};

const FIELD_ORDER: Record<AsoPlatform, readonly FitField[]> = {
  ios: ['title', 'subtitle', 'keywords', 'description'],
  macos: ['title', 'subtitle', 'keywords', 'description'],
  android: ['title', 'shortDescription', 'description'],
};

export const FIT_ASSUMPTIONS: readonly string[] = [
  'UNVERIFIED: which fields each store searches (iOS: name, subtitle, keyword field; Android: title, short and full description).',
  'UNVERIFIED: an iOS multi word keyword is matched when its words appear anywhere in name, subtitle and keyword field.',
  'Matching ignores case and accents; English plurals (a trailing "s") are folded. Other languages are matched by exact word.',
];

export type FieldMatch = {
  field: FitField;
  /** The words of the keyword appear next to each other, in order, in this field. */
  phrase: boolean;
  /** How many of the keyword's words are in the field. */
  wordsPresent: number;
  /** How many times the whole phrase appears (0 when `phrase` is false). */
  occurrences: number;
};

export type FitStatus =
  /** The phrase is in a high weight field (name or subtitle; title or short description). */
  | 'strong'
  /** Every word is in the searched fields together, but not as a phrase in a high weight field. */
  | 'covered'
  /** Some words are in the searched fields. */
  | 'partial'
  /** iOS: the words are only in the description, which the store does not search (UNVERIFIED). */
  | 'description_only'
  | 'missing';

export type FitKeyword = {
  id: string;
  term: string;
  /** 1 low, 2 normal, 3 high. Default 2. */
  priority?: number;
  /** The latest rank of this keyword (null: not ranked), when known. Used only to order the gaps. */
  rank?: number | null;
};

export type KeywordFit = {
  id: string;
  term: string;
  priority: number;
  status: FitStatus;
  where: FieldMatch[];
  /** Words of the keyword that no searched field has. */
  missingWords: string[];
};

export type KeywordFieldReport = {
  /** The field as given. */
  value: string;
  bytes: number;
  characters: number;
  max: number;
  remaining: number;
  overBudget: boolean;
  /** The comma separated entries, trimmed, in order. */
  terms: string[];
  /** Entries (folded) that appear more than once in the field. */
  duplicates: string[];
  /** Entries whose words are all in the name or subtitle already: the store searches those anyway (UNVERIFIED), so they cost space for nothing. */
  inTitleOrSubtitle: string[];
  /** Bytes that are white space around the commas. */
  separatorBytes: number;
  /** The field without those spaces, duplicates and entries already in name or subtitle. */
  compacted: string;
  compactedBytes: number;
  /** Bytes given back by `compacted`. */
  savedBytes: number;
};

export const APP_STORE_KEYWORD_BYTES = 100;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** English plural folding only for English: `trackers` matches `tracker`. */
export function stem(word: string, language: string): string {
  if (language === 'en' && word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export const matchWords = (text: string | undefined, language: string): string[] =>
  text ? foldedWords(text).map((w) => stem(w, language)) : [];

function countPhrase(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0;
  let count = 0;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let all = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        all = false;
        break;
      }
    }
    if (all) count += 1;
  }
  return count;
}

/** How one keyword sits in the fields of one locale. */
export function fitKeyword(platform: AsoPlatform, locale: string, fields: FitFields, keyword: FitKeyword): KeywordFit {
  const language = languageOf(locale);
  const needle = matchWords(keyword.term, language);
  const unique = Array.from(new Set(needle));
  const where: FieldMatch[] = [];
  const indexed = INDEXED_FIELDS[platform];
  const present = new Set<string>();
  const inIndexed = new Set<string>();
  for (const field of FIELD_ORDER[platform]) {
    const text = matchWords(fields[field], language);
    const set = new Set(text);
    const wordsPresent = unique.filter((w) => set.has(w)).length;
    if (wordsPresent === 0) continue;
    // The keyword field holds separate entries: a phrase there is not a phrase for the store.
    const occurrences = field === 'keywords' ? 0 : countPhrase(text, needle);
    where.push({ field, phrase: occurrences > 0, wordsPresent, occurrences });
    for (const w of unique) {
      if (set.has(w)) {
        present.add(w);
        if (indexed.includes(field)) inIndexed.add(w);
      }
    }
  }
  const strong = where.some((m) => m.phrase && STRONG_FIELDS[platform].includes(m.field));
  let status: FitStatus;
  if (strong) status = 'strong';
  else if (unique.length > 0 && inIndexed.size === unique.length) status = 'covered';
  else if (inIndexed.size > 0) status = 'partial';
  else if (present.size > 0) status = 'description_only';
  else status = 'missing';
  return {
    id: keyword.id,
    term: keyword.term,
    priority: keyword.priority ?? 2,
    status,
    where,
    missingWords: unique.filter((w) => !inIndexed.has(w)),
  };
}

const STATUS_ORDER: Record<FitStatus, number> = { missing: 0, description_only: 1, partial: 2, covered: 3, strong: 4 };

export type ListingFit = {
  platform: AsoPlatform;
  locale: string;
  keywords: KeywordFit[];
  counts: Record<FitStatus, number>;
  /** Keywords that are not covered, worst first: high priority first, then the ones that rank worst. */
  gaps: KeywordFit[];
  keywordField?: KeywordFieldReport;
  assumptions: readonly string[];
};

/** Splits the iOS keyword field and measures it against its budget. */
export function analyzeKeywordField(
  value: string,
  options: { title?: string; subtitle?: string; maxBytes?: number; language?: string } = {},
): KeywordFieldReport {
  const max = options.maxBytes ?? APP_STORE_KEYWORD_BYTES;
  const language = options.language ?? 'en';
  const terms = value.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const known = new Set<string>(matchWords(options.title, language).concat(matchWords(options.subtitle, language)));
  const inTitleOrSubtitle: string[] = [];
  const keep: string[] = [];
  for (const term of terms) {
    const key = matchWords(term, language).join(' ');
    if (key === '') continue;
    if (seen.has(key)) {
      if (duplicates.indexOf(key) === -1) duplicates.push(key);
      continue;
    }
    seen.add(key);
    const parts = key.split(' ');
    if (parts.every((p) => known.has(p))) {
      inTitleOrSubtitle.push(term);
      continue;
    }
    keep.push(term);
  }
  const compacted = keep.join(',');
  const bytes = byteLength(value);
  const separatorBytes = (value.match(/\s*,\s*/g) || []).reduce((n, m) => n + byteLength(m) - 1, 0);
  const compactedBytes = byteLength(compacted);
  return {
    value,
    bytes,
    characters: Array.from(value).length,
    max,
    remaining: max - bytes,
    overBudget: bytes > max,
    terms,
    duplicates,
    inTitleOrSubtitle,
    separatorBytes,
    compacted,
    compactedBytes,
    savedBytes: Math.max(0, bytes - compactedBytes),
  };
}

/** The fit of every keyword against one locale of the listing. */
export function listingFit(input: {
  platform: AsoPlatform;
  locale: string;
  fields: FitFields;
  keywords: readonly FitKeyword[];
}): ListingFit {
  const { platform, locale, fields } = input;
  const keywords = input.keywords.map((k) => fitKeyword(platform, locale, fields, k));
  const counts: Record<FitStatus, number> = { strong: 0, covered: 0, partial: 0, description_only: 0, missing: 0 };
  for (const k of keywords) counts[k.status] += 1;
  const rankOf = new Map<string, number | null | undefined>();
  for (const k of input.keywords) rankOf.set(k.id, k.rank);
  const worse = (id: string): number => {
    const r = rankOf.get(id);
    return r === null || r === undefined ? Number.POSITIVE_INFINITY : r;
  };
  const gaps = keywords
    .filter((k) => k.status !== 'strong' && k.status !== 'covered')
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        worse(b.id) - worse(a.id) ||
        a.term.localeCompare(b.term),
    );
  return {
    platform,
    locale,
    keywords,
    counts,
    gaps,
    ...(isApplePlatform(platform) && fields.keywords !== undefined
      ? {
          keywordField: analyzeKeywordField(fields.keywords, {
            ...(fields.title !== undefined ? { title: fields.title } : {}),
            ...(fields.subtitle !== undefined ? { subtitle: fields.subtitle } : {}),
            language: languageOf(locale),
          }),
        }
      : {}),
    assumptions: FIT_ASSUMPTIONS,
  };
}

// ---------------------------------------------------------------------------------------------
// Stop words and idea mining

const STOP: Record<string, string> = {
  en: 'a an and are as at be been but by can do does for from get had has have how i if in into is it its just more most my new no not of on one or our out so than that the their them then there these they this to up use used using was we what when which who will with you your all any also app apps free',
  de: 'aber alle als am an auch auf aus bei bin bis das dass dein deine dem den der des die dies diese dieser du ein eine einen einem einer er es für hat ihr im in ist ja kann man mehr mit nach nicht noch nur oder ohne sehr sich sie sind so über um und uns unter von vor was wie wir wird zu zum zur app apps kostenlos',
  fr: 'à au aux avec ce ces dans de des du elle en est et il ils je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous app apps gratuit',
  es: 'a al algo con como cual de del el ella ellos en es esta este esto la las lo los más mi mis muy no nos o para pero por que se si sin su sus te tu tus un una uno y yo app apps gratis',
  it: 'a ad al alla alle anche che chi ci come con cui da dal dei del della delle di e è gli ha il in io la le lo ma mi nel nella non o per più se si sono su tra tu un una uno vi app apps gratis',
  pt: 'a ao aos as com como da das de do dos e é ela ele em esta este eu isso mais mas me meu na nas no nos não o os ou para pela pelo por que se sem seu sua um uma você app apps grátis',
  nl: 'aan al als ben bij dan dat de der deze die dit door een en er had heb het hij hun ik in is je kan maar me mee met mijn naar niet nog nu of om ons ook op over te tot uit van voor was we wel wij ze zijn zo app apps gratis',
};

const stopSets: Record<string, Set<string>> = {};
for (const language of Object.keys(STOP)) stopSets[language] = new Set((STOP[language] as string).split(' '));

/** The languages that have a stop word list. Others are mined without one (only length and digits are filtered). */
export const STOPWORD_LANGUAGES: readonly string[] = Object.keys(STOP);

export function isStopWord(language: string, word: string): boolean {
  const set = stopSets[language];
  return set !== undefined && set.has(word);
}

export type IdeaSource = {
  /** Whatever names the text: a competitor id. Ideas count the distinct sources they appear in. */
  id: string;
  text: string;
  /** Default 1. A title can weigh more than a description. */
  weight?: number;
};

export type Idea = {
  term: string;
  words: number;
  /** Times it occurs in all texts. */
  occurrences: number;
  /** Distinct sources it occurs in. */
  sources: number;
  /**
   * A frequency in the texts you gave, weighted by their weight and a little by phrase length.
   * It is NOT a search volume or a popularity.
   */
  localScore: number;
};

export type MineOptions = {
  /** Language of the texts (`en`, `de-AT` reads as `de`). Picks the stop words. Default `en`. */
  language?: string;
  /** Longest phrase in words. Default 3, at most 4. */
  maxWords?: number;
  /** An idea must occur at least this many times. Default 2. */
  minOccurrences?: number;
  /** ... and in at least this many sources. Default 1. */
  minSources?: number;
  limit?: number;
  /** Terms already tracked (any form `checkTerm` accepts): they are not suggested again. */
  exclude?: readonly string[];
};

const MAX_SOURCE_CHARACTERS = 20_000;
const MAX_SOURCES = 100;

export function mineIdeas(sources: readonly IdeaSource[], options: MineOptions = {}): Idea[] {
  const language = languageOf(options.language ?? 'en') || 'en';
  const maxWords = Math.min(Math.max(options.maxWords ?? 3, 1), 4);
  const minOccurrences = options.minOccurrences ?? 2;
  const minSources = options.minSources ?? 1;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const stop = (w: string) => isStopWord(language, w);
  const excluded = new Set<string>();
  for (const term of options.exclude ?? []) {
    const check = checkTerm(term);
    if (check.ok) excluded.add(check.key);
  }
  type Entry = { words: string[]; display: string; occurrences: number; score: number; sources: Set<string> };
  const entries = new Map<string, Entry>();
  for (const source of sources.slice(0, MAX_SOURCES)) {
    const weight = source.weight ?? 1;
    const tokens = words(source.text.slice(0, MAX_SOURCE_CHARACTERS));
    const folded = tokens.map(foldWord);
    for (let i = 0; i < tokens.length; i += 1) {
      for (let n = 1; n <= maxWords && i + n <= tokens.length; n += 1) {
        const first = tokens[i] as string;
        const last = tokens[i + n - 1] as string;
        if (stop(first) || stop(last)) continue;
        if (n === 1 && (Array.from(first).length < 3 || /^[0-9]+$/.test(first))) continue;
        if (/^[0-9]+$/.test(first) && /^[0-9]+$/.test(last)) continue;
        const key = folded.slice(i, i + n).join(' ');
        let entry = entries.get(key);
        if (!entry) {
          entry = { words: folded.slice(i, i + n), display: tokens.slice(i, i + n).join(' '), occurrences: 0, score: 0, sources: new Set() };
          entries.set(key, entry);
        }
        entry.occurrences += 1;
        entry.score += weight * (1 + 0.5 * (n - 1));
        entry.sources.add(source.id);
      }
    }
  }
  const kept = Array.from(entries.entries())
    .filter(([key, e]) => e.occurrences >= minOccurrences && e.sources.size >= minSources && !excluded.has(key))
    .map(([key, e]) => ({ key, ...e }));
  // A phrase swallows the shorter ones inside it that occur no more often than it does:
  // "task manager" present everywhere makes "task" and "manager" add nothing.
  const longer = kept.filter((e) => e.words.length > 1);
  const result = kept.filter(
    (e) =>
      !longer.some(
        (l) => l.words.length > e.words.length && l.occurrences >= e.occurrences && (' ' + l.key + ' ').indexOf(' ' + e.key + ' ') !== -1,
      ),
  );
  result.sort(
    (a, b) => b.score - a.score || b.sources.size - a.sources.size || b.words.length - a.words.length || a.key.localeCompare(b.key),
  );
  return result.slice(0, limit).map((e) => ({
    term: e.display,
    words: e.words.length,
    occurrences: e.occurrences,
    sources: e.sources.size,
    localScore: Math.round(e.score * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------------------------
// Competitors

export type CompetitorState = {
  version?: string | null;
  /** Average rating in thousandths. */
  ratingMilli?: number | null;
  ratingCount?: number | null;
  price?: string | null;
  title?: string | null;
  subtitle?: string | null;
  /** A hash of the listing text (title, subtitle, description), made by the server. */
  textHash: string;
  /** A hash of the description alone, so a changed title is not reported as a changed description. */
  descriptionHash?: string | null;
  screenshotCount?: number | null;
  /** A hash of the icon and screenshot addresses, made by the server. */
  mediaHash?: string | null;
};

export type CompetitorField =
  | 'version'
  | 'title'
  | 'subtitle'
  | 'price'
  | 'description'
  | 'media'
  | 'screenshots'
  | 'rating'
  | 'ratingCount';

export type CompetitorChange = {
  field: CompetitorField;
  /** Short public values only (version, price, title, subtitle, rating, counts). Absent for the description and the media: they are hashes. */
  from?: string | number | null;
  to?: string | number | null;
};

const same = <T>(a: T | null | undefined, b: T | null | undefined) => (a ?? null) === (b ?? null);

/** The rating count moves all the time: it only counts as a change at 5 % (and at least 20). */
export const RATING_COUNT_CHANGE_RATIO = 0.05;
export const RATING_COUNT_CHANGE_MIN = 20;
/** The average rating counts as changed from 0.05 stars. */
export const RATING_CHANGE_MILLI = 50;
/** ... and as notable (an event) from 0.2 stars. */
export const RATING_NOTABLE_MILLI = 200;

/**
 * What changed between two states of a competitor. `notable` is true when something other than the
 * drift of the rating count changed, with a rating only from 0.2 stars: that is what raises
 * an event. Without `previous` nothing changed (`first` is for the caller to see).
 */
export function diffCompetitor(
  previous: CompetitorState | undefined,
  next: CompetitorState,
): { changes: CompetitorChange[]; notable: boolean } {
  if (!previous) return { changes: [], notable: false };
  const changes: CompetitorChange[] = [];
  let notable = false;
  const text = (field: 'version' | 'title' | 'subtitle' | 'price') => {
    if (!same(previous[field], next[field])) {
      changes.push({ field, from: previous[field] ?? null, to: next[field] ?? null });
      notable = true;
    }
  };
  text('version');
  text('title');
  text('subtitle');
  text('price');
  if (previous.descriptionHash != null && next.descriptionHash != null && previous.descriptionHash !== next.descriptionHash) {
    changes.push({ field: 'description' });
    notable = true;
  }
  if (!same(previous.mediaHash, next.mediaHash) && next.mediaHash) {
    changes.push({ field: 'media' });
    notable = true;
  }
  if (!same(previous.screenshotCount, next.screenshotCount) && next.screenshotCount !== undefined) {
    changes.push({ field: 'screenshots', from: previous.screenshotCount ?? null, to: next.screenshotCount ?? null });
    notable = true;
  }
  if (previous.ratingMilli != null && next.ratingMilli != null) {
    const d = Math.abs(next.ratingMilli - previous.ratingMilli);
    if (d >= RATING_CHANGE_MILLI) {
      changes.push({ field: 'rating', from: previous.ratingMilli / 1000, to: next.ratingMilli / 1000 });
      if (d >= RATING_NOTABLE_MILLI) notable = true;
    }
  }
  if (previous.ratingCount != null && next.ratingCount != null) {
    const d = Math.abs(next.ratingCount - previous.ratingCount);
    if (d >= RATING_COUNT_CHANGE_MIN && d >= previous.ratingCount * RATING_COUNT_CHANGE_RATIO) {
      changes.push({ field: 'ratingCount', from: previous.ratingCount, to: next.ratingCount });
    }
  }
  return { changes, notable };
}

export type SnapshotDecision = {
  /** Whether a new row is stored. */
  store: boolean;
  kind: 'first' | 'change' | 'heartbeat' | 'none';
  changes: CompetitorChange[];
  notable: boolean;
};

/**
 * Store a snapshot when it is the first, when something changed (`diffCompetitor`), or when the
 * last stored one is older than the heartbeat: so a quiet competitor still shows it was looked at.
 */
export function decideSnapshot(
  previous: (CompetitorState & { checkedAt: number }) | undefined,
  next: CompetitorState,
  now: number,
  heartbeatMs: number,
): SnapshotDecision {
  if (!previous) return { store: true, kind: 'first', changes: [], notable: false };
  const { changes, notable } = diffCompetitor(previous, next);
  if (changes.length > 0) return { store: true, kind: 'change', changes, notable };
  if (now - previous.checkedAt >= heartbeatMs) return { store: true, kind: 'heartbeat', changes: [], notable: false };
  return { store: false, kind: 'none', changes: [], notable: false };
}

export type SuggestedCompetitor = {
  externalId: string;
  /** How many tracked keywords this app is in the results of. */
  keywordCount: number;
  bestRank: number;
  averageRank: number;
  keywordIds: string[];
};

/**
 * Apps that appear in the top results of several of the same tracked keywords: candidates to
 * track as competitors. A person confirms; nothing is added here. `ids` is the results of one
 * keyword in order (rank 1 first).
 */
export function suggestCompetitors(
  results: readonly { keywordId: string; ids: readonly string[] }[],
  options: { ownId?: string; exclude?: readonly string[]; topN?: number; minKeywords?: number; limit?: number } = {},
): SuggestedCompetitor[] {
  const topN = options.topN ?? 10;
  const minKeywords = options.minKeywords ?? 2;
  const skip = new Set<string>(options.exclude ?? []);
  if (options.ownId) skip.add(options.ownId);
  const found = new Map<string, { ranks: number[]; keywordIds: string[] }>();
  for (const r of results) {
    const seen = new Set<string>();
    r.ids.slice(0, topN).forEach((id, index) => {
      if (skip.has(id) || seen.has(id)) return;
      seen.add(id);
      let entry = found.get(id);
      if (!entry) {
        entry = { ranks: [], keywordIds: [] };
        found.set(id, entry);
      }
      entry.ranks.push(index + 1);
      entry.keywordIds.push(r.keywordId);
    });
  }
  const out: SuggestedCompetitor[] = [];
  found.forEach((entry, externalId) => {
    if (entry.ranks.length < minKeywords) return;
    const sum = entry.ranks.reduce((a, b) => a + b, 0);
    out.push({
      externalId,
      keywordCount: entry.ranks.length,
      bestRank: Math.min(...entry.ranks),
      averageRank: Math.round((sum / entry.ranks.length) * 10) / 10,
      keywordIds: entry.keywordIds,
    });
  });
  out.sort((a, b) => b.keywordCount - a.keywordCount || a.averageRank - b.averageRank || a.externalId.localeCompare(b.externalId));
  return out.slice(0, options.limit ?? 20);
}

// ---------------------------------------------------------------------------------------------
// Coverage gaps: what competitors use that we do not

export type CompetitorText = { id: string; title?: string; subtitle?: string; description?: string };

export type CoverageGap = {
  term: string;
  /** `tracked`: one of your keywords; `idea`: mined from the competitors' names and subtitles. */
  origin: 'tracked' | 'idea';
  /** Competitors that have the phrase in their title or subtitle (or, for the description list, in their description). */
  inTitle: string[];
  inDescription: string[];
  /** How well our own listing has it. */
  ourStatus: FitStatus;
};

/**
 * Terms that competitors put in their names, subtitles or descriptions and our searched fields
 * do not hold: tracked keywords we cover badly, and phrases mined from the competitors' names and
 * subtitles. Ordered by how many competitors use them in the title, then in the description.
 */
export function coverageGaps(input: {
  platform: AsoPlatform;
  locale: string;
  ours: FitFields;
  competitors: readonly CompetitorText[];
  tracked: readonly FitKeyword[];
  limit?: number;
}): CoverageGap[] {
  const language = languageOf(input.locale);
  const candidates = new Map<string, { term: string; origin: 'tracked' | 'idea' }>();
  for (const k of input.tracked) {
    const check = checkTerm(k.term);
    if (check.ok) candidates.set(check.key, { term: check.term, origin: 'tracked' });
  }
  const headings: IdeaSource[] = input.competitors.map((c) => ({
    id: c.id,
    text: [c.title, c.subtitle].filter((x): x is string => typeof x === 'string').join('. '),
    weight: 2,
  }));
  for (const idea of mineIdeas(headings, { language, minOccurrences: 1, minSources: 2, maxWords: 2, limit: 40 })) {
    const check = checkTerm(idea.term);
    if (check.ok && !candidates.has(check.key)) candidates.set(check.key, { term: idea.term, origin: 'idea' });
  }
  const gaps: CoverageGap[] = [];
  candidates.forEach(({ term, origin }) => {
    const needle = matchWords(term, language);
    const inTitle: string[] = [];
    const inDescription: string[] = [];
    for (const c of input.competitors) {
      const head = matchWords([c.title, c.subtitle].filter((x): x is string => typeof x === 'string').join('. '), language);
      if (countPhrase(head, needle) > 0) inTitle.push(c.id);
      else if (c.description && countPhrase(matchWords(c.description, language), needle) > 0) inDescription.push(c.id);
    }
    if (inTitle.length === 0 && inDescription.length === 0) return;
    const ours = fitKeyword(input.platform, input.locale, input.ours, { id: term, term });
    if (ours.status === 'strong' || ours.status === 'covered') return;
    gaps.push({ term, origin, inTitle, inDescription, ourStatus: ours.status });
  });
  gaps.sort(
    (a, b) =>
      b.inTitle.length - a.inTitle.length ||
      b.inDescription.length - a.inDescription.length ||
      Number(a.origin === 'idea') - Number(b.origin === 'idea') ||
      a.term.localeCompare(b.term),
  );
  return gaps.slice(0, input.limit ?? 30);
}

// ---------------------------------------------------------------------------------------------
// One keyword across markets

export type MarketKeyword = {
  id: string;
  term: string;
  key: string;
  country: string;
  locale: string;
  rank: number | null;
  state: 'ranked' | 'not_ranked' | 'unavailable' | null;
  checkedAt: number | null;
};

export type TermAcrossMarkets = {
  key: string;
  term: string;
  markets: { country: string; locale: string; id: string; rank: number | null; state: MarketKeyword['state']; checkedAt: number | null }[];
  /** The best (lowest) rank over the markets, or null when it ranks nowhere. */
  bestRank: number | null;
};

/** The same term in several countries and locales as one row. Rows by term, markets by country. */
export function termsAcrossMarkets(items: readonly MarketKeyword[]): TermAcrossMarkets[] {
  const rows = new Map<string, TermAcrossMarkets>();
  for (const item of items) {
    let row = rows.get(item.key);
    if (!row) {
      row = { key: item.key, term: item.term, markets: [], bestRank: null };
      rows.set(item.key, row);
    }
    row.markets.push({ country: item.country, locale: item.locale, id: item.id, rank: item.rank, state: item.state, checkedAt: item.checkedAt });
    if (item.rank !== null && (row.bestRank === null || item.rank < row.bestRank)) row.bestRank = item.rank;
  }
  const out = Array.from(rows.values());
  for (const row of out) row.markets.sort((a, b) => a.country.localeCompare(b.country) || a.locale.localeCompare(b.locale));
  out.sort((a, b) => a.term.localeCompare(b.term));
  return out;
}
