import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  type AnalyticsNextStep,
  type AnalyticsSetupCode,
  type AnalyticsSource,
  addDays,
  analyticsDimensions,
  analyticsErrorMessages,
  analyticsMetrics,
  bucketStart,
  bucketStarts,
  type CoverageNoteCode,
  coverageNoteMessages,
  dateToDay,
  daysBetween,
  type Granularity,
  isAnalyticsErrorCode,
  isGranularity,
  isIsoDate,
  type MetricAggregation,
  type MetricUnit,
  metricInfo,
  type PlayBucketSource,
  safeRatio,
  sourcesForPlatform,
  splitProductDimValue,
  supports,
} from '@kiln/core';
import type { Sql } from '@kiln/db';
import type { ManagedApp } from '../../services/apps.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import { deriveSetup, type Setup, setupMessages } from './setup.ts';
import {
  type DailyRow,
  dayBounds,
  getAppConfig,
  getSourceStates,
  listReportRequests,
  readDaily,
  recentRuns,
  resolvePlayBucket,
} from './store.ts';

/**
 * The read side of analytics (docs/api/analytics.md): `overview` (series per metric with their source, delay and coverage) and
 * `status` (sources, last sync, setup needs). Nothing here reads a store: it works from what is stored.
 */

export const MAX_OVERVIEW_DAYS = 400;
export const DEFAULT_OVERVIEW_DAYS = 28;

type Issue = { path: string; message: string };
export type QueryFailure = {
  ok: false;
  status: 400;
  body: { error: string; message?: string; issues: Issue[] };
};

export type OverviewQuery = {
  platform?: string;
  from?: string;
  to?: string;
  granularity?: string;
  breakdown?: string;
};

export type Note = { code: CoverageNoteCode; message: string };
const note = (code: CoverageNoteCode): Note => ({ code, message: coverageNoteMessages[code] });

export type SeriesCoverage = {
  /** `complete`: no gap and the newest day is as new as the source's delay allows. `partial`: gaps or older data. `none`: no day in range. */
  state: 'complete' | 'partial' | 'none';
  firstDay: string | null;
  lastDay: string | null;
  /** Days with a value in the range. */
  days: number;
  /** Days between the first and last day with no value (months, for a series with `cadence: 'monthly'`). */
  gapDays: number;
  notes: Note[];
};

export type Series = {
  /** The metric, `sales_proceeds:EUR` or `sales_gross:EUR` for the money of one currency, or a derived id. */
  id: string;
  metric: AnalyticsMetric | 'product_page_conversion' | 'impression_tap_rate';
  label: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  /** The store source this series comes from (the numerator's source for a derived series). */
  source: AnalyticsSource;
  /**
   * `monthly`: one figure per calendar month, stored on the first day of the month (the Play Earnings report). Read it with
   * `granularity=month`; the coverage then counts months, not days. Absent for a daily series.
   */
  cadence?: 'monthly';
  derived: boolean;
  currency: string | null;
  /** Days after a date that the store may still change that day's value. */
  delayDays: number;
  /** The sum (counts, money) or the mean (rates, ratings) of the days in the range; null without data. */
  total: number | null;
  /** One entry per bucket from `from` to `to`; `value` is null where there is no data. */
  points: { date: string; value: number | null }[];
  coverage: SeriesCoverage;
  breakdown?: { dimension: AnalyticsDimension; items: { value: string; total: number }[] };
};

export type Overview = {
  appId: string;
  platform: string;
  from: string;
  to: string;
  granularity: Granularity;
  series: Series[];
  notes: Note[];
};

const staticNotes: Record<AnalyticsMetric, CoverageNoteCode[]> = {
  impressions: ['apple_privacy_thresholds', 'apple_counts_not_unique'],
  product_page_views: ['apple_privacy_thresholds', 'apple_counts_not_unique'],
  downloads_first_time: ['apple_privacy_thresholds'],
  downloads_redownload: ['apple_privacy_thresholds'],
  sessions: ['apple_usage_opt_in_only', 'apple_usage_sample_not_total', 'apple_privacy_thresholds'],
  crashes: ['apple_usage_opt_in_only', 'apple_usage_sample_not_total', 'apple_privacy_thresholds'],
  sales_units: ['apple_estimates', 'apple_pacific_time', 'apple_in_app_not_included'],
  sales_proceeds: ['apple_estimates', 'apple_proceeds_per_currency', 'apple_pacific_time'],
  sales_gross: [
    'play_estimated_sales_gross',
    'play_sales_per_currency',
    'play_sales_latency',
    'play_sales_utc',
  ],
  sales_refunds: [
    'play_estimated_sales_gross',
    'play_sales_per_currency',
    'play_sales_latency',
    'play_sales_utc',
  ],
  sales_orders: ['play_estimated_sales_gross', 'play_sales_latency', 'play_sales_utc'],
  earnings_net: [
    'play_earnings_monthly',
    'play_earnings_net',
    'play_earnings_per_currency',
    'play_earnings_pacific',
  ],
  earnings_charges: [
    'play_earnings_monthly',
    'play_earnings_per_currency',
    'play_earnings_pacific',
  ],
  earnings_taxes: ['play_earnings_monthly', 'play_earnings_per_currency', 'play_earnings_pacific'],
  earnings_fees: ['play_earnings_monthly', 'play_earnings_per_currency', 'play_earnings_pacific'],
  earnings_orders: ['play_earnings_monthly', 'play_earnings_pacific'],
  subscriptions_active: ['apple_subscription_counts'],
  subscriptions_active_offer: ['apple_subscription_counts'],
  subscriptions_active_trial: ['apple_subscription_counts'],
  subscriptions_new: ['apple_subscription_counts', 'apple_subscription_events'],
  subscriptions_cancelled: ['apple_subscription_counts', 'apple_subscription_events'],
  subscriptions_trial_conversions: ['apple_subscription_counts', 'apple_subscription_events'],
  play_subscriptions_active: ['play_subscription_stats', 'google_monthly_files'],
  play_subscriptions_new: ['play_subscription_stats', 'google_monthly_files'],
  play_subscriptions_cancelled: ['play_subscription_stats', 'google_monthly_files'],
  crash_rate: ['google_unit_unverified'],
  anr_rate: ['google_unit_unverified'],
  installs_user: ['google_monthly_files'],
  installs_device: ['google_monthly_files'],
  uninstalls_device: ['google_monthly_files'],
  active_installs_device: ['google_monthly_files'],
  rating_average_daily: ['google_monthly_files', 'google_rating_average_only'],
  rating_average_total: ['google_monthly_files', 'google_rating_average_only'],
  store_listing_visitors: ['google_monthly_files', 'google_legacy_store_listing'],
  store_listing_acquisitions: ['google_monthly_files', 'google_legacy_store_listing'],
};

const aggregate = (values: number[], how: MetricAggregation): number | null =>
  values.length === 0
    ? null
    : how === 'sum'
      ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length;

/** Day values (sorted by day) combined into buckets; a bucket with no day is null. */
function bucketValues(
  days: Map<string, number>,
  buckets: string[],
  granularity: Granularity,
  how: MetricAggregation,
): Map<string, number | null> {
  const grouped = new Map<string, number[]>();
  for (const [day, value] of days) {
    const key = bucketStart(day, granularity);
    const list = grouped.get(key);
    if (list) list.push(value);
    else grouped.set(key, [value]);
  }
  return new Map(buckets.map((b) => [b, aggregate(grouped.get(b) ?? [], how)]));
}

export function checkOverviewQuery(
  app: Pick<ManagedApp, 'platform'>,
  query: OverviewQuery,
  now: number,
):
  | { ok: true; from: string; to: string; granularity: Granularity; breakdown?: AnalyticsDimension }
  | QueryFailure {
  const issues: Issue[] = [];
  if (query.platform !== undefined && query.platform !== '' && query.platform !== app.platform) {
    issues.push({
      path: 'platform',
      message: `This app is ${app.platform}. Leave platform out or use ${app.platform}.`,
    });
  }
  const today = dateToDay(now);
  let granularity: Granularity = 'day';
  if (query.granularity !== undefined && query.granularity !== '') {
    if (isGranularity(query.granularity)) granularity = query.granularity;
    else issues.push({ path: 'granularity', message: 'Use day, week or month.' });
  }
  let to = addDays(today, -1);
  if (query.to !== undefined && query.to !== '') {
    if (isIsoDate(query.to)) to = query.to > today ? today : query.to;
    else issues.push({ path: 'to', message: 'Use a date written YYYY-MM-DD.' });
  }
  let from = addDays(to, -(DEFAULT_OVERVIEW_DAYS - 1));
  if (query.from !== undefined && query.from !== '') {
    if (isIsoDate(query.from)) from = query.from;
    else issues.push({ path: 'from', message: 'Use a date written YYYY-MM-DD.' });
  }
  if (issues.length === 0) {
    if (from > to) issues.push({ path: 'from', message: 'from must not be after to.' });
    else if (daysBetween(from, to) + 1 > MAX_OVERVIEW_DAYS)
      issues.push({ path: 'from', message: `At most ${MAX_OVERVIEW_DAYS} days at a time.` });
  }
  let breakdown: AnalyticsDimension | undefined;
  if (query.breakdown !== undefined && query.breakdown !== '') {
    if ((analyticsDimensions as readonly string[]).includes(query.breakdown))
      breakdown = query.breakdown as AnalyticsDimension;
    else
      issues.push({ path: 'breakdown', message: `Use one of ${analyticsDimensions.join(', ')}.` });
  }
  if (issues.length > 0)
    return { ok: false, status: 400, body: { error: 'invalid_request', issues } };
  return { ok: true, from, to, granularity, ...(breakdown ? { breakdown } : {}) };
}

type CoverageInput = {
  days: Map<string, number>;
  from: string;
  to: string;
  delayDays: number;
  today: string;
  connected: boolean;
  hasHistory: boolean;
  imported: boolean;
  notes: CoverageNoteCode[];
  sourceOldestDay: string | null;
  /** One figure per calendar month, on its first day: gaps and freshness are counted in months. */
  monthly?: boolean;
};

const monthIndex = (day: string): number => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));

/**
 * The first day of the newest month whose Earnings report should be out by `today`: Google posts a month's report "by the 5th of the
 * following month", so the report of month M is expected from about the 6th of month M+1.
 */
export function newestExpectedMonth(today: string): string {
  const current = bucketStart(addDays(today, -6), 'month');
  const y = Number(current.slice(0, 4));
  const m = Number(current.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

function coverageOf(input: CoverageInput): SeriesCoverage {
  const notes: CoverageNoteCode[] = [...input.notes];
  const sorted = [...input.days.keys()].sort();
  const firstDay = sorted[0] ?? null;
  const lastDay = sorted[sorted.length - 1] ?? null;
  const gapDays =
    firstDay && lastDay
      ? (input.monthly
          ? monthIndex(lastDay) - monthIndex(firstDay)
          : daysBetween(firstDay, lastDay)) +
        1 -
        sorted.length
      : 0;
  let state: SeriesCoverage['state'] = 'none';
  if (sorted.length > 0) {
    const fresh = input.monthly
      ? lastDay !== null &&
        lastDay >= [newestExpectedMonth(input.today), bucketStart(input.to, 'month')].sort()[0]!
      : lastDay !== null && lastDay >= addDays(input.to, -input.delayDays);
    state = gapDays === 0 && fresh ? 'complete' : 'partial';
    if (gapDays > 0 && !input.monthly) notes.push('gaps');
    if (input.imported) notes.push('imported');
    if (input.sourceOldestDay !== null && input.from < input.sourceOldestDay)
      notes.push('only_since_connected');
  } else if (!input.connected && !input.hasHistory) notes.push('source_not_connected');
  else notes.push('no_data_yet');
  if (!input.monthly && addDays(input.today, -input.delayDays) < input.to)
    notes.push('recent_days_incomplete');
  return {
    state,
    firstDay,
    lastDay,
    days: sorted.length,
    gapDays,
    notes: [...new Set(notes)].map(note),
  };
}

export async function overview(
  sql: Sql,
  input: {
    workspaceId: string;
    app: ManagedApp;
    from: string;
    to: string;
    granularity: Granularity;
    breakdown?: AnalyticsDimension;
    now: number;
  },
): Promise<Overview> {
  const { app } = input;
  const today = dateToDay(input.now);
  const buckets = bucketStarts(input.from, input.to, input.granularity);
  const sources = sourcesForPlatform(app.platform);
  const base = {
    workspaceId: input.workspaceId,
    appId: app.id,
    platform: app.platform,
    from: input.from,
    to: input.to,
  };
  const totals = await readDaily(sql, base);
  const currency = await readDaily(sql, { ...base, dimension: 'currency' });
  const bounds = await dayBounds(sql, {
    workspaceId: input.workspaceId,
    appId: app.id,
    platform: app.platform,
  });
  const states = await getSourceStates(sql, input.workspaceId, app.id, app.platform);
  const broken = input.breakdown
    ? await readDaily(sql, { ...base, dimension: input.breakdown })
    : [];

  const byMetric = (rows: DailyRow[]) => {
    const map = new Map<string, DailyRow[]>();
    for (const r of rows) {
      const list = map.get(r.metric);
      if (list) list.push(r);
      else map.set(r.metric, [r]);
    }
    return map;
  };
  const totalRows = byMetric(totals);
  const currencyRows = byMetric(currency);
  const brokenRows = byMetric(broken);

  const series: Series[] = [];
  const bucketed = new Map<string, Map<string, number | null>>();
  const dayMaps = new Map<string, Map<string, number>>();

  const build = (metric: AnalyticsMetric, rows: DailyRow[], id: string, cur: string | null) => {
    const info = metricInfo[metric];
    const days = new Map<string, number>();
    for (const r of rows) days.set(r.day, r.value);
    const values = bucketValues(days, buckets, input.granularity, info.aggregation);
    const state = states.get(info.source);
    const connected = state?.lastOkAt !== null && state?.lastOkAt !== undefined;
    const item: Series = {
      id,
      metric,
      label: cur ? `${info.label} (${cur})` : info.label,
      unit: info.unit,
      aggregation: info.aggregation,
      source: info.source,
      ...(info.cadence ? { cadence: info.cadence } : {}),
      derived: false,
      currency: cur,
      delayDays: info.delayDays,
      total: aggregate([...days.values()], info.aggregation),
      points: buckets.map((date) => ({ date, value: values.get(date) ?? null })),
      coverage: coverageOf({
        days,
        from: input.from,
        to: input.to,
        delayDays: info.delayDays,
        today,
        connected,
        hasHistory: bounds.has(info.source),
        imported: rows.some((r) => r.origin === 'import'),
        notes: staticNotes[metric],
        sourceOldestDay: state?.oldestDay ?? null,
        ...(info.cadence === 'monthly' ? { monthly: true } : {}),
      }),
    };
    const dim = brokenRows.get(metric);
    if (input.breakdown && dim && dim.length > 0) {
      const sums = new Map<string, number[]>();
      for (const r of dim) {
        let value = r.dimValue;
        if (input.breakdown === 'product' && info.unit === 'money') {
          // A money value of a product is keyed `<CUR>:<product id>`: only this series' currency counts, and the id is shown.
          const split = splitProductDimValue(value, true);
          if (split.currency !== cur) continue;
          value = split.productId;
        }
        const list = sums.get(value);
        if (list) list.push(r.value);
        else sums.set(value, [r.value]);
      }
      if (sums.size === 0) {
        series.push(item);
        bucketed.set(id, values);
        dayMaps.set(id, days);
        return;
      }
      const items = [...sums.entries()]
        .map(([value, list]) => ({ value, total: aggregate(list, info.aggregation) ?? 0 }))
        .sort((a, b) => b.total - a.total || (a.value < b.value ? -1 : 1))
        .slice(0, 10);
      item.breakdown = { dimension: input.breakdown, items };
    }
    series.push(item);
    bucketed.set(id, values);
    dayMaps.set(id, days);
  };

  for (const metric of analyticsMetrics) {
    if (!sources.includes(metricInfo[metric].source)) continue;
    if (metricInfo[metric].unit === 'money') {
      const rows = currencyRows.get(metric) ?? [];
      const codes = [...new Set(rows.map((r) => r.dimValue))].sort();
      if (codes.length === 0) build(metric, [], metric, null);
      for (const code of codes)
        build(
          metric,
          rows.filter((r) => r.dimValue === code),
          `${metric}:${code}`,
          code,
        );
      continue;
    }
    build(metric, totalRows.get(metric) ?? [], metric, null);
  }

  // Derived series: ratios of two stored series, null where the denominator is missing or zero.
  const derive = (
    id: 'product_page_conversion' | 'impression_tap_rate',
    label: string,
    num: AnalyticsMetric,
    den: AnalyticsMetric,
  ) => {
    const n = bucketed.get(num);
    const d = bucketed.get(den);
    if (!n || !d) return;
    const numeratorSource = metricInfo[num].source;
    const days = new Map<string, number>();
    const nd = dayMaps.get(num) ?? new Map<string, number>();
    const dd = dayMaps.get(den) ?? new Map<string, number>();
    for (const [day, value] of nd) {
      const r = safeRatio(value, dd.get(day) ?? null);
      if (r !== null) days.set(day, r);
    }
    const points = buckets.map((date) => ({
      date,
      value: safeRatio(n.get(date) ?? null, d.get(date) ?? null),
    }));
    const delay = Math.max(metricInfo[num].delayDays, metricInfo[den].delayDays);
    const state = states.get(numeratorSource);
    const totalNum = series.find((s) => s.id === num)?.total ?? null;
    const totalDen = series.find((s) => s.id === den)?.total ?? null;
    series.push({
      id,
      metric: id,
      label,
      unit: 'ratio',
      aggregation: 'mean',
      source: numeratorSource,
      derived: true,
      currency: null,
      delayDays: delay,
      total: safeRatio(totalNum, totalDen),
      points,
      coverage: coverageOf({
        days,
        from: input.from,
        to: input.to,
        delayDays: delay,
        today,
        connected: state?.lastOkAt !== null && state?.lastOkAt !== undefined,
        hasHistory: bounds.has(numeratorSource),
        imported: false,
        notes: ['derived'],
        sourceOldestDay: state?.oldestDay ?? null,
      }),
    });
  };
  if (supports(app.platform, 'playReportsBucket')) {
    derive(
      'product_page_conversion',
      'Store listing conversion',
      'store_listing_acquisitions',
      'store_listing_visitors',
    );
  } else {
    derive(
      'product_page_conversion',
      'Product page conversion',
      'downloads_first_time',
      'product_page_views',
    );
    derive('impression_tap_rate', 'Tap-through rate', 'product_page_views', 'impressions');
  }

  const notes: Note[] = supports(app.platform, 'playReportsBucket')
    ? [note('google_no_impressions')]
    : [note('apple_rating_history_not_available')];
  return {
    appId: app.id,
    platform: app.platform,
    from: input.from,
    to: input.to,
    granularity: input.granularity,
    series,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Status

export type SourceStatus = {
  source: AnalyticsSource;
  label: string;
  /** `off`: analytics is off in the workspace. `needs_setup`: see `setup`. `waiting`: set up, no data yet. `error`: the last read failed. `ready`: data is flowing. */
  state: 'off' | 'needs_setup' | 'waiting' | 'error' | 'ready';
  setup: {
    code: AnalyticsSetupCode;
    nextStep: AnalyticsNextStep;
    alternatives: AnalyticsNextStep[];
    optional: boolean;
    message: string;
  } | null;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  /** A code of the fixed vocabulary with its sentence, or null. */
  lastError: { code: string; message: string } | null;
  /** The first and last day stored for this source. */
  firstDay: string | null;
  lastDay: string | null;
};

export type AnalyticsStatus = {
  appId: string;
  platform: string;
  /** The workspace setting `analytics.enabled`. */
  enabled: boolean;
  schedule: { intervalMinutes: number };
  apple: {
    /** off, ongoing (a report request exists) or import (files are uploaded by hand). */
    mode: 'off' | 'ongoing' | 'import';
    requests: {
      accessType: string;
      status: string;
      createdAt: number;
      lastCheckedAt: number | null;
    }[];
    vendorNumberSet: boolean;
  } | null;
  google: { bucketIdSet: boolean; bucketSource: PlayBucketSource | null } | null;
  sources: SourceStatus[];
  runs: {
    source: AnalyticsSource;
    trigger: string;
    status: string;
    errorCode: string | null;
    pointsWritten: number;
    reportsRead: number;
    startedAt: number;
    finishedAt: number | null;
  }[];
};

const sourceLabels: Record<AnalyticsSource, string> = {
  apple_analytics: 'App Store analytics reports',
  apple_sales: 'Sales and Trends',
  play_vitals: 'Android vitals',
  play_reports: 'Play Console reports',
  play_sales: 'Play Console sales reports',
  apple_subscriptions: 'Subscription reports',
  play_earnings: 'Play Console earnings reports',
  play_subscriptions: 'Play Console subscription statistics',
};

export async function status(
  sql: Sql,
  input: { workspaceId: string; app: ManagedApp; intervalMinutes: number },
): Promise<AnalyticsStatus> {
  const { app, workspaceId } = input;
  const settings = (await getSettings(sql, workspaceId)).values;
  const enabled = settings['analytics.enabled'] === true;
  const vendorNumber = String(settings['analytics.appleVendorNumber'] ?? '');
  const config = await getAppConfig(sql, workspaceId, app.id);
  const { bucketId, source: bucketSource } = await resolvePlayBucket(sql, {
    workspaceId,
    app,
    settings,
  });
  const requests = await listReportRequests(sql, workspaceId, app.id);
  const states = await getSourceStates(sql, workspaceId, app.id, app.platform);
  const bounds = await dayBounds(sql, { workspaceId, appId: app.id, platform: app.platform });
  const runs = await recentRuns(sql, workspaceId, app.id, 10);
  const apple = supports(app.platform, 'appleAnalyticsReports');

  const sources: SourceStatus[] = sourcesForPlatform(app.platform).map((source) => {
    const state = states.get(source);
    const b = bounds.get(source);
    const setup: Setup | null = deriveSetup({
      source,
      enabled,
      appleMode: config.appleMode,
      requests,
      vendorNumber,
      bucketId,
      state,
      hasData: b !== undefined,
    });
    const errorCode = state?.lastErrorCode ?? null;
    let st: SourceStatus['state'];
    if (setup?.code === 'turn_on_analytics') st = 'off';
    else if (setup && !setup.optional && setup.code === 'waiting_first_data') st = 'waiting';
    else if (setup && setup.code !== 'first_sync_pending') st = 'needs_setup';
    else if (errorCode !== null) st = 'error';
    else if (b !== undefined) st = 'ready';
    else st = 'waiting';
    return {
      source,
      label: sourceLabels[source],
      state: st,
      setup: setup ? { ...setup, message: setupMessages[setup.code] } : null,
      lastAttemptAt: state?.lastAttemptAt ?? null,
      lastOkAt: state?.lastOkAt ?? null,
      lastError:
        errorCode === null
          ? null
          : {
              code: errorCode,
              message: isAnalyticsErrorCode(errorCode)
                ? analyticsErrorMessages[errorCode]
                : analyticsErrorMessages.sync_failed,
            },
      firstDay: b?.first ?? null,
      lastDay: b?.last ?? null,
    };
  });

  return {
    appId: app.id,
    platform: app.platform,
    enabled,
    schedule: { intervalMinutes: input.intervalMinutes },
    apple: apple
      ? {
          mode: requests.some((r) => r.status === 'active') ? 'ongoing' : config.appleMode,
          requests: requests.map((r) => ({
            accessType: r.accessType,
            status: r.status,
            createdAt: r.createdAt,
            lastCheckedAt: r.lastCheckedAt,
          })),
          vendorNumberSet: vendorNumber !== '',
        }
      : null,
    google: apple ? null : { bucketIdSet: bucketId !== null, bucketSource },
    sources,
    runs: runs.map((r) => ({
      source: r.source,
      trigger: r.trigger,
      status: r.status,
      errorCode: r.errorCode,
      pointsWritten: r.pointsWritten,
      reportsRead: r.reportsRead,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  };
}
