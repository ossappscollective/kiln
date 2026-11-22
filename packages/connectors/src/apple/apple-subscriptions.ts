import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  analyticsLimits,
  productDimValue,
} from '@kiln/core';
import { AnalyticsError, type AnalyticsPoint, type ParseStats } from '../analytics-types.ts';
import { columnIndex, normalizeHeader, parseNumber, type Table } from '../delimited.ts';

/**
 * Apple subscription reports of Sales and Trends, read only (docs/adr/0042-earnings-and-subscription-metrics.md). Two reports of
 * `GET /v1/salesReports`, both DAILY and SUMMARY, version `1_3` (Apple's table of allowed values, read 2026-11-21: SUBSCRIPTION /
 * SUMMARY, SUBSCRIPTION_EVENT / SUMMARY and SUBSCRIBER / DETAILED, all `1_3`; `1_2` is no longer available), with the same vendor
 * number as the sales summary:
 * - the Subscription report: a snapshot of the day, one row per subscription, duration, offer, device and country, with the COUNT
 *   columns (Active Standard Price Subscriptions, the free-trial and the pay-up-front / pay-as-you-go offer columns, Marketing Opt-Ins,
 *   Billing Retry, Grace Period, Subscribers). It has no date column: the day is the day that was asked for;
 * - the Subscription Event report: one row per event kind with the number of events (`Quantity`), `Event`, `Subscription Offer Type`,
 *   `Cancellation Reason` and the same app and subscription columns.
 * The SUBSCRIBER report is NOT read: it has one row per subscriber with a subscriber id, and no per-person data is stored here.
 *
 * Stored per day: `subscriptions_active` (the standard-price count), `subscriptions_active_offer` (the pay-up-front and pay-as-you-go
 * offer columns), `subscriptions_active_trial` (the free-trial columns), all LEVELS summed over the rows of the day; and from the event
 * report `subscriptions_new`, `subscriptions_cancelled` and `subscriptions_trial_conversions`, summed over `Quantity`. For the app as a
 * whole (no dimension), per store product (dimension `product`: the id given by `productOf`, else the Subscription Apple ID) and, for the
 * levels and events alike, per standard duration (dimension `duration`, e.g. `1 Month`). Counts of subscriptions, never people.
 *
 * UNVERIFIED (never guessed silently; also in docs/api/analytics.md):
 * - the names of the count columns beyond the ones read from Apple's field table (matched by header text: `free trial` is a trial
 *   column, `pay up front` and `pay as you go` are paid-offer columns), and that the count columns do not overlap (a subscription is
 *   counted in one state). `Marketing Opt-Ins`, `Billing Retry`, `Grace Period` and `Subscribers` are not added to any figure;
 * - that a report of day D describes day D (the Subscription report is "the state at the end of the day": Apple's pages do not say, and
 *   the time zone is not stated: Apple's other Sales reports run on Pacific Time);
 * - that the report is TAB separated (the delimiter is sniffed; comma and semicolon are read too), and that the day to read is the
 *   day of the request, not the `Event Date` of a row (the event date is not used);
 * - the event names: new = `Subscribe`, `Opt-In` and every event that starts with `Start` (`Start Introductory Offer`, `Start Offer
 *   Code`, probably `Start Win-Back Offer`); cancelled = every event that starts with `Cancel` (`Cancel`, `Canceled from Billing
 *   Retry`, `Canceled from Billing Grace Period`, `Canceled After Renewal Extension`); a trial conversion = `Paid Subscription from
 *   Introductory Offer` on a row whose `Subscription Offer Type` is `Free Trial` (whether that column holds the offer that was left is
 *   not stated). Reactivations, renewals, refunds, upgrades and billing events are not counted. New subscriptions include trials started;
 * - that `Subscription Apple ID` is the `id` of the subscription resource of the App Store Connect API that the Products page stores as
 *   `storeRef` (the id is mapped to the product id through that); an id with no match is stored as the Apple id itself;
 * - that the `Device` of a Mac subscription is `Desktop` (matched with mac, macos and desktop, like the sales summary).
 */

const isMac = (device: string) => /\b(mac|macos|desktop)\b/i.test(device);
const clip = (v: string) => v.trim().slice(0, analyticsLimits.maxDimensionLength);

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

const sortPoints = (acc: Acc): AnalyticsPoint[] =>
  [...acc.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.metric.localeCompare(b.metric) ||
      (a.dimension?.type ?? '').localeCompare(b.dimension?.type ?? '') ||
      (a.dimension?.value ?? '').localeCompare(b.dimension?.value ?? ''),
  );

export type AppleSubscriptionOptions = {
  /** The numeric App Store id of the app. Rows of other apps of the vendor are left out. */
  appleId: string;
  /** The day the report was asked for (YYYY-MM-DD): the Subscription report has no date column. */
  date: string;
  platform?: 'ios' | 'macos' | undefined;
  /** The store product id of a Subscription Apple ID, when the Products snapshot knows it. */
  productOf?: ((subscriptionAppleId: string) => string | undefined) | undefined;
};

/** Where the facts of one row go: the total, its product and its duration. */
function targets(
  row: string[],
  at: (row: string[], name: string) => string | undefined,
  options: AppleSubscriptionOptions,
): ({ type: AnalyticsDimension; value: string } | undefined)[] {
  const out: ({ type: AnalyticsDimension; value: string } | undefined)[] = [undefined];
  const apple = (at(row, 'subscription apple id') ?? '').trim();
  const product = productDimValue(options.productOf?.(apple) ?? apple, null);
  if (product) out.push({ type: 'product', value: product });
  const duration = clip(at(row, 'standard subscription duration') ?? '');
  if (duration !== '') out.push({ type: 'duration', value: duration });
  return out;
}

const rowReader = (table: Table) => {
  const cols = columnIndex(table.header);
  return {
    cols,
    at: (row: string[], name: string): string | undefined => {
      const i = cols.get(name);
      return i === undefined ? undefined : row[i];
    },
  };
};

/** How a count column of the Subscription report counts, from its header; `ignored` for opt-ins, billing states and subscribers. */
export function subscriptionColumnKind(header: string): 'standard' | 'trial' | 'offer' | 'ignored' {
  const h = normalizeHeader(header);
  if (h === 'active standard price subscriptions') return 'standard';
  if (/\bfree trial\b/.test(h)) return 'trial';
  if (/\bpay up front\b|\bpay as you go\b/.test(h)) return 'offer';
  return 'ignored';
}

/**
 * The Subscription report (a snapshot of the day) of ONE app. A table without the app id and the standard count column is
 * `missing_columns`. A report without a row for the app has no points.
 */
export function mapAppleSubscriptionTable(
  table: Table,
  options: AppleSubscriptionOptions,
): { points: AnalyticsPoint[]; stats: ParseStats } {
  const { cols, at } = rowReader(table);
  if (!cols.has('app apple id') || !cols.has('active standard price subscriptions'))
    throw new AnalyticsError('missing_columns');
  const counted: { index: number; kind: 'standard' | 'trial' | 'offer' }[] = [];
  table.header.forEach((name, index) => {
    const kind = subscriptionColumnKind(name);
    if (kind !== 'ignored') counted.push({ index, kind });
  });
  const metricOf = {
    standard: 'subscriptions_active',
    offer: 'subscriptions_active_offer',
    trial: 'subscriptions_active_trial',
  } as const;
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const acc: Acc = new Map();
  for (const row of table.rows) {
    if ((at(row, 'app apple id') ?? '').trim() !== options.appleId) {
      stats.rowsFiltered++;
      continue;
    }
    const device = at(row, 'device') ?? '';
    if (options.platform && device !== '' && isMac(device) !== (options.platform === 'macos')) {
      stats.rowsFiltered++;
      continue;
    }
    const where = targets(row, at, options);
    let any = false;
    for (const { index, kind } of counted) {
      const raw = (row[index] ?? '').trim();
      // A blank count is zero for that row; text that is no number makes the row unreadable.
      const value = raw === '' ? 0 : parseNumber(raw);
      if (value === undefined) continue;
      any = true;
      for (const dimension of where) add(acc, options.date, metricOf[kind], value, dimension);
    }
    if (any) stats.rowsUsed++;
    else stats.rowsUnreadable++;
  }
  return { points: sortPoints(acc), stats };
}

const normalizeEvent = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type SubscriptionEventKind = 'new' | 'cancelled' | 'trial_conversion' | 'other';

/** The kind of an event name (and, for a conversion, the offer type of the row). UNVERIFIED for names Apple adds later. */
export function subscriptionEventKind(event: string, offerType = ''): SubscriptionEventKind {
  const e = normalizeEvent(event);
  if (e === 'subscribe' || e === 'opt in' || e.startsWith('start ')) return 'new';
  if (e.startsWith('cancel')) return 'cancelled';
  if (
    e === 'paid subscription from introductory offer' &&
    normalizeEvent(offerType) === 'free trial'
  )
    return 'trial_conversion';
  return 'other';
}

/** The Subscription Event report of the day, for ONE app: new, cancelled and trial conversions summed over `Quantity`. */
export function mapAppleSubscriptionEventTable(
  table: Table,
  options: AppleSubscriptionOptions,
): { points: AnalyticsPoint[]; stats: ParseStats } {
  const { cols, at } = rowReader(table);
  if (!cols.has('app apple id') || !cols.has('event')) throw new AnalyticsError('missing_columns');
  const stats: ParseStats = {
    rowsRead: table.rows.length,
    rowsUsed: 0,
    rowsUnreadable: 0,
    rowsFiltered: 0,
  };
  const acc: Acc = new Map();
  for (const row of table.rows) {
    if ((at(row, 'app apple id') ?? '').trim() !== options.appleId) {
      stats.rowsFiltered++;
      continue;
    }
    const device = at(row, 'device') ?? '';
    if (options.platform && device !== '' && isMac(device) !== (options.platform === 'macos')) {
      stats.rowsFiltered++;
      continue;
    }
    const kind = subscriptionEventKind(at(row, 'event') ?? '', at(row, 'subscription offer type'));
    if (kind === 'other') {
      stats.rowsFiltered++;
      continue;
    }
    const raw = (at(row, 'quantity') ?? '').trim();
    const quantity = raw === '' ? 1 : parseNumber(raw);
    if (quantity === undefined) {
      stats.rowsUnreadable++;
      continue;
    }
    const metric: AnalyticsMetric =
      kind === 'new'
        ? 'subscriptions_new'
        : kind === 'cancelled'
          ? 'subscriptions_cancelled'
          : 'subscriptions_trial_conversions';
    for (const dimension of targets(row, at, options))
      add(acc, options.date, metric, quantity, dimension);
    stats.rowsUsed++;
  }
  return { points: sortPoints(acc), stats };
}
