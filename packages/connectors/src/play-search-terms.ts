import {
  analyticsLimits,
  daysBetween,
  isIsoDate,
  readSearchTerm,
  SEARCH_TERM_OTHER_KEY,
  type SearchTermPoint,
  searchTermLimits,
} from '@mrm/core';
import { AnalyticsError, type ParseStats } from './analytics-types.ts';
import {
  columnIndex,
  decodeTableText,
  isGzip,
  normalizeHeader,
  openFileBytes,
  parseTable,
  readTable,
  type Table,
} from './delimited.ts';
import { isZip, readZipEntries } from './zip.ts';

/**
 * Reads a Google Play search terms export a person uploaded (docs/research/play-search-terms.md): the CSV of "Export report" on a
 * store listing page of Play Console, a monthly `store_performance` file of the Cloud Storage bucket, or a .zip (or .gz) of such files.
 *
 * What is known and what is not: Google documents the columns of the Cloud Storage `traffic_source` file (Date, Package name, Traffic
 * source, Search term, UTM source, UTM campaign, Store listing acquisitions, Store listing visitors, Store listing conversion rate). The
 * columns of the console's own export, its encoding, whether it is one file or a zip, whether it has a date column, and the headers in
 * other console languages are UNVERIFIED. So the reader is strict about what it stores and tolerant about how the file names things:
 * - Columns are matched BY NAME (normalised: case, punctuation and spacing ignored; a list of synonyms, then a phrase match), never by
 *   position, so a renamed or added column does not break it. A file without a term column and at least one of visitors and installs is
 *   `missing_columns`.
 * - A file with no date column covers the period the person gives (`period_required` without it); `Start date` and `End date` columns
 *   give each row its own period.
 * - Only Google Play search traffic is kept when the file has a traffic source column. `Other` (terms Google grouped) is kept as its own
 *   line, never as a term. A country that is not two letters is stored as "not split".
 * - UTF-8 and UTF-16, tab, comma or semicolon, quoted cells, and the numbers `1,234`, `1.234`, `1 234`, `12.5%`, `12,5 %` are accepted.
 * - Every step has a cap (the file, the unpacked text, the entries, the rows), and a failure is an `AnalyticsError` with a fixed code.
 * Nothing here logs or returns a cell of the file except as the numbers and normalised terms of the points.
 */

const TERM = [
  'search term',
  'search terms',
  'search query',
  'search queries',
  'query',
  'queries',
  'term',
  'terms',
  'keyword',
  'keywords',
];
const VISITORS = [
  'store listing visitors',
  'listing visitors',
  'store visitors',
  'unique visitors',
  'visitors',
];
const INSTALLS = [
  'store listing acquisitions',
  'listing acquisitions',
  'acquisitions',
  'store listing installs',
  'installs',
  'first time installers',
  'new installers',
];
const CONVERSION = [
  'store listing conversion rate',
  'listing conversion rate',
  'conversion rate',
  'conversion',
];
const DAY = ['date', 'day'];
const START = ['start date', 'period start', 'from date', 'from'];
const END = ['end date', 'period end', 'to date', 'to'];
const COUNTRY = ['country region', 'country or region', 'country', 'region', 'territory'];
const SOURCE = ['traffic source', 'source', 'traffic'];

type Cols = Map<string, number>;

/** The first synonym that is a column, else the first column whose name contains one of the phrases. */
function find(cols: Cols, exact: string[], contains: string[] = []): number | undefined {
  for (const name of exact) {
    const i = cols.get(name);
    if (i !== undefined) return i;
  }
  for (const [key, i] of cols) if (contains.some((c) => key.indexOf(c) >= 0)) return i;
  return undefined;
}

type Mapping = {
  term: number;
  visitors?: number;
  installs?: number;
  conversion?: number;
  day?: number;
  start?: number;
  end?: number;
  country?: number;
  source?: number;
};

/** The columns of a table, or undefined when it is not a search terms table. */
export function mapSearchTermColumns(header: string[]): Mapping | undefined {
  const cols = columnIndex(header);
  const term = find(cols, TERM, ['search term']);
  if (term === undefined) return undefined;
  const visitors = find(cols, VISITORS, ['visitors']);
  const installs = find(cols, INSTALLS, ['acquisition']);
  const conversion = find(cols, CONVERSION, ['conversion']);
  if (visitors === undefined && installs === undefined && conversion === undefined)
    return undefined;
  const map: Mapping = { term };
  if (visitors !== undefined) map.visitors = visitors;
  if (installs !== undefined) map.installs = installs;
  if (conversion !== undefined) map.conversion = conversion;
  const day = find(cols, DAY);
  const start = find(cols, START);
  const end = find(cols, END);
  const country = find(cols, COUNTRY);
  const source = find(cols, SOURCE);
  if (day !== undefined) map.day = day;
  if (start !== undefined && end !== undefined) {
    map.start = start;
    map.end = end;
  }
  if (country !== undefined) map.country = country;
  if (source !== undefined) map.source = source;
  return map;
}

/** A day as Play or a spreadsheet writes it: 2026-11-03, 2026/11/03, 03.11.2026, and a slash date only when it cannot be read two ways. */
export function parseSearchDay(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  let hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T ])/.exec(v);
  if (hit) {
    y = Number(hit[1]);
    m = Number(hit[2]);
    d = Number(hit[3]);
  } else if ((hit = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v))) {
    d = Number(hit[1]);
    m = Number(hit[2]);
    y = Number(hit[3]);
  } else if ((hit = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v))) {
    const a = Number(hit[1]);
    const b = Number(hit[2]);
    y = Number(hit[3]);
    if (a > 12 && b <= 12) {
      d = a;
      m = b;
    } else if (b > 12 && a <= 12) {
      m = a;
      d = b;
    } else return undefined; // 03/04/2026 is March or April: not guessed
  } else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return undefined;
  return date.toISOString().slice(0, 10);
}

const NO_BREAK = /[   ]/g;

/** A count: `1234`, `1,234`, `1.234`, `1 234`; a plain decimal is accepted as it is. Anything else is undefined. */
export function parseCountCell(raw: string): number | null | undefined {
  const v = raw.replace(NO_BREAK, ' ').trim();
  if (v === '' || v === '-' || v === '–') return null;
  if (/^\d{1,3}([,. ]\d{3})+$/.test(v)) return Number(v.replace(/[,. ]/g, ''));
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d+[.,]\d+$/.test(v)) return Number(v.replace(',', '.'));
  return undefined;
}

/** A conversion rate as a ratio from 0 to 1: `12.5%`, `12,5 %` and `0.125` (a bare number above 1 is read as a percent). */
export function parseRatioCell(raw: string): number | null | undefined {
  const v = raw.replace(NO_BREAK, ' ').trim();
  if (v === '' || v === '-' || v === '–') return null;
  const percent = /%$/.test(v);
  const body = v.replace(/%$/, '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(body)) return undefined;
  const n = Number(body);
  if (!Number.isFinite(n)) return undefined;
  const ratio = percent || n > 1 ? n / 100 : n;
  return ratio >= 0 && ratio <= 1 ? Math.round(ratio * 1e6) / 1e6 : undefined;
}

const isOther = (cell: string) => /^\(?other\)?$/i.test(cell.trim());
const isSearchSource = (cell: string) => normalizeHeader(cell).indexOf('search') >= 0;

export type SearchTermStats = ParseStats & {
  /** Rows of the `Other` line (terms Google grouped). */
  rowsOther: number;
};

export type SearchTermsFile = {
  points: SearchTermPoint[];
  stats: SearchTermStats;
  dateFrom: string | null;
  dateTo: string | null;
  /** The file had a date (or start and end) column; else the period came from the person. */
  hasDates: boolean;
  hasCountry: boolean;
  hasConversion: boolean;
  /** Distinct terms (without `Other`), and the countries (two letters) seen. */
  terms: number;
  countries: string[];
  /** Files read (a zip may hold several). */
  files: number;
  notes: string[];
};

export type SearchTermsReadOptions = {
  /** The period of a file with no date column (YYYY-MM-DD). */
  from?: string;
  to?: string;
};

/** Checks a period the person gave: both dates, in order, not longer than `maxPeriodDays`. */
export function checkPeriod(
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string } | undefined {
  if (from === undefined || to === undefined || !isIsoDate(from) || !isIsoDate(to) || from > to)
    return undefined;
  return daysBetween(from, to) + 1 <= searchTermLimits.maxPeriodDays ? { from, to } : undefined;
}

type Acc = SearchTermPoint;

function mapTable(
  table: Table,
  map: Mapping,
  period: { from: string; to: string } | undefined,
  into: Map<string, Acc>,
  stats: SearchTermStats,
  seen: { countriesUnknown: number; sourcesLeft: number },
): void {
  const cell = (row: string[], i: number | undefined): string =>
    i === undefined ? '' : (row[i] ?? '');
  for (const row of table.rows) {
    stats.rowsRead += 1;
    if (map.source !== undefined) {
      const s = cell(row, map.source).trim();
      if (s !== '' && !isSearchSource(s)) {
        stats.rowsFiltered += 1;
        seen.sourcesLeft += 1;
        continue;
      }
    }
    const rawTerm = cell(row, map.term).trim();
    if (rawTerm === '') {
      stats.rowsFiltered += 1;
      continue;
    }
    let term = '';
    let key = SEARCH_TERM_OTHER_KEY;
    const other = isOther(rawTerm);
    if (!other) {
      const read = readSearchTerm(rawTerm);
      if (!read) {
        stats.rowsUnreadable += 1;
        continue;
      }
      term = read.term;
      key = read.key;
    }

    let from: string | undefined;
    let to: string | undefined;
    if (map.day !== undefined) {
      from = parseSearchDay(cell(row, map.day));
      to = from;
    } else if (map.start !== undefined && map.end !== undefined) {
      from = parseSearchDay(cell(row, map.start));
      to = parseSearchDay(cell(row, map.end));
    } else if (period) {
      from = period.from;
      to = period.to;
    }
    if (
      from === undefined ||
      to === undefined ||
      from > to ||
      daysBetween(from, to) + 1 > searchTermLimits.maxPeriodDays
    ) {
      stats.rowsUnreadable += 1;
      continue;
    }

    const visitors = map.visitors === undefined ? null : parseCountCell(cell(row, map.visitors));
    const installs = map.installs === undefined ? null : parseCountCell(cell(row, map.installs));
    const conversion =
      map.conversion === undefined ? null : parseRatioCell(cell(row, map.conversion));
    if (
      visitors === undefined ||
      installs === undefined ||
      conversion === undefined ||
      (visitors === null && installs === null && conversion === null)
    ) {
      stats.rowsUnreadable += 1;
      continue;
    }

    let country = '';
    if (map.country !== undefined) {
      const c = cell(row, map.country).trim();
      if (/^[A-Za-z]{2}$/.test(c)) country = c.toLowerCase();
      else if (c !== '') seen.countriesUnknown += 1;
    }

    stats.rowsUsed += 1;
    if (other) stats.rowsOther += 1;
    const id = `${country}\u0000${from}\u0000${to}\u0000${key}`;
    const have = into.get(id);
    if (!have) {
      into.set(id, { country, from, to, term, key, visitors, installs, conversion });
    } else {
      // The same term, day and storefront twice in a file (another breakdown of the same traffic): the counts add up.
      have.visitors =
        have.visitors === null
          ? visitors
          : visitors === null
            ? have.visitors
            : have.visitors + visitors;
      have.installs =
        have.installs === null
          ? installs
          : installs === null
            ? have.installs
            : have.installs + installs;
      have.conversion = null;
    }
  }
}

/** Entries of an archive that can hold a table. */
const wantsEntry = (name: string) =>
  /\.(csv|tsv|txt)$/i.test(name) && name.indexOf('__MACOSX') < 0 && !/(^|\/)\./.test(name);

/**
 * Reads the bytes of an uploaded file: a .zip of tables, a .gz, or a plain table. Throws an `AnalyticsError`: `file_too_large`, `bad_gzip`,
 * `bad_zip`, `bad_format`, `missing_columns` (no table has a term column and a number column), `period_required`, `no_rows`.
 */
export async function readSearchTermsFile(
  bytes: Uint8Array,
  options: SearchTermsReadOptions = {},
): Promise<SearchTermsFile> {
  const limits = {
    maxFileBytes: analyticsLimits.maxFileBytes,
    maxTextBytes: analyticsLimits.maxTextBytes,
    maxRows: analyticsLimits.maxRows,
  };
  if (bytes.length > limits.maxFileBytes) throw new AnalyticsError('file_too_large');
  const tables: Table[] = [];
  if (isZip(bytes)) {
    const entries = await readZipEntries(bytes, wantsEntry, {
      maxEntryBytes: limits.maxTextBytes,
      maxTotalBytes: limits.maxTextBytes,
    });
    if (entries.length === 0) throw new AnalyticsError('bad_zip');
    for (const e of entries)
      tables.push(
        parseTable(
          decodeTableText(isGzip(e.bytes) ? await openFileBytes(e.bytes, limits) : e.bytes),
          limits,
        ),
      );
  } else {
    tables.push(await readTable(bytes, limits));
  }

  const into = new Map<string, Acc>();
  const stats: SearchTermStats = {
    rowsRead: 0,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
    rowsOther: 0,
  };
  const seen = { countriesUnknown: 0, sourcesLeft: 0 };
  const period = checkPeriod(options.from, options.to);
  let files = 0;
  let skipped = 0;
  let hasDates = false;
  let hasCountry = false;
  let hasConversion = false;
  let needsPeriod = false;
  for (const table of tables) {
    const map = mapSearchTermColumns(table.header);
    if (!map) {
      skipped += 1;
      continue;
    }
    files += 1;
    const dated = map.day !== undefined || (map.start !== undefined && map.end !== undefined);
    if (dated) hasDates = true;
    else needsPeriod = true;
    if (map.country !== undefined) hasCountry = true;
    if (map.conversion !== undefined) hasConversion = true;
    mapTable(table, map, period, into, stats, seen);
    if (into.size > searchTermLimits.maxRowsPerImport) throw new AnalyticsError('file_too_large');
  }
  if (files === 0) throw new AnalyticsError('missing_columns');
  if (needsPeriod && !period) throw new AnalyticsError('period_required');
  if (into.size === 0) throw new AnalyticsError('no_rows');

  const points = [...into.values()].sort((a, b) =>
    a.from !== b.from
      ? a.from < b.from
        ? -1
        : 1
      : a.to !== b.to
        ? a.to < b.to
          ? -1
          : 1
        : a.country !== b.country
          ? a.country < b.country
            ? -1
            : 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
  );
  let dateFrom = points[0]?.from ?? null;
  let dateTo = points[0]?.to ?? null;
  const terms = new Set<string>();
  const countries = new Set<string>();
  for (const p of points) {
    if (dateFrom === null || p.from < dateFrom) dateFrom = p.from;
    if (dateTo === null || p.to > dateTo) dateTo = p.to;
    if (p.key !== SEARCH_TERM_OTHER_KEY) terms.add(p.key);
    if (p.country !== '') countries.add(p.country);
  }

  const notes: string[] = [];
  if (!hasDates && period)
    notes.push(
      `The file has no date column. All of its numbers are stored for the period you gave, ${period.from} to ${period.to}.`,
    );
  if (hasDates && needsPeriod && period)
    notes.push(
      'One of the files has no date column; its numbers are stored for the period you gave.',
    );
  if (seen.sourcesLeft > 0)
    notes.push(
      `${seen.sourcesLeft} rows were left out because their traffic source is not Google Play search.`,
    );
  if (seen.countriesUnknown > 0)
    notes.push(
      `${seen.countriesUnknown} rows have a country that is not a two letter code; they are stored as "not split by country".`,
    );
  if (!hasCountry)
    notes.push('The file has no country column: the terms are not split by country.');
  if (stats.rowsOther > 0)
    notes.push(
      'The file has an "Other" line: Google groups terms that were too small to report on their own.',
    );
  if (skipped > 0)
    notes.push(`${skipped} files in the archive have no search term table and were skipped.`);
  if (hasConversion)
    notes.push(
      'A conversion rate in the file is kept as it was given; the view works it out from installs and visitors when it can.',
    );

  return {
    points,
    stats,
    dateFrom,
    dateTo,
    hasDates,
    hasCountry,
    hasConversion,
    terms: terms.size,
    countries: [...countries].sort(),
    files,
    notes,
  };
}
