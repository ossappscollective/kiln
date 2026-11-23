/**
 * Reports (docs/adr/0053-timeline-and-reports.md): the pure view model of `GET .../apps/{appId}/reports` (docs/api/reports.md) and its two
 * exports, Markdown and CSV, both built here from what the API answered (nothing is sent anywhere). A report is one calendar week, month
 * or year against the period before it; the server decides what is comparable, this file only words it. A missing number is never a zero.
 */
import { type Comparison, type Platform, type ReportFigure, type ReportKind, type TimelineEvent, type TimelineMetricId, periodAfter, periodBefore, reportKinds } from '@kiln/core';
import { formatDay, formatValue } from '../analytics/analytics.ts';
import { parseViewPath } from '../app-scope.ts';
import { formatNumber, formatPercent } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { LOW_SAMPLE } from '../ratings/ratings.ts';
import { eventText, kindLabelKeys } from './timeline.ts';

export type ReportApi = {
  app: { id: string; name: string; platform: Platform; store: string };
  kind: ReportKind;
  /** The newest day with final numbers. */
  through: string;
  comparison: Comparison;
  figures: ReportFigure[];
  countries: { code: string; value: number; share: number | null; change: number | null }[];
  sources: { source: string; seen: number | null; pageViews: number | null; downloads: number }[];
  reviews: { current: ReviewsIn; previous: ReviewsIn };
  events: TimelineEvent[];
  missingDays: number;
  downloadMetric: string | null;
};
type ReviewsIn = { count: number; average: number | null; lowUnanswered: number };

export const reportKindKeys: Record<ReportKind, string> = {
  week: k('timeline:report.kind.week'),
  month: k('timeline:report.kind.month'),
  year: k('timeline:report.kind.year'),
};

const metricKeys: Record<TimelineMetricId, string> = {
  impressions: k('timeline:metric.impressions'),
  product_page_views: k('timeline:metric.productPageViews'),
  downloads_first_time: k('timeline:metric.downloadsFirstTime'),
  download_rate: k('timeline:metric.downloadRate'),
  product_page_conversion: k('timeline:metric.productPageConversion'),
  downloads_redownload: k('timeline:metric.downloadsRedownload'),
  installs_user: k('timeline:metric.installsUser'),
  store_listing_visitors: k('timeline:metric.storeListingVisitors'),
  store_listing_acquisitions: k('timeline:metric.storeListingAcquisitions'),
  sales_units: k('timeline:metric.salesUnits'),
  sales_proceeds: k('timeline:metric.salesProceeds'),
  sales_gross: k('timeline:metric.salesGross'),
};

const reasonKeys = {
  no_data: k('timeline:report.reason.noData'),
  previous_incomplete: k('timeline:report.reason.previousIncomplete'),
  current_incomplete: k('timeline:report.reason.currentIncomplete'),
};

export type FigureRow = {
  id: string;
  label: string;
  value: string;
  previous: string;
  /** "+12.4%", or null when the periods cannot be compared. */
  change: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  /** Why there is no change, in words. */
  note: string | null;
  raw: ReportFigure;
};

/** A ratio is a share of two counts (a rate), a level or count is drawn as such; money carries its currency, never converted. */
function valueText(f: ReportFigure, v: number | null): string {
  if (v === null) return t('timeline:report.noValue');
  if (f.kind === 'ratio') return formatPercent(v, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return formatValue(f.currency ? 'money' : 'count', v, f.currency);
}

export const changeText = (change: number): string => formatPercent(change, { signDisplay: 'exceptZero', maximumFractionDigits: 1 });

export function figureRow(f: ReportFigure): FigureRow {
  const label = t(metricKeys[f.metric]);
  return {
    id: f.id,
    label: f.currency ? t('timeline:report.withCurrency', { label, currency: f.currency }) : label,
    value: valueText(f, f.value),
    previous: valueText(f, f.previous),
    change: f.change === null ? null : changeText(f.change),
    direction: f.change === null ? null : Math.abs(f.change) < 0.0005 ? 'flat' : f.change > 0 ? 'up' : 'down',
    note: f.uncompared === null ? null : t(reasonKeys[f.uncompared]),
    raw: f,
  };
}

export type ReviewsRow = { count: number; previousCount: number; average: string | null; previousAverage: string | null; delta: string | null; lowSample: boolean; lowUnanswered: number } | null;

/** The written reviews of the period (the stars of reviews Kiln stored, not the store's rating). Null when there are none on either side. */
export function reviewsRow(r: ReportApi['reviews']): ReviewsRow {
  if (r.current.count === 0 && r.previous.count === 0) return null;
  const fmt = (v: number | null) => (v === null ? null : formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
  const both = r.current.average !== null && r.previous.average !== null;
  return {
    count: r.current.count,
    previousCount: r.previous.count,
    average: fmt(r.current.average),
    previousAverage: fmt(r.previous.average),
    delta: both ? formatNumber((r.current.average as number) - (r.previous.average as number), { signDisplay: 'exceptZero', maximumFractionDigits: 2 }) : null,
    lowSample: r.current.count < LOW_SAMPLE,
    lowUnanswered: r.current.lowUnanswered,
  };
}

/** The title of the period: a month by name, a week or a year as its first and last day. */
export function periodTitle(kind: ReportKind, w: { from: string; to: string }): string {
  if (kind === 'month') return formatDay(w.from.slice(0, 7));
  if (kind === 'year') return w.from.slice(0, 4);
  return t('timeline:report.range', { from: formatDay(w.from), to: formatDay(w.to, true) });
}

/** The first day of the period before and after the one shown (`on=` in the address), and whether the one after has any day with numbers. */
export function periodNav(kind: ReportKind, comparison: Pick<Comparison, 'period'>, through: string): { prev: string; next: string | null } {
  const next = periodAfter(kind, comparison.period);
  return { prev: periodBefore(kind, comparison.period).from, next: next.from > through ? null : next.from };
}

export type ReportNote = { id: string; text: string };

/** What the reader should know before trusting the numbers: the partial period, missing days, missing sources, figures without a comparison. */
export function dataNotes(v: ReportApi): ReportNote[] {
  const out: ReportNote[] = [];
  const c = v.comparison;
  if (c.currentDays === 0) {
    out.push({ id: 'notStarted', text: t('timeline:report.note.notStarted') });
    return out;
  }
  if (v.figures.length === 0) out.push({ id: 'noFigures', text: t(v.app.platform === 'android' ? k('timeline:report.note.noFiguresAndroid') : k('timeline:report.note.noFiguresIos')) });
  if (c.partial) out.push({ id: 'partial', text: t('timeline:report.note.partial', { count: c.currentDays, through: formatDay(c.current.to, true) }) });
  else if (c.lengthsDiffer) out.push({ id: 'lengths', text: t('timeline:report.note.lengths', { current: c.currentDays, previous: c.previousDays }) });
  if (v.figures.length > 0 && v.missingDays > 0) out.push({ id: 'missing', text: t('timeline:report.note.missingDays', { count: v.missingDays }) });
  const uncompared = v.figures.filter((f) => f.uncompared === 'previous_incomplete' || f.uncompared === 'current_incomplete').length;
  if (uncompared > 0) out.push({ id: 'uncompared', text: t('timeline:report.note.uncompared', { count: uncompared }) });
  if (reviewsRow(v.reviews) === null) out.push({ id: 'noReviews', text: t('timeline:report.note.noReviews') });
  else if (v.reviews.current.count < LOW_SAMPLE) out.push({ id: 'lowReviews', text: t('timeline:report.note.lowReviews', { count: v.reviews.current.count }) });
  if (v.figures.length > 0 && v.sources.length === 0) out.push({ id: 'noSources', text: t(v.app.platform === 'android' ? k('timeline:report.note.noSourcesAndroid') : k('timeline:report.note.noSourcesIos')) });
  if (v.figures.length > 0 && v.countries.length === 0) out.push({ id: 'noCountries', text: t('timeline:report.note.noCountries') });
  return out;
}

/** True when the period has nothing to show at all (no figures, no reviews, no events): the screen says so in one line. */
export const reportIsEmpty = (v: ReportApi): boolean => v.figures.length === 0 && reviewsRow(v.reviews) === null && v.events.length === 0;

/** The source of a download (the store's own name for it, as the API gives it) is shown as written: it is data, not a message. */
export const sourceLabel = (s: string): string => s;

// ---------------------------------------------------------------------------------------------
// Exports

/** Markdown table cells: a pipe or a line break would break the table. */
const mdCell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const mdLine = (s: string): string => s.replace(/\r?\n/g, ' ');

/** The report of one or more app records (a platform each) as Markdown, in the language of the screen. Dates and numbers are formatted as on screen. */
export function reportMarkdown(views: readonly ReportApi[], platformName: (p: Platform) => string): string {
  const out: string[] = [];
  const first = views[0];
  if (!first) return '';
  const title = periodTitle(first.kind, first.comparison.period);
  out.push(`# ${mdLine(t('timeline:report.title', { period: title }))}`, '');
  for (const v of views) {
    const c = v.comparison;
    out.push(`## ${mdLine(v.app.name)} (${platformName(v.app.platform)})`, '');
    out.push(t('timeline:report.compare', { current: periodTitle(v.kind, c.current.to < c.current.from ? c.period : c.current), previous: periodTitle(v.kind, c.previous) }), '');
    const rows = v.figures.map(figureRow);
    if (rows.length > 0) {
      out.push(`| ${t('timeline:report.col.figure')} | ${t('timeline:report.col.value')} | ${t('timeline:report.col.previous')} | ${t('timeline:report.col.change')} |`, '| --- | ---: | ---: | ---: |');
      for (const r of rows) out.push(`| ${mdCell(r.label)} | ${mdCell(r.value)} | ${mdCell(r.previous)} | ${mdCell(r.change ?? r.note ?? '')} |`);
      out.push('');
    }
    const rev = reviewsRow(v.reviews);
    if (rev) {
      out.push(`### ${t('timeline:report.reviews.title')}`, '', t('timeline:report.reviews.line', { count: rev.count, average: rev.average ?? t('timeline:report.noValue'), previous: rev.previousAverage ?? t('timeline:report.noValue') }), '');
    }
    if (v.countries.length > 0) {
      out.push(`### ${t('timeline:report.countries.title')}`, '');
      for (const row of v.countries) out.push(`- ${row.code}: ${formatNumber(row.value)}${row.share === null ? '' : ` (${formatPercent(row.share, { maximumFractionDigits: 0 })})`}${row.change === null ? '' : `, ${changeText(row.change)}`}`);
      out.push('');
    }
    if (v.events.length > 0) {
      out.push(`### ${t('timeline:report.events.title')}`, '');
      for (const e of v.events) out.push(`- ${formatDay(e.day, true)}: ${mdLine(t(kindLabelKeys[e.kind]))}, ${mdLine(eventText(e))}`);
      out.push('');
    }
    const notes = dataNotes(v);
    if (notes.length > 0) {
      out.push(`### ${t('timeline:report.notes.title')}`, '');
      for (const n of notes) out.push(`- ${mdLine(n.text)}`);
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** A cell a spreadsheet would run as a formula is made text (leading apostrophe), then quoted when it holds a separator, a quote or a line break. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ['app', 'platform', 'section', 'item', 'currency', 'period_from', 'period_to', 'value', 'previous', 'change_percent', 'note'] as const;

/**
 * The figures as CSV for a spreadsheet: raw numbers with a dot (never localized), ISO days, and the same rows the screen shows (figures, the written
 * reviews, countries, sources). The header and the item ids are fixed identifiers, not translated. A leading BOM makes Excel read UTF-8.
 */
export function reportCsv(views: readonly ReportApi[]): string {
  const lines: string[] = [CSV_HEADER.join(',')];
  const push = (cells: (string | number | null)[]) => void lines.push(cells.map(csvCell).join(','));
  for (const v of views) {
    const c = v.comparison;
    const head = [v.app.name, v.app.platform];
    const period = [c.current.to < c.current.from ? c.period.from : c.current.from, c.current.to < c.current.from ? c.period.to : c.current.to];
    const pct = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 100);
    for (const f of v.figures) push([...head, 'figure', f.id, f.currency, ...period, f.value, f.previous, pct(f.change), f.uncompared]);
    const r = v.reviews;
    if (r.current.count > 0 || r.previous.count > 0) {
      push([...head, 'reviews', 'reviews_count', null, ...period, r.current.count, r.previous.count, null, null]);
      push([...head, 'reviews', 'reviews_average', null, ...period, r.current.average, r.previous.average, null, null]);
    }
    for (const row of v.countries) push([...head, 'countries', row.code, null, ...period, row.value, null, pct(row.change), v.downloadMetric]);
    for (const row of v.sources) push([...head, 'sources', row.source, null, ...period, row.downloads, null, null, null]);
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export const reportFileName = (views: readonly ReportApi[]): string => {
  const first = views[0];
  if (!first) return 'kiln-report.csv';
  const p = first.comparison.period;
  const name = first.app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `kiln-report-${name}-${p.from}_${p.to}.csv`;
};

export { reportKinds };

// ---------------------------------------------------------------------------------------------
// Address: `?view=timeline&section=reports&report=week|month|year&on=YYYY-MM-DD` (`on` is any day of the period; none is the newest finished one).

export function reportKindOf(hash: string): ReportKind {
  const asked = parseViewPath(hash).query.get('report');
  return (reportKinds as readonly string[]).indexOf(asked ?? '') >= 0 ? (asked as ReportKind) : 'week';
}

export function reportDayOf(hash: string): string | null {
  const asked = parseViewPath(hash).query.get('on');
  return asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null;
}

/** The same address on another period of the report; `on: null` goes back to the newest finished period. */
export function withReport(hash: string, next: { kind: ReportKind; on: string | null }): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.set('view', 'timeline');
  params.set('section', 'reports');
  if (next.kind === 'week') params.delete('report');
  else params.set('report', next.kind);
  if (next.on) params.set('on', next.on);
  else params.delete('on');
  return `${path}?${params.toString()}`;
}
