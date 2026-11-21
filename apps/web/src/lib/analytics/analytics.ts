import {
  type AnalyticsErrorCode,
  type AnalyticsNextStep,
  type AnalyticsSetupCode,
  addDays,
  analyticsErrorMessages,
  coverageNoteMessages,
  dateToDay,
  daysBetween,
  isAnalyticsErrorCode,
  isIsoDate,
  type MetricAggregation,
  type MetricUnit,
  safeRatio,
} from '@mrm/core';
import { ApiError } from '../api.ts';
import { parseViewPath } from '../app-scope.ts';

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
  if (!isIsoDate(from) || !isIsoDate(to)) return 'Enter both dates.';
  if (from > to) return 'The start date must not be after the end date.';
  if (to > dateToDay(now)) return 'The end date cannot be in the future.';
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return '';
}

export const rangeText = (choice: RangeChoice, range: ResolvedRange): string =>
  choice.kind === 'preset'
    ? `Last ${choice.days} days`
    : `${formatDay(range.from, true)} to ${formatDay(range.to, true)}`;

// ---------------------------------------------------------------------------------------------
// Numbers and dates

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 17", or "Nov 17, 2026" with `withYear`. From the text of the date, so no time zone can move it. */
export function formatDay(day: string, withYear = false): string {
  if (!isIsoDate(day)) return day;
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? '';
  const d = Number(day.slice(8, 10));
  return withYear ? `${month} ${d}, ${day.slice(0, 4)}` : `${month} ${d}`;
}

const group = (n: number): string => {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.round(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

/** Whole numbers with separators: 12,345. For tooltips and tables, where the exact number is wanted. */
export const formatCountExact = (n: number): string => (Number.isFinite(n) ? group(n) : '');

/** 1,284 / 12.9K / 4.2M: in full under 10,000, compact above. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a < 10_000) return group(n);
  const compact = (value: number, suffix: string): string =>
    `${n < 0 ? '-' : ''}${(Math.round(value * 10) / 10).toString()}${suffix}`;
  if (a < 1_000_000) return compact(a / 1_000, 'K');
  if (a < 1_000_000_000) return compact(a / 1_000_000, 'M');
  return compact(a / 1_000_000_000, 'B');
}

/** A fraction as a percentage with the digits its size needs: 0.0123 is 1.23%, 0.2 is 20%. */
export function formatPercent(fraction: number, exact = false): string {
  if (!Number.isFinite(fraction)) return '';
  const p = fraction * 100;
  const a = Math.abs(p);
  if (exact) return `${p.toFixed(2)}%`;
  if (a === 0) return '0%';
  if (a < 1) return `${p.toFixed(2)}%`;
  if (a < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export const formatRating = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '');

/** Money in its own currency; never converted. A code the runtime does not know is written as text. */
export function formatMoney(n: number, currency: string | null, exact = false): string {
  if (!Number.isFinite(n)) return '';
  const digits = exact || Math.abs(n) < 1_000 ? 2 : 0;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(n);
    } catch {
      // fall through to the plain form
    }
  }
  return `${currency ? `${currency} ` : ''}${n.toFixed(digits)}`;
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
      return `${delta.text} vs previous ${days} days`;
    case 'flat':
      return `About the same as the previous ${days} days`;
    default:
      return delta.reason === 'not_enough_data' ? 'Not enough data to compare' : '';
  }
}

/** The same for a screen reader: words and not a sign. */
export function deltaSpoken(delta: Delta, days: number): string {
  if (delta.kind === 'change')
    return `${delta.direction === 'up' ? 'Up' : 'Down'} ${delta.text.replace(/^[+-]/, '')} compared with the previous ${days} days`;
  return deltaLine(delta, days);
}

// ---------------------------------------------------------------------------------------------
// Where a number comes from and how late it can be

export const sourceLabels: Record<string, string> = {
  apple_analytics: 'App Store analytics reports',
  apple_sales: 'Sales and Trends',
  play_vitals: 'Android vitals',
  play_reports: 'Play Console reports',
  play_sales: 'Play Console sales reports',
};

export const sourceLabel = (source: string): string => sourceLabels[source] ?? 'Store data';

/** How late a source can be, as a sentence. `delayDays` is an upper bound ("complete within"). */
export function lagText(source: string, delayDays: number): string {
  const days = `${delayDays} ${delayDays === 1 ? 'day' : 'days'}`;
  switch (source) {
    case 'apple_analytics':
      return `Apple reports can lag up to ${days}`;
    case 'apple_sales':
      return 'Sales and Trends is posted the next day, on Pacific Time';
    case 'play_vitals':
      return `Play vitals can lag up to ${days}`;
    case 'play_reports':
      return 'Play monthly reports are posted 3 to 7 days late';
    case 'play_sales':
      return 'Play sales are added to the month file every day, up to a few days late, on UTC';
    default:
      return `The store can lag up to ${days}`;
  }
}

/** "Data up to Nov 17. Apple reports can lag up to 3 days." */
export function freshnessLine(
  series: Pick<AnalyticsSeries, 'source' | 'delayDays' | 'coverage'>,
): string {
  const lag = lagText(series.source, series.delayDays);
  return series.coverage.lastDay
    ? `Data up to ${formatDay(series.coverage.lastDay)}. ${lag}.`
    : `No data yet. ${lag}.`;
}

/** The sentence of a coverage note, from the fixed vocabulary; an unknown code gets a generic one (the API's own text is not shown). */
export function noteText(note: AnalyticsNote): string {
  const known = (coverageNoteMessages as Record<string, string>)[note.code];
  return known ?? 'A limit of the store data applies here.';
}

// ---------------------------------------------------------------------------------------------
// Errors, as sentences from the fixed vocabularies

const apiSentences: Record<string, string> = {
  analytics_disabled: 'Analytics is off for this workspace. Turn it on first.',
  sync_in_progress: 'A sync of this app is already running. Try again in a moment.',
  plan_changed:
    'What exists at Apple changed since the preview. Review the new plan and confirm again.',
  confirm_mismatch: 'This is not the file that was checked. Choose the file again.',
  payload_too_large: 'The file is larger than 10 MiB.',
  import_not_supported: 'Importing a report file is only for iOS and macOS apps.',
  not_apple_app: 'Apple analytics is only for iOS and macOS apps.',
  forbidden: 'Only an owner or an admin can do that.',
  not_found: 'This app is no longer in the workspace.',
  network: 'Cannot reach the server. Check that it is running.',
  invalid_request: 'The request was not accepted. Check the values and try again.',
};

/** What went wrong, in a sentence from a fixed list. Never the text of a store, and never the server's own message. */
export function analyticsErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.code === 'rate_limited') {
    const wait = error.retryAfter;
    return wait
      ? `Too many analytics requests. Try again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.`
      : 'Too many analytics requests. Try again in a minute.';
  }
  const own = apiSentences[error.code];
  if (own) return own;
  if (isAnalyticsErrorCode(error.code))
    return analyticsErrorMessages[error.code as AnalyticsErrorCode];
  return error.status >= 500
    ? 'The server had a problem. Try again.'
    : 'The analytics request failed. Try again.';
}

/** The code of an API error, or '' for anything else. */
export const errorCodeOf = (error: unknown): string =>
  error instanceof ApiError ? error.code : '';

/** A sentence for a stored error code (the last failed read of a source). */
export const storedErrorText = (code: string): string =>
  isAnalyticsErrorCode(code) ? analyticsErrorMessages[code] : analyticsErrorMessages.sync_failed;

// ---------------------------------------------------------------------------------------------
// Setup needs and next steps (the fixed vocabularies of the status)

export const setupText: Record<AnalyticsSetupCode, string> = {
  turn_on_analytics:
    'Analytics is off for this workspace. Nothing is requested from the stores until an owner or an admin turns it on.',
  create_report_request:
    'Apple makes analytics reports only after a report request exists for the app. Enabling it creates one request at Apple.',
  role_required:
    'The App Store Connect key may not create report requests (Apple lists the Admin role). Import a report file you download from App Store Connect, or ask an Apple admin.',
  waiting_first_data:
    'The request exists. Apple takes one to two days to produce the first reports.',
  request_stopped:
    'Apple stopped the request because nothing was read for a long time. Enable Apple analytics again.',
  vendor_number_missing:
    'Optional: add the Apple vendor number in the workspace settings to read daily units and proceeds, also by product.',
  sales_forbidden:
    'The key may not read Sales and Trends. It needs the Sales and Reports role or higher.',
  play_sales_forbidden:
    'In Play Console open Users and permissions, find the service account and give it the permission View financial data, set to Global (all apps). Then sync again. Without it the Play sales numbers stay off.',
  bucket_id_missing:
    'Add the Cloud Storage bucket of your Play Console reports (it is the same for every app of the Play account) to read installs and ratings, and sales when the service account may also view financial data.',
  bucket_forbidden:
    'The service account may not read the bucket of the Play Console reports. Grant it read access to the bucket.',
  reporting_api_not_enabled:
    'In Google Cloud console, open the project of the service account, find Google Play Developer Reporting API and click Enable. Then sync again.',
  play_permission_missing:
    'In Play Console open Users and permissions, invite the service account email address and give it access to this app with View app quality information (read-only). Then sync again.',
  credential_problem: 'The saved credential could not be used. Check it under Credentials.',
  first_sync_pending:
    'Everything is set up and nothing has been read yet. Sync now, or wait for the next scheduled sync.',
};

export const setupSentence = (code: string): string =>
  (setupText as Record<string, string>)[code] ??
  'This source needs attention before it can deliver data.';

export const nextStepLabels: Record<AnalyticsNextStep, string> = {
  turn_on_analytics: 'Turn on analytics',
  enable_apple_analytics: 'Enable Apple analytics',
  import_apple_report: 'Import a report file',
  ask_apple_admin: 'Ask an Apple admin',
  set_vendor_number: 'Set the vendor number',
  set_bucket_id: 'Set the reports bucket',
  grant_play_permission: 'Grant the Play permission',
  grant_play_financial_permission: 'Grant View financial data',
  enable_reporting_api: 'Enable the Reporting API',
  fix_credential: 'Check the credential',
  sync_now: 'Sync analytics now',
  wait: 'Wait',
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
  const label = (nextStepLabels as Record<string, string>)[step] ?? 'Next step';
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
      return { kind: 'link', label: `${label} in Settings`, target: 'settings', needs: 'none' };
    case 'fix_credential':
      return {
        kind: 'link',
        label: `${label} under Credentials`,
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
    label: string;
    tone: 'neutral' | 'warn' | 'info' | 'bad' | 'ok';
    icon: 'check-circle' | 'clock' | 'alert-triangle' | 'x-circle' | 'info';
  }
> = {
  off: { label: 'Off', tone: 'neutral', icon: 'info' },
  needs_setup: { label: 'Needs setup', tone: 'warn', icon: 'alert-triangle' },
  waiting: { label: 'Waiting for the first data', tone: 'info', icon: 'clock' },
  error: { label: 'Last read failed', tone: 'bad', icon: 'x-circle' },
  ready: { label: 'Ready', tone: 'ok', icon: 'check-circle' },
};

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
    if (!setUp) return `${label}: not set up`;
    if (!found) return `${label}: not set up`;
    switch (stateOf(found.state)) {
      case 'ready':
        return `${label}: connected`;
      case 'waiting':
        return `${label}: waiting for data`;
      case 'error':
        return `${label}: last read failed`;
      case 'off':
        return `${label}: off`;
      default:
        return `${label}: needs setup`;
    }
  };
  return [
    word('play_vitals', 'Vitals', true),
    word('play_reports', 'Installs', status.google?.bucketIdSet === true),
    word('play_sales', 'Sales', status.google?.bucketIdSet === true),
  ].join(' · ');
}

/** Where the bucket the app reads comes from, in words. */
export function bucketSourceText(view: Pick<PlayBucketView, 'source' | 'sharedWith'>): string {
  switch (view.source) {
    case 'app':
      return 'Set for this app only.';
    case 'account':
      return view.sharedWith > 1
        ? `Shared by the ${view.sharedWith} Android apps of this Play account.`
        : 'Saved for this Play account.';
    case 'workspace':
      return 'Set in the workspace settings.';
    default:
      return 'Not set.';
  }
}
