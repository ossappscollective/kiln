import { type AnalyticsDimension, type AnalyticsMetric, productDimValue } from '@kiln/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import { columnIndex, parseDay, parseNumber, type Table } from '../delimited.ts';
import type { PlayAnalyticsOptions } from './play-analytics.ts';
import { PlayFinancialStorage } from './play-financial.ts';
import { readSalesTables } from './play-sales.ts';

/**
 * Google Play subscription statistics, read only (docs/adr/0042-earnings-and-subscription-metrics.md): per product and day the number of
 * new, canceled and active subscriptions. They are in the SAME Cloud Storage bucket as the other Play reports, in the `financial-stats`
 * folder, so they need the Play Console permission "View financial data" set to Global (and not "View app information").
 *
 * Confirmed from Google's help page "Download and export monthly reports" (answer 6135870), read 2026-11-21:
 * - object `financial-stats/subscriptions/subscriptions_<package name>_<product id>_YYYYMM_<dimension>.csv`, one file per product and
 *   month, the supported dimension being `country`;
 * - columns Date, Package Name, Product ID, Country, New Subscriptions, Canceled Subscriptions, Active Subscriptions, Base Plan ID,
 *   Offer ID.
 *
 * Stored per day, as counts: `play_subscriptions_new`, `play_subscriptions_cancelled`, `play_subscriptions_active` (a snapshot LEVEL),
 * for the app as a whole (the sum of the rows of the day over every product, country, base plan and offer) and per product
 * (dimension `product`, the Product ID). Counts of subscriptions, not money, so nothing about currencies.
 *
 * UNVERIFIED (not confirmed by any page read, never guessed silently):
 * - the exact name of the dimension suffix (`country` is documented; `overview` is tried first because Google's other exports have
 *   one) and that every product of the app has a file for the month;
 * - the format of the `Date` column (YYYY-MM-DD and M/D/YYYY are read; anything else is an unreadable row);
 * - whether a file holds rows that overlap (a row per country AND a row per base plan or offer for the same day), which would count a
 *   subscription twice: the rows are summed as they are;
 * - what `Active Subscriptions` includes (free trials, grace period, paused, cancelled-until-expiry): Google's page does not say;
 * - that the bytes are a plain CSV (a zip or a gzip is opened too, like the sales files; a byte order mark is handled and UTF-16 is read).
 */

export type PlaySubscriptionsResult = {
  points: AnalyticsPoint[];
  files: string[];
  /** Products whose file for the month was read. */
  products: number;
  stats: ParseStats;
};

export interface PlaySubscriptionsPort {
  /** The subscription statistics of the package for one month (`YYYYMM`). `reports_not_found` when no file exists for it. */
  readMonth(month: string): Promise<PlaySubscriptionsResult>;
}

type Acc = Map<string, AnalyticsPoint>;

function add(
  acc: Acc,
  date: string,
  metric: AnalyticsMetric,
  value: number,
  dimension?: { type: AnalyticsDimension; value: string },
) {
  const key = `${date}\u0000${metric}\u0000${dimension ? `${dimension.type}\u0000${dimension.value}` : ''}`;
  const found = acc.get(key);
  if (found) found.value += value;
  else acc.set(key, { date, metric, value, ...(dimension ? { dimension } : {}) });
}

/**
 * The daily points of the rows of ONE subscription statistics table: totals per day and the same per product. `fallbackProduct` is the
 * product id of the file name, used when a row has no Product ID. A table without the date and the three counts is `missing_columns`.
 */
export function mapPlaySubscriptionsTable(
  table: Table,
  options: { packageName?: string; fallbackProduct?: string },
): { points: AnalyticsPoint[]; stats: ParseStats } {
  const cols = columnIndex(table.header);
  const dateAt = cols.get('date');
  const newAt = cols.get('new subscriptions');
  const cancelledAt = cols.get('canceled subscriptions') ?? cols.get('cancelled subscriptions');
  const activeAt = cols.get('active subscriptions');
  const productAt = cols.get('product id');
  const packageAt = cols.get('package name');
  if (dateAt === undefined || (newAt === undefined && cancelledAt === undefined && activeAt === undefined))
    throw new AnalyticsError('missing_columns');
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const wanted = options.packageName?.trim().toLowerCase();
  const acc: Acc = new Map();
  for (const row of table.rows) {
    if (wanted && packageAt !== undefined && (row[packageAt] ?? '').trim().toLowerCase() !== wanted) {
      stats.rowsFiltered++;
      continue;
    }
    const date = parseDay(row[dateAt]);
    if (!date) {
      stats.rowsUnreadable++;
      continue;
    }
    const product = productDimValue(
      (productAt === undefined ? '' : (row[productAt] ?? '')) || options.fallbackProduct || '',
      null,
    );
    const counts: [AnalyticsMetric, number | undefined][] = [
      ['play_subscriptions_new', newAt === undefined ? undefined : parseNumber(row[newAt])],
      [
        'play_subscriptions_cancelled',
        cancelledAt === undefined ? undefined : parseNumber(row[cancelledAt]),
      ],
      [
        'play_subscriptions_active',
        activeAt === undefined ? undefined : parseNumber(row[activeAt]),
      ],
    ];
    let used = false;
    for (const [metric, value] of counts) {
      if (value === undefined) continue;
      add(acc, date, metric, value);
      if (product) add(acc, date, metric, value, { type: 'product', value: product });
      used = true;
    }
    if (used) stats.rowsUsed++;
    else stats.rowsUnreadable++;
  }
  const points = [...acc.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.metric.localeCompare(b.metric) ||
      (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
  );
  return { points, stats };
}

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DIMENSION_RANK = ['overview', 'country'];
/** Files read per month and products kept: a bound, not a claim about how many an app has. */
const MAX_FILES = 60;

export class PlaySubscriptionsConnector implements PlaySubscriptionsPort {
  readonly #storage: PlayFinancialStorage;

  constructor(options: PlayAnalyticsOptions) {
    this.#storage = new PlayFinancialStorage(options);
  }

  async readMonth(month: string): Promise<PlaySubscriptionsResult> {
    if (!/^\d{6}$/.test(month)) throw new AnalyticsError('reports_not_found');
    const pkg = this.#storage.packageName;
    const prefix = `financial-stats/subscriptions/subscriptions_${pkg}_`;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}(.+)_${month}_([A-Za-z0-9-]+)\\.csv$`);
    // One file per product: the dimension file that is documented or most like an overview.
    const best = new Map<string, { name: string; rank: number }>();
    for (const name of await this.#storage.list(prefix)) {
      const m = pattern.exec(name);
      if (!m) continue;
      const product = m[1] as string;
      const dim = (m[2] as string).toLowerCase();
      const found = DIMENSION_RANK.indexOf(dim);
      const rank = found < 0 ? DIMENSION_RANK.length : found;
      const have = best.get(product);
      if (!have || rank < have.rank || (rank === have.rank && name < have.name))
        best.set(product, { name, rank });
    }
    if (best.size === 0) throw new AnalyticsError('reports_not_found');
    const stats: ParseStats = { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 };
    const merged = new Map<string, AnalyticsPoint>();
    const files: string[] = [];
    const chosen = [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, MAX_FILES);
    for (const [product, { name }] of chosen) {
      const raw = await this.#storage.download(name);
      const tables = await readSalesTables(raw);
      const mapped = {
        points: [] as AnalyticsPoint[],
        stats: { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 } as ParseStats,
      };
      for (const table of tables) {
        const one = mapPlaySubscriptionsTable(table, { packageName: pkg, fallbackProduct: product });
        mapped.points.push(...one.points);
        mapped.stats.rowsRead += one.stats.rowsRead;
        mapped.stats.rowsUsed += one.stats.rowsUsed;
        mapped.stats.rowsUnreadable += one.stats.rowsUnreadable;
        mapped.stats.rowsFiltered += one.stats.rowsFiltered;
      }
      files.push(name);
      stats.rowsRead += mapped.stats.rowsRead;
      stats.rowsUsed += mapped.stats.rowsUsed;
      stats.rowsUnreadable += mapped.stats.rowsUnreadable;
      stats.rowsFiltered += mapped.stats.rowsFiltered;
      for (const p of mapped.points) {
        const key = `${p.date}\u0000${p.metric}\u0000${p.dimension?.type ?? ''}\u0000${p.dimension?.value ?? ''}`;
        const found = merged.get(key);
        if (found) found.value += p.value;
        else merged.set(key, { ...p });
      }
    }
    return { points: [...merged.values()], files, products: files.length, stats };
  }
}
