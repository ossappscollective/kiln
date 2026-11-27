// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// Checks on the store page text that need no AI and no store call: limits, wasted keyword space, words paid for twice, text left untranslated,
// fields left empty or half used, a language with no screenshots of its own. Pure: the caller gives the text of each locale as it is live in the
// store. Limits come from the field specs (`APP_STORE_FIELD_SPECS`, `PLAY_FIELD_SPECS`), never retyped here. The only fix offered is the keyword
// field with its wasted space removed (`analyzeKeywordField`), because it changes no meaning; the rest is advice a person acts on.

import { analyzeKeywordField, languageOf } from '../aso/aso.ts';
import { type ListingStore, measureField } from '../listing/listing.ts';
import { requiredFieldsOf, textLimitOf } from '../listing-facts/text.ts';
import { languageKey } from './countries.ts';

export type CheckSeverity = 'problem' | 'warning' | 'tip';

export type CheckCode =
  | 'empty'
  | 'too_long'
  | 'keywords_spaces'
  | 'keywords_duplicate'
  | 'keywords_in_title'
  | 'keywords_underused'
  | 'subtitle_repeats_name'
  | 'subtitle_missing'
  | 'underused'
  | 'untranslated'
  | 'no_screenshots'
  | 'promo_missing';

export type CheckIssue = {
  /** `<locale>:<code>:<field>`, stable for one finding. */
  id: string;
  code: CheckCode;
  /** The field id of the store (`name`, `keywords`, `short_description`), or null for a finding about the whole locale. */
  field: string | null;
  severity: CheckSeverity;
  /** Numbers and words the explanation needs (`used`, `limit`, `saved`, `words`), for the interface to put in a sentence. */
  params: Record<string, string | number>;
  /** A rewritten field, only where it is safe: the keyword field without its wasted space. */
  fix: { field: string; value: string } | null;
};

export type LocaleChecks = { locale: string; score: number; issues: CheckIssue[] };

/**
 * The one count every screen says: `problems` are what must be fixed (a limit exceeded, a required field empty); `warnings` are advice
 * worth reading (wasted keyword space, text left untranslated); `tips` are quiet. Only problems make a page "red". A difference between the
 * repository and the store is NOT a check: it is never counted here (the repository comparison is opt-in, see the app's listing settings).
 */
export type CheckCounts = { problems: number; warnings: number; tips: number };

export function countIssues(issues: readonly CheckIssue[]): CheckCounts {
  const out: CheckCounts = { problems: 0, warnings: 0, tips: 0 };
  for (const i of issues) {
    if (i.severity === 'problem') out.problems += 1;
    else if (i.severity === 'warning') out.warnings += 1;
    else out.tips += 1;
  }
  return out;
}

export type CheckLocaleText = {
  locale: string;
  /** Store field id to text; a field the store page lacks is absent. */
  fields: Record<string, string | undefined>;
  /** Whether this locale has screenshots of its own; null or absent when the data does not say. */
  hasScreenshots?: boolean | null | undefined;
};

const PENALTY: Record<CheckSeverity, number> = { problem: 20, warning: 8, tip: 3 };

export const scoreOf = (issues: readonly CheckIssue[]): number =>
  Math.max(0, 100 - issues.reduce((sum, i) => sum + PENALTY[i.severity], 0));

/** The fields the checks look at, per store. */
const FIELDS: Record<
  ListingStore,
  {
    name: string;
    short: string | null;
    keywords: string | null;
    promo: string | null;
    long: string;
  }
> = {
  app_store: {
    name: 'name',
    short: 'subtitle',
    keywords: 'keywords',
    promo: 'promotional_text',
    long: 'description',
  },
  google_play: {
    name: 'title',
    short: 'short_description',
    keywords: null,
    promo: null,
    long: 'full_description',
  },
};

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ]+/)
    .filter((w) => w.length >= 3);

const key = (locale: string, code: CheckCode, field: string | null) =>
  `${locale}:${code}:${field ?? '-'}`;

/** Under this share of the limit a field is "underused": room that shoppers' searches and eyes could use. */
const UNDERUSED = 0.5;

function checkLocale(
  store: ListingStore,
  entry: CheckLocaleText,
  base: CheckLocaleText | null,
  anyScreenshots: boolean,
): CheckIssue[] {
  const f = FIELDS[store];
  const issues: CheckIssue[] = [];
  const add = (
    code: CheckCode,
    field: string | null,
    severity: CheckSeverity,
    params: Record<string, string | number> = {},
    fix: CheckIssue['fix'] = null,
  ) => issues.push({ id: key(entry.locale, code, field), code, field, severity, params, fix });
  const text = (field: string): string => entry.fields[field] ?? '';

  // Limits and empty fields, for every field the store counts. ONE rule (`listing-facts/text.ts`): a limit or a `required` an official page
  // states is a problem, one no page states is a warning; the same severity as readiness and the staged view.
  for (const field of [f.name, f.short, f.long, f.keywords, f.promo]) {
    if (field === null) continue;
    const limit = textLimitOf(store, field);
    if (limit === null || limit.max === null) continue;
    const used = measureField(limit.spec, text(field));
    if (used > limit.max)
      add('too_long', field, limit.maxVerified ? 'problem' : 'warning', {
        used,
        limit: limit.max,
        over: used - limit.max,
        unit: limit.unit,
      });
  }
  const checked = [f.name, f.short, f.long, f.keywords];
  for (const required of requiredFieldsOf(store)) {
    if (checked.indexOf(required.field) < 0) continue;
    if (text(required.field).trim() === '')
      add('empty', required.field, required.severity === 'error' ? 'problem' : 'warning');
  }

  // Use of the room.
  const room = (field: string, code: CheckCode, severity: CheckSeverity) => {
    const limit = textLimitOf(store, field);
    const value = text(field).trim();
    if (limit === null || limit.max === null || value === '') return;
    const used = measureField(limit.spec, value);
    if (used < limit.max * UNDERUSED)
      add(code, field, severity, { used, limit: limit.max, unit: limit.unit });
  };
  if (store === 'app_store') {
    if (text('subtitle').trim() === '') add('subtitle_missing', 'subtitle', 'warning');
    else room('subtitle', 'underused', 'tip');
    if (text('promotional_text').trim() === '') add('promo_missing', 'promotional_text', 'tip');
    room('name', 'underused', 'tip');
    const kw = text('keywords');
    if (kw.trim() !== '') {
      const report = analyzeKeywordField(kw, {
        title: text('name'),
        subtitle: text('subtitle'),
        language: languageOf(entry.locale),
      });
      const fixValue = report.compacted;
      const fix =
        report.savedBytes > 0 && fixValue !== '' ? { field: 'keywords', value: fixValue } : null;
      if (report.separatorBytes > 0)
        add('keywords_spaces', 'keywords', 'warning', { saved: report.separatorBytes }, fix);
      if (report.duplicates.length > 0)
        add(
          'keywords_duplicate',
          'keywords',
          'warning',
          { count: report.duplicates.length, words: report.duplicates.slice(0, 5).join(', ') },
          fix,
        );
      if (report.inTitleOrSubtitle.length > 0) {
        add(
          'keywords_in_title',
          'keywords',
          'warning',
          {
            count: report.inTitleOrSubtitle.length,
            words: report.inTitleOrSubtitle.slice(0, 5).join(', '),
          },
          fix,
        );
      }
      if (
        report.bytes <= report.max &&
        report.bytes < report.max * 0.7 &&
        report.terms.length > 0
      ) {
        add('keywords_underused', 'keywords', 'tip', {
          used: report.bytes,
          limit: report.max,
          unit: 'bytes',
        });
      }
    }
    // A subtitle that says the name again spends 30 characters for nothing.
    const nameWords = new Set(wordsOf(text('name')));
    const subtitleWords = wordsOf(text('subtitle'));
    if (subtitleWords.length > 0 && subtitleWords.every((w) => nameWords.has(w)))
      add('subtitle_repeats_name', 'subtitle', 'warning');
  } else {
    room('short_description', 'underused', 'tip');
    room('title', 'underused', 'tip');
  }

  // Text left as it is in the base language.
  if (
    base &&
    base.locale !== entry.locale &&
    languageKey(base.locale) !== languageKey(entry.locale)
  ) {
    const same = [f.name, f.short, f.long].filter((field): field is string => {
      if (field === null) return false;
      const mine = text(field).trim();
      return mine.length >= 12 && mine === (base.fields[field] ?? '').trim();
    });
    if (same.length > 0)
      add('untranslated', null, 'warning', {
        fields: same.join(', '),
        count: same.length,
        base: base.locale,
      });
  }

  // Screenshots: only said when the data says it, and only for a page where others have some.
  if (entry.hasScreenshots === false && anyScreenshots) add('no_screenshots', null, 'warning');
  return issues;
}

/**
 * Checks every locale. `baseLocale` is the language the text was written in (default: `en-US` when present, else the first locale); other
 * languages are compared with it for untranslated text. A locale with no entry in `fields` at all is checked like an empty page.
 */
export function checkListing(input: {
  store: ListingStore;
  locales: readonly CheckLocaleText[];
  baseLocale?: string | undefined;
}): {
  locales: LocaleChecks[];
  score: number;
  issueCount: number;
  counts: CheckCounts;
} {
  const list = input.locales;
  const base =
    list.find((l) => l.locale === input.baseLocale) ??
    list.find((l) => l.locale === 'en-US') ??
    list[0] ??
    null;
  const anyScreenshots = list.some((l) => l.hasScreenshots === true);
  const locales = list.map((entry) => {
    const issues = checkLocale(input.store, entry, base, anyScreenshots);
    return { locale: entry.locale, score: scoreOf(issues), issues };
  });
  const score =
    locales.length === 0
      ? 100
      : Math.round(locales.reduce((s, l) => s + l.score, 0) / locales.length);
  return {
    locales,
    score,
    issueCount: locales.reduce((n, l) => n + l.issues.length, 0),
    counts: countIssues(locales.flatMap((l) => l.issues)),
  };
}
