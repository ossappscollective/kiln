// Deterministic, mechanical fixes for the findings of `checkListing` (docs/adr/0059-listing-fixes-via-cart.md). Pure: no store, no database, no AI.
//
// A fix is only ever a PROPOSAL with the text before and after: the caller stages it (the cart) and nothing is published without the cart's review. What
// is offered is what changes no meaning or only drops whole terms the person sees listed: keyword hygiene (spaces, empty terms, repeated terms),
// dropping keyword terms that the name or subtitle already index, dropping whole trailing terms until the field fits, and collapsing stray white
// space in a text that is a little over its limit. Prose is NEVER truncated: a text over its limit gets `ai_shorten` (a proposal a person must
// accept, only where AI is on) and `edit_field` (the editor with the counter); an empty required field gets `edit_field` with no invented text.
// Every proposed `after` is re-checked with `checkListing`: a fix that would leave the same finding (or empty a field) is not offered, and the
// finding is reported as one that cannot be fixed automatically. Written for the ES2017 web build.

import { APP_STORE_KEYWORD_BYTES, languageOf, matchWords } from '../aso/aso.ts';
import { type CheckCode, type CheckIssue, checkListing } from '../insights/listing-checks.ts';
import type { Platform } from '../platform.ts';
import {
  APP_STORE_FIELD_SPECS,
  countBytes,
  countCharacters,
  type ListingStore,
  PLAY_FIELD_SPECS,
} from './listing.ts';
import { isStageableTextField } from './staged-changes.ts';

export type FixId =
  | 'keywords_tidy'
  | 'keywords_drop_in_title'
  | 'keywords_fit'
  | 'text_tidy'
  | 'shorten_ai'
  | 'edit_field';

/** `stage`: `after` is complete and can be staged as it is. `ai_shorten`: `after` is null; a proposal from the AI, accepted by a person. `edit_field`: open the editor. */
export type ListingFixKind = 'stage' | 'ai_shorten' | 'edit_field';

/** `safe` changes nothing a reader sees; `review` drops terms or collapses text: read the before and after. */
export type FixRisk = 'safe' | 'review';

export type Fix = {
  id: FixId;
  /** The i18n key of the button label; the interface translates it. */
  labelKey: string;
  kind: ListingFixKind;
  locale: string;
  field: string;
  before: string;
  /** The whole field after the fix; null for `ai_shorten` and `edit_field`. */
  after: string | null;
  /** Whole terms the fix drops, in the order it dropped them (keyword fixes). */
  removed: string[];
  risk: FixRisk;
  /** The finding codes this fix settles (checked again after applying). */
  resolves: CheckCode[];
  /** The limit of the field and its unit (for the counter in the review). */
  limit: number | null;
  unit: 'characters' | 'bytes';
  /** A draft push can write this field (the App Store name and subtitle cannot: they belong to the app information). */
  stageable: boolean;
};

export type UnfixableIssue = { locale: string; field: string; code: CheckCode };

export type FixInput = {
  platform: Platform;
  store: ListingStore;
  locale: string;
  /** The text as it is now (the staged text where there is one, else the store's). */
  fields: Record<string, string | undefined>;
};

export type FixAnalysis = { fixes: Fix[]; cannot: UnfixableIssue[] };

const KEY = {
  tidy: 'listing:fix.keywordsTidy',
  dropInTitle: 'listing:fix.keywordsDropInTitle',
  fit: 'listing:fix.keywordsFit',
  textTidy: 'listing:fix.textTidy',
  shorten: 'listing:fix.shortenAi',
  edit: 'listing:fix.editField',
};

const specOf = (
  store: ListingStore,
  field: string,
): { maxLength?: number; unit: 'characters' | 'bytes' } | undefined =>
  (store === 'app_store'
    ? (APP_STORE_FIELD_SPECS as Record<string, never>)
    : (PLAY_FIELD_SPECS as Record<string, never>))[field];

const lengthIn = (unit: 'characters' | 'bytes', text: string): number =>
  unit === 'bytes' ? countBytes(text) : countCharacters(text);

/** The terms of an Apple keyword field: split on commas, white space collapsed, empty terms gone. Repeats are kept (the caller decides). */
export function keywordTerms(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (term !== '') out.push(term);
  }
  return out;
}

/** What makes two terms the same term: their words folded as the keyword analysis folds them (case, accents; singular and plural are NOT judged). */
const termKey = (term: string, language: string): string => {
  const key = matchWords(term, language).join(' ');
  return key === '' ? term.toLowerCase() : key;
};

/** Hygiene: trim, collapse spaces, drop empty terms and trailing commas, drop a term seen before (the first stays). Joined with a comma and no space. */
export function tidyKeywords(
  value: string,
  language: string,
): { value: string; removed: string[] } {
  const seen = new Set<string>();
  const keep: string[] = [];
  const removed: string[] = [];
  for (const term of keywordTerms(value)) {
    const key = termKey(term, language);
    if (seen.has(key)) {
      removed.push(term);
      continue;
    }
    seen.add(key);
    keep.push(term);
  }
  return { value: keep.join(','), removed };
}

/** The words the name and the subtitle already index. */
const knownWords = (
  name: string | undefined,
  subtitle: string | undefined,
  language: string,
): Set<string> =>
  new Set<string>(matchWords(name, language).concat(matchWords(subtitle, language)));

const inTitle = (term: string, known: Set<string>, language: string): boolean => {
  const words = matchWords(term, language);
  return words.length > 0 && words.every((w) => known.has(w));
};

/**
 * Drops whole terms until the keyword field fits `maxBytes`: first the terms the name or subtitle already index (last first), then the trailing terms
 * (last first). A word is never cut. Returns null when it cannot fit without emptying the field.
 */
export function fitKeywords(
  value: string,
  options: {
    language: string;
    name?: string | undefined;
    subtitle?: string | undefined;
    maxBytes?: number;
  },
): { value: string; removed: string[] } | null {
  const max = options.maxBytes ?? APP_STORE_KEYWORD_BYTES;
  const tidy = tidyKeywords(value, options.language);
  const terms = keywordTerms(tidy.value);
  const removed = tidy.removed.slice();
  const known = knownWords(options.name, options.subtitle, options.language);
  const size = () => countBytes(terms.join(','));
  const drop = (index: number) => {
    removed.push(terms[index] as string);
    terms.splice(index, 1);
  };
  for (let i = terms.length - 1; i >= 0 && size() > max; i -= 1) {
    if (terms.length > 1 && inTitle(terms[i] as string, known, options.language)) drop(i);
  }
  while (size() > max && terms.length > 1) drop(terms.length - 1);
  if (size() > max || terms.length === 0) return null;
  return { value: terms.join(','), removed };
}

/** A text a little over its limit because of stray white space: spaces and tabs collapsed, line ends trimmed, three line breaks made two. Keeps every word. */
export function tidyText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The findings of `field` after `fields` replaced it with `after`: used to confirm that a fix settles what it says it settles. */
function stillFailing(
  input: FixInput,
  field: string,
  after: string,
  codes: readonly CheckCode[],
): boolean {
  const fields = { ...input.fields, [field]: after };
  const res = checkListing({
    store: input.store,
    locales: [{ locale: input.locale, fields }],
    baseLocale: input.locale,
  });
  const issues = res.locales[0]?.issues ?? [];
  return issues.some((i) => i.field === field && codes.indexOf(i.code) >= 0);
}

/** Findings and the fixes for them, with what cannot be fixed on its own. Deterministic: the same text gives the same answer. */
export function analyzeFixes(input: FixInput): FixAnalysis {
  const { store, locale } = input;
  const language = languageOf(locale);
  const fixes: Fix[] = [];
  const cannot: UnfixableIssue[] = [];
  const res = checkListing({
    store,
    locales: [{ locale, fields: input.fields }],
    baseLocale: locale,
  });
  const issues: CheckIssue[] = res.locales[0]?.issues ?? [];
  const has = (code: CheckCode, field: string) =>
    issues.some((i) => i.code === code && i.field === field);
  const text = (field: string) => input.fields[field] ?? '';
  const stageableField = (field: string) => isStageableTextField(input.platform, field);
  const base = {
    locale,
    removed: [] as string[],
    limit: null as number | null,
    unit: 'characters' as const,
  };

  // Apple keyword field.
  if (store === 'app_store' && text('keywords') !== '') {
    const before = text('keywords');
    const spec = specOf(store, 'keywords');
    const limit = spec?.maxLength ?? APP_STORE_KEYWORD_BYTES;
    const mk = (
      id: FixId,
      labelKey: string,
      after: string,
      removed: string[],
      risk: FixRisk,
      resolves: CheckCode[],
    ): Fix => ({
      ...base,
      id,
      labelKey,
      kind: 'stage',
      field: 'keywords',
      before,
      after,
      removed,
      risk,
      resolves,
      limit,
      unit: 'bytes',
      stageable: stageableField('keywords'),
    });
    const present = (codes: CheckCode[]) => codes.filter((c) => has(c, 'keywords'));
    const tidy = tidyKeywords(before, language);
    const tidyOk = tidy.value !== '' && tidy.value !== before;
    if (tidyOk) {
      const resolves = present(['keywords_spaces', 'keywords_duplicate']);
      if (!stillFailing(input, 'keywords', tidy.value, resolves))
        fixes.push(mk('keywords_tidy', KEY.tidy, tidy.value, tidy.removed, 'safe', resolves));
    }
    if (has('keywords_in_title', 'keywords')) {
      const known = knownWords(text('name'), text('subtitle'), language);
      const terms = keywordTerms(tidy.value);
      const kept = terms.filter((t) => !inTitle(t, known, language));
      const dropped = terms.filter((t) => inTitle(t, known, language));
      const after = kept.join(',');
      const resolves = present(['keywords_in_title', 'keywords_spaces', 'keywords_duplicate']);
      if (after !== '' && after !== before && !stillFailing(input, 'keywords', after, resolves)) {
        fixes.push(
          mk(
            'keywords_drop_in_title',
            KEY.dropInTitle,
            after,
            tidy.removed.concat(dropped),
            'review',
            resolves,
          ),
        );
      }
    }
    if (has('too_long', 'keywords')) {
      const fit = fitKeywords(before, {
        language,
        name: text('name'),
        subtitle: text('subtitle'),
        maxBytes: limit,
      });
      const resolves: CheckCode[] = ['too_long'];
      if (fit && !stillFailing(input, 'keywords', fit.value, resolves))
        fixes.push(mk('keywords_fit', KEY.fit, fit.value, fit.removed, 'review', resolves));
      else cannot.push({ locale, field: 'keywords', code: 'too_long' });
    }
  }

  // Texts over their limit and required texts left empty.
  for (const issue of issues) {
    if (issue.field === null || issue.field === 'keywords') continue;
    const field = issue.field;
    const spec = specOf(store, field);
    const unit = spec?.unit ?? 'characters';
    const limit = spec?.maxLength ?? null;
    const common = {
      ...base,
      field,
      limit,
      unit,
      stageable: stageableField(field),
      before: text(field),
    };
    if (
      issue.code === 'empty' &&
      (field === 'name' ||
        field === 'title' ||
        field === 'description' ||
        field === 'full_description' ||
        field === 'short_description')
    ) {
      fixes.push({
        ...common,
        id: 'edit_field',
        labelKey: KEY.edit,
        kind: 'edit_field',
        after: null,
        risk: 'safe',
        resolves: ['empty'],
      });
    } else if (issue.code === 'too_long') {
      const tidy = tidyText(text(field));
      const fits =
        limit !== null && tidy !== text(field) && tidy !== '' && lengthIn(unit, tidy) <= limit;
      if (fits && !stillFailing(input, field, tidy, ['too_long'])) {
        fixes.push({
          ...common,
          id: 'text_tidy',
          labelKey: KEY.textTidy,
          kind: 'stage',
          after: tidy,
          risk: 'review',
          resolves: ['too_long'],
        });
      } else {
        fixes.push({
          ...common,
          id: 'shorten_ai',
          labelKey: KEY.shorten,
          kind: 'ai_shorten',
          after: null,
          risk: 'review',
          resolves: ['too_long'],
        });
        fixes.push({
          ...common,
          id: 'edit_field',
          labelKey: KEY.edit,
          kind: 'edit_field',
          after: null,
          risk: 'safe',
          resolves: ['too_long'],
        });
      }
    }
  }
  return { fixes, cannot };
}

/** The fixes for one locale (see `analyzeFixes` for what could not be fixed on its own). */
export const proposeFixes = (input: FixInput): Fix[] => analyzeFixes(input).fixes;

const RANK: Record<FixId, number> = {
  keywords_fit: 5,
  keywords_drop_in_title: 4,
  keywords_tidy: 3,
  text_tidy: 3,
  shorten_ai: 2,
  edit_field: 1,
};

/**
 * "Fix all": for each field the one fix that does the most and can be staged as it is (a `stage` fix); fields with only `ai_shorten` or `edit_field`
 * are left to the person. `keywords_fit` includes the hygiene and the drops of the smaller ones, so it wins over them.
 */
export function stageableFixesOf(fixes: readonly Fix[]): Fix[] {
  const byField: Record<string, Fix> = {};
  for (const fix of fixes) {
    if (fix.kind !== 'stage' || !fix.stageable || fix.after === null) continue;
    const have = byField[fix.field];
    if (!have || RANK[fix.id] > RANK[have.id]) byField[fix.field] = fix;
  }
  return Object.keys(byField).map((f) => byField[f] as Fix);
}
