import { addDays, daysBetween } from '@mrm/core';
import type {
  AnalyticsNote,
  AnalyticsOverview,
  AnalyticsSeries,
  AnalyticsStatus,
  SourceStatus,
} from './analytics.ts';

/**
 * Made-up analytics answers for TESTS ONLY (and for a person who wants to paste one into the browser to look at the data
 * views, since the screen has no fixture mode of its own). Nothing in the app imports this file. The numbers are not from any
 * store; the shapes are those of docs/api/analytics.md.
 */

export const FROM = '2026-10-22';
export const TO = '2026-11-18';
export const NOW = Date.parse('2026-11-19T12:00:00Z');
export const DAYS = daysBetween(FROM, TO) + 1;

export const dayList = (from: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(from, i));

const note = (code: string): AnalyticsNote => ({ code, message: `server text for ${code}` });

type Spec = {
  id: string;
  metric?: string;
  label: string;
  unit: AnalyticsSeries['unit'];
  aggregation?: AnalyticsSeries['aggregation'];
  source: string;
  values: (number | null)[];
  delayDays?: number;
  derived?: boolean;
  currency?: string | null;
  notes?: string[];
  from?: string;
  breakdown?: AnalyticsSeries['breakdown'];
};

export function mkSeries(spec: Spec): AnalyticsSeries {
  const from = spec.from ?? FROM;
  const aggregation = spec.aggregation ?? 'sum';
  const points = spec.values.map((value, i) => ({ date: addDays(from, i), value }));
  const present = points.filter((p) => p.value !== null) as { date: string; value: number }[];
  const first = present[0]?.date ?? null;
  const last = present[present.length - 1]?.date ?? null;
  const gapDays = first && last ? daysBetween(first, last) + 1 - present.length : 0;
  const sum = present.reduce((a, p) => a + p.value, 0);
  return {
    id: spec.id,
    metric: spec.metric ?? spec.id,
    label: spec.label,
    unit: spec.unit,
    aggregation,
    source: spec.source,
    derived: spec.derived ?? false,
    currency: spec.currency ?? null,
    delayDays: spec.delayDays ?? 3,
    total: present.length === 0 ? null : aggregation === 'sum' ? sum : sum / present.length,
    points,
    coverage: {
      state: present.length === 0 ? 'none' : gapDays > 0 ? 'partial' : 'complete',
      firstDay: first,
      lastDay: last,
      days: present.length,
      gapDays,
      notes: (spec.notes ?? []).map(note),
    },
    ...(spec.breakdown ? { breakdown: spec.breakdown } : {}),
  };
}

/** A deterministic wave, so tests do not depend on a random number. */
export const wave = (count: number, base: number, amplitude: number, phase = 0): number[] =>
  Array.from({ length: count }, (_, i) => Math.round(base + amplitude * Math.sin((i + phase) / 3)));

const ratio = (num: (number | null)[], den: (number | null)[]): (number | null)[] =>
  num.map((n, i) =>
    n === null || den[i] === null || (den[i] as number) <= 0 ? null : n / (den[i] as number),
  );

/** An iOS overview for the 28 days up to 2026-11-18, with a gap of two days (Nov 3 and 4) and nothing for the last day. */
export function appleOverview(options: { gap?: boolean; empty?: boolean } = {}): AnalyticsOverview {
  const n = DAYS;
  const hole = (values: number[]): (number | null)[] =>
    values.map((v, i) =>
      options.empty ? null : options.gap && (i === 12 || i === 13) ? null : i === n - 1 ? null : v,
    );
  const impressions = hole(wave(n, 2400, 500));
  const views = hole(wave(n, 380, 80, 1));
  const first = hole(wave(n, 90, 25, 2));
  const again = hole(wave(n, 30, 10, 3));
  const sessions = hole(wave(n, 1200, 200));
  const crashes = hole(wave(n, 12, 4));
  const sales = hole(wave(n, 40, 8));
  const eur = hole(wave(n, 60, 12)).map((v) => (v === null ? null : v + 0.25));
  const usd = hole(wave(n, 25, 6)).map((v) => (v === null ? null : v + 0.5));
  const appleNotes = ['apple_privacy_thresholds', 'apple_counts_not_unique'];
  const series = [
    mkSeries({
      id: 'impressions',
      label: 'Impressions',
      unit: 'count',
      source: 'apple_analytics',
      values: impressions,
      notes: appleNotes,
    }),
    mkSeries({
      id: 'product_page_views',
      label: 'Product page views',
      unit: 'count',
      source: 'apple_analytics',
      values: views,
      notes: appleNotes,
    }),
    mkSeries({
      id: 'downloads_first_time',
      label: 'First-time downloads',
      unit: 'count',
      source: 'apple_analytics',
      delayDays: 2,
      values: first,
      notes: ['apple_privacy_thresholds'],
    }),
    mkSeries({
      id: 'downloads_redownload',
      label: 'Redownloads',
      unit: 'count',
      source: 'apple_analytics',
      delayDays: 2,
      values: again,
      notes: ['apple_privacy_thresholds'],
    }),
    mkSeries({
      id: 'sessions',
      label: 'Sessions',
      unit: 'count',
      source: 'apple_analytics',
      delayDays: 5,
      values: sessions,
      notes: ['apple_usage_opt_in_only', 'apple_usage_sample_not_total'],
    }),
    mkSeries({
      id: 'crashes',
      label: 'Crashes',
      unit: 'count',
      source: 'apple_analytics',
      delayDays: 5,
      values: crashes,
      notes: ['apple_usage_opt_in_only', 'apple_usage_sample_not_total'],
      breakdown: {
        dimension: 'app_version',
        items: [
          { value: '2.4.1', total: 210 },
          { value: '2.4.0', total: 96 },
          { value: '2.3.9', total: 12 },
        ],
      },
    }),
    mkSeries({
      id: 'sales_units',
      label: 'Units',
      unit: 'count',
      source: 'apple_sales',
      delayDays: 1,
      values: sales,
      notes: ['apple_estimates'],
    }),
    mkSeries({
      id: 'sales_proceeds:EUR',
      metric: 'sales_proceeds',
      label: 'Proceeds (EUR)',
      unit: 'money',
      source: 'apple_sales',
      delayDays: 1,
      currency: 'EUR',
      values: eur,
      notes: ['apple_proceeds_per_currency'],
    }),
    mkSeries({
      id: 'sales_proceeds:USD',
      metric: 'sales_proceeds',
      label: 'Proceeds (USD)',
      unit: 'money',
      source: 'apple_sales',
      delayDays: 1,
      currency: 'USD',
      values: usd,
      notes: ['apple_proceeds_per_currency'],
    }),
    mkSeries({
      id: 'product_page_conversion',
      label: 'Product page conversion',
      unit: 'ratio',
      aggregation: 'mean',
      source: 'apple_analytics',
      derived: true,
      values: ratio(first, views),
      notes: ['derived'],
    }),
    mkSeries({
      id: 'impression_tap_rate',
      label: 'Tap-through rate',
      unit: 'ratio',
      aggregation: 'mean',
      source: 'apple_analytics',
      derived: true,
      values: ratio(views, impressions),
      notes: ['derived'],
    }),
  ];
  return {
    appId: 'app-ios',
    platform: 'ios',
    from: FROM,
    to: TO,
    granularity: 'day',
    series,
    notes: [note('apple_rating_history_not_available')],
  };
}

export function androidOverview(options: { empty?: boolean } = {}): AnalyticsOverview {
  const n = DAYS;
  const maybe = (values: number[]): (number | null)[] =>
    values.map((v) => (options.empty ? null : v));
  const crash = maybe(wave(n, 120, 30).map((v) => v / 10000));
  const anr = maybe(wave(n, 40, 12, 2).map((v) => v / 10000));
  const visitors = maybe(wave(n, 300, 60));
  const acquisitions = maybe(wave(n, 80, 20, 1));
  const rating = maybe(wave(n, 430, 15).map((v) => v / 100));
  const series = [
    mkSeries({
      id: 'installs_user',
      label: 'User installs',
      unit: 'count',
      source: 'play_reports',
      delayDays: 7,
      values: maybe(wave(n, 70, 20)),
      notes: ['google_monthly_files'],
    }),
    mkSeries({
      id: 'crash_rate',
      label: 'Crash rate',
      unit: 'ratio',
      aggregation: 'mean',
      source: 'play_vitals',
      delayDays: 2,
      values: crash,
      notes: ['google_unit_unverified'],
      breakdown: {
        dimension: 'app_version',
        items: [
          { value: '412', total: 0.0131 },
          { value: '410', total: 0.0094 },
        ],
      },
    }),
    mkSeries({
      id: 'anr_rate',
      label: 'ANR rate',
      unit: 'ratio',
      aggregation: 'mean',
      source: 'play_vitals',
      delayDays: 2,
      values: anr,
      notes: ['google_unit_unverified'],
    }),
    mkSeries({
      id: 'store_listing_visitors',
      label: 'Store listing visitors',
      unit: 'count',
      source: 'play_reports',
      delayDays: 7,
      values: visitors,
      notes: ['google_monthly_files', 'google_legacy_store_listing'],
    }),
    mkSeries({
      id: 'store_listing_acquisitions',
      label: 'Store listing acquisitions',
      unit: 'count',
      source: 'play_reports',
      delayDays: 7,
      values: acquisitions,
      notes: ['google_monthly_files', 'google_legacy_store_listing'],
    }),
    mkSeries({
      id: 'rating_average_total',
      label: 'Average rating, all time',
      unit: 'rating',
      aggregation: 'mean',
      source: 'play_reports',
      delayDays: 7,
      values: rating,
      notes: ['google_monthly_files', 'google_rating_average_only'],
    }),
    mkSeries({
      id: 'product_page_conversion',
      label: 'Store listing conversion',
      unit: 'ratio',
      aggregation: 'mean',
      source: 'play_reports',
      delayDays: 7,
      derived: true,
      values: ratio(acquisitions, visitors),
      notes: ['derived'],
    }),
  ];
  return {
    appId: 'app-android',
    platform: 'android',
    from: FROM,
    to: TO,
    granularity: 'day',
    series,
    notes: [note('google_no_impressions')],
  };
}

export function sourceOf(partial: Partial<SourceStatus> & { source: string }): SourceStatus {
  return {
    label: partial.source,
    state: 'ready',
    setup: null,
    lastAttemptAt: NOW - 3_600_000,
    lastOkAt: NOW - 3_600_000,
    lastError: null,
    firstDay: '2026-10-25',
    lastDay: '2026-11-16',
    ...partial,
  };
}

export function statusOf(partial: Partial<AnalyticsStatus> = {}): AnalyticsStatus {
  return {
    appId: 'app-ios',
    platform: 'ios',
    enabled: true,
    schedule: { intervalMinutes: 360 },
    apple: { mode: 'ongoing', requests: [], vendorNumberSet: true },
    google: null,
    sources: [
      sourceOf({ source: 'apple_analytics', label: 'App Store analytics reports' }),
      sourceOf({ source: 'apple_sales', label: 'Sales and Trends' }),
    ],
    runs: [],
    ...partial,
  };
}

/** Google Play estimated sales (buyer-paid, per currency of sale), to add to an Android overview. Made-up numbers. */
export function androidSalesSeries(): AnalyticsSeries[] {
  const n = DAYS;
  const notes = ['play_estimated_sales_gross', 'play_sales_per_currency', 'play_sales_latency'];
  const days = (base: number) => Array.from({ length: n }, (_, i) => base + (i % 5));
  return [
    mkSeries({
      id: 'sales_gross:EUR',
      metric: 'sales_gross',
      label: 'Sales, buyer-paid estimate (EUR)',
      unit: 'money',
      source: 'play_sales',
      delayDays: 7,
      currency: 'EUR',
      values: days(20),
      notes,
    }),
    mkSeries({
      id: 'sales_gross:USD',
      metric: 'sales_gross',
      label: 'Sales, buyer-paid estimate (USD)',
      unit: 'money',
      source: 'play_sales',
      delayDays: 7,
      currency: 'USD',
      values: days(30),
      notes,
    }),
    mkSeries({
      id: 'sales_refunds:EUR',
      metric: 'sales_refunds',
      label: 'Refunds, buyer-paid estimate (EUR)',
      unit: 'money',
      source: 'play_sales',
      delayDays: 7,
      currency: 'EUR',
      values: days(1),
      notes,
    }),
    mkSeries({
      id: 'sales_orders',
      label: 'Orders',
      unit: 'count',
      source: 'play_sales',
      delayDays: 7,
      values: days(5),
      notes: ['play_estimated_sales_gross', 'play_sales_latency'],
    }),
  ];
}
