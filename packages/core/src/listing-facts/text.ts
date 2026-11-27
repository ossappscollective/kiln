import {
  APP_STORE_COPYRIGHT_SPEC,
  APP_STORE_FIELD_SPECS,
  checkListingField,
  measureField,
  type ListingFieldSpec,
  type ListingProblem,
  type ListingStore,
  PLAY_CHANGELOG_SPEC,
  PLAY_FIELD_SPECS,
  validateLocaleText,
} from '../listing/listing.ts';
import { type Platform, listingStoreOf } from '../platform.ts';
import { isStageableTextField } from '../listing/staged-changes.ts';

/**
 * Listing TEXT facts: the limit of a field, how it is counted, whether it is required, and the one check (docs/state-model.md, "Single
 * owners (core)"). The specs of `listing.ts` are the single source of every number; this file is how a surface asks them, so none types
 * `500`, `4000` or `100` again (the audit found `?? 500` and `?? 4000` fallbacks, `PLAY_NOTES_LIMIT`, `APP_STORE_KEYWORD_BYTES`,
 * `noteLimitOf` `{apple: 4000, google: 500}`, the web `NOTES_TRANSLATE_MAX_CHARS`).
 *
 * COUNTING UNIT: `measureField` (listing.ts, re-exported by the package): Unicode code points (UTF-8 bytes for the App Store keywords),
 * white space trimmed at both ends. See its comment for why.
 *
 * SEVERITY, once: a limit or a `required` that an official page states (`spec.unverified` does not list it) is an ERROR / BLOCKING; one that
 * no page states is a WARNING. That holds for every consumer: a Play note over 500 is an error in the staged view, a blocker in readiness and
 * a problem in PlayCheck (before: a warning in the staged view). An EMPTY iOS keywords field is blocking everywhere (the Insights `empty`
 * check called the same fault a warning).
 *
 * Pure. ES2017.
 */

/** The field ids of the notes of a release: the App Store `release_notes` and the Play changelog, both asked as `release_notes`. */
export const RELEASE_NOTES_FIELD = 'release_notes';

/** The spec of a field of a store; Play release notes are the changelog spec; null for a field that has none. */
export function fieldSpecOf(store: ListingStore, field: string): ListingFieldSpec | null {
  if (store === 'google_play' && (field === RELEASE_NOTES_FIELD || field === 'changelog'))
    return PLAY_CHANGELOG_SPEC;
  if (store === 'app_store' && field === 'copyright') return APP_STORE_COPYRIGHT_SPEC;
  const specs: Record<string, ListingFieldSpec> =
    store === 'app_store' ? APP_STORE_FIELD_SPECS : PLAY_FIELD_SPECS;
  return specs[field] ?? null;
}

export type TextLimit = {
  /** The most it may measure, in `unit`; null when no limit is documented. */
  max: number | null;
  /** The least a non-empty value may measure; null when none. */
  min: number | null;
  unit: 'characters' | 'bytes';
  /** An official page states the maximum (a longer value is an error); else it is a warning. */
  maxVerified: boolean;
  minVerified: boolean;
  spec: ListingFieldSpec;
};

/**
 * The limit of a field of a store, from the specs (`limitOf(store, field)`; named `textLimitOf` in the package because `limitOf` is the
 * image limit table). Null for a field with no spec. Play notes: 500 characters; App Store notes: 4000; description: 4000; keywords: 100 bytes;
 * titles and subtitles: 30 (Play title 30, short description 80).
 */
export function textLimitOf(store: ListingStore, field: string): TextLimit | null {
  const spec = fieldSpecOf(store, field);
  if (spec === null) return null;
  return {
    max: spec.maxLength ?? null,
    min: spec.minLength ?? null,
    unit: spec.unit,
    maxVerified: spec.unverified.indexOf('max') < 0,
    minVerified: spec.unverified.indexOf('min') < 0,
    spec,
  };
}

/** The most characters of release notes per locale in a store (`textLimitOf(store, 'release_notes').max`). */
export const releaseNotesLimitOf = (store: ListingStore): number | null =>
  textLimitOf(store, RELEASE_NOTES_FIELD)?.max ?? null;

/**
 * How long a release note is, the one way: the notes spec's unit (Unicode code points, white space trimmed). Never `text.length` (UTF-16
 * units: an emoji counts twice, so a note at the limit read as "over").
 */
export const notesLengthOf = (store: ListingStore, text: string): number =>
  measureField(fieldSpecOf(store, RELEASE_NOTES_FIELD) as ListingFieldSpec, text);

export type RequiredField = {
  field: string;
  label: string;
  /** `error`: an official page says it is required. `warning`: no page does (`spec.unverified` lists `required`). */
  severity: 'error' | 'warning';
  spec: ListingFieldSpec;
};

/**
 * The per-locale text fields a store requires, in the order of the store's field list. `platform` limits it to the fields a push can write
 * (the stageable ones: the App Store name and the privacy policy URL belong to the app information, which a draft does not write).
 * ONE rule for the empty-locale chip, the readiness `missing_text` and the Insights `empty` check.
 */
export function requiredFieldsOf(
  store: ListingStore,
  options: { stageableFor?: Platform } = {},
): RequiredField[] {
  const specs: Record<string, ListingFieldSpec> =
    store === 'app_store' ? APP_STORE_FIELD_SPECS : PLAY_FIELD_SPECS;
  const out: RequiredField[] = [];
  for (const field of Object.keys(specs)) {
    const spec = specs[field] as ListingFieldSpec;
    if (!spec.required || spec.scope !== 'locale') continue;
    if (options.stageableFor !== undefined && !isStageableTextField(options.stageableFor, field)) continue;
    out.push({
      field,
      label: spec.label,
      severity: spec.unverified.indexOf('required') >= 0 ? 'warning' : 'error',
      spec,
    });
  }
  return out;
}

/** The required fields that are blank in `values`, for a platform (stageable ones only). Replaces the server's `emptyRequiredFields`. */
export function emptyRequiredTexts(
  platform: Platform,
  values: Readonly<Record<string, string | null | undefined>>,
): string[] {
  return requiredFieldsOf(listingStoreOf(platform), { stageableFor: platform })
    .filter((r) => {
      const value = values[r.field];
      return value === undefined || value === null || value.trim() === '';
    })
    .map((r) => r.field);
}

/**
 * One text against its spec: required (blank), too long, too short, a URL that is not one, keyword advice. The one check; `validateListing`
 * calls it per field, and so can readiness, the staged view and the Insights checks. `fallback` fills a blank (the fastlane `default`
 * folder). `required: false` skips the required check (a locale that only fills gaps).
 */
export function checkTextField(
  spec: ListingFieldSpec,
  value: string | null | undefined,
  options: { locale?: string; field?: string; fallback?: string; required?: boolean } = {},
): ListingProblem[] {
  const problems: ListingProblem[] = [];
  const where = {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    field: options.field ?? spec.id,
  };
  const effective = options.required === false ? { ...spec, required: false } : spec;
  checkListingField(problems, effective, where, value === null ? undefined : value, options.fallback);
  return problems;
}

/**
 * The text problems of a whole listing of one store: every locale, every field, in the order `validateListing` returns them (locales
 * sorted). Composition of `validateLocaleText`, so it cannot drift from `validateListing`. The App Store `copyright` is not per locale: pass it as
 * `copyright`.
 */
export function validateListingText(
  store: ListingStore,
  locales: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>,
  options: { copyright?: string | undefined } = {},
): ListingProblem[] {
  const problems: ListingProblem[] = [];
  const fallback = locales.default;
  for (const locale of Object.keys(locales).sort()) {
    problems.push(...validateLocaleText(store, locale, locales[locale] ?? {}, store === 'app_store' ? fallback : undefined));
  }
  if (store === 'app_store')
    problems.push(
      ...checkTextField(APP_STORE_COPYRIGHT_SPEC, options.copyright, { field: 'copyright' }),
    );
  return problems;
}

/**
 * What two values are compared as: line breaks as `\n` and no white space at the end. The stores trim and the repository model drops one
 * trailing line break, so these differences are not changes. THE normaliser (the server's `normalizeListingValue`); the web `normalizeText`,
 * which also stripped trailing blanks of every line, gave `upToDate: true` for text the server hashed differently.
 */
export const normalizeStoreText = (value: string): string =>
  value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** Whether two values are the same text once normalised. */
export const sameListingText = (a: string, b: string): boolean =>
  normalizeStoreText(a) === normalizeStoreText(b);
