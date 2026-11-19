/**
 * Google Play search terms (docs/research/play-search-terms.md, docs/api/aso.md): the terms people searched before they opened the
 * listing, with store listing visitors and installs, from a file the developer exports from Play Console. Pure: no I/O, no clock.
 * Kept to ES2017 library calls because the web imports it.
 *
 * What this is NOT: a search volume. A term only shows up here when somebody searched it AND opened the listing, and Google groups
 * small terms into "Other". Everything shown with these numbers says so.
 *
 * A stored row is (app, country, period, term). A day row has `from === to`; a period row covers `from` to `to` (a file with no date
 * column). `country` is '' when the file has no usable country (all countries, or not split).
 */

import { type FitFields, type FitStatus, fitKeyword, foldedWords } from './aso.ts';

export const searchTermLimits = {
  /** Longest term kept; a longer cell is an unreadable row. */
  maxTermCharacters: 100,
  defaultLimit: 50,
  maxLimit: 200,
  /** Most stored rows one read looks at. */
  maxRowsRead: 200_000,
  /** Longest period (days) a file or a view may cover. */
  maxPeriodDays: 400,
  /** Most rows of one import (the file's own row cap is analyticsLimits.maxRows). */
  maxRowsPerImport: 100_000,
} as const;

/** The key of the `Other` row: terms Google grouped because each was too small to report. */
export const SEARCH_TERM_OTHER_KEY = '';

export type SearchTermPoint = {
  /** Two letters, lower case; '' when the file does not say. */
  country: string;
  from: string;
  to: string;
  /** What a person sees; '' for the `Other` row. */
  term: string;
  /** Folded words joined by one space (the key of a tracked keyword); '' for `Other`. */
  key: string;
  visitors: number | null;
  installs: number | null;
  /** A ratio from 0 to 1 as the file gave it; null when it had none. */
  conversion: number | null;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** A term as the file wrote it: its display text and its key, or undefined when it is not a usable term. */
export function readSearchTerm(raw: string): { term: string; key: string } | undefined {
  if (typeof raw !== 'string' || CONTROL.test(raw)) return undefined;
  const term = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (term === '') return undefined;
  if (Array.from(term).length > searchTermLimits.maxTermCharacters) return undefined;
  const key = foldedWords(term).join(' ');
  return key === '' ? undefined : { term, key };
}

export type SearchTermSort = 'installs' | 'visitors';
export const isSearchTermSort = (v: unknown): v is SearchTermSort =>
  v === 'installs' || v === 'visitors';

export type SearchTermLine = {
  key: string;
  term: string;
  visitors: number | null;
  installs: number | null;
  /** installs / visitors over the period when every row has both numbers; else the file's own figure when there is exactly one row; else null. */
  conversion: number | null;
  /** The storefronts the term was seen in ('' is not listed). */
  countries: string[];
  rows: number;
};

export type SearchTermsSummary = {
  from: string;
  to: string;
  terms: SearchTermLine[];
  /** Terms before the limit. */
  termCount: number;
  /** The `Other` row: terms Google grouped. */
  other: { visitors: number | null; installs: number | null } | null;
  /** Visitors and installs of every term, `Other` included. */
  totals: { visitors: number | null; installs: number | null };
  rowsUsed: number;
  /** Rows of a file with no dates that were left out because day rows of the same country exist (they would count twice). */
  droppedPeriodRows: number;
  /** Two stored period files of one country overlap: their numbers may count a day twice. */
  overlappingPeriods: boolean;
};

const add = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : a + b;

type Acc = {
  key: string;
  term: string;
  best: number;
  visitors: number | null;
  installs: number | null;
  both: boolean;
  conversion: number | null;
  countries: Record<string, true>;
  rows: number;
};

const overlap = (a: SearchTermPoint, b: SearchTermPoint) => a.from <= b.to && b.from <= a.to;

/**
 * The terms of a period: stored rows fully inside `from`..`to` (and of one country when given), summed per term. Rows of a file with
 * no dates are dropped for a country that also has day rows. Ordered by the chosen metric, then the other, then the term.
 */
export function summariseSearchTerms(
  rows: readonly SearchTermPoint[],
  options: { from: string; to: string; country?: string; sort?: SearchTermSort; limit?: number },
): SearchTermsSummary {
  const sort = options.sort ?? 'installs';
  const limit = Math.min(
    Math.max(options.limit ?? searchTermLimits.defaultLimit, 1),
    searchTermLimits.maxLimit,
  );
  const inside = rows.filter(
    (r) =>
      r.from >= options.from &&
      r.to <= options.to &&
      (options.country === undefined || r.country === options.country),
  );

  const withDays: Record<string, true> = {};
  for (const r of inside) if (r.from === r.to) withDays[r.country] = true;
  let droppedPeriodRows = 0;
  const used = inside.filter((r) => {
    if (r.from !== r.to && withDays[r.country]) {
      droppedPeriodRows += 1;
      return false;
    }
    return true;
  });

  // Two different period files of one country that overlap.
  let overlappingPeriods = false;
  const periods = used.filter((r) => r.from !== r.to);
  const seen: SearchTermPoint[] = [];
  for (const r of periods) {
    if (
      seen.some(
        (s) => s.country === r.country && (s.from !== r.from || s.to !== r.to) && overlap(s, r),
      )
    )
      overlappingPeriods = true;
    if (!seen.some((s) => s.country === r.country && s.from === r.from && s.to === r.to))
      seen.push(r);
  }

  const byKey: Record<string, Acc> = {};
  const order: string[] = [];
  for (const r of used) {
    const id = `k:${r.key}`;
    let a = byKey[id];
    if (!a) {
      a = {
        key: r.key,
        term: r.term,
        best: -1,
        visitors: null,
        installs: null,
        both: true,
        conversion: null,
        countries: {},
        rows: 0,
      };
      byKey[id] = a;
      order.push(id);
    }
    // The spelling shown is the one of the row with the most visitors.
    const weight = r.visitors ?? r.installs ?? 0;
    if (weight > a.best && r.term !== '') {
      a.best = weight;
      a.term = r.term;
    }
    a.visitors = add(a.visitors, r.visitors);
    a.installs = add(a.installs, r.installs);
    if (r.visitors === null || r.installs === null) a.both = false;
    a.conversion = r.conversion;
    if (r.country !== '') a.countries[r.country] = true;
    a.rows += 1;
  }

  const lines: SearchTermLine[] = [];
  let other: SearchTermsSummary['other'] = null;
  let totalVisitors: number | null = null;
  let totalInstalls: number | null = null;
  for (const id of order) {
    const a = byKey[id] as Acc;
    totalVisitors = add(totalVisitors, a.visitors);
    totalInstalls = add(totalInstalls, a.installs);
    if (a.key === SEARCH_TERM_OTHER_KEY) {
      other = { visitors: a.visitors, installs: a.installs };
      continue;
    }
    const derived =
      a.both && a.visitors !== null && a.installs !== null && a.visitors > 0
        ? a.installs / a.visitors
        : null;
    lines.push({
      key: a.key,
      term: a.term,
      visitors: a.visitors,
      installs: a.installs,
      conversion: derived !== null ? derived : a.rows === 1 ? a.conversion : null,
      countries: Object.keys(a.countries).sort(),
      rows: a.rows,
    });
  }
  const primary = (l: SearchTermLine) => (sort === 'installs' ? l.installs : l.visitors);
  const secondary = (l: SearchTermLine) => (sort === 'installs' ? l.visitors : l.installs);
  lines.sort((x, y) => {
    const px = primary(x) ?? -1;
    const py = primary(y) ?? -1;
    if (px !== py) return py - px;
    const sx = secondary(x) ?? -1;
    const sy = secondary(y) ?? -1;
    if (sx !== sy) return sy - sx;
    return x.term < y.term ? -1 : x.term > y.term ? 1 : 0;
  });
  return {
    from: options.from,
    to: options.to,
    terms: lines.slice(0, limit),
    termCount: lines.length,
    other,
    totals: { visitors: totalVisitors, installs: totalInstalls },
    rowsUsed: used.length,
    droppedPeriodRows,
    overlappingPeriods,
  };
}

// ---------------------------------------------------------------------------------------------
// Which terms are tracked, which are in the listing

export type TermListing = 'in_listing' | 'partly' | 'not_in_listing' | 'unknown';

export type SearchTermTrackedRef = { id: string; key: string; country: string };

export type SearchTermInsight = SearchTermLine & {
  /** The id of a tracked keyword for this term in the chosen storefront (or in any, when none is chosen). */
  trackedKeywordId: string | null;
  /** The storefronts it is tracked in. */
  trackedCountries: string[];
  listing: TermListing;
  /** The fields of the listing that hold at least one word of the term. */
  inFields: string[];
  /**
   * `add_to_listing`: the term brought installs and the stored listing text does not hold all of it. A suggestion for a person to weigh,
   * not a finding that adding it would bring more installs.
   */
  hint: 'add_to_listing' | null;
};

const listingOf = (status: FitStatus): TermListing =>
  status === 'strong' || status === 'covered'
    ? 'in_listing'
    : status === 'missing'
      ? 'not_in_listing'
      : 'partly';

/** Marks each term tracked or not and in the stored Google Play listing text or not. `fields` null: no listing text is stored (`unknown`, no hint). */
export function searchTermInsights(
  lines: readonly SearchTermLine[],
  input: {
    locale: string;
    fields: FitFields | null;
    tracked: readonly SearchTermTrackedRef[];
    country?: string;
  },
): SearchTermInsight[] {
  return lines.map((line) => {
    const mine = input.tracked.filter((t) => t.key === line.key);
    const chosen =
      input.country !== undefined && input.country !== ''
        ? mine.find((t) => t.country === input.country)
        : mine[0];
    let listing: TermListing = 'unknown';
    let inFields: string[] = [];
    if (input.fields !== null) {
      const fit = fitKeyword('android', input.locale, input.fields, {
        id: line.key,
        term: line.term,
      });
      listing = listingOf(fit.status);
      inFields = fit.where.map((w) => w.field);
    }
    const hint =
      (line.installs ?? 0) > 0 && (listing === 'not_in_listing' || listing === 'partly')
        ? ('add_to_listing' as const)
        : null;
    const countries: Record<string, true> = {};
    for (const t of mine) countries[t.country] = true;
    return {
      ...line,
      trackedKeywordId: chosen ? chosen.id : null,
      trackedCountries: Object.keys(countries).sort(),
      listing,
      inFields,
      hint,
    };
  });
}
