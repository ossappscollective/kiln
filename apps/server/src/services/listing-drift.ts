import { createHash } from 'node:crypto';
import {
  APP_STORE_FIELD_SPECS,
  APP_STORE_FIELDS,
  DEFAULT_LOCALE,
  type Listing,
  type ListingFieldSpec,
  type ListingProblem,
  type LocaleText,
  PLAY_FIELD_SPECS,
  PLAY_FIELDS,
  type Platform,
  validateListing,
  isApplePlatform,
} from '@mrm/core';

/**
 * The pure part of the listing history and drift view: which fields an app has, how a value is
 * compared and hashed, how a repository listing is flattened into field values, and how the three
 * sides (repository, tool database, live store) are classified. No database, no network.
 */

export const LISTING_SOURCES = ['store', 'repo', 'change_set'] as const;
export type ListingSource = (typeof LISTING_SOURCES)[number];

/** The fields of the store listing that belongs to a platform, in display order. */
export const listingFieldsFor = (platform: Platform): readonly string[] =>
  isApplePlatform(platform) ? APP_STORE_FIELDS : PLAY_FIELDS;

export const isListingField = (platform: Platform, field: string): boolean =>
  listingFieldsFor(platform).includes(field);

export function fieldSpec(platform: Platform, field: string): ListingFieldSpec | undefined {
  const specs: Record<string, ListingFieldSpec> =
    isApplePlatform(platform) ? APP_STORE_FIELD_SPECS : PLAY_FIELD_SPECS;
  return specs[field];
}

/**
 * What two values are compared as: line breaks as `\n` and no trailing white space. The stores trim
 * and the repository model drops one trailing line break, so these differences are not changes.
 */
export const normalizeListingValue = (value: string): string =>
  value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** The hash of an absent value (no file, no field). Different from the hash of an empty string. */
export const ABSENT_HASH = 'absent';

/** SHA-256 of the normalized value, or `ABSENT_HASH` for null. Stored with every snapshot. */
export const hashListingValue = (value: string | null): string =>
  value === null ? ABSENT_HASH : createHash('sha256').update(normalizeListingValue(value)).digest('hex');

export type FieldValue = { locale: string; field: string; value: string };

export const fieldKey = (locale: string, field: string): string => `${locale}\u0000${field}`;
export const splitKey = (key: string): { locale: string; field: string } => {
  const [locale = '', field = ''] = key.split('\u0000');
  return { locale, field };
};

/** The listing of the app's own store as flat field values. A field that is not set is left out. */
export function flattenListing(listing: Listing, platform: Platform): FieldValue[] {
  const locales: Record<string, LocaleText<string>> | undefined =
    isApplePlatform(platform) ? listing.appStore?.locales : listing.googlePlay?.locales;
  const out: FieldValue[] = [];
  if (!locales) return out;
  for (const locale of Object.keys(locales).sort()) {
    const texts = locales[locale] ?? {};
    for (const field of listingFieldsFor(platform)) {
      const value = texts[field];
      if (typeof value === 'string') out.push({ locale, field, value });
    }
  }
  return out;
}

/** True when the listing has the store of this platform at all. */
export const hasStoreListing = (listing: Listing, platform: Platform): boolean =>
  isApplePlatform(platform) ? listing.appStore !== undefined : listing.googlePlay !== undefined;

// ---------------------------------------------------------------------------------------------
// The three-way view

/**
 * - `identical`: repository and store have the same value (or neither has one).
 * - `repo-ahead`: they differ and the store still shows a value the repository once had: the
 *   repository changed after they last agreed.
 * - `store-ahead`: they differ and the repository still holds a value the store once had: the store
 *   changed after they last agreed.
 * - `diverged`: they differ and neither holds the value they last agreed on, or they never agreed
 *   (nothing in the history is shared).
 * - `missing-in-one`: only one of them has a value; `missingIn` says which one lacks it.
 */
export type DriftStatus = 'identical' | 'repo-ahead' | 'store-ahead' | 'diverged' | 'missing-in-one';

export const DRIFT_STATUSES: readonly DriftStatus[] = [
  'identical',
  'repo-ahead',
  'store-ahead',
  'diverged',
  'missing-in-one',
];

export type DriftInput = {
  /** The repository's value now, or null when it has none. */
  repo: string | null;
  /** The live store value now, or null. */
  live: string | null;
  /** Hashes of every value the repository side has had (repository snapshots and applied change sets), newest first. */
  repoHistory: readonly string[];
  /** Hashes of every value the store has shown. */
  liveHistory: ReadonlySet<string> | readonly string[];
};

export function classifyDrift(input: DriftInput): { status: DriftStatus; missingIn?: 'repo' | 'store' } {
  const { repo, live } = input;
  if (repo === null && live === null) return { status: 'identical' };
  if (repo === null) return { status: 'missing-in-one', missingIn: 'repo' };
  if (live === null) return { status: 'missing-in-one', missingIn: 'store' };
  const r = hashListingValue(repo);
  const l = hashListingValue(live);
  if (r === l) return { status: 'identical' };
  const seen = input.liveHistory instanceof Set ? input.liveHistory : new Set(input.liveHistory);
  // The last value the two sides had in common: the newest repository value the store has shown.
  const base = input.repoHistory.find((hash) => seen.has(hash));
  if (base === l) return { status: 'repo-ahead' };
  if (base === r) return { status: 'store-ahead' };
  return { status: 'diverged' };
}

export type DriftSide = {
  value: string | null;
  /** When this value was first seen on this side (a row is written only when the value changes). */
  observedAt: number | null;
  /** A commit sha, a change set id or a store version. */
  sourceRef: string | null;
  /** The side the value came from: `repo`, `store` or `change_set`. */
  source: ListingSource | null;
};

export const emptySide = (): DriftSide => ({ value: null, observedAt: null, sourceRef: null, source: null });

export type SideProblem = Pick<
  ListingProblem,
  'code' | 'severity' | 'message' | 'limit' | 'actual' | 'unit'
>;

export type DriftField = {
  locale: string;
  field: string;
  label: string;
  /** The limit of the field (characters or bytes), when the store has one. */
  limit: number | null;
  unit: 'characters' | 'bytes';
  status: DriftStatus;
  missingIn?: 'repo' | 'store';
  repo: DriftSide;
  /** What the tool last knew: the newest of the store snapshots and applied change sets. */
  db: DriftSide;
  live: DriftSide;
  /** `validateListing` problems of each side's value (the same limits as the listing editor). */
  problems: { repo: SideProblem[]; live: SideProblem[] };
};

export type DriftLocale = { locale: string; fields: DriftField[] };

/** A flat set of values as a listing of the platform's store, so `validateListing` can check it. */
export function toListing(platform: Platform, values: ReadonlyMap<string, string>): Listing {
  const locales: Record<string, Record<string, string>> = {};
  for (const [key, value] of values) {
    const { locale, field } = splitKey(key);
    (locales[locale] ??= {})[field] = value;
  }
  return isApplePlatform(platform)
    ? { appStore: { locales: locales as Record<string, LocaleText<never>> } as Listing['appStore'] }
    : { googlePlay: { locales, changelogs: {} } as unknown as Listing['googlePlay'] };
}

/**
 * Problems per field of one side, from the shared validator. A side with no values at all is not
 * validated (it has not been read, so "everything is missing" would be noise), and problems that
 * are not about a locale field (the app wide copyright) are left out because they are not read.
 */
export function sideProblems(
  platform: Platform,
  values: ReadonlyMap<string, string>,
): Map<string, SideProblem[]> {
  const found = new Map<string, SideProblem[]>();
  if (values.size === 0) return found;
  for (const p of validateListing(toListing(platform, values))) {
    if (p.locale === undefined || !isListingField(platform, p.field)) continue;
    const key = fieldKey(p.locale, p.field);
    const list = found.get(key) ?? [];
    list.push({
      code: p.code,
      severity: p.severity,
      message: p.message,
      ...(p.limit !== undefined ? { limit: p.limit } : {}),
      ...(p.actual !== undefined ? { actual: p.actual } : {}),
      ...(p.unit !== undefined ? { unit: p.unit } : {}),
    });
    found.set(key, list);
  }
  return found;
}

export const DEFAULT_FALLBACK_LOCALE = DEFAULT_LOCALE;

// ---------------------------------------------------------------------------------------------
// When a scheduled listing read is due

const DAY_MS = 24 * 60 * 60_000;
/** After this many failures in a row the wait stops growing (interval times 2 to the power of it). */
const MAX_BACKOFF_STEPS = 5;

/**
 * How long to wait after the last attempt before the next scheduled read: the interval, doubled
 * for each failure in a row (at most 5 doublings), and never more than a day unless the interval
 * itself is longer. A broken credential is therefore not hammered every interval.
 */
export function listingBackoffMs(intervalMs: number, failures: number): number {
  const steps = Math.min(Math.max(Math.trunc(failures), 0), MAX_BACKOFF_STEPS);
  return Math.min(intervalMs * 2 ** steps, Math.max(intervalMs, DAY_MS));
}

/**
 * When the next scheduled read of an app is due, from its last read and last attempt (whichever is
 * later): `null` when it has never been tried, which means due now. `intervalMs` 0 (scheduling
 * off) has no due time either, so callers check that first.
 */
export function listingDueAt(
  intervalMs: number,
  last: { readAt: number | null; attemptAt: number | null },
  failures: number,
): number | null {
  const at = Math.max(last.readAt ?? 0, last.attemptAt ?? 0);
  return at === 0 ? null : at + listingBackoffMs(intervalMs, failures);
}

export type DriftSummary = Record<DriftStatus, number>;

export function summarize(locales: readonly DriftLocale[]): DriftSummary {
  const summary: DriftSummary = {
    identical: 0,
    'repo-ahead': 0,
    'store-ahead': 0,
    diverged: 0,
    'missing-in-one': 0,
  };
  for (const l of locales) for (const f of l.fields) summary[f.status]++;
  return summary;
}
