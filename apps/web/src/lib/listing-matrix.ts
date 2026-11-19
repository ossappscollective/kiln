import { PLATFORMS, type Platform, platformLabel, sortPlatforms } from '@mrm/core';
import type { IconName } from './icons.ts';
import { localeName, usage } from './listing-drift.ts';
import type { BadgeTone } from './portfolio.ts';
import type { DriftField, ListingDrift } from './types.ts';

/**
 * The locale grid of the Listing tab as pure functions: rows are locales, columns are listing
 * fields, and every cell is one status dot per platform in scope. The status comes from the drift
 * view (repository against the store); nothing here reads or changes a store.
 */

// ---------------------------------------------------------------------------------------------
// Cell status

/**
 * What a cell says about one field of one locale on one platform.
 * - `sync`: the repository and the store have the same value.
 * - `repo-differs`: the value in the repository differs from the store, and the store is the newer one (store ahead).
 * - `store-differs`: the value in the store differs from the repository, and the repository is the newer one (repository ahead).
 * - `diverged`: both changed, or the history cannot say which is newer.
 * - `missing`: one side has no value, or the locale has no row for a field the platform has.
 * - `over`: a value is over the store's limit (takes the place of the others: it blocks a push).
 * - `na`: not applicable: the platform has no such field, or no such locale.
 */
export type CellStatus =
  | 'sync'
  | 'repo-differs'
  | 'store-differs'
  | 'diverged'
  | 'missing'
  | 'over'
  | 'na';

export type CellInfo = { label: string; short: string; tone: BadgeTone; icon: IconName };

const INFO: Record<CellStatus, CellInfo> = {
  sync: { label: 'In sync', short: 'In sync', tone: 'ok', icon: 'check' },
  'repo-differs': {
    label: 'Differs from repo: the store is ahead',
    short: 'Differs from repo',
    tone: 'warn',
    icon: 'arrow-down',
  },
  'store-differs': {
    label: 'Differs from store: the repository is ahead',
    short: 'Differs from store',
    tone: 'info',
    icon: 'arrow-up',
  },
  diverged: {
    label: 'Differs from both: the repository and the store diverged',
    short: 'Diverged',
    tone: 'bad',
    icon: 'alert-triangle',
  },
  missing: {
    label: 'Missing: one side has no value',
    short: 'Missing',
    tone: 'neutral',
    icon: 'minus',
  },
  over: { label: 'Over the limit', short: 'Over limit', tone: 'bad', icon: 'alert' },
  na: { label: 'Not on this platform', short: 'n/a', tone: 'neutral', icon: 'minus' },
};

export const cellInfo = (status: CellStatus): CellInfo => INFO[status];

/** The statuses shown in the legend, in the order a person scans them. */
export const LEGEND_ORDER: readonly CellStatus[] = [
  'sync',
  'store-differs',
  'repo-differs',
  'diverged',
  'missing',
  'over',
];

const hasLimitError = (field: DriftField): boolean =>
  [...field.problems.repo, ...field.problems.live].some(
    (p) => p.code === 'too_long' && p.severity === 'error',
  );

/** True when either side's value is over the field's limit (counted as the store counts it). */
export function isOverLimit(field: DriftField): boolean {
  if (hasLimitError(field)) return true;
  return (
    usage(field.repo.value, field.limit, field.unit).over ||
    usage(field.live.value, field.limit, field.unit).over
  );
}

/** The one status a field shows in the grid. Over the limit wins, because it blocks a push. */
export function cellStatus(field: DriftField): CellStatus {
  if (isOverLimit(field)) return 'over';
  switch (field.status) {
    case 'identical':
      return 'sync';
    case 'store-ahead':
      return 'repo-differs';
    case 'repo-ahead':
      return 'store-differs';
    case 'diverged':
      return 'diverged';
    default:
      return 'missing';
  }
}

// ---------------------------------------------------------------------------------------------
// Columns: the fields, merged across the platforms in scope

/** A field the two stores both have under another id. The grid shows one column for it. */
const SHARED_KEY: Record<string, string> = { title: 'name', full_description: 'description' };

export const columnKey = (fieldId: string): string => SHARED_KEY[fieldId] ?? fieldId;

const COLUMN_ORDER: readonly string[] = [
  'name',
  'subtitle',
  'short_description',
  'description',
  'keywords',
  'promotional_text',
  'release_notes',
];

export type MatrixColumn = {
  key: string;
  label: string;
  /** The platforms that have this field, iOS first. */
  platforms: Platform[];
  /** The limit per platform (null: none). Shared fields can have different limits. */
  limits: Partial<Record<Platform, number | null>>;
};

export type MatrixCell = { platform: Platform; status: CellStatus; field: DriftField | null };

export type MatrixRow = {
  locale: string;
  name: string;
  /** The platforms that have this locale. */
  platforms: Platform[];
  /** One cell per platform in the grid, per column key. */
  cells: Record<string, MatrixCell[]>;
  /** The fields of the locale, by platform, in the order the API sent them. */
  fields: Partial<Record<Platform, DriftField[]>>;
  /** Number of cells per status (`na` not counted). */
  counts: Record<CellStatus, number>;
};

export type Matrix = {
  /** The platforms that have a drift view, iOS first. */
  platforms: Platform[];
  columns: MatrixColumn[];
  rows: MatrixRow[];
};

export type MatrixSource = { platform: Platform; drift: ListingDrift | null };

const platformOrder: Platform[] = [...PLATFORMS];

const emptyCounts = (): Record<CellStatus, number> => ({
  sync: 0,
  'repo-differs': 0,
  'store-differs': 0,
  diverged: 0,
  missing: 0,
  over: 0,
  na: 0,
});

const orderIndex = (key: string): number => {
  const at = COLUMN_ORDER.indexOf(key);
  return at < 0 ? COLUMN_ORDER.length : at;
};

/**
 * Builds the grid from the drift view of each platform in scope. A platform whose view is not
 * loaded yet is left out. Locales are merged by code; a locale one platform lacks is `na` there.
 */
export function buildMatrix(sources: readonly MatrixSource[]): Matrix {
  const loaded = sources
    .filter((s): s is { platform: Platform; drift: ListingDrift } => s.drift !== null)
    .sort((a, b) => platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform));
  const platforms = loaded.map((s) => s.platform);

  // Columns, in the order the fields first appear, then sorted by the canonical order (stable).
  const columns: MatrixColumn[] = [];
  const byKey = new Map<string, MatrixColumn>();
  const labels = new Map<string, string[]>();
  for (const source of loaded) {
    for (const locale of source.drift.locales) {
      for (const field of locale.fields) {
        const key = columnKey(field.field);
        let column = byKey.get(key);
        if (!column) {
          column = { key, label: field.label, platforms: [], limits: {} };
          byKey.set(key, column);
          columns.push(column);
          labels.set(key, []);
        }
        if (!column.platforms.includes(source.platform)) {
          column.platforms.push(source.platform);
          column.limits[source.platform] = field.limit;
          (labels.get(key) as string[]).push(field.label);
        }
      }
    }
  }
  for (const column of columns) {
    const names = [...new Set(labels.get(column.key) ?? [])];
    column.label = names.length > 1 ? names.join(' / ') : (names[0] ?? column.label);
  }
  const sortedColumns = columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => orderIndex(a.column.key) - orderIndex(b.column.key) || a.index - b.index)
    .map((entry) => entry.column);

  // Locales, in the order they first appear.
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const source of loaded) {
    for (const locale of source.drift.locales) {
      if (!seen.has(locale.locale)) {
        seen.add(locale.locale);
        codes.push(locale.locale);
      }
    }
  }

  const rows: MatrixRow[] = codes.map((code) => {
    const fields: Partial<Record<Platform, DriftField[]>> = {};
    for (const source of loaded) {
      const locale = source.drift.locales.find((l) => l.locale === code);
      if (locale) fields[source.platform] = locale.fields;
    }
    const counts = emptyCounts();
    const cells: Record<string, MatrixCell[]> = {};
    for (const column of sortedColumns) {
      const list: MatrixCell[] = [];
      for (const platform of platforms) {
        const own = fields[platform];
        let cell: MatrixCell;
        if (!column.platforms.includes(platform) || own === undefined) {
          cell = { platform, status: 'na', field: null };
        } else {
          const field = own.find((f) => columnKey(f.field) === column.key) ?? null;
          cell = field
            ? { platform, status: cellStatus(field), field }
            : { platform, status: 'missing', field: null };
        }
        counts[cell.status] += 1;
        list.push(cell);
      }
      cells[column.key] = list;
    }
    return {
      locale: code,
      name: localeName(code),
      platforms: platforms.filter((p) => fields[p] !== undefined),
      cells,
      fields,
      counts,
    };
  });

  return { platforms, columns: sortedColumns, rows };
}

/** "iOS only", "macOS only" or "iOS and macOS only" for a column that fewer than the shown platforms have; null otherwise. */
export function columnScopeNote(
  column: Pick<MatrixColumn, 'platforms'>,
  shown: readonly Platform[],
): string | null {
  if (shown.length < 2 || column.platforms.length === 0 || column.platforms.length >= shown.length)
    return null;
  return `${sortPlatforms(column.platforms).map(platformLabel).join(' and ')} only`;
}

/** "30 characters" or "iOS 4000 / Android 500 characters" for the limit line of a column header. */
export function limitText(column: Pick<MatrixColumn, 'limits' | 'platforms'>): string {
  const parts: { platform: Platform; limit: number }[] = [];
  for (const platform of column.platforms) {
    const limit = column.limits[platform];
    if (typeof limit === 'number') parts.push({ platform, limit });
  }
  if (parts.length === 0) return '';
  const first = parts[0] as { limit: number };
  if (parts.every((p) => p.limit === first.limit)) return `max ${first.limit}`;
  return parts.map((p) => `${platformLabel(p.platform)} ${p.limit}`).join(' / ');
}

// ---------------------------------------------------------------------------------------------
// Filters: one click on a chip, plus a search

export type MatrixMode = 'all' | 'differing' | 'missing' | 'over';

export type MatrixFilter = { mode: MatrixMode; query: string };

export const defaultMatrixFilter = (): MatrixFilter => ({ mode: 'all', query: '' });

export const MODE_LABELS: Record<MatrixMode, string> = {
  all: 'All locales',
  differing: 'Needs attention',
  missing: 'Missing only',
  over: 'Over limit',
};

export const MODE_ORDER: readonly MatrixMode[] = ['all', 'differing', 'missing', 'over'];

/** True when the cell is one the mode is about (a cell that is not stays dimmed in the grid). */
export function cellMatchesMode(status: CellStatus, mode: MatrixMode): boolean {
  if (status === 'na') return false;
  switch (mode) {
    case 'all':
      return true;
    case 'differing':
      return status !== 'sync';
    case 'missing':
      return status === 'missing';
    case 'over':
      return status === 'over';
  }
}

/** True when the locale has at least one cell the mode is about. */
export function rowMatchesMode(row: Pick<MatrixRow, 'counts'>, mode: MatrixMode): boolean {
  switch (mode) {
    case 'all':
      return true;
    case 'differing':
      return (
        row.counts['repo-differs'] +
          row.counts['store-differs'] +
          row.counts.diverged +
          row.counts.missing +
          row.counts.over >
        0
      );
    case 'missing':
      return row.counts.missing > 0;
    case 'over':
      return row.counts.over > 0;
  }
}

/** The locales that remain: the mode first, then a search over the code and the language name. */
export function filterRows(rows: readonly MatrixRow[], filter: MatrixFilter): MatrixRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!rowMatchesMode(row, filter.mode)) return false;
    if (query === '') return true;
    return row.locale.toLowerCase().includes(query) || row.name.toLowerCase().includes(query);
  });
}

/** How many locales each chip would show, for the counts on the chips. */
export function modeCounts(rows: readonly MatrixRow[]): Record<MatrixMode, number> {
  const out: Record<MatrixMode, number> = { all: rows.length, differing: 0, missing: 0, over: 0 };
  for (const row of rows) {
    if (rowMatchesMode(row, 'differing')) out.differing += 1;
    if (rowMatchesMode(row, 'missing')) out.missing += 1;
    if (rowMatchesMode(row, 'over')) out.over += 1;
  }
  return out;
}

/** "12 locales, 3 need attention, 2 with missing fields". */
export function matrixSummary(rows: readonly MatrixRow[]): string {
  if (rows.length === 0) return 'No locales yet';
  const counts = modeCounts(rows);
  const parts = [`${rows.length} ${rows.length === 1 ? 'locale' : 'locales'}`];
  if (counts.differing === 0) parts.push('all in sync');
  else parts.push(`${counts.differing} ${counts.differing === 1 ? 'needs' : 'need'} attention`);
  if (counts.missing > 0) parts.push(`${counts.missing} with missing fields`);
  if (counts.over > 0) parts.push(`${counts.over} over a limit`);
  return parts.join(', ');
}

export type ListingStatusLine = {
  /** `ok` all in sync, `warn` something needs attention, `info` nothing to say yet. */
  tone: 'ok' | 'warn' | 'info';
  text: string;
  /** How many locales "needs attention" covers (the button that filters by it is offered when this is above zero). */
  attention: number;
};

/**
 * The one status line above the grid: "3 locales need attention, 1 with missing fields". The count of locales and the platforms are
 * the context line (`listingContext`), not repeated here.
 */
export function listingStatusLine(rows: readonly MatrixRow[]): ListingStatusLine {
  if (rows.length === 0)
    return { tone: 'info', text: 'No listing values to compare yet', attention: 0 };
  const counts = modeCounts(rows);
  if (counts.differing === 0)
    return {
      tone: 'ok',
      text: rows.length === 1 ? 'The locale is in sync' : 'All locales are in sync',
      attention: 0,
    };
  const parts = [
    `${counts.differing} ${counts.differing === 1 ? 'locale needs' : 'locales need'} attention`,
  ];
  if (counts.missing > 0) parts.push(`${counts.missing} with missing fields`);
  if (counts.over > 0) parts.push(`${counts.over} over a limit`);
  return { tone: 'warn', text: parts.join(', '), attention: counts.differing };
}

/** "iOS and Android, 12 locales": the stores in scope and how many locales the grid holds. */
export function listingContext(platforms: readonly Platform[], localeCount: number): string {
  const stores = platforms.map(platformLabel).join(' and ');
  const locales = `${localeCount} ${localeCount === 1 ? 'locale' : 'locales'}`;
  return stores === '' ? locales : `${stores}, ${locales}`;
}

/** The words for one cell, for a tooltip and for assistive technology: "iOS, Name: Differs from repo". */
export function cellText(
  column: Pick<MatrixColumn, 'label'>,
  cell: Pick<MatrixCell, 'platform' | 'status'>,
  withPlatform: boolean,
): string {
  const platform = platformLabel(cell.platform);
  const text = `${column.label}: ${INFO[cell.status].label}`;
  return withPlatform ? `${platform}, ${text}` : text;
}

/** "iOS: In sync; Android: Differs from store: the repository is ahead", without the stores that do not have the field. */
export function cellsSummary(
  cells: readonly Pick<MatrixCell, 'platform' | 'status'>[],
  withPlatform: boolean,
): string {
  const live = cells.filter((c) => c.status !== 'na');
  if (live.length === 0) return INFO.na.label;
  return live
    .map((c) =>
      withPlatform ? `${platformLabel(c.platform)}: ${INFO[c.status].label}` : INFO[c.status].label,
    )
    .join('; ');
}
