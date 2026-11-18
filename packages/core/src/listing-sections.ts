/**
 * The parts of a store listing beyond its texts: categories, age rating, privacy choices, media
 * counts, app details and (Google Play) release notes. Strictly read-only data: it is read from the
 * stores and from the repository to be shown and compared, never written anywhere.
 *
 * Pure. Every section is a small JSON value with a canonical text form (`canonicalJson`), which is
 * what the server stores and hashes. A section that is absent from a read means "not read" (the
 * store could not say, the call failed, or the repository's files cannot express it); a section
 * that is present but empty means "read, and there is nothing". The two must never be confused:
 * see docs/api/listing.md, "Sections".
 *
 * Nothing in here holds image bytes, image URLs, demo-account credentials, review contact names or
 * phone numbers. Media is metadata only: display types, counts, file names, asset states and ids.
 */

export const LISTING_SECTIONS = [
  'categories',
  'ageRating',
  'privacy',
  'media',
  'details',
  'releaseNotes',
] as const;
export type ListingSectionName = (typeof LISTING_SECTIONS)[number];

export const isListingSection = (name: string): name is ListingSectionName =>
  (LISTING_SECTIONS as readonly string[]).includes(name);

/** The reserved locale of a section row in the snapshot table. A real locale never looks like this. */
export const SECTION_LOCALE = '_app';
/** The field of a section row: `section:<name>`. */
export const sectionField = (name: ListingSectionName): string => `section:${name}`;
export const sectionOfField = (field: string): ListingSectionName | undefined => {
  if (!field.startsWith('section:')) return undefined;
  const name = field.slice('section:'.length);
  return isListingSection(name) ? name : undefined;
};

/**
 * App Store categories, as the store's category ids (`GAMES`, `GAMES_CARD`) or, from a repository,
 * the text the file holds. Compare with `normalizeCategory`. Google Play has no categories in the
 * Play Developer API: this section is never present for an Android app.
 */
export type ListingCategories = {
  primary?: string;
  secondary?: string;
  /** At most two (App Store Connect `primarySubcategoryOne` and `primarySubcategoryTwo`). */
  primarySubcategories?: string[];
  secondarySubcategories?: string[];
};

/**
 * The age rating declaration: the answers of App Store Connect's `ageRatingDeclarations` (an
 * attribute name to a string such as `NONE` or `FREQUENT_OR_INTENSE`, or a boolean) and the
 * resulting label (`AppInfo.appStoreAgeRating`, verbatim, UNVERIFIED values).
 */
export type ListingAgeRating = {
  rating?: string;
  answers: Record<string, string | boolean>;
};

/** Privacy choices URL per locale (`appInfoLocalizations.privacyChoicesUrl`). The policy URL is a text field. */
export type ListingPrivacy = {
  choicesUrls: Record<string, string>;
};

/** One set of media of one kind in one locale: an App Store display type, or a Play image type. */
export type MediaSet = {
  /** `APP_IPHONE_67`, `IPHONE_67` (previews), `phoneScreenshots`, `icon`, ... or `all` (a repository folder). */
  type: string;
  count: number;
  /** File names, in the store's order (App Store). */
  names?: string[];
  /** Store ids (Google Play). */
  ids?: string[];
  /** Asset state to count (`COMPLETE`: 3). App Store only. */
  states?: Record<string, number>;
};

export type ListingMedia = {
  /** Locale to sets, sorted by type. */
  screenshots: Record<string, MediaSet[]>;
  /** App Store previews. Absent for Google Play and for a repository. */
  previews?: Record<string, MediaSet[]>;
  /** Google Play icon, feature graphic and TV banner. */
  graphics?: Record<string, MediaSet[]>;
  /** True when some locales were left out to stay within the read limits. */
  truncated?: boolean;
};

/** What `edits.details` and the App Store version hold about the app as a whole. No phone number. */
export type ListingDetails = {
  copyright?: string;
  defaultLanguage?: string;
  contactEmail?: string;
  contactWebsite?: string;
};

/** Google Play release notes of the newest release of each track, per language. */
export type ListingReleaseNotes = {
  tracks: Record<
    string,
    { name?: string; status?: string; versionCodes: string[]; notes: Record<string, string> }
  >;
};

export type ListingSections = {
  categories?: ListingCategories;
  ageRating?: ListingAgeRating;
  privacy?: ListingPrivacy;
  media?: ListingMedia;
  details?: ListingDetails;
  releaseNotes?: ListingReleaseNotes;
};

// ---------------------------------------------------------------------------------------------
// Canonical text form

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with sorted object keys and no undefined members: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const inner = v[key];
        if (inner !== undefined) out[key] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const MAX_TEXT = 2000;
const MAX_ITEMS = 500;
const MAX_KEYS = 200;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
const strings = (v: unknown, max = MAX_ITEMS): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((s) => s.slice(0, MAX_TEXT)) : undefined;

function cleanSets(v: unknown): MediaSet[] {
  if (!Array.isArray(v)) return [];
  const sets: MediaSet[] = [];
  for (const item of v.slice(0, MAX_KEYS)) {
    if (!isObject(item)) continue;
    const type = text(item.type);
    const n = count(item.count);
    if (type === undefined || n === undefined) continue;
    const set: MediaSet = { type, count: n };
    const names = strings(item.names, 100);
    const ids = strings(item.ids, 100);
    if (names) set.names = names;
    if (ids) set.ids = ids;
    if (isObject(item.states)) {
      const states: Record<string, number> = {};
      for (const [k, c] of Object.entries(item.states).slice(0, 20)) {
        const parsed = count(c);
        if (parsed !== undefined) states[k] = parsed;
      }
      set.states = states;
    }
    sets.push(set);
  }
  return sets;
}

function cleanSetMap(v: unknown): Record<string, MediaSet[]> {
  const out: Record<string, MediaSet[]> = {};
  if (!isObject(v)) return out;
  for (const locale of Object.keys(v).sort().slice(0, MAX_KEYS)) out[locale] = cleanSets(v[locale]);
  return out;
}

/**
 * The tolerant reading of a stored or received section: unknown members are dropped, wrong types
 * are ignored, nothing throws. `undefined` when the value is not an object at all (so "not read").
 */
export function cleanSection<N extends ListingSectionName>(
  name: N,
  value: unknown,
): ListingSections[N] | undefined {
  if (!isObject(value)) return undefined;
  const result = ((): ListingSections[ListingSectionName] => {
    switch (name) {
      case 'categories': {
        const out: ListingCategories = {};
        const primary = text(value.primary);
        const secondary = text(value.secondary);
        const p = strings(value.primarySubcategories, 2);
        const s = strings(value.secondarySubcategories, 2);
        if (primary !== undefined) out.primary = primary;
        if (secondary !== undefined) out.secondary = secondary;
        if (p && p.length > 0) out.primarySubcategories = p;
        if (s && s.length > 0) out.secondarySubcategories = s;
        return out;
      }
      case 'ageRating': {
        const answers: Record<string, string | boolean> = {};
        if (isObject(value.answers)) {
          for (const key of Object.keys(value.answers).sort().slice(0, MAX_KEYS)) {
            const a = value.answers[key];
            if (typeof a === 'boolean') answers[key] = a;
            else if (typeof a === 'string') answers[key] = a.slice(0, 100);
          }
        }
        const rating = text(value.rating);
        return rating !== undefined ? { rating, answers } : { answers };
      }
      case 'privacy': {
        const choicesUrls: Record<string, string> = {};
        if (isObject(value.choicesUrls)) {
          for (const locale of Object.keys(value.choicesUrls).sort().slice(0, MAX_KEYS)) {
            const url = text(value.choicesUrls[locale]);
            if (url !== undefined) choicesUrls[locale] = url;
          }
        }
        return { choicesUrls };
      }
      case 'media': {
        const out: ListingMedia = { screenshots: cleanSetMap(value.screenshots) };
        if (isObject(value.previews)) out.previews = cleanSetMap(value.previews);
        if (isObject(value.graphics)) out.graphics = cleanSetMap(value.graphics);
        if (value.truncated === true) out.truncated = true;
        return out;
      }
      case 'details': {
        const out: ListingDetails = {};
        for (const key of ['copyright', 'defaultLanguage', 'contactEmail', 'contactWebsite'] as const) {
          const v = text(value[key]);
          if (v !== undefined) out[key] = v;
        }
        return out;
      }
      case 'releaseNotes': {
        const tracks: ListingReleaseNotes['tracks'] = {};
        if (isObject(value.tracks)) {
          for (const track of Object.keys(value.tracks).sort().slice(0, 20)) {
            const t = value.tracks[track];
            if (!isObject(t)) continue;
            const notes: Record<string, string> = {};
            if (isObject(t.notes)) {
              for (const language of Object.keys(t.notes).sort().slice(0, MAX_KEYS)) {
                const n = text(t.notes[language]);
                if (n !== undefined) notes[language] = n;
              }
            }
            const entry: ListingReleaseNotes['tracks'][string] = {
              versionCodes: strings(t.versionCodes, 50) ?? [],
              notes,
            };
            const tname = text(t.name);
            const status = text(t.status);
            if (tname !== undefined) entry.name = tname;
            if (status !== undefined) entry.status = status;
            tracks[track] = entry;
          }
        }
        return { tracks };
      }
    }
  })();
  return result as ListingSections[N];
}

/** The canonical text of a section, for storing and hashing. */
export const sectionToText = (name: ListingSectionName, value: unknown): string | undefined => {
  const clean = cleanSection(name, value);
  return clean === undefined ? undefined : canonicalJson(clean);
};

/** A stored section text back to the section, or undefined when it is not one. Never throws. */
export function sectionFromText<N extends ListingSectionName>(
  name: N,
  raw: string | null | undefined,
): ListingSections[N] | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    return cleanSection(name, JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Comparing the store with the repository

/**
 * - `identical`: the side(s) that can be compared say the same.
 * - `differs`: they disagree; `details` says where.
 * - `missing-in-repo`: the store has something, the repository's files say nothing.
 * - `missing-in-store`: the repository has something, the store has nothing.
 * - `not-comparable`: no faithful comparison is possible (the repository's source cannot express the
 *   section, was not read, or uses names this tool does not know); the store value is shown read-only.
 * - `not-read`: the store side has not been read (never, or that call failed).
 */
export type SectionStatus =
  | 'identical'
  | 'differs'
  | 'missing-in-repo'
  | 'missing-in-store'
  | 'not-comparable'
  | 'not-read';

export type SectionCompare = {
  status: SectionStatus;
  /** One short sentence per difference or limit, safe to show. */
  details: string[];
};

const done = (status: SectionStatus, details: string[] = []): SectionCompare => ({ status, details });

/**
 * What two category texts are compared as: upper case, `&` as AND, everything but letters and
 * digits as `_`, a leading `MZGenre.` dropped (fastlane's own prefix). `Food & Drink` and
 * `FOOD_AND_DRINK` are then the same category. Not a promise that fastlane's other spellings match.
 */
export function normalizeCategory(raw: string): string {
  return raw
    .trim()
    .replace(/^MZGenre\./i, '')
    .replace(/&/g, ' AND ')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const hasCategories = (c: ListingCategories | undefined) =>
  c !== undefined &&
  (c.primary !== undefined ||
    c.secondary !== undefined ||
    (c.primarySubcategories?.length ?? 0) > 0 ||
    (c.secondarySubcategories?.length ?? 0) > 0);

const categoryRows = (c: ListingCategories | undefined): [string, string | undefined][] => [
  ['primary category', c?.primary],
  ['secondary category', c?.secondary],
  ['first primary subcategory', c?.primarySubcategories?.[0]],
  ['second primary subcategory', c?.primarySubcategories?.[1]],
  ['first secondary subcategory', c?.secondarySubcategories?.[0]],
  ['second secondary subcategory', c?.secondarySubcategories?.[1]],
];

export function compareCategories(
  store: ListingCategories | undefined,
  repo: ListingCategories | undefined,
): SectionCompare {
  if (store === undefined) return done('not-read');
  if (repo === undefined) {
    return done('not-comparable', ['The repository has not been read, or its source cannot hold categories.']);
  }
  if (!hasCategories(store) && !hasCategories(repo)) return done('identical');
  if (!hasCategories(repo)) return done('missing-in-repo');
  if (!hasCategories(store)) return done('missing-in-store');
  const details: string[] = [];
  const a = categoryRows(store);
  const b = categoryRows(repo);
  for (let i = 0; i < a.length; i++) {
    const [label, s] = a[i] as [string, string | undefined];
    const r = (b[i] as [string, string | undefined])[1];
    const same = (s === undefined ? '' : normalizeCategory(s)) === (r === undefined ? '' : normalizeCategory(r));
    if (!same) details.push(`${label}: store ${s ?? 'none'}, repository ${r ?? 'none'}`);
  }
  return details.length === 0 ? done('identical') : done('differs', details);
}

/** Legacy numeric answers of fastlane's age rating file (0, 1, 2) as the API's words. */
export const LEGACY_AGE_ANSWER: Record<string, string> = {
  '0': 'NONE',
  '1': 'INFREQUENT_OR_MILD',
  '2': 'FREQUENT_OR_INTENSE',
};

/**
 * Age rating answers are compared key by key, only for the keys the repository states under the
 * App Store Connect API's own names (`ageRatingDeclarations` attributes). A repository key the
 * store does not report, or a repository file in another naming, is not compared. When no key can
 * be compared the result is `not-comparable`, and the store's answers are shown as they are.
 */
export function compareAgeRating(
  store: ListingAgeRating | undefined,
  repo: ListingAgeRating | undefined,
): SectionCompare {
  if (store === undefined) return done('not-read');
  if (repo === undefined) {
    return done('not-comparable', ['The repository has not been read, or its source cannot hold an age rating.']);
  }
  const repoKeys = Object.keys(repo.answers);
  if (repoKeys.length === 0) {
    return Object.keys(store.answers).length === 0 ? done('identical') : done('missing-in-repo');
  }
  const details: string[] = [];
  let compared = 0;
  let unknown = 0;
  for (const key of repoKeys) {
    if (!(key in store.answers)) {
      unknown++;
      continue;
    }
    compared++;
    const s = store.answers[key];
    const rv = repo.answers[key];
    const r = typeof rv === 'string' ? (LEGACY_AGE_ANSWER[rv] ?? rv) : rv;
    if (s !== r) details.push(`${key}: store ${String(s)}, repository ${String(rv)}`);
  }
  if (compared === 0) {
    return done('not-comparable', [
      'None of the repository\'s age rating keys is one the store reports, so they cannot be compared.',
    ]);
  }
  const notes = unknown > 0 ? [`${unknown} repository key(s) are not reported by the store and were not compared.`] : [];
  return details.length === 0 ? done('identical', notes) : done('differs', [...details, ...notes]);
}

export function comparePrivacy(
  store: ListingPrivacy | undefined,
  repo: ListingPrivacy | undefined,
): SectionCompare {
  if (store === undefined) return done('not-read');
  if (repo === undefined) {
    return done('not-comparable', ['The repository has not been read, or its source cannot hold a privacy choices URL.']);
  }
  const locales = [...new Set([...Object.keys(store.choicesUrls), ...Object.keys(repo.choicesUrls)])].sort();
  if (locales.length === 0) return done('identical');
  if (Object.keys(repo.choicesUrls).length === 0) return done('missing-in-repo');
  if (Object.keys(store.choicesUrls).length === 0) return done('missing-in-store');
  const details: string[] = [];
  for (const locale of locales) {
    const s = store.choicesUrls[locale];
    const r = repo.choicesUrls[locale];
    if ((s ?? '').trim() !== (r ?? '').trim()) {
      details.push(`${locale}: store ${s ?? 'none'}, repository ${r ?? 'none'}`);
    }
  }
  return details.length === 0 ? done('identical') : done('differs', details);
}

export function compareDetails(
  store: ListingDetails | undefined,
  repo: ListingDetails | undefined,
): SectionCompare {
  if (store === undefined) return done('not-read');
  if (repo === undefined) return done('not-comparable', ['The repository has not been read.']);
  const s = (store.copyright ?? '').trim();
  const r = (repo.copyright ?? '').trim();
  if (s === '' && r === '') return done('identical');
  if (r === '') return done('missing-in-repo');
  if (s === '') return done('missing-in-store');
  return s === r ? done('identical') : done('differs', [`copyright: store "${s}", repository "${r}"`]);
}

const countsByLocale = (map: Record<string, MediaSet[]> | undefined, perType: boolean) => {
  const out = new Map<string, number>();
  for (const [locale, sets] of Object.entries(map ?? {})) {
    if (perType) for (const set of sets) out.set(`${locale} ${set.type}`, set.count);
    else out.set(locale, sets.reduce((sum, set) => sum + set.count, 0));
  }
  return out;
};

/**
 * Media is compared by COUNT only, never by content. A repository folder of an iOS app has no
 * display type (fastlane tells them apart by image size, which is not read), so the totals per
 * locale are compared; an Android repository has the image type in the folder name, so each type is.
 * Locales and types the repository has no folder for count as zero only when it has some media at
 * all; the store's previews are not compared.
 */
export function compareMedia(
  store: ListingMedia | undefined,
  repo: ListingMedia | undefined,
  platform: 'ios' | 'android',
): SectionCompare {
  if (store === undefined) return done('not-read');
  if (repo === undefined) {
    return done('not-comparable', ['The repository has not been read, or its source cannot hold screenshots.']);
  }
  const perType = platform === 'android';
  const merge = (m: ListingMedia) => {
    const all = new Map(countsByLocale(m.screenshots, perType));
    if (perType) for (const [k, v] of countsByLocale(m.graphics, true)) all.set(k, v);
    return all;
  };
  const s = merge(store);
  const r = merge(repo);
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  if (total(s) === 0 && total(r) === 0) return done('identical');
  if (total(r) === 0) return done('missing-in-repo');
  if (total(s) === 0) return done('missing-in-store');
  const details: string[] = [];
  for (const key of [...new Set([...s.keys(), ...r.keys()])].sort()) {
    const a = s.get(key) ?? 0;
    const b = r.get(key) ?? 0;
    if (a !== b) details.push(`${key}: store ${a}, repository ${b}`);
  }
  const notes: string[] = [];
  if (!perType) notes.push('Totals per locale: the repository does not say which device each file is for.');
  if (store.truncated === true) notes.push('The store read was cut short, so some locales are missing from the store side.');
  return details.length === 0 ? done('identical', notes) : done('differs', [...details, ...notes]);
}
