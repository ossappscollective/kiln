import {
  type AnalyticsErrorCode,
  type AnalyticsNextStep,
  type AnalyticsSetupCode,
  addDays,
  type CoverageNoteCode,
  dateToDay,
  daysBetween,
  isAnalyticsErrorCode,
  isIsoDate,
  type MetricAggregation,
  type MetricUnit,
  safeRatio,
} from '@kiln/core';
import { ApiError } from '../api.ts';
import { parseViewPath } from '../app-scope.ts';
import { formatCompact, formatCurrency, formatDate, formatNumber, formatPercent as formatPercentOf } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * Analytics in the web UI: the shapes of the API (docs/api/analytics.md), the date range kept in the address,
 * number and date formatting, the comparison with the previous period, the honesty lines (source, delay, coverage
 * notes) and the sentences for errors. Pure: no `window`, no `document`, no network. ES2017 library calls only.
 *
 * The rules this file keeps (docs/adr/0017-analytics-foundation.md, docs/research/analytics-apis.md):
 * - `null` is not zero. A missing value stays missing; a total over days with no data is never shown as 0.
 * - Nothing is converted or added across currencies, and nothing across platforms.
 * - Sentences come from fixed vocabularies (error, setup and coverage codes). An unknown code gets a plain generic
 *   sentence; store text is never shown.
 * - A comparison is only drawn when both periods have enough days; otherwise it says so.
 */

// ---------------------------------------------------------------------------------------------
// The API shapes

export type AnalyticsNote = { code: string; message: string };
export type SeriesCoverage = {
  state: 'complete' | 'partial' | 'none';
  firstDay: string | null;
  lastDay: string | null;
  days: number;
  gapDays: number;
  notes: AnalyticsNote[];
};
export type SeriesPoint = { date: string; value: number | null };
export type SeriesBreakdown = { dimension: string; items: { value: string; total: number }[] };

export type AnalyticsSeries = {
  /** The metric, `sales_proceeds:EUR` or `sales_gross:EUR` for one currency, or a derived id. */
  id: string;
  metric: string;
  label: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  source: string;
  derived: boolean;
  currency: string | null;
  delayDays: number;
  total: number | null;
  points: SeriesPoint[];
  coverage: SeriesCoverage;
  breakdown?: SeriesBreakdown;
  /** `monthly` for a figure the store reports once a month (Google Play earnings): each point is a month, dated the first of it. Absent for a daily series. */
  cadence?: 'monthly';
};

export type AnalyticsOverview = {
  appId: string;
  platform: string;
  from: string;
  to: string;
  granularity: string;
  series: AnalyticsSeries[];
  notes: AnalyticsNote[];
};

export type SourceState = 'off' | 'needs_setup' | 'waiting' | 'error' | 'ready';

export type SourceStatus = {
  source: string;
  label: string;
  state: SourceState;
  setup: {
    code: string;
    nextStep: string;
    alternatives: string[];
    optional: boolean;
    message: string;
  } | null;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: { code: string; message: string } | null;
  firstDay: string | null;
  lastDay: string | null;
};

export type AnalyticsRun = {
  source: string;
  trigger: string;
  status: string;
  errorCode: string | null;
  pointsWritten: number;
  reportsRead: number;
  startedAt: number;
  finishedAt: number | null;
};

export type AnalyticsStatus = {
  appId: string;
  platform: string;
  enabled: boolean;
  schedule: { intervalMinutes: number };
  apple: {
    mode: 'off' | 'ongoing' | 'import';
    requests: {
      accessType: string;
      status: string;
      createdAt: number;
      lastCheckedAt: number | null;
    }[];
    vendorNumberSet: boolean;
  } | null;
  google: { bucketIdSet: boolean; bucketSource?: 'app' | 'account' | 'workspace' | null } | null;
  sources: SourceStatus[];
  runs: AnalyticsRun[];
};

export type SyncSourceResult = {
  source: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped' | string;
  points?: number;
  reports?: number;
  dayFrom?: string | null;
  dayTo?: string | null;
  errorCode?: string;
  transient?: boolean;
  setup?: string;
};
export type AnalyticsSyncResult = {
  sync: { at: number; pointsWritten: number; sources: SyncSourceResult[] };
  status: AnalyticsStatus;
};

export type EnablePlan = {
  appId?: string;
  platform?: string;
  roleCheck: 'ok' | 'role_required' | string;
  steps: { accessType: string; action: 'create' | 'adopt' | 'exists' | string }[];
  willSend: string[];
  notes: string[];
};
export type EnablePreview = { plan: EnablePlan; confirmHash: string; canCreate: boolean };
export type EnableResult = {
  enabled: { appleMode: string; steps: { accessType: string; action: string }[] };
};

export type ImportMetric = { metric: string; label: string; days: number; total: number | null };
export type ImportPlan = {
  source: string;
  report: { kind: string; label: string };
  platform: string;
  stats: { rowsRead: number; rowsUsed: number; rowsUnreadable: number; rowsFiltered: number };
  dateFrom: string | null;
  dateTo: string | null;
  days: number;
  points: number;
  metrics: ImportMetric[];
  sample: unknown[];
  notes: unknown[];
};
export type ImportPreview = { plan: ImportPlan; confirmHash: string };
export type ImportResult = {
  imported: {
    source: string;
    points: number;
    written: number;
    unchanged: number;
    dateFrom: string | null;
    dateTo: string | null;
  };
};

// ---------------------------------------------------------------------------------------------
// The date range, kept in the address (`?range=7|28|90` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`)

export const PRESET_DAYS = [7, 28, 90] as const;
export type PresetDays = (typeof PRESET_DAYS)[number];
export type RangeChoice =
  | { kind: 'preset'; days: PresetDays }
  | { kind: 'custom'; from: string; to: string };
export const DEFAULT_RANGE: RangeChoice = { kind: 'preset', days: 28 };
/** The most days the API reads at a time. */
export const MAX_RANGE_DAYS = 400;

export type ResolvedRange = { from: string; to: string; days: number };

const isPreset = (n: number): n is PresetDays => (PRESET_DAYS as readonly number[]).indexOf(n) >= 0;

/** The range an address asks for. Anything that is not a clean preset or a valid custom range reads as the default. */
export function parseRange(hash: string): RangeChoice {
  const { query } = parseViewPath(hash);
  const preset = Number(query.get('range'));
  if (isPreset(preset)) return { kind: 'preset', days: preset };
  const from = query.get('from');
  const to = query.get('to');
  if (isIsoDate(from) && isIsoDate(to) && from <= to && daysBetween(from, to) + 1 <= MAX_RANGE_DAYS)
    return { kind: 'custom', from, to };
  return DEFAULT_RANGE;
}

/** The same address with another range; the default range leaves the address clean. Other query parts stay. */
export function withRange(hash: string, choice: RangeChoice): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.delete('range');
  params.delete('from');
  params.delete('to');
  if (choice.kind === 'custom') {
    params.set('from', choice.from);
    params.set('to', choice.to);
  } else if (choice.days !== 28) {
    params.set('range', String(choice.days));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

export const sameRange = (a: RangeChoice, b: RangeChoice): boolean =>
  a.kind === 'preset'
    ? b.kind === 'preset' && a.days === b.days
    : b.kind === 'custom' && a.from === b.from && a.to === b.to;

/** The dates a choice means on `now` (UTC days, as the API counts). A preset ends yesterday, like the API's default. */
export function resolveRange(choice: RangeChoice, now: number): ResolvedRange {
  const today = dateToDay(now);
  if (choice.kind === 'preset') {
    const to = addDays(today, -1);
    return { from: addDays(to, -(choice.days - 1)), to, days: choice.days };
  }
  const to = choice.to > today ? today : choice.to;
  const from = choice.from > to ? to : choice.from;
  return { from, to, days: daysBetween(from, to) + 1 };
}

/** The period of the same length that ends the day before `range` starts. */
export function previousRange(range: ResolvedRange): ResolvedRange {
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(range.days - 1)), to, days: range.days };
}

/** Why a custom range cannot be used, or '' when it can. */
export function customRangeProblem(from: string, to: string, now: number): string {
  if (!isIsoDate(from) || !isIsoDate(to)) return t('analytics:range.errBothDates');
  if (from > to) return t('analytics:range.errOrder');
  if (to > dateToDay(now)) return t('analytics:range.errFuture');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return t('analytics:range.errTooLong', { count: MAX_RANGE_DAYS });
  return '';
}

export const rangeText = (choice: RangeChoice, range: ResolvedRange): string =>
  choice.kind === 'preset'
    ? t('analytics:range.last', { count: choice.days })
    : t('analytics:range.fromTo', { from: formatDay(range.from, true), to: formatDay(range.to, true) });

// ---------------------------------------------------------------------------------------------
// Numbers and dates

/**
 * "Nov 17", or "Nov 17, 2026" with `withYear`, in the active language. The calendar day is read from the text of the date and
 * formatted in UTC, so no time zone can move it.
 */
export function formatDay(day: string, withYear = false): string {
  // A month ("2026-10", from `monthKey`) is named as one: "Oct 2026". It is never shown as a day.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(day)) {
    return formatDate(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, 1), { timeZone: 'UTC', month: 'short', year: 'numeric' });
  }
  if (!isIsoDate(day)) return day;
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return formatDate(at, withYear ? { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' } : { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

const group = (n: number): string => formatNumber(Math.round(n), { maximumFractionDigits: 0 });

/** Whole numbers with separators: 12,345. For tooltips and tables, where the exact number is wanted. */
export const formatCountExact = (n: number): string => (Number.isFinite(n) ? group(n) : '');

/** 1,284 / 12.9K / 4.2M: in full under 10,000, compact above. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a < 10_000) return group(n);
  return formatCompact(n);
}

/** A fraction as a percentage with the digits its size needs: 0.0123 is 1.23%, 0.2 is 20%. */
export function formatPercent(fraction: number, exact = false): string {
  if (!Number.isFinite(fraction)) return '';
  const a = Math.abs(fraction * 100);
  const digits = exact || (a > 0 && a < 1) ? 2 : a > 0 && a < 10 ? 1 : 0;
  return formatPercentOf(fraction, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const formatRating = (n: number): string => formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money in its own currency; never converted. A code the runtime does not know is written as text. */
export function formatMoney(n: number, currency: string | null, exact = false): string {
  return formatCurrency(n, currency, { digits: exact || Math.abs(n) < 1_000 ? 2 : 0 });
}

/** A value for a chip or an axis: compact. */
export function formatValue(
  unit: MetricUnit,
  value: number,
  currency: string | null = null,
): string {
  switch (unit) {
    case 'ratio':
      return formatPercent(value);
    case 'rating':
      return formatRating(value);
    case 'money':
      return formatMoney(value, currency);
    default:
      return formatCount(value);
  }
}

/** A value for a tooltip or a table: the exact number, with no rounding away of what the store gave. */
export function formatExact(
  unit: MetricUnit,
  value: number,
  currency: string | null = null,
): string {
  switch (unit) {
    case 'ratio':
      return formatPercent(value, true);
    case 'rating':
      return formatRating(value);
    case 'money':
      return formatMoney(value, currency, true);
    default:
      return Number.isInteger(value) ? formatCountExact(value) : value.toFixed(2);
  }
}

// ---------------------------------------------------------------------------------------------
// Series

export const hasData = (series: AnalyticsSeries | null | undefined): series is AnalyticsSeries =>
  !!series && series.points.some((p) => p.value !== null);

export const seriesOf = (
  overview: AnalyticsOverview | null | undefined,
  id: string,
): AnalyticsSeries | null => overview?.series.find((s) => s.id === id) ?? null;

/** The newest value that is not missing, or null. */
export function lastValue(series: AnalyticsSeries | null | undefined): number | null {
  if (!series) return null;
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const v = series.points[i]?.value;
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** An inclusive range of indexes. */
export type Run = { start: number; end: number };

/** The maximal runs of `true`. */
export function runsWhere(flags: readonly boolean[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i += 1) {
    const on = i < flags.length && flags[i] === true;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/** The stretches of a line that have values. A line is drawn per run, so a gap is a gap and never a bridge or a zero. */
export const presentRuns = (values: readonly (number | null)[]): Run[] =>
  runsWhere(values.map((v) => v !== null));
/** The stretches with no value: drawn as a hatched band, not as zero. */
export const missingRuns = (values: readonly (number | null)[]): Run[] =>
  runsWhere(values.map((v) => v === null));

/**
 * A ratio of two series computed here (not by the store), for example crashes per session. Null where either value is
 * missing or the denominator is zero. Marked `derived`, with the notes of both inputs.
 */
export function deriveRatioSeries(input: {
  id: string;
  label: string;
  numerator: AnalyticsSeries;
  denominator: AnalyticsSeries;
}): AnalyticsSeries {
  const { numerator: num, denominator: den } = input;
  const byDate = new Map<string, number | null>();
  for (const p of den.points) byDate.set(p.date, p.value);
  const points: SeriesPoint[] = num.points.map((p) => ({
    date: p.date,
    value: safeRatio(p.value, byDate.get(p.date) ?? null),
  }));
  const days = points.filter((p) => p.value !== null);
  const first = days[0]?.date ?? null;
  const last = days[days.length - 1]?.date ?? null;
  const gapDays = first && last ? daysBetween(first, last) + 1 - days.length : 0;
  const codes: string[] = [];
  for (const n of [...num.coverage.notes, ...den.coverage.notes])
    if (n.code !== 'gaps' && n.code !== 'derived' && codes.indexOf(n.code) < 0) codes.push(n.code);
  codes.push('derived');
  if (gapDays > 0) codes.push('gaps');
  return {
    id: input.id,
    metric: input.id,
    label: input.label,
    unit: 'ratio',
    aggregation: 'mean',
    source: num.source,
    derived: true,
    currency: null,
    delayDays: Math.max(num.delayDays, den.delayDays),
    total: safeRatio(num.total, den.total),
    points,
    coverage: {
      state: days.length === 0 ? 'none' : gapDays > 0 ? 'partial' : 'complete',
      firstDay: first,
      lastDay: last,
      days: days.length,
      gapDays,
      notes: codes.map((code) => ({ code, message: noteText({ code, message: '' }) })),
    },
  };
}

/** Whether a day may still be changed by the store: it is no more than `delayDays` behind today. */
export const isProvisional = (day: string, today: string, delayDays: number): boolean =>
  daysBetween(day, today) <= delayDays;

// ---------------------------------------------------------------------------------------------
// The comparison with the previous period

export type Delta =
  | { kind: 'none'; reason: 'no_current' | 'no_previous' | 'not_enough_data' }
  | { kind: 'flat' }
  | { kind: 'change'; direction: 'up' | 'down'; text: string };

/** A period needs at least this share of its days to be compared with another. */
export const MIN_COVERAGE = 0.6;
/** And the two periods may differ by at most this share of the days, or a sum would compare unequal stretches. */
export const MAX_COVERAGE_DIFFERENCE = 0.15;

function deltaOfValues(unit: MetricUnit, current: number, previous: number): Delta {
  const sign = (n: number) => (n > 0 ? '+' : '-');
  if (unit === 'ratio') {
    const points = (current - previous) * 100;
    if (Math.abs(points) < 0.05) return { kind: 'flat' };
    return {
      kind: 'change',
      direction: points > 0 ? 'up' : 'down',
      text: `${sign(points)}${Math.abs(points).toFixed(1)} pts`,
    };
  }
  if (unit === 'rating') {
    const diff = current - previous;
    if (Math.abs(diff) < 0.05) return { kind: 'flat' };
    return {
      kind: 'change',
      direction: diff > 0 ? 'up' : 'down',
      text: `${sign(diff)}${Math.abs(diff).toFixed(2)}`,
    };
  }
  if (previous === 0) return { kind: 'none', reason: 'no_previous' };
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 1) return { kind: 'flat' };
  const a = Math.abs(pct);
  return {
    kind: 'change',
    direction: pct > 0 ? 'up' : 'down',
    text: `${sign(pct)}${a < 10 ? a.toFixed(1) : String(Math.round(a))}%`,
  };
}

/**
 * How this period compares with the previous one, from the totals the API gives (sum for counts and money, mean for rates).
 * Without enough days in either period the answer is "not enough data", never a percentage of a half-empty period.
 */
export function periodDelta(
  current: AnalyticsSeries | null,
  previous: AnalyticsSeries | null,
  days: number,
): Delta {
  if (!current || current.total === null) return { kind: 'none', reason: 'no_current' };
  if (!previous || previous.total === null) return { kind: 'none', reason: 'no_previous' };
  const need = current.aggregation === 'sum' ? Math.ceil(days * MIN_COVERAGE) : Math.min(3, days);
  if (current.coverage.days < need || previous.coverage.days < need)
    return { kind: 'none', reason: 'not_enough_data' };
  if (
    current.aggregation === 'sum' &&
    Math.abs(current.coverage.days - previous.coverage.days) > days * MAX_COVERAGE_DIFFERENCE
  ) {
    return { kind: 'none', reason: 'not_enough_data' };
  }
  return deltaOfValues(current.unit, current.total, previous.total);
}

/** The newest value now against the newest value of the previous period (a rating, which is a level and not a sum). */
export function levelDelta(
  current: AnalyticsSeries | null,
  previous: AnalyticsSeries | null,
): Delta {
  const now = lastValue(current);
  if (now === null || !current) return { kind: 'none', reason: 'no_current' };
  const before = lastValue(previous);
  if (before === null || !previous) return { kind: 'none', reason: 'no_previous' };
  return deltaOfValues(current.unit, now, before);
}

export type DeltaTone = 'ok' | 'bad' | 'neutral';
/** Green or red only by whether the direction is good for this measure (a crash rate that falls is good). */
export function deltaTone(delta: Delta, upIsGood: boolean): DeltaTone {
  if (delta.kind !== 'change') return 'neutral';
  return (delta.direction === 'up') === upIsGood ? 'ok' : 'bad';
}

/** The line next to a figure: "+12% vs previous 28 days", or what is missing. Empty when there is nothing worth saying. */
export function deltaLine(delta: Delta, days: number): string {
  switch (delta.kind) {
    case 'change':
      return t('analytics:delta.vsPrevious', { text: delta.text, count: days });
    case 'flat':
      return t('analytics:delta.same', { count: days });
    default:
      return delta.reason === 'not_enough_data' ? t('analytics:delta.notEnough') : '';
  }
}

/** The same for a screen reader: words and not a sign. */
export function deltaSpoken(delta: Delta, days: number): string {
  if (delta.kind === 'change')
    return delta.direction === 'up'
      ? t('analytics:delta.spokenUp', { text: delta.text.replace(/^[+-]/, ''), count: days })
      : t('analytics:delta.spokenDown', { text: delta.text.replace(/^[+-]/, ''), count: days });
  return deltaLine(delta, days);
}

// ---------------------------------------------------------------------------------------------
// Where a number comes from and how late it can be

const sourceKeys: Record<string, string> = {
  apple_analytics: k('analytics:source.appleAnalytics'),
  apple_sales: k('analytics:source.appleSales'),
  play_vitals: k('analytics:source.playVitals'),
  play_reports: k('analytics:source.playReports'),
  play_sales: k('analytics:source.playSales'),
  play_earnings: k('analytics:source.playEarnings'),
  apple_subscriptions: k('analytics:source.appleSubscriptions'),
  play_subscriptions: k('analytics:source.playSubscriptions'),
};

export const sourceLabel = (source: string): string => {
  const key = sourceKeys[source] ?? k('analytics:source.other');
  return t(key);
};

/** How late a source can be, as a sentence. `delayDays` is an upper bound ("complete within"). */
export function lagText(source: string, delayDays: number): string {
  const count = delayDays;
  switch (source) {
    case 'apple_analytics':
      return t('analytics:lag.appleAnalytics', { count });
    case 'apple_sales':
      return t('analytics:lag.appleSales');
    case 'play_vitals':
      return t('analytics:lag.playVitals', { count });
    case 'play_reports':
      return t('analytics:lag.playReports');
    case 'play_sales':
      return t('analytics:lag.playSales');
    case 'play_earnings':
      return t('analytics:lag.playEarnings');
    case 'apple_subscriptions':
      return t('analytics:lag.appleSubscriptions', { count });
    case 'play_subscriptions':
      return t('analytics:lag.playSubscriptions', { count });
    default:
      return t('analytics:lag.other', { count });
  }
}

/** "Data up to Nov 17. Apple reports can lag up to 3 days." */
export function freshnessLine(
  series: Pick<AnalyticsSeries, 'source' | 'delayDays' | 'coverage'> & { cadence?: 'monthly' | undefined },
): string {
  const lag = lagText(series.source, series.delayDays);
  // A monthly figure is named by its month, never by the first day it is stored on.
  const last = series.coverage.lastDay;
  return last
    ? t('analytics:freshness.dataUpTo', { date: series.cadence === 'monthly' ? formatDay(monthKey(last), true) : formatDay(last), lag })
    : t('analytics:freshness.noData', { lag });
}

/** "2026-10-01" to "2026-10": the key of the month a monthly figure is about. Anything else is returned as it is. */
export const monthKey = (day: string): string => (isIsoDate(day) ? day.slice(0, 7) : day);

/** The sentence of a coverage note, from the fixed vocabulary; an unknown code gets a generic one (the API's own text is not shown). */
export function noteText(note: AnalyticsNote): string {
  const key = (noteKeys as Record<string, string>)[note.code] ?? k('analytics:note.unknown');
  return t(key);
}

// ---------------------------------------------------------------------------------------------
// Errors, as sentences from the fixed vocabularies

const apiSentences: Record<string, string> = {
  analytics_disabled: k('analytics:apiError.analyticsDisabled'),
  sync_in_progress: k('analytics:apiError.syncInProgress'),
  plan_changed: k('analytics:apiError.planChanged'),
  confirm_mismatch: k('analytics:apiError.confirmMismatch'),
  payload_too_large: k('analytics:apiError.payloadTooLarge'),
  import_not_supported: k('analytics:apiError.importNotSupported'),
  not_apple_app: k('analytics:apiError.notAppleApp'),
  forbidden: k('analytics:apiError.forbidden'),
  not_found: k('analytics:apiError.notFound'),
  network: k('analytics:apiError.network'),
  invalid_request: k('analytics:apiError.invalidRequest'),
};

// The sentence of each code of the fixed vocabularies of `@kiln/core`, translated here (the English text is the core's).
const errorKeys: Record<AnalyticsErrorCode, string> = {
  analytics_role_required: k('analytics:error.analyticsRoleRequired'),
  analytics_request_missing: k('analytics:error.analyticsRequestMissing'),
  analytics_request_stopped: k('analytics:error.analyticsRequestStopped'),
  report_not_ready: k('analytics:error.reportNotReady'),
  segment_expired: k('analytics:error.segmentExpired'),
  segment_too_large: k('analytics:error.segmentTooLarge'),
  file_too_large: k('analytics:error.fileTooLarge'),
  bad_gzip: k('analytics:error.badGzip'),
  bad_zip: k('analytics:error.badZip'),
  period_required: k('analytics:error.periodRequired'),
  bad_format: k('analytics:error.badFormat'),
  unknown_report: k('analytics:error.unknownReport'),
  missing_columns: k('analytics:error.missingColumns'),
  no_rows: k('analytics:error.noRows'),
  vendor_number_missing: k('analytics:error.vendorNumberMissing'),
  vendor_number_invalid: k('analytics:error.vendorNumberInvalid'),
  sales_forbidden: k('analytics:error.salesForbidden'),
  play_reporting_not_enabled: k('analytics:error.playReportingNotEnabled'),
  play_permission_missing: k('analytics:error.playPermissionMissing'),
  play_app_not_found: k('analytics:error.playAppNotFound'),
  play_vitals_bad_request: k('analytics:error.playVitalsBadRequest'),
  play_vitals_no_data: k('analytics:error.playVitalsNoData'),
  bucket_missing: k('analytics:error.bucketMissing'),
  bucket_invalid: k('analytics:error.bucketInvalid'),
  bucket_forbidden: k('analytics:error.bucketForbidden'),
  bucket_not_found: k('analytics:error.bucketNotFound'),
  reports_not_found: k('analytics:error.reportsNotFound'),
  package_not_in_bucket: k('analytics:error.packageNotInBucket'),
  play_sales_forbidden: k('analytics:error.playSalesForbidden'),
  store_auth: k('analytics:error.storeAuth'),
  store_forbidden: k('analytics:error.storeForbidden'),
  store_not_found: k('analytics:error.storeNotFound'),
  rate_limited: k('analytics:error.rateLimited'),
  store_unavailable: k('analytics:error.storeUnavailable'),
  timeout: k('analytics:error.timeout'),
  credential_unreadable: k('analytics:error.credentialUnreadable'),
  credential_not_found: k('analytics:error.credentialNotFound'),
  app_not_synced: k('analytics:error.appNotSynced'),
  sync_failed: k('analytics:error.syncFailed'),
};

const noteKeys: Record<CoverageNoteCode, string> = {
  apple_usage_opt_in_only: k('analytics:note.appleUsageOptInOnly'),
  apple_privacy_thresholds: k('analytics:note.applePrivacyThresholds'),
  apple_counts_not_unique: k('analytics:note.appleCountsNotUnique'),
  apple_usage_sample_not_total: k('analytics:note.appleUsageSampleNotTotal'),
  apple_estimates: k('analytics:note.appleEstimates'),
  apple_pacific_time: k('analytics:note.applePacificTime'),
  apple_proceeds_per_currency: k('analytics:note.appleProceedsPerCurrency'),
  apple_in_app_not_included: k('analytics:note.appleInAppNotIncluded'),
  apple_rating_history_not_available: k('analytics:note.appleRatingHistoryNotAvailable'),
  apple_impressions_only_via_reports: k('analytics:note.appleImpressionsOnlyViaReports'),
  google_unit_unverified: k('analytics:note.googleUnitUnverified'),
  google_legacy_store_listing: k('analytics:note.googleLegacyStoreListing'),
  google_no_impressions: k('analytics:note.googleNoImpressions'),
  google_rating_average_only: k('analytics:note.googleRatingAverageOnly'),
  google_monthly_files: k('analytics:note.googleMonthlyFiles'),
  play_estimated_sales_gross: k('analytics:note.playEstimatedSalesGross'),
  play_sales_latency: k('analytics:note.playSalesLatency'),
  play_sales_utc: k('analytics:note.playSalesUtc'),
  play_sales_per_currency: k('analytics:note.playSalesPerCurrency'),
  apple_product_sales_include_in_app: k('analytics:note.appleProductSalesIncludeInApp'),
  sales_products_capped: k('analytics:note.salesProductsCapped'),
  play_earnings_monthly: k('analytics:note.playEarningsMonthly'),
  play_earnings_net: k('analytics:note.playEarningsNet'),
  play_earnings_per_currency: k('analytics:note.playEarningsPerCurrency'),
  play_earnings_pacific: k('analytics:note.playEarningsPacific'),
  apple_subscription_counts: k('analytics:note.appleSubscriptionCounts'),
  apple_subscription_events: k('analytics:note.appleSubscriptionEvents'),
  play_subscription_stats: k('analytics:note.playSubscriptionStats'),
  derived: k('analytics:note.derived'),
  imported: k('analytics:note.imported'),
  recent_days_incomplete: k('analytics:note.recentDaysIncomplete'),
  gaps: k('analytics:note.gaps'),
  source_not_connected: k('analytics:note.sourceNotConnected'),
  no_data_yet: k('analytics:note.noDataYet'),
  only_since_connected: k('analytics:note.onlySinceConnected'),
};


/** What went wrong, in a sentence from a fixed list. Never the text of a store, and never the server's own message. */
export function analyticsErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('analytics:apiError.generic');
  if (error.code === 'rate_limited') {
    const wait = error.retryAfter;
    return wait ? t('analytics:apiError.rateLimited', { count: wait }) : t('analytics:apiError.rateLimitedMinute');
  }
  const own = apiSentences[error.code];
  if (own) return t(own);
  if (isAnalyticsErrorCode(error.code)) return t(errorKeys[error.code as AnalyticsErrorCode]);
  return error.status >= 500 ? t('analytics:apiError.server') : t('analytics:apiError.failed');
}

/** The code of an API error, or '' for anything else. */
export const errorCodeOf = (error: unknown): string =>
  error instanceof ApiError ? error.code : '';

/** A sentence for a stored error code (the last failed read of a source). */
export const storedErrorText = (code: string): string =>
  isAnalyticsErrorCode(code) ? t(errorKeys[code]) : t(errorKeys.sync_failed);

// ---------------------------------------------------------------------------------------------
// Setup needs and next steps (the fixed vocabularies of the status)

const setupKeys: Record<AnalyticsSetupCode, string> = {
  turn_on_analytics: k('analytics:setup.turnOnAnalytics'),
  create_report_request: k('analytics:setup.createReportRequest'),
  role_required: k('analytics:setup.roleRequired'),
  waiting_first_data: k('analytics:setup.waitingFirstData'),
  request_stopped: k('analytics:setup.requestStopped'),
  vendor_number_missing: k('analytics:setup.vendorNumberMissing'),
  sales_forbidden: k('analytics:setup.salesForbidden'),
  play_sales_forbidden: k('analytics:setup.playSalesForbidden'),
  bucket_id_missing: k('analytics:setup.bucketIdMissing'),
  bucket_forbidden: k('analytics:setup.bucketForbidden'),
  reporting_api_not_enabled: k('analytics:setup.reportingApiNotEnabled'),
  play_permission_missing: k('analytics:setup.playPermissionMissing'),
  credential_problem: k('analytics:setup.credentialProblem'),
  first_sync_pending: k('analytics:setup.firstSyncPending'),
};

export const setupSentence = (code: string): string => {
  const key = (setupKeys as Record<string, string>)[code] ?? k('analytics:setup.unknown');
  return t(key);
};

const stepKeys: Record<AnalyticsNextStep, string> = {
  turn_on_analytics: k('analytics:step.turnOnAnalytics'),
  enable_apple_analytics: k('analytics:step.enableAppleAnalytics'),
  import_apple_report: k('analytics:step.importAppleReport'),
  ask_apple_admin: k('analytics:step.askAppleAdmin'),
  set_vendor_number: k('analytics:step.setVendorNumber'),
  set_bucket_id: k('analytics:step.setBucketId'),
  grant_play_permission: k('analytics:step.grantPlayPermission'),
  grant_play_financial_permission: k('analytics:step.grantPlayFinancialPermission'),
  enable_reporting_api: k('analytics:step.enableReportingApi'),
  fix_credential: k('analytics:step.fixCredential'),
  sync_now: k('analytics:step.syncNow'),
  wait: k('analytics:step.wait'),
};

/** What a next step does in this UI: a button that opens a flow, a link, or only words. */
export type StepAction =
  | { kind: 'turn_on'; label: string; needs: 'manage' }
  | { kind: 'enable_apple'; label: string; needs: 'manage' }
  | { kind: 'import'; label: string; needs: 'manage' }
  | { kind: 'sync'; label: string; needs: 'manage' }
  | { kind: 'bucket'; label: string; needs: 'manage' }
  | { kind: 'link'; label: string; target: 'settings' | 'credentials'; needs: 'none' }
  | { kind: 'text'; label: string; needs: 'none' };

export function stepAction(step: string): StepAction {
  const labelKey = (stepKeys as Record<string, string>)[step] ?? k('analytics:step.next');
  const label = t(labelKey);
  switch (step) {
    case 'turn_on_analytics':
      return { kind: 'turn_on', label, needs: 'manage' };
    case 'enable_apple_analytics':
      return { kind: 'enable_apple', label, needs: 'manage' };
    case 'import_apple_report':
      return { kind: 'import', label, needs: 'manage' };
    case 'sync_now':
      return { kind: 'sync', label, needs: 'manage' };
    case 'set_bucket_id':
      return { kind: 'bucket', label, needs: 'manage' };
    case 'set_vendor_number':
      return { kind: 'link', label: t('analytics:step.inSettings', { label }), target: 'settings', needs: 'none' };
    case 'fix_credential':
      return {
        kind: 'link',
        label: t('analytics:step.underCredentials', { label }),
        target: 'credentials',
        needs: 'none',
      };
    default:
      return { kind: 'text', label, needs: 'none' };
  }
}

/** Whether a person with or without `analytics.manage` gets a button for the step. A viewer gets the words, not a dead button. */
export const stepAvailable = (action: StepAction, canManage: boolean): boolean =>
  action.needs === 'none' || canManage;

export const stateInfo: Record<
  SourceState,
  {
    /** A message key: draw it with `t(info.labelKey)`. */
    labelKey: string;
    tone: 'neutral' | 'warn' | 'info' | 'bad' | 'ok';
    icon: 'check-circle' | 'clock' | 'alert-triangle' | 'x-circle' | 'info';
  }
> = {
  off: { labelKey: k('analytics:state.off'), tone: 'neutral', icon: 'info' },
  needs_setup: { labelKey: k('analytics:state.needsSetup'), tone: 'warn', icon: 'alert-triangle' },
  waiting: { labelKey: k('analytics:state.waiting'), tone: 'info', icon: 'clock' },
  error: { labelKey: k('analytics:state.error'), tone: 'bad', icon: 'x-circle' },
  ready: { labelKey: k('analytics:state.ready'), tone: 'ok', icon: 'check-circle' },
};

/** The words of a source state. */
export const stateLabel = (state: SourceState): string => t(stateInfo[state].labelKey);

export const stateOf = (value: string): SourceState =>
  value in stateInfo ? (value as SourceState) : 'needs_setup';

// ---------------------------------------------------------------------------------------------
// The Google Play reports bucket (docs/api/analytics.md): installs and ratings of an Android app come from monthly CSV files in ONE
// private Cloud Storage bucket per Play developer account. Crash and ANR numbers (vitals) need no bucket.

export type PlayBucketView = {
  bucketId: string | null;
  source: 'app' | 'account' | 'workspace' | null;
  app: string | null;
  account: string | null;
  workspace: string | null;
  /** What the app reads without its own override: its Play credential's bucket, else the workspace default. */
  inherited: { bucketId: string | null; source: 'app' | 'account' | 'workspace' | null };
  credentialId: string;
  sharedWith: number;
};

export type PlayBucketTestResult = { ok: boolean; code: string; message: string; months: string[] };

/** Whether an Android app has vitals but nowhere to read installs from: the "Downloads need your Play reports bucket" state. */
export const needsPlayBucket = (status: Pick<AnalyticsStatus, 'google'> | null): boolean =>
  status !== null && status.google !== null && !status.google.bucketIdSet;

/** One line per source of an Android app: "Vitals: connected · Installs: not set up". */
export function playSourceLine(status: AnalyticsStatus): string {
  const word = (source: string, label: string, setUp: boolean): string => {
    const found = status.sources.find((s) => s.source === source);
    if (!setUp) return t('analytics:playLine.notSetUp', { label });
    if (!found) return t('analytics:playLine.notSetUp', { label });
    switch (stateOf(found.state)) {
      case 'ready':
        return t('analytics:playLine.connected', { label });
      case 'waiting':
        return t('analytics:playLine.waiting', { label });
      case 'error':
        return t('analytics:playLine.error', { label });
      case 'off':
        return t('analytics:playLine.off', { label });
      default:
        return t('analytics:playLine.needsSetup', { label });
    }
  };
  return [
    word('play_vitals', t('analytics:playLine.vitals'), true),
    word('play_reports', t('analytics:playLine.installs'), status.google?.bucketIdSet === true),
    word('play_sales', t('analytics:playLine.sales'), status.google?.bucketIdSet === true),
  ].join(' · ');
}

/** Where the bucket the app reads comes from, in words. */
export function bucketSourceText(view: Pick<PlayBucketView, 'source' | 'sharedWith'>): string {
  switch (view.source) {
    case 'app':
      return t('analytics:bucket.appOnly');
    case 'account':
      return view.sharedWith > 1
        ? t('analytics:bucket.sharedAccount', { count: view.sharedWith })
        : t('analytics:bucket.savedAccount');
    case 'workspace':
      return t('analytics:bucket.workspace');
    default:
      return t('analytics:bucket.notSet');
  }
}
