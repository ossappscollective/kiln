import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  productDimValue,
} from '@kiln/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import { columnIndex, type Table } from '../delimited.ts';
import type { PlayAnalyticsOptions } from './play-analytics.ts';
import { PlayFinancialStorage } from './play-financial.ts';
import { parseSalesAmount, readSalesTables } from './play-sales.ts';

/**
 * Google Play "Earnings" report, read only (docs/adr/0042-earnings-and-subscription-metrics.md). One monthly zip per developer account in
 * the same Cloud Storage bucket as the statistics and the estimated sales: `earnings/earnings_YYYYMM.zip`, for ALL apps of the account,
 * so rows are filtered by the `Package ID` column.
 *
 * Confirmed from Google's help page "Download and export monthly reports" (answer 6135870), read 2026-11-21:
 * - object `earnings/earnings_YYYYMM.zip`, generated once a month, "typically by the 5th of the following month";
 * - the Transaction Date is in Pacific Time (`MMM DD, YYYY`);
 * - columns Description, Transaction Date, Transaction Time, Tax Type, Transaction Type, Refund Type, Product Title, Package ID,
 *   Product Type, SKU ID, Hardware, Buyer Country, Buyer State, Buyer Postcode, Buyer Currency, Amount (Buyer Currency), Currency
 *   Conversion Rate, Merchant Currency, Amount (Merchant Currency), Base Plan or Purchase Option ID, Offer ID, Group ID, First USD 1M
 *   Eligible, Service Fee %, Fee Description, Promotion ID, Sales Channel;
 * - transaction types "Charge", "Google fee", "Tax", "Charge refund", "Google fee refund", "Charge rebill", "Tax rebill",
 *   "Google fee rebill", "Adjustment"; "Amount (Merchant Currency)" is the line's total after conversion to the currency you are paid in;
 * - financial reports need the Play Console permission "View financial data" set to Global.
 *
 * What is stored, per calendar month of the FILE, on the first day of that month (never on the Transaction Date: the report is a monthly
 * statement, its days are Pacific Time while every other series is UTC, and a daily series would arrive a month late), per merchant
 * currency (dimension `currency`) and per product (dimension `product`, `<CUR>:<SKU ID>`):
 * - `earnings_net`: the sum of EVERY line of the app in the file, exactly as signed by Google;
 * - `earnings_charges`, `earnings_taxes`, `earnings_fees`: the sum of the lines of the family (Charge, Charge refund, Charge rebill;
 *   Tax, Tax rebill; Google fee, Google fee refund, Google fee rebill), exactly as signed. Adjustment lines and lines of a type this
 *   server does not know are in the net only, so net = charges + taxes + fees + the rest;
 * - `earnings_orders`: the number of `Charge` lines (not rebills, not refunds).
 * Nothing is converted or added across currencies.
 *
 * UNVERIFIED (not confirmed by any page read, never guessed silently; also in docs/api/analytics.md):
 * - the SIGN of each transaction type (the page does not say). The net is a plain signed sum, so it is right only if Google writes fees
 *   and refunds as negative amounts and taxes as the sign that makes the ledger add up to what is paid out;
 * - whether the zip holds exactly one CSV, and its encoding (a byte order mark is honoured, UTF-16 and UTF-8 both read);
 * - the spelling of the transaction types (compared case-insensitively, punctuation ignored) and of the column names;
 * - whether a file can be split or suffixed (`earnings_YYYYMM_1.zip`): every object whose name starts with the prefix is read, and a
 *   second file that holds exactly the same figures as an earlier one is skipped as a duplicate;
 * - `Package ID` (current page) versus `Product ID` (older exports): both are read;
 * - the amounts with a thousands separator (`1,234.56`): read as the sales report's amounts;
 * - that the 10 MiB file cap fits a large account's month (`file_too_large` otherwise).
 */

export type PlayEarningsResult = {
  points: AnalyticsPoint[];
  /** The objects read. */
  files: string[];
  stats: ParseStats;
};

export interface PlayEarningsPort {
  /** The earnings of the package for one month (`YYYYMM`). `reports_not_found` when the month has no file yet. */
  readMonth(month: string): Promise<PlayEarningsResult>;
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

const normalizeType = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();

export type EarningsFamily = 'charges' | 'taxes' | 'fees' | 'other';

/** Which family a transaction type belongs to, and whether it is a plain `Charge` (counted as an order). UNVERIFIED spelling. */
export function earningsTypeOf(raw: string): { family: EarningsFamily; isCharge: boolean } {
  const t = normalizeType(raw);
  if (t === 'charge') return { family: 'charges', isCharge: true };
  if (t === 'charge refund' || t === 'charge rebill') return { family: 'charges', isCharge: false };
  if (t === 'tax' || t === 'tax rebill' || t === 'tax refund')
    return { family: 'taxes', isCharge: false };
  if (t === 'google fee' || t === 'google fee refund' || t === 'google fee rebill')
    return { family: 'fees', isCharge: false };
  return { family: 'other', isCharge: false };
}

const PACKAGE_COLUMNS = ['package id', 'product id', 'package name'];
const FAMILY_METRIC: Record<Exclude<EarningsFamily, 'other'>, AnalyticsMetric> = {
  charges: 'earnings_charges',
  taxes: 'earnings_taxes',
  fees: 'earnings_fees',
};

/** The first day of a `YYYYMM` month. */
export const earningsMonthDay = (month: string): string => `${month.slice(0, 4)}-${month.slice(4)}-01`;

/**
 * The monthly points of ONE package out of an Earnings table, all dated the first day of `month`. The table holds every app of the
 * account: rows of another package are filtered. A table without the needed columns is `missing_columns`.
 */
export function mapPlayEarningsTable(
  table: Table,
  options: { packageName: string; month: string },
): { points: AnalyticsPoint[]; stats: ParseStats } {
  if (!/^\d{6}$/.test(options.month)) throw new AnalyticsError('reports_not_found');
  const cols = columnIndex(table.header);
  const at = (...names: string[]) => names.map((n) => cols.get(n)).find((i) => i !== undefined);
  const typeAt = at('transaction type');
  const packageAt = at(...PACKAGE_COLUMNS);
  const currencyAt = at('merchant currency');
  const amountAt = at('amount merchant currency');
  const skuAt = at('sku id', 'sku');
  if (
    typeAt === undefined ||
    packageAt === undefined ||
    currencyAt === undefined ||
    amountAt === undefined
  )
    throw new AnalyticsError('missing_columns');
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const date = earningsMonthDay(options.month);
  const wanted = options.packageName.trim().toLowerCase();
  const acc: Acc = new Map();
  for (const row of table.rows) {
    if ((row[packageAt] ?? '').trim().toLowerCase() !== wanted) {
      stats.rowsFiltered++;
      continue;
    }
    const currency = (row[currencyAt] ?? '').trim().toUpperCase();
    const amount = parseSalesAmount(row[amountAt]);
    if (amount === undefined || !/^[A-Z]{3}$/.test(currency)) {
      stats.rowsUnreadable++;
      continue;
    }
    const { family, isCharge } = earningsTypeOf(row[typeAt] ?? '');
    const sku = skuAt === undefined ? '' : (row[skuAt] ?? '');
    const byProduct = productDimValue(sku, currency);
    const money: AnalyticsMetric[] = ['earnings_net'];
    if (family !== 'other') money.push(FAMILY_METRIC[family]);
    for (const metric of money) {
      add(acc, date, metric, amount, { type: 'currency', value: currency });
      if (byProduct) add(acc, date, metric, amount, { type: 'product', value: byProduct });
    }
    if (isCharge) {
      add(acc, date, 'earnings_orders', 1);
      const id = productDimValue(sku, null);
      if (id) add(acc, date, 'earnings_orders', 1, { type: 'product', value: id });
    }
    stats.rowsUsed++;
  }
  const points = [...acc.values()]
    .map((p) => ({ ...p, value: Math.round(p.value * 1e6) / 1e6 }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.metric.localeCompare(b.metric) ||
        (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
    );
  return { points, stats };
}

const MAX_FILES = 6;

/**
 * Reads `earnings/earnings_YYYYMM*.zip` of the account's bucket for one package. A month with no file is `reports_not_found` (the
 * report appears about the 5th of the next month: "not available yet", not a failure). A refused folder is `play_sales_forbidden`.
 */
export class PlayEarningsConnector implements PlayEarningsPort {
  readonly #storage: PlayFinancialStorage;

  constructor(options: PlayAnalyticsOptions) {
    this.#storage = new PlayFinancialStorage(options);
  }

  async readMonth(month: string): Promise<PlayEarningsResult> {
    if (!/^\d{6}$/.test(month)) throw new AnalyticsError('reports_not_found');
    const prefix = `earnings/earnings_${month}`;
    const names = (await this.#storage.list(prefix))
      .filter((n) => n.startsWith(prefix) && /\.(zip|csv|gz)$/i.test(n))
      .sort()
      .slice(0, MAX_FILES);
    if (names.length === 0) throw new AnalyticsError('reports_not_found');
    const stats: ParseStats = { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 };
    const merged = new Map<string, AnalyticsPoint>();
    const seen = new Set<string>();
    const files: string[] = [];
    for (const name of names) {
      const raw = await this.#storage.download(name);
      const filePoints: AnalyticsPoint[] = [];
      const fileStats: ParseStats = { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 };
      for (const table of await readSalesTables(raw)) {
        const mapped = mapPlayEarningsTable(table, {
          packageName: this.#storage.packageName,
          month,
        });
        fileStats.rowsRead += mapped.stats.rowsRead;
        fileStats.rowsUsed += mapped.stats.rowsUsed;
        fileStats.rowsUnreadable += mapped.stats.rowsUnreadable;
        fileStats.rowsFiltered += mapped.stats.rowsFiltered;
        filePoints.push(...mapped.points);
      }
      // A second object that holds exactly the figures of an earlier one is a copy, not more transactions.
      const signature = JSON.stringify(
        filePoints.map((p) => [p.metric, p.dimension?.type, p.dimension?.value, p.value]),
      );
      if (filePoints.length > 0 && seen.has(signature)) continue;
      seen.add(signature);
      files.push(name);
      stats.rowsRead += fileStats.rowsRead;
      stats.rowsUsed += fileStats.rowsUsed;
      stats.rowsUnreadable += fileStats.rowsUnreadable;
      stats.rowsFiltered += fileStats.rowsFiltered;
      for (const p of filePoints) {
        const key = `${p.date}\u0000${p.metric}\u0000${p.dimension?.type ?? ''}\u0000${p.dimension?.value ?? ''}`;
        const found = merged.get(key);
        if (found) found.value += p.value;
        else merged.set(key, { ...p });
      }
    }
    return { points: [...merged.values()], files, stats };
  }
}
