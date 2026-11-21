import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  analyticsLimits,
  productDimValue,
} from '@mrm/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import {
  columnIndex,
  decodeTableText,
  isGzip,
  openFileBytes,
  parseDay,
  parseTable,
  type Table,
} from '../delimited.ts';
import { isZip, readZipEntries } from '../zip.ts';
import { type PlayAnalyticsOptions, PlayReportsConnector } from './play-analytics.ts';

/**
 * Google Play "Estimated sales" reports, read only (docs/adr/0038-sales-analytics.md). They live in the SAME Cloud Storage bucket as
 * the statistics reports (the bucket id of `analytics.playBucketId`), one file per month for ALL apps of the developer account.
 *
 * Confirmed from Google's help page "Download and export monthly reports" (answer 6135870) and "View financial reports" (answer 2482017):
 * - object `sales/salesreport_YYYYMM.zip`; "generated daily by adding all transactions that were CHARGED or REFUNDED recently to the
 *   current month's file"; days are UTC (`Order Charged Date`, YYYY-MM-DD);
 * - columns Order Number, Order Charged Date, Order Charged Timestamp, Financial Status, Device Model, Product Title, Package ID,
 *   Product Type, SKU ID, Currency of Sale, Item Price, Taxes Collected, Charged Amount (= item price + taxes, in the buyer's currency),
 *   City / State / Postcode / Country of Buyer, Base Plan or Purchase Option ID, Offer ID, ...;
 * - the report does not deduct taxes or Google's fee: it is what the BUYER paid, "not recommended for accounting";
 * - reading financial data needs the Play Console permission "View financial data" set to Global.
 *
 * UNVERIFIED (not confirmed by any page read, never guessed silently):
 * - that the zip holds exactly one CSV, and its encoding (Google says only that CSVs from Cloud Storage may need a UTF-16 to UTF-8
 *   conversion: a byte order mark is honoured, as for the statistics files);
 * - the exact spelling of `Financial Status` (the page's examples are "charged, refund, partial refund"): matched case-insensitively,
 *   `charged` is a sale, anything with `refund` is a refund, every other status is left out;
 * - the SIGN of a refund amount (the page does not say): the absolute value is used for a refund;
 * - which day a refund row carries (the day of the refund, or the day of the original charge);
 * - whether the package column is called `Package ID` (current page) or `Product ID` (older exports): both are accepted;
 * - which status or error Cloud Storage answers when "View financial data" is missing (assumed HTTP 403 on the `sales/` objects).
 */

export type PlaySalesResult = {
  points: AnalyticsPoint[];
  /** The object read. */
  file: string;
  stats: ParseStats;
};

export interface PlaySalesPort {
  /** The sales of the package for one month (`YYYYMM`). `reports_not_found` when the month has no file yet. */
  readMonth(month: string): Promise<PlaySalesResult>;
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

/** An amount as Google writes it: `12,345.67` (comma as thousands separator) or plain digits. */
export function parseSalesAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let v = raw.trim();
  if (v === '') return undefined;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const normalizeStatus = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();

/** `charge` (a sale), `refund` (full or partial) or `other` (left out). Case and punctuation do not matter. UNVERIFIED spelling. */
export function salesStatusKind(raw: string): 'charge' | 'refund' | 'other' {
  const s = normalizeStatus(raw);
  if (s === 'charged' || s === 'charge') return 'charge';
  if (s.indexOf('refund') >= 0) return 'refund';
  return 'other';
}

const PACKAGE_COLUMNS = ['package id', 'product id', 'package name'];

/**
 * The daily points of ONE package out of a sales table. The table holds every app of the account: rows of another package are
 * filtered. Per day: `sales_gross` and `sales_refunds` per currency of sale (dimension `currency`), `sales_orders` (the number of
 * charged rows), and the same per product (dimension `product`, the SKU ID; see `productDimValue`). Nothing is converted or added
 * across currencies. A table without the needed columns is `missing_columns`.
 */
export function mapPlaySalesTable(
  table: Table,
  options: { packageName: string },
): { points: AnalyticsPoint[]; stats: ParseStats } {
  const cols = columnIndex(table.header);
  const at = (...names: string[]) => names.map((n) => cols.get(n)).find((i) => i !== undefined);
  const dateAt = at('order charged date');
  const statusAt = at('financial status');
  const packageAt = at(...PACKAGE_COLUMNS);
  const currencyAt = at('currency of sale');
  const chargedAt = at('charged amount');
  const itemAt = at('item price');
  const taxAt = at('taxes collected');
  const skuAt = at('sku id', 'sku');
  if (
    dateAt === undefined ||
    statusAt === undefined ||
    packageAt === undefined ||
    currencyAt === undefined ||
    (chargedAt === undefined && itemAt === undefined)
  )
    throw new AnalyticsError('missing_columns');
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const wanted = options.packageName.trim().toLowerCase();
  const acc: Acc = new Map();
  for (const row of table.rows) {
    if ((row[packageAt] ?? '').trim().toLowerCase() !== wanted) {
      stats.rowsFiltered++;
      continue;
    }
    const kind = salesStatusKind(row[statusAt] ?? '');
    if (kind === 'other') {
      stats.rowsFiltered++;
      continue;
    }
    const date = parseDay(row[dateAt]);
    const currency = (row[currencyAt] ?? '').trim().toUpperCase();
    let amount = chargedAt === undefined ? undefined : parseSalesAmount(row[chargedAt]);
    if (amount === undefined && itemAt !== undefined) {
      const item = parseSalesAmount(row[itemAt]);
      if (item !== undefined)
        amount = item + (taxAt === undefined ? 0 : (parseSalesAmount(row[taxAt]) ?? 0));
    }
    if (!date || amount === undefined || !/^[A-Z]{3}$/.test(currency)) {
      stats.rowsUnreadable++;
      continue;
    }
    const sku = skuAt === undefined ? '' : (row[skuAt] ?? '');
    const money = kind === 'charge' ? 'sales_gross' : 'sales_refunds';
    const value = kind === 'charge' ? amount : Math.abs(amount);
    add(acc, date, money, value, { type: 'currency', value: currency });
    const byProduct = productDimValue(sku, currency);
    if (byProduct) add(acc, date, money, value, { type: 'product', value: byProduct });
    if (kind === 'charge') {
      add(acc, date, 'sales_orders', 1);
      const id = productDimValue(sku, null);
      if (id) add(acc, date, 'sales_orders', 1, { type: 'product', value: id });
    }
    stats.rowsUsed++;
  }
  const points = [...acc.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.metric.localeCompare(b.metric) ||
      (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
  );
  return { points, stats };
}

const wantsEntry = (name: string) =>
  /\.(csv|tsv|txt)$/i.test(name) && name.indexOf('__MACOSX') < 0 && !/(^|\/)\./.test(name);

/** The tables of a downloaded sales object: a zip of CSV files (the documented form), a .gz, or a plain CSV. */
export async function readSalesTables(bytes: Uint8Array): Promise<Table[]> {
  const limits = {
    maxFileBytes: analyticsLimits.maxFileBytes,
    maxTextBytes: analyticsLimits.maxTextBytes,
    maxRows: analyticsLimits.maxRows,
    maxColumns: analyticsLimits.maxColumns,
  };
  if (bytes.length > limits.maxFileBytes) throw new AnalyticsError('file_too_large');
  if (!isZip(bytes))
    return [parseTable(decodeTableText(await openFileBytes(bytes, limits)), limits)];
  const entries = await readZipEntries(bytes, wantsEntry, {
    maxEntryBytes: limits.maxTextBytes,
    maxTotalBytes: limits.maxTextBytes,
  });
  if (entries.length === 0) throw new AnalyticsError('bad_zip');
  const tables: Table[] = [];
  for (const e of entries)
    tables.push(
      parseTable(
        decodeTableText(isGzip(e.bytes) ? await openFileBytes(e.bytes, limits) : e.bytes),
        limits,
      ),
    );
  return tables;
}

/**
 * Reads `sales/salesreport_YYYYMM.zip` of the account's bucket for one package. Refused access to the `sales/` objects is
 * `play_sales_forbidden` (the financial permission), not `bucket_forbidden`: the statistics reports of the same bucket may still work.
 */
export class PlaySalesConnector implements PlaySalesPort {
  readonly #storage: PlayReportsConnector;
  readonly #package: string;

  constructor(options: PlayAnalyticsOptions) {
    this.#storage = new PlayReportsConnector(options);
    this.#package = options.packageName;
  }

  async readMonth(month: string): Promise<PlaySalesResult> {
    if (!/^\d{6}$/.test(month)) throw new AnalyticsError('reports_not_found');
    const prefix = `sales/salesreport_${month}`;
    const refused = (error: unknown): never => {
      if (error instanceof AnalyticsError && error.code === 'bucket_forbidden')
        throw new AnalyticsError('play_sales_forbidden', undefined, error.status);
      throw error;
    };
    let names: string[] = [];
    try {
      names = await this.#storage.listObjects(prefix);
    } catch (error) {
      refused(error);
    }
    const wanted = names
      .filter((n) => n.startsWith(prefix) && /\.(zip|csv|gz)$/i.test(n))
      .sort()[0];
    if (!wanted) throw new AnalyticsError('reports_not_found');
    let raw: Uint8Array;
    try {
      raw = await this.#storage.downloadObject(wanted);
    } catch (error) {
      return refused(error);
    }
    const stats: ParseStats = { rowsRead: 0, rowsUsed: 0, rowsUnreadable: 0, rowsFiltered: 0 };
    const merged = new Map<string, AnalyticsPoint>();
    for (const table of await readSalesTables(raw)) {
      const mapped = mapPlaySalesTable(table, { packageName: this.#package });
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
    return { points: [...merged.values()], file: wanted, stats };
  }
}
