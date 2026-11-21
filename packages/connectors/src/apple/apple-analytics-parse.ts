import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  type AnalyticsSource,
  analyticsLimits,
  productDimValue,
} from '@mrm/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import { columnIndex, normalizeHeader, parseDay, parseNumber, type Table } from '../delimited.ts';

/**
 * Maps the files Apple produces to normalised daily facts. Two inputs share this code: the segments of the Analytics Reports API
 * (downloaded by `AppleAnalyticsConnector`) and a file a person uploads (downloaded from App Store Connect or exported by their
 * own script). Both are read BY HEADER NAME, never by position (Apple may add or move columns).
 *
 * What is known and what is not (docs/research/analytics-apis.md, section 2.1):
 * - The report names and the columns below are the ones Apple's documentation lists. The delimiter (tab or comma), the date
 *   format, the exact wording of the cell values (`First-time Download`, `Page view`, the Device strings) and the time zone of
 *   the Date column are UNVERIFIED: the parser accepts the likely variants and counts a value it does not know as filtered.
 * - Standard and Detailed variants exist. They map to the same metrics. Detailed drops rows under 5 users and adds noise; the
 *   variant is returned so the preview can say so.
 * - Only Counts (additive) are stored. Unique Counts are not additive across rows, so they are never summed.
 * - Weekly and monthly files carry the first day of the period in the Date column: only DAILY files are meant to be read here.
 */

export const appleReportKinds = [
  'discovery_engagement',
  'downloads',
  'sessions',
  'crashes',
] as const;
export type AppleReportKind = (typeof appleReportKinds)[number];

export type AppleReportVariant = 'standard' | 'detailed' | 'unknown';

/** Apple's report names the API listing is matched against (case and spacing ignored), and what each maps to. */
export const appleReportLabels: Record<AppleReportKind, string> = {
  discovery_engagement: 'App Store Discovery and Engagement',
  downloads: 'App Store Downloads',
  sessions: 'App Sessions',
  crashes: 'App Crashes',
};

/** The source every Apple analytics report belongs to. */
export const APPLE_ANALYTICS_SOURCE: AnalyticsSource = 'apple_analytics';

/** What a report name says it is, or undefined when it is not one of the four this server reads. */
export function appleReportKindFromName(name: string): AppleReportKind | undefined {
  const n = normalizeHeader(name);
  if (n.includes('discovery and engagement')) return 'discovery_engagement';
  if (n.includes('app store downloads') || n === 'downloads') return 'downloads';
  // `App Sessions Context` and the like are other reports.
  if (n.includes('app sessions') && !n.includes('context')) return 'sessions';
  // `App Crashes Expanded` (PERFORMANCE category) has other columns and is iOS and iPadOS only.
  if (n.includes('app crashes') && !n.includes('expanded')) return 'crashes';
  return undefined;
}

export function appleReportVariant(name: string): AppleReportVariant {
  const n = normalizeHeader(name);
  if (/\bdetailed\b/.test(n)) return 'detailed';
  if (/\bstandard\b/.test(n)) return 'standard';
  return 'unknown';
}

/** The report of a table, from its header alone. Used when a file name does not say. */
export function appleReportKindFromHeader(header: string[]): AppleReportKind | undefined {
  const cols = columnIndex(header);
  if (cols.has('download type') && cols.has('counts')) return 'downloads';
  if (
    cols.has('event') &&
    cols.has('counts') &&
    (cols.has('page type') || cols.has('engagement type') || cols.has('source type'))
  ) {
    return 'discovery_engagement';
  }
  if (cols.has('sessions') && (cols.has('total session duration') || cols.has('unique devices')))
    return 'sessions';
  if (cols.has('crashes') && cols.has('date')) return 'crashes';
  return undefined;
}

/** The columns each report needs. A table without one is `missing_columns`. */
const required: Record<AppleReportKind, string[]> = {
  discovery_engagement: ['date', 'event', 'counts'],
  downloads: ['date', 'download type', 'counts'],
  sessions: ['date', 'sessions'],
  crashes: ['date', 'crashes'],
};

export type ParsedAppleReport = {
  kind: AppleReportKind;
  variant: AppleReportVariant;
  source: AnalyticsSource;
  points: AnalyticsPoint[];
  stats: ParseStats;
  /** First and last date seen in the used rows, or null. */
  dateFrom: string | null;
  dateTo: string | null;
  /** Distinct dates in the points. */
  dates: number;
  /** Sentences the preview shows (never a cell value). */
  notes: string[];
};

export type ParseAppleOptions = {
  /** The report name, from the API listing or the file name. Without it the header decides. */
  reportName?: string;
  /** The app record's platform: a macOS record keeps the Mac rows of the Device column, an iOS record the others. */
  platform?: 'ios' | 'macos';
};

const isMac = (device: string) => /\b(mac|macos|desktop)\b/i.test(device);

type Acc = Map<string, AnalyticsPoint>;

function add(
  acc: Acc,
  date: string,
  metric: AnalyticsMetric,
  value: number,
  dimension?: { type: AnalyticsDimension; value: string },
) {
  const dimKey = dimension ? `${dimension.type}\u0000${dimension.value}` : '';
  const key = `${date}\u0000${metric}\u0000${dimKey}`;
  const found = acc.get(key);
  if (found) found.value += value;
  else acc.set(key, { date, metric, value, ...(dimension ? { dimension } : {}) });
}

const clip = (v: string) => v.trim().slice(0, analyticsLimits.maxDimensionLength);

/**
 * Reads one Apple analytics table into points. Throws `AnalyticsError`: `unknown_report` (the report is not one of the four, or
 * the name and the header disagree), `missing_columns`. A file whose rows all fail is `no_rows`, not an empty success.
 */
export function mapAppleTable(table: Table, options: ParseAppleOptions = {}): ParsedAppleReport {
  const named = options.reportName ? appleReportKindFromName(options.reportName) : undefined;
  const kind = named ?? appleReportKindFromHeader(table.header);
  if (!kind) throw new AnalyticsError('unknown_report');
  const cols = columnIndex(table.header);
  for (const name of required[kind])
    if (!cols.has(name)) throw new AnalyticsError('missing_columns');

  const at = (row: string[], name: string): string | undefined => {
    const i = cols.get(name);
    return i === undefined ? undefined : row[i];
  };
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const acc: Acc = new Map();
  const notes: string[] = [];
  const hasDevice = cols.has('device');
  const platform = options.platform;
  let noPageType = false;

  for (const row of table.rows) {
    const date = parseDay(at(row, 'date'));
    if (!date) {
      stats.rowsUnreadable++;
      continue;
    }
    if (hasDevice && platform) {
      const device = at(row, 'device') ?? '';
      if (device !== '' && isMac(device) !== (platform === 'macos')) {
        stats.rowsFiltered++;
        continue;
      }
    }
    const sourceType = clip(at(row, 'source type') ?? '');
    const territory = clip(at(row, 'territory') ?? '');
    const version = clip(at(row, 'app version') ?? '');
    const split = (
      metric: AnalyticsMetric,
      value: number,
      by: ('source_type' | 'territory' | 'app_version')[],
    ) => {
      add(acc, date, metric, value);
      for (const type of by) {
        const v = type === 'source_type' ? sourceType : type === 'territory' ? territory : version;
        if (v !== '') add(acc, date, metric, value, { type, value: v });
      }
    };

    if (kind === 'discovery_engagement') {
      const count = parseNumber(at(row, 'counts'));
      if (count === undefined) {
        stats.rowsUnreadable++;
        continue;
      }
      const event = normalizeHeader(at(row, 'event') ?? '');
      if (event === 'impression' || event === 'impressions') {
        split('impressions', count, ['source_type']);
        stats.rowsUsed++;
      } else if (event === 'page view' || event === 'page views') {
        // Page Type also names pages that are not the product page; only the product page counts.
        const pageType = normalizeHeader(at(row, 'page type') ?? '');
        if (!cols.has('page type')) noPageType = true;
        if (cols.has('page type') && !pageType.includes('product page')) {
          stats.rowsFiltered++;
          continue;
        }
        split('product_page_views', count, ['source_type']);
        stats.rowsUsed++;
      } else {
        // Taps and other events are not part of the MVP charts.
        stats.rowsFiltered++;
      }
    } else if (kind === 'downloads') {
      const count = parseNumber(at(row, 'counts'));
      if (count === undefined) {
        stats.rowsUnreadable++;
        continue;
      }
      // Updates, restores and the like are download types too; only first-time downloads and redownloads count as downloads.
      const type = normalizeHeader(at(row, 'download type') ?? '');
      if (type.startsWith('first time')) {
        split('downloads_first_time', count, ['source_type', 'territory']);
        stats.rowsUsed++;
      } else if (type.startsWith('redownload')) {
        split('downloads_redownload', count, ['source_type', 'territory']);
        stats.rowsUsed++;
      } else stats.rowsFiltered++;
    } else if (kind === 'sessions') {
      const count = parseNumber(at(row, 'sessions'));
      if (count === undefined) {
        stats.rowsUnreadable++;
        continue;
      }
      split('sessions', count, ['app_version']);
      stats.rowsUsed++;
    } else {
      const count = parseNumber(at(row, 'crashes'));
      if (count === undefined) {
        stats.rowsUnreadable++;
        continue;
      }
      split('crashes', count, ['app_version']);
      stats.rowsUsed++;
    }
  }

  if (stats.rowsUsed === 0) throw new AnalyticsError('no_rows');
  const points = [...acc.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.metric.localeCompare(b.metric) ||
      (a.dimension?.type ?? '').localeCompare(b.dimension?.type ?? '') ||
      (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
  );
  const dates = [...new Set(points.map((p) => p.date))].sort();
  const variant = options.reportName ? appleReportVariant(options.reportName) : 'unknown';
  if (variant === 'detailed') {
    notes.push(
      'This is a Detailed report: Apple drops rows with fewer than 5 users and adds small random noise to its counts.',
    );
  }
  if (kind === 'sessions' || kind === 'crashes') {
    notes.push(
      'Sessions and crashes cover only users who chose to share data with developers: a sample, not a total.',
    );
  }
  if (noPageType)
    notes.push(
      'The file has no Page Type column, so every page view was counted, not only product page views.',
    );
  if (hasDevice && !platform)
    notes.push('Rows of every device were kept because no platform was given.');
  return {
    kind,
    variant,
    source: APPLE_ANALYTICS_SOURCE,
    points,
    stats,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    dates: dates.length,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Sales and Trends (`GET /v1/salesReports`, SALES / SUMMARY / DAILY, version 1_0)

export type ParsedAppleSales = {
  source: 'apple_sales';
  points: AnalyticsPoint[];
  stats: ParseStats;
  dateFrom: string | null;
  dateTo: string | null;
  dates: number;
  notes: string[];
};

/**
 * Product type identifiers that are NOT a purchase or download of the app itself: updates (`7`, `7F`, `7T`, `F7`) and in-app
 * purchases (`IA...`). The full list of identifiers is UNVERIFIED here; anything else with the app's Apple Identifier counts.
 */
const notAnApp = (productType: string) =>
  /^(7|7F|7T|F7|IA[0-9A-Z]*|FI[0-9A-Z]*)$/i.test(productType);

/** In-app purchases and subscriptions (Apple's table of product type identifiers: IA1, IA3, IA9, IAY, FI1 and their `-M` forms). */
const isInApp = (productType: string) => /^(IA[0-9A-Z]*|FI[0-9A-Z]*)(-M)?$/i.test(productType);
/** App updates: not a sale, but their SKU is the app's own SKU. */
const isUpdate = (productType: string) => /^(7|7F|7T|F7)$/i.test(productType);

/**
 * Reads a Sales and Trends daily summary for ONE app (`appleId` is its numeric App Store id). Units are negative for refunds, and
 * proceeds are `units * Developer Proceeds` in the `Currency of Proceeds` of the row (never converted). Rows of other apps, updates
 * and in-app purchases are left out. A report without a row for the app is not an error: it has no points.
 */
export function mapAppleSalesTable(
  table: Table,
  options: {
    appleId: string;
    platform?: 'ios' | 'macos';
    /**
     * SKUs of the app's in-app products as the Products page has them. An in-app row is matched to the app when its `Parent
     * Identifier` (the SKU of the app, per Apple's field table) is one of the app's own SKUs read from the same report, or when
     * its `SKU` is in this set. UNVERIFIED: that the SKU of an in-app row is the product id of the store product.
     */
    knownSkus?: ReadonlySet<string> | undefined;
  },
): ParsedAppleSales {
  const cols = columnIndex(table.header);
  for (const name of ['units', 'developer proceeds', 'apple identifier', 'begin date']) {
    if (!cols.has(name)) throw new AnalyticsError('missing_columns');
  }
  const at = (row: string[], name: string): string | undefined => {
    const i = cols.get(name);
    return i === undefined ? undefined : row[i];
  };
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const acc: Acc = new Map();
  // The app's own SKU(s): rows of the app (and its updates) carry its Apple Identifier. In-app rows name it as `Parent Identifier`.
  const appSkus = new Set<string>();
  for (const row of table.rows) {
    if ((at(row, 'apple identifier') ?? '').trim() !== options.appleId) continue;
    const type = (at(row, 'product type identifier') ?? '').trim();
    const sku = (at(row, 'sku') ?? '').trim();
    if (sku !== '' && !isInApp(type)) appSkus.add(sku);
  }
  for (const row of table.rows) {
    const date = parseDay(at(row, 'begin date'));
    const units = parseNumber(at(row, 'units'));
    const each = parseNumber(at(row, 'developer proceeds'));
    if (!date || units === undefined) {
      stats.rowsUnreadable++;
      continue;
    }
    const type = (at(row, 'product type identifier') ?? '').trim();
    const sku = (at(row, 'sku') ?? '').trim();
    const own = (at(row, 'apple identifier') ?? '').trim() === options.appleId;
    // An in-app row belongs to the app by its parent SKU or its own SKU; it feeds the per-product numbers only.
    const inApp =
      isInApp(type) &&
      (own ||
        appSkus.has((at(row, 'parent identifier') ?? '').trim()) ||
        (sku !== '' && options.knownSkus?.has(sku) === true));
    if (!inApp && (!own || (type !== '' && notAnApp(type)))) {
      stats.rowsFiltered++;
      continue;
    }
    const device = at(row, 'device') ?? '';
    if (options.platform && device !== '' && isMac(device) !== (options.platform === 'macos')) {
      stats.rowsFiltered++;
      continue;
    }
    const country = clip(at(row, 'country code') ?? '');
    const currency = clip(at(row, 'currency of proceeds') ?? '');
    if (!inApp) {
      add(acc, date, 'sales_units', units);
      if (country !== '')
        add(acc, date, 'sales_units', units, { type: 'territory', value: country });
      if (each !== undefined && currency !== '') {
        add(acc, date, 'sales_proceeds', units * each, { type: 'currency', value: currency });
      }
    }
    // Per product (SKU), the same facts under the `product` dimension; the currency is part of the key of a money value.
    const productId = productDimValue(sku, null);
    if (productId && !isUpdate(type)) {
      add(acc, date, 'sales_units', units, { type: 'product', value: productId });
      const byCurrency = each !== undefined ? productDimValue(sku, currency) : undefined;
      if (byCurrency && each !== undefined)
        add(acc, date, 'sales_proceeds', units * each, { type: 'product', value: byCurrency });
    }
    stats.rowsUsed++;
  }
  const points = [...acc.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.metric.localeCompare(b.metric) ||
      (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
  );
  const dates = [...new Set(points.map((p) => p.date))].sort();
  return {
    source: 'apple_sales',
    points,
    stats,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    dates: dates.length,
    notes: [],
  };
}
