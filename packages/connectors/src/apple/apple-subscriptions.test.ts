import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fx from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { parseTable } from '../delimited.ts';
import {
  mapAppleSubscriptionEventTable,
  mapAppleSubscriptionTable,
  subscriptionColumnKind,
  subscriptionEventKind,
} from './apple-subscriptions.ts';

const APP = fx.APPLE_APP_ID;
const DAY = '2026-11-10';

type P = { date: string; metric: string; value: number; dimension?: { type: string; value: string } };
const find = (points: P[], metric: string, dim?: string) =>
  points.find(
    (p) =>
      p.date === DAY &&
      p.metric === metric &&
      (p.dimension ? `${p.dimension.type}:${p.dimension.value}` : undefined) === dim,
  )?.value;

// Columns of the Subscription report as Apple documents them (version 1_3 field table), in the documented order.
const SUB_HEADER = [
  'App Name',
  'App Apple ID',
  'Subscription Name',
  'Subscription Apple ID',
  'Subscription Group ID',
  'Standard Subscription Duration',
  'Subscription Offer Name',
  'Promotional Offer ID',
  'Customer Price',
  'Customer Currency',
  'Developer Proceeds',
  'Proceeds Currency',
  'Preserved Pricing',
  'Proceeds Reason',
  'Client',
  'Device',
  'State',
  'Country',
  'Active Standard Price Subscriptions',
  'Active Free Trial Introductory Offer Subscriptions',
  'Active Pay Up Front Introductory Offer Subscriptions',
  'Active Pay As You Go Introductory Offer Subscriptions',
  'Free Trial Promotional Offer Subscriptions',
  'Pay Up Front Promotional Offer Subscriptions',
  'Pay As You Go Promotional Offer Subscriptions',
  'Free Trial Offer Code Subscriptions',
  'Pay Up Front Offer Code Subscriptions',
  'Pay As You Go Offer Code Subscriptions',
  'Marketing Opt-Ins',
  'Billing Retry',
  'Grace Period',
  'Subscribers',
  'Free Trial Win-Back Offers',
  'Pay Up Front Win-Back Offers',
  'Pay As You Go Win-Back Offers',
];
const sub = (
  app: string,
  subId: string,
  duration: string,
  device: string,
  counts: Partial<Record<string, string>>,
) =>
  SUB_HEADER.map((h) => {
    switch (h) {
      case 'App Apple ID':
        return app;
      case 'Subscription Apple ID':
        return subId;
      case 'Standard Subscription Duration':
        return duration;
      case 'Device':
        return device;
      default:
        return counts[h] ?? (h.startsWith('Active') || /Subscriptions$|Offers$|Opt-Ins|Retry|Grace|Subscribers/.test(h) ? '0' : '');
    }
  });
const SUBSCRIPTION = fx.tsv([
  SUB_HEADER,
  sub(APP, '6001', '1 Month', 'iPhone', {
    'Active Standard Price Subscriptions': '40',
    'Active Free Trial Introductory Offer Subscriptions': '5',
    'Active Pay Up Front Introductory Offer Subscriptions': '2',
    'Free Trial Promotional Offer Subscriptions': '1',
    'Marketing Opt-Ins': '9',
    'Billing Retry': '4',
    'Grace Period': '3',
    Subscribers: '30',
  }),
  sub(APP, '6001', '1 Month', 'iPad', { 'Active Standard Price Subscriptions': '10', 'Pay As You Go Promotional Offer Subscriptions': '3' }),
  sub(APP, '6002', '1 Year', 'iPhone', { 'Active Standard Price Subscriptions': '7', 'Free Trial Win-Back Offers': '2' }),
  sub(APP, '6002', '1 Year', 'Desktop', { 'Active Standard Price Subscriptions': '100' }),
  sub('555', '7001', '1 Month', 'iPhone', { 'Active Standard Price Subscriptions': '999' }),
]);

test('count columns are told apart by their header: standard, free trial, paid offer; opt-ins, billing states and subscribers are not figures', () => {
  assert.equal(subscriptionColumnKind('Active Standard Price Subscriptions'), 'standard');
  assert.equal(subscriptionColumnKind('Active Free Trial Introductory Offer Subscriptions'), 'trial');
  assert.equal(subscriptionColumnKind('Free Trial Win-Back Offers'), 'trial');
  assert.equal(subscriptionColumnKind('Pay Up Front Offer Code Subscriptions'), 'offer');
  assert.equal(subscriptionColumnKind('Active Pay As You Go Introductory Offer Subscriptions'), 'offer');
  for (const h of ['Marketing Opt-Ins', 'Billing Retry', 'Grace Period', 'Subscribers', 'Customer Price'])
    assert.equal(subscriptionColumnKind(h), 'ignored', h);
});

test('mapAppleSubscriptionTable: the day is the day asked for; levels are summed over the rows of one app; per product and per duration', () => {
  const r = mapAppleSubscriptionTable(parseTable(SUBSCRIPTION), {
    appleId: APP,
    date: DAY,
    productOf: (id) => (id === '6001' ? 'pro_monthly' : undefined),
  });
  const p = r.points;
  // iPhone + iPad + iPhone + Desktop of the app: 40 + 10 + 7 + 100. Another app's 999 is not in it.
  assert.equal(find(p, 'subscriptions_active'), 157);
  assert.equal(find(p, 'subscriptions_active_trial'), 5 + 1 + 2);
  assert.equal(find(p, 'subscriptions_active_offer'), 2 + 3);
  // The product of the Products snapshot, else the Subscription Apple ID.
  assert.equal(find(p, 'subscriptions_active', 'product:pro_monthly'), 50);
  assert.equal(find(p, 'subscriptions_active', 'product:6002'), 107);
  assert.equal(find(p, 'subscriptions_active', 'duration:1 Month'), 50);
  assert.equal(find(p, 'subscriptions_active', 'duration:1 Year'), 107);
  assert.ok(p.every((x) => x.date === DAY));
  assert.equal(r.stats.rowsRead, 5);
  assert.equal(r.stats.rowsUsed, 4);
  assert.equal(r.stats.rowsFiltered, 1);
});

test('mapAppleSubscriptionTable: a macOS record keeps Desktop rows, an iOS record leaves them out; a table without the columns is refused', () => {
  const mac = mapAppleSubscriptionTable(parseTable(SUBSCRIPTION), { appleId: APP, date: DAY, platform: 'macos' });
  assert.equal(find(mac.points, 'subscriptions_active'), 100);
  const ios = mapAppleSubscriptionTable(parseTable(SUBSCRIPTION), { appleId: APP, date: DAY, platform: 'ios' });
  assert.equal(find(ios.points, 'subscriptions_active'), 57);
  assert.throws(
    () => mapAppleSubscriptionTable(parseTable('A\tB\n1\t2\n'), { appleId: APP, date: DAY }),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
});

test('events: new, cancelled and trial conversions are classified from the names; everything else is not counted', () => {
  for (const e of ['Subscribe', 'Opt-In', 'Start Introductory Offer', 'Start Offer Code'])
    assert.equal(subscriptionEventKind(e), 'new', e);
  for (const e of ['Cancel', 'Canceled from Billing Retry', 'Canceled from Billing Grace Period', 'Canceled After Renewal Extension'])
    assert.equal(subscriptionEventKind(e), 'cancelled', e);
  assert.equal(subscriptionEventKind('Paid Subscription from Introductory Offer', 'Free Trial'), 'trial_conversion');
  assert.equal(subscriptionEventKind('Paid Subscription from Introductory Offer', 'Pay Up Front'), 'other');
  assert.equal(subscriptionEventKind('Paid Subscription from Introductory Offer'), 'other');
  for (const e of ['Renew', 'Reactivate', 'Refund', 'Billing Retry from Paid Subscription', 'Upgrade', 'Crossgrade', 'Renewal from Billing Retry'])
    assert.equal(subscriptionEventKind(e), 'other', e);
});

const EVENT_HEADER = [
  'Event Date',
  'Event',
  'App Name',
  'App Apple ID',
  'Subscription Name',
  'Subscription Apple ID',
  'Subscription Group ID',
  'Standard Subscription Duration',
  'Subscription Offer Type',
  'Subscription Offer Duration',
  'Device',
  'Country',
  'Cancellation Reason',
  'Quantity',
];
const ev = (event: string, app: string, subId: string, duration: string, offer: string, device: string, quantity: string) => [
  '2026-11-10',
  event,
  'App',
  app,
  'Pro',
  subId,
  '1',
  duration,
  offer,
  '',
  device,
  'US',
  '',
  quantity,
];
const EVENTS = fx.tsv([
  EVENT_HEADER,
  ev('Subscribe', APP, '6001', '1 Month', '', 'iPhone', '4'),
  ev('Start Introductory Offer', APP, '6001', '1 Month', 'Free Trial', 'iPhone', '6'),
  ev('Cancel', APP, '6001', '1 Month', '', 'iPhone', '3'),
  ev('Canceled from Billing Retry', APP, '6002', '1 Year', '', 'iPad', '1'),
  ev('Paid Subscription from Introductory Offer', APP, '6001', '1 Month', 'Free Trial', 'iPhone', '2'),
  ev('Paid Subscription from Introductory Offer', APP, '6001', '1 Month', 'Pay Up Front', 'iPhone', '5'),
  ev('Renew', APP, '6001', '1 Month', '', 'iPhone', '50'),
  ev('Subscribe', '555', '7001', '1 Month', '', 'iPhone', '99'),
  ev('Subscribe', APP, '6002', '1 Year', '', 'Desktop', '1'),
  ev('Cancel', APP, '6002', '1 Year', '', 'iPhone', 'many'),
]);

test('mapAppleSubscriptionEventTable: Quantity is summed per kind, for the app, its products and its durations', () => {
  const r = mapAppleSubscriptionEventTable(parseTable(EVENTS), {
    appleId: APP,
    date: DAY,
    productOf: (id) => (id === '6001' ? 'pro_monthly' : undefined),
  });
  const p = r.points;
  assert.equal(find(p, 'subscriptions_new'), 4 + 6 + 1);
  assert.equal(find(p, 'subscriptions_new', 'product:pro_monthly'), 10);
  assert.equal(find(p, 'subscriptions_new', 'duration:1 Year'), 1);
  assert.equal(find(p, 'subscriptions_cancelled'), 3 + 1);
  assert.equal(find(p, 'subscriptions_cancelled', 'product:6002'), 1);
  assert.equal(find(p, 'subscriptions_trial_conversions'), 2);
  // The renewal, the conversion from a paid offer, the other app and the unreadable quantity are not counted.
  assert.equal(r.stats.rowsRead, 10);
  assert.equal(r.stats.rowsUsed, 6);
  assert.equal(r.stats.rowsUnreadable, 1);
  assert.equal(r.stats.rowsFiltered, 3);
  const mac = mapAppleSubscriptionEventTable(parseTable(EVENTS), { appleId: APP, date: DAY, platform: 'macos' });
  assert.equal(find(mac.points, 'subscriptions_new'), 1);
  assert.throws(
    () => mapAppleSubscriptionEventTable(parseTable('A\tB\n1\t2\n'), { appleId: APP, date: DAY }),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
});
