/**
 * Store listings as data: the fields each store has, their limits, and a validator.
 *
 * Pure. No file layout lives here (that is `@kiln/connectors/fastlane`); this module only knows
 * what a listing is and what makes one acceptable to the store.
 *
 * Every limit carries the page it came from. A limit or a "required" flag that no official page
 * states is marked in `unverified`, and a problem found through it is only a warning. See
 * docs/spikes/repo-conventions.md for what was and was not confirmed.
 */

export type ListingStore = 'app_store' | 'google_play';

export const APP_STORE_FIELDS = [
  'name',
  'subtitle',
  'description',
  'keywords',
  'promotional_text',
  'release_notes',
  'marketing_url',
  'support_url',
  'privacy_url',
  'apple_tv_privacy_policy',
] as const;
export type AppStoreField = (typeof APP_STORE_FIELDS)[number];

export const PLAY_FIELDS = ['title', 'short_description', 'full_description', 'video'] as const;
export type PlayField = (typeof PLAY_FIELDS)[number];

/** The text of one locale. A field that is absent has no file; an empty string is an empty file. */
export type LocaleText<F extends string> = Partial<Record<F, string>>;

export type AppStoreListing = {
  locales: Record<string, LocaleText<AppStoreField>>;
  /** Not localized. Lives in `copyright.txt` beside the locale folders. */
  copyright?: string;
};

export type PlayListing = {
  locales: Record<string, LocaleText<PlayField>>;
  /**
   * Release notes per locale, keyed by version code (the file name without `.txt`), or
   * `default` for the fallback file.
   */
  changelogs: Record<string, Record<string, string>>;
};

export type Listing = {
  appStore?: AppStoreListing | undefined;
  googlePlay?: PlayListing | undefined;
};

export type ListingFieldKind = 'text' | 'multiline' | 'keywords' | 'url';
export type Unverified = 'max' | 'min' | 'required';

export type ListingFieldSpec = {
  store: ListingStore;
  id: string;
  label: string;
  kind: ListingFieldKind;
  /** Where the field lives: per locale, or once per app. */
  scope: 'locale' | 'app';
  required: boolean;
  maxLength?: number;
  minLength?: number;
  /** Unit of `maxLength`. Characters are counted as Unicode code points. */
  unit: 'characters' | 'bytes';
  /** Aspects of this spec that no official page confirmed. */
  unverified: Unverified[];
  source: string;
  note?: string;
};

const ASC_VERSION =
  'https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information';
const ASC_APP =
  'https://developer.apple.com/help/app-store-connect/reference/app-information/app-information';
const PLAY_LISTING = 'https://support.google.com/googleplay/android-developer/answer/9859152';
const PLAY_RELEASE = 'https://support.google.com/googleplay/android-developer/answer/9859348';
const PLAY_API_LISTING =
  'https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings';

export const APP_STORE_FIELD_SPECS: Record<AppStoreField, ListingFieldSpec> = {
  name: {
    store: 'app_store',
    id: 'name',
    label: 'Name',
    kind: 'text',
    scope: 'locale',
    required: true,
    minLength: 2,
    maxLength: 30,
    unit: 'characters',
    unverified: ['required'],
    source: ASC_APP,
  },
  subtitle: {
    store: 'app_store',
    id: 'subtitle',
    label: 'Subtitle',
    kind: 'text',
    scope: 'locale',
    required: false,
    maxLength: 30,
    unit: 'characters',
    unverified: [],
    source: ASC_APP,
  },
  description: {
    store: 'app_store',
    id: 'description',
    label: 'Description',
    kind: 'multiline',
    scope: 'locale',
    required: true,
    minLength: 10,
    maxLength: 4000,
    unit: 'characters',
    unverified: ['min'],
    source: ASC_VERSION,
    note: 'The 10 character minimum comes from the EAS Metadata schema, not from Apple.',
  },
  keywords: {
    store: 'app_store',
    id: 'keywords',
    label: 'Keywords',
    kind: 'keywords',
    scope: 'locale',
    required: true,
    maxLength: 100,
    unit: 'bytes',
    unverified: [],
    source: ASC_VERSION,
    note: 'Apple says "up to 100 bytes". Whether commas count toward it is not stated, so the whole string is measured.',
  },
  promotional_text: {
    store: 'app_store',
    id: 'promotional_text',
    label: 'Promotional text',
    kind: 'multiline',
    scope: 'locale',
    required: false,
    maxLength: 170,
    unit: 'characters',
    unverified: [],
    source: ASC_VERSION,
  },
  release_notes: {
    store: 'app_store',
    id: 'release_notes',
    label: "What's new",
    kind: 'multiline',
    scope: 'locale',
    required: false,
    maxLength: 4000,
    unit: 'characters',
    unverified: ['required'],
    source: ASC_VERSION,
  },
  marketing_url: {
    store: 'app_store',
    id: 'marketing_url',
    label: 'Marketing URL',
    kind: 'url',
    scope: 'locale',
    required: false,
    maxLength: 255,
    unit: 'characters',
    unverified: ['max'],
    source: ASC_VERSION,
    note: 'The 255 limit comes from the EAS Metadata schema, not from Apple.',
  },
  support_url: {
    store: 'app_store',
    id: 'support_url',
    label: 'Support URL',
    kind: 'url',
    scope: 'locale',
    required: true,
    maxLength: 255,
    unit: 'characters',
    unverified: ['max'],
    source: ASC_VERSION,
    note: 'The 255 limit comes from the EAS Metadata schema, not from Apple.',
  },
  privacy_url: {
    store: 'app_store',
    id: 'privacy_url',
    label: 'Privacy policy URL',
    kind: 'url',
    scope: 'locale',
    required: true,
    maxLength: 255,
    unit: 'characters',
    unverified: ['max'],
    source: ASC_APP,
    note: 'Required for iOS and macOS apps. The 255 limit comes from the EAS Metadata schema.',
  },
  apple_tv_privacy_policy: {
    store: 'app_store',
    id: 'apple_tv_privacy_policy',
    label: 'Apple TV privacy policy text',
    kind: 'multiline',
    scope: 'locale',
    required: false,
    unit: 'characters',
    unverified: [],
    source: ASC_APP,
    note: 'Required only when the app has a tvOS platform. No limit is documented.',
  },
};

export const APP_STORE_COPYRIGHT_SPEC: ListingFieldSpec = {
  store: 'app_store',
  id: 'copyright',
  label: 'Copyright',
  kind: 'text',
  scope: 'app',
  required: true,
  unit: 'characters',
  unverified: [],
  source: ASC_VERSION,
  note: 'The year the rights were obtained, then the owner. No limit is documented.',
};

export const PLAY_FIELD_SPECS: Record<PlayField, ListingFieldSpec> = {
  title: {
    store: 'google_play',
    id: 'title',
    label: 'App name',
    kind: 'text',
    scope: 'locale',
    required: true,
    maxLength: 30,
    unit: 'characters',
    unverified: ['required'],
    source: PLAY_LISTING,
  },
  short_description: {
    store: 'google_play',
    id: 'short_description',
    label: 'Short description',
    kind: 'text',
    scope: 'locale',
    required: true,
    maxLength: 80,
    unit: 'characters',
    unverified: ['required'],
    source: PLAY_LISTING,
  },
  full_description: {
    store: 'google_play',
    id: 'full_description',
    label: 'Full description',
    kind: 'multiline',
    scope: 'locale',
    required: true,
    maxLength: 4000,
    unit: 'characters',
    unverified: ['required'],
    source: PLAY_LISTING,
  },
  video: {
    store: 'google_play',
    id: 'video',
    label: 'Promo video',
    kind: 'url',
    scope: 'locale',
    required: false,
    unit: 'characters',
    unverified: [],
    source: PLAY_API_LISTING,
    note: 'A YouTube URL. No limit is documented.',
  },
};

export const PLAY_CHANGELOG_SPEC: ListingFieldSpec = {
  store: 'google_play',
  id: 'changelog',
  label: 'Release notes',
  kind: 'multiline',
  scope: 'locale',
  required: false,
  maxLength: 500,
  unit: 'characters',
  unverified: [],
  source: PLAY_RELEASE,
};

export const LISTING_FIELD_SPECS: readonly ListingFieldSpec[] = [
  ...APP_STORE_FIELDS.map((f) => APP_STORE_FIELD_SPECS[f]),
  APP_STORE_COPYRIGHT_SPEC,
  ...PLAY_FIELDS.map((f) => PLAY_FIELD_SPECS[f]),
  PLAY_CHANGELOG_SPEC,
];

export type ListingProblemCode =
  | 'missing_required'
  | 'too_long'
  | 'too_short'
  | 'invalid_url'
  | 'keywords_empty_entry'
  | 'keywords_duplicate'
  | 'keywords_short_entry'
  | 'keywords_newline';

export type ListingProblem = {
  store: ListingStore;
  /** Absent for a field that is not per locale (copyright). */
  locale?: string;
  /** A field id, or `changelog/<versionCode>`. */
  field: string;
  code: ListingProblemCode;
  /** `warning` when the rule is not confirmed by an official page, or is advice. */
  severity: 'error' | 'warning';
  message: string;
  limit?: number;
  actual?: number;
  unit?: 'characters' | 'bytes';
};

/** Length in Unicode code points. Whether the stores count code points is not documented. */
export function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function countBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * THE counting unit of a listing text (docs/state-model.md, "Single owners (core)"): the length of `value` in the unit of its spec,
 * Unicode CODE POINTS (an emoji is one, not two UTF-16 units) or UTF-8 BYTES (keywords), after TRIMMING white space at both ends.
 *
 * Why trimmed: the text that is pushed is normalised first (line breaks as `\n`, no trailing white space, `normalizeListingValue` of the
 * server), so a trailing newline is not sent and must not count; readiness already trimmed, `countCharacters` did not. The decision for
 * every surface: validators, readiness, the notes row, the cart and the staged cap all call this, never `value.length` (UTF-16, which put a
 * 480-code-point Play note with 30 emoji at 510 "over") and never `countCharacters` on a raw value. Leading white space is trimmed too
 * although the push keeps it: at most a few units of under-count, never a false "over".
 */
export function measureField(spec: Pick<ListingFieldSpec, 'unit'>, value: string): number {
  const text = value.trim();
  return spec.unit === 'bytes' ? countBytes(text) : countCharacters(text);
}

const measure = measureField;

const isBlank = (value: string | undefined) => value === undefined || value.trim() === '';

const severityFor = (spec: ListingFieldSpec, aspect: Unverified): 'error' | 'warning' =>
  spec.unverified.includes(aspect) ? 'warning' : 'error';

/** `default` is deliver's fallback folder, not a locale. */
export const DEFAULT_LOCALE = 'default';

type Where = { locale?: string; field: string };

function checkLength(
  problems: ListingProblem[],
  spec: ListingFieldSpec,
  where: Where,
  value: string,
) {
  const actual = measure(spec, value);
  const base = { store: spec.store, ...where, unit: spec.unit, actual } as const;
  if (spec.maxLength !== undefined && actual > spec.maxLength) {
    problems.push({
      ...base,
      code: 'too_long',
      severity: severityFor(spec, 'max'),
      limit: spec.maxLength,
      message: `${spec.label} is ${actual} ${spec.unit}, over the limit of ${spec.maxLength}.`,
    });
  }
  if (spec.minLength !== undefined && value.trim() !== '' && actual < spec.minLength) {
    problems.push({
      ...base,
      code: 'too_short',
      severity: severityFor(spec, 'min'),
      limit: spec.minLength,
      message: `${spec.label} is ${actual} ${spec.unit}, under the minimum of ${spec.minLength}.`,
    });
  }
}

function checkUrl(problems: ListingProblem[], spec: ListingFieldSpec, where: Where, value: string) {
  const text = value.trim();
  if (text === '') return;
  let ok = /^https?:\/\/[^\s/]+/i.test(text) && !/\s/.test(text);
  let message = `${spec.label} must be a full URL that starts with http:// or https://.`;
  let severity: 'error' | 'warning' = 'error';
  if (ok && spec.store === 'google_play' && spec.id === 'video') {
    try {
      const host = new URL(text).hostname.replace(/^(www|m)\./, '');
      if (host !== 'youtube.com' && host !== 'youtu.be') {
        ok = false;
        message = 'The Play promo video should be a YouTube URL.';
        severity = 'warning';
      }
    } catch {
      ok = false;
    }
  }
  if (!ok) problems.push({ store: spec.store, ...where, code: 'invalid_url', severity, message });
}

/**
 * Keyword advice. Apple documents only the 100 byte limit and that each keyword should be longer
 * than two characters; the rest is advice, so only a warning.
 */
function checkKeywords(
  problems: ListingProblem[],
  spec: ListingFieldSpec,
  where: Where,
  value: string,
) {
  const warn = (code: ListingProblemCode, message: string) =>
    problems.push({ store: spec.store, ...where, code, severity: 'warning', message });
  if (/[\r\n]/.test(value)) {
    warn(
      'keywords_newline',
      'Keywords are one comma separated line; line breaks are probably not wanted.',
    );
  }
  if (value.trim() === '') return;
  const entries = value.split(',').map((k) => k.trim());
  if (entries.some((k) => k === '')) {
    warn('keywords_empty_entry', 'Keywords contain an empty entry (a doubled or trailing comma).');
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of entries) {
    if (k === '') continue;
    const key = k.toLowerCase();
    if (seen.has(key)) dupes.add(k);
    seen.add(key);
  }
  if (dupes.size > 0)
    warn('keywords_duplicate', `Repeated keywords waste space: ${[...dupes].join(', ')}.`);
  const short = entries.filter((k) => k !== '' && countCharacters(k) <= 2);
  if (short.length > 0) {
    warn(
      'keywords_short_entry',
      `Apple asks for keywords longer than two characters: ${short.join(', ')}.`,
    );
  }
}

function checkField(
  problems: ListingProblem[],
  spec: ListingFieldSpec,
  where: Where,
  value: string | undefined,
  fallback?: string,
) {
  if (spec.required && isBlank(value ?? fallback)) {
    problems.push({
      store: spec.store,
      ...where,
      code: 'missing_required',
      severity: severityFor(spec, 'required'),
      message: `${spec.label} is required.`,
    });
    return;
  }
  if (value === undefined) return;
  checkLength(problems, spec, where, value);
  if (spec.kind === 'url') checkUrl(problems, spec, where, value);
  if (spec.kind === 'keywords') checkKeywords(problems, spec, where, value);
}

/** One field of one locale against its spec (required, length, URL, keyword advice). The one check every surface calls. */
export { checkField as checkListingField };

/**
 * The text problems of ONE locale of a store: every field of the store against its spec, in the order of the store's field list. The
 * `default` locale only fills gaps and is never "missing" a field; `fallback` is the `default` locale's text (repository only).
 */
export function validateLocaleText(
  store: ListingStore,
  locale: string,
  text: Readonly<Record<string, string | undefined>>,
  fallback?: Readonly<Record<string, string | undefined>>,
): ListingProblem[] {
  const problems: ListingProblem[] = [];
  const fields: readonly string[] = store === 'app_store' ? APP_STORE_FIELDS : PLAY_FIELDS;
  const specs: Record<string, ListingFieldSpec> =
    store === 'app_store' ? APP_STORE_FIELD_SPECS : PLAY_FIELD_SPECS;
  for (const field of fields) {
    const spec = specs[field] as ListingFieldSpec;
    if (locale === DEFAULT_LOCALE) {
      // The fallback folder only fills gaps; it is never "missing" a field.
      checkField(problems, { ...spec, required: false }, { locale, field }, text[field]);
    } else {
      checkField(problems, spec, { locale, field }, text[field], fallback?.[field]);
    }
  }
  return problems;
}

function validateAppStore(listing: AppStoreListing): ListingProblem[] {
  const problems: ListingProblem[] = [];
  const fallback = listing.locales[DEFAULT_LOCALE];
  for (const locale of Object.keys(listing.locales).sort()) {
    problems.push(...validateLocaleText('app_store', locale, listing.locales[locale] ?? {}, fallback));
  }
  checkField(problems, APP_STORE_COPYRIGHT_SPEC, { field: 'copyright' }, listing.copyright);
  return problems;
}

function validatePlay(listing: PlayListing): ListingProblem[] {
  const problems: ListingProblem[] = [];
  for (const locale of Object.keys(listing.locales).sort()) {
    problems.push(...validateLocaleText('google_play', locale, listing.locales[locale] ?? {}));
  }
  for (const locale of Object.keys(listing.changelogs).sort()) {
    const notes = listing.changelogs[locale] ?? {};
    for (const code of Object.keys(notes).sort()) {
      const value = notes[code];
      if (value === undefined) continue;
      checkLength(problems, PLAY_CHANGELOG_SPEC, { locale, field: `changelog/${code}` }, value);
    }
  }
  return problems;
}

/** Per-field problems, ordered by store, locale and field. An empty array means nothing to fix. */
export function validateListing(listing: Listing): ListingProblem[] {
  return [
    ...(listing.appStore ? validateAppStore(listing.appStore) : []),
    ...(listing.googlePlay ? validatePlay(listing.googlePlay) : []),
  ];
}

/** True when no problem is an error (warnings are allowed). */
export function listingIsValid(problems: ListingProblem[]): boolean {
  return problems.every((p) => p.severity !== 'error');
}
