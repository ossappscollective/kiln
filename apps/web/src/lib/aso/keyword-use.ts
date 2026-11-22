import {
  type AsoPlatform,
  checkTerm,
  type FitFields,
  type KeywordFieldSummary,
  type ListingRow,
  type ListingRowTerm,
  languageOf,
  listingRows,
  supports,
  type TermSource,
  type TermTracking,
  type TrackedRank,
  termKeyOf,
  trackingOf,
} from '@kiln/core';
import { k, t } from '../i18n/t.ts';
import {
  editableFields,
  type FieldInfo,
  type FieldMeter,
  fieldIdForSource,
  measureField,
  whereText,
} from '../listing/edit.ts';

/**
 * "Keywords your listing uses now" (Insights, Keywords): the pure parts. The terms a locale of the stored listing sets are worked
 * out in `@kiln/core` (`listingRows`: the App Store keyword field entries and the words of the title and subtitle; Google Play: the words
 * of the title and short description and the frequent words of the full description). Here the phrases of a title are added, each term is
 * put into plain words (where it appears, whether it is tracked and at which rank, the visitors a Play Console file reports for it)
 * and each field of the locale is measured so it can be edited. Nothing here reads a store or writes anything. ES2017 web build.
 */

/** These four are message keys: `t(APP_STORE_NOTE)` where they are drawn. */
export const APP_STORE_NOTE = k('aso:kw.appStoreNote');

export const PLAY_DERIVED_NOTE = k('aso:kw.playDerivedNote');

export const NOT_READ_TITLE = k('aso:kw.notReadTitle');

/** What to say when no listing text is stored: the tool cannot know what the listing uses. */
export const NOT_READ_TEXT = k('aso:kw.notReadText');

/** Phrases only count from this many words (a single word is already a term) up to this many. */
const PHRASE_MIN_WORDS = 2;
const PHRASE_MAX_WORDS = 4;

/** Where a title or a short text is cut into phrases: dashes, colons, bars, bullets, commas, full stops, slashes, brackets. */
const PHRASE_BREAK = /[-–—:|•·,;.!?/()[\]{}&+]|\s[-–—]\s/;

/** The phrases of a text: its parts between those breaks that have two to four words. Each once, in the order written. */
export function phrasesOf(text: string | undefined, locale: string): string[] {
  if (!text) return [];
  const language = languageOf(locale);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(PHRASE_BREAK)) {
    const clean = part.replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    const check = checkTerm(clean);
    if (!check.ok) continue;
    if (check.words < PHRASE_MIN_WORDS || check.words > PHRASE_MAX_WORDS) continue;
    const key = termKeyOf(clean, language);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export type SearchTermFigures = { visitors: number | null; installs: number | null };

/** The figures of imported Google Play search terms by the key two terms are compared by. */
export function searchFigures(
  lines: readonly { term: string; visitors: number | null; installs: number | null }[],
  locale: string,
): Map<string, SearchTermFigures> {
  const out = new Map<string, SearchTermFigures>();
  for (const line of lines) {
    const key = termKeyOf(line.term, locale);
    if (key === '') continue;
    const before = out.get(key);
    if (before) {
      out.set(key, {
        visitors: sum(before.visitors, line.visitors),
        installs: sum(before.installs, line.installs),
      });
    } else {
      out.set(key, { visitors: line.visitors, installs: line.installs });
    }
  }
  return out;
}

const sum = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

export type UsedKeyword = ListingRowTerm & {
  kind: 'entry' | 'phrase' | 'word';
  /** "In the title and keyword field". */
  where: string;
  /** The listing field ids it appears in, the likeliest to edit first. */
  fieldIds: string[];
  /** The rank line: "Rank 12", "Not in the first 50 results", "Tracked, not checked yet", or "Not tracked". */
  rankText: string;
  /** Imported search terms: the figures for this term, or null when none were imported for it. */
  search: SearchTermFigures | null;
};

export type UsedField = {
  info: FieldInfo;
  /** The text stored for the locale (empty when the field has none). */
  text: string;
  meter: FieldMeter;
  /** The words of the field that are keyword terms, for a line under it. */
  terms: string[];
};

export type UsedLocale = {
  locale: string;
  country: string;
  storefronts: string[];
  trackable: boolean;
  hasText: boolean;
  /** Google Play: the terms are found in text, not typed into a keyword field. */
  derived: boolean;
  keywordField: KeywordFieldSummary | null;
  fields: UsedField[];
  keywords: UsedKeyword[];
  trackedCount: number;
  untracked: UsedKeyword[];
};

export function rankText(
  term: Pick<TermTracking, 'tracked' | 'state' | 'rank'>,
  depth = 50,
): string {
  if (!term.tracked) return t('aso:kw.rank.notTracked');
  if (term.state === 'ranked' && term.rank !== null) return t('aso:kw.rank.rank', { rank: term.rank });
  if (term.state === 'not_ranked') return t('aso:kw.rank.notRanked', { count: depth });
  return t('aso:kw.rank.notChecked');
}

const FIT_KEY: Record<string, keyof FitFields> = {
  name: 'title',
  title: 'title',
  subtitle: 'subtitle',
  keywords: 'keywords',
  short_description: 'shortDescription',
  description: 'description',
  full_description: 'description',
};

/** The stored text of one listing field (a listing field id such as `name`, `short_description`) out of the fields of a locale; '' when there is none. */
export const storeTextOf = (fields: FitFields, fieldId: string): string => {
  const key = FIT_KEY[fieldId];
  return (key ? fields[key] : undefined) ?? '';
};

const KIND_ORDER = { entry: 0, phrase: 1, word: 2 } as const;

/** The terms and the editable fields of every locale of one app's stored listing. */
export function usedKeywords(input: {
  platform: AsoPlatform;
  locales: readonly { locale: string; fields: FitFields }[];
  tracked: readonly TrackedRank[];
  /** Imported search terms of the app (Google Play), if any. Matched by the words of the term. */
  searchTerms?:
    | readonly { term: string; visitors: number | null; installs: number | null }[]
    | undefined;
  countries?: Readonly<Record<string, string | undefined>> | undefined;
  depth?: number | undefined;
}): UsedLocale[] {
  const apple = supports(input.platform, 'keywordField');
  const rows: ListingRow[] = listingRows({
    platform: input.platform,
    locales: input.locales,
    tracked: input.tracked,
    // Google Play: the full description counts too, with the words that occur twice or more.
    options: { includeDescription: true, minDescriptionOccurrences: 2, maxDescriptionTerms: 30 },
    ...(input.countries ? { countries: input.countries } : {}),
  });
  const infos = editableFields(input.platform);
  return rows.map((row) => {
    const fields = (input.locales.find((l) => l.locale === row.locale) as { fields: FitFields })
      .fields;
    const figures = input.searchTerms
      ? searchFigures(input.searchTerms, row.locale)
      : new Map<string, SearchTermFigures>();
    const base = row.rows.slice();
    // A phrase of the title (and of the subtitle or short description): "Habit Tracker" from "Habit Tracker - Daily Routine".
    const have = new Set(base.map((t) => t.key));
    const phraseSources: { source: TermSource; text: string | undefined }[] = [
      { source: 'title', text: fields.title },
      apple
        ? { source: 'subtitle', text: fields.subtitle }
        : { source: 'shortDescription', text: fields.shortDescription },
    ];
    const phrases: ListingRowTerm[] = [];
    for (const p of phraseSources) {
      for (const phrase of phrasesOf(p.text, row.locale)) {
        const key = termKeyOf(phrase, row.locale);
        const known = phrases.find((x) => x.key === key);
        if (known) {
          if (known.sources.indexOf(p.source) < 0) known.sources.push(p.source);
          continue;
        }
        if (have.has(key)) continue;
        have.add(key);
        phrases.push({
          term: phrase,
          key,
          sources: [p.source],
          set: false,
          waste: null,
          duplicate: false,
          entries: 0,
          occurrences: 0,
          ...trackingOf({ key }, row.locale, row.country, input.tracked),
        });
      }
    }
    const all = base.concat(phrases);
    const keywords: UsedKeyword[] = all
      .map((t) => {
        const kind: UsedKeyword['kind'] = t.set
          ? 'entry'
          : t.key.indexOf(' ') >= 0
            ? 'phrase'
            : 'word';
        const fig = figures.get(t.key) ?? null;
        return {
          ...t,
          kind,
          where: whereText(t.sources),
          fieldIds: t.sources.map((s) => fieldIdForSource(input.platform, s)),
          rankText: rankText(t, input.depth ?? 50),
          search: fig,
        };
      })
      .map((t, i) => ({ t, i }))
      .sort((a, b) => KIND_ORDER[a.t.kind] - KIND_ORDER[b.t.kind] || a.i - b.i)
      .map((x) => x.t);
    const usedFields: UsedField[] = infos.map((info) => {
      const text = storeTextOf(fields, info.id);
      const own = keywords.filter((k) => k.fieldIds.indexOf(info.id) >= 0).map((k) => k.term);
      return { info, text, meter: measureField(info, text), terms: own };
    });
    return {
      locale: row.locale,
      country: row.country,
      storefronts: row.storefronts,
      trackable: row.trackable,
      hasText: row.terms.hasText,
      derived: row.terms.extracted,
      keywordField: row.terms.keywordField,
      fields: usedFields,
      keywords,
      trackedCount: keywords.filter((k) => k.tracked).length,
      untracked: keywords.filter((k) => !k.tracked && checkTerm(k.term).ok),
    };
  });
}

/** "14 keywords, 5 tracked". */
export function usedSummary(l: Pick<UsedLocale, 'keywords' | 'trackedCount'>): string {
  return t('aso:kw.summary', { count: l.keywords.length, tracked: l.trackedCount });
}

/** The locale a view opens on: the one with most tracked keywords, else the first. */
export function defaultLocale(
  locales: readonly { locale: string }[],
  tracked: readonly { locale: string }[],
): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const l of locales) {
    const n = tracked.filter((t) => t.locale.toLowerCase() === l.locale.toLowerCase()).length;
    if (n > bestCount) {
      best = l.locale;
      bestCount = n;
    }
  }
  return best;
}

export const visitorsText = (s: SearchTermFigures | null): string =>
  s === null || s.visitors === null ? '' : String(s.visitors);
