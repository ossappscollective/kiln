import {
  type MoveComparison,
  type RankDownloadsMissing,
  type RankDownloadsView,
  type RankMarker,
  type RankSeries,
  rankDownloadsLimits,
} from '@kiln/core';
import { formatCountExact, formatDay } from '../analytics/analytics.ts';
import { type Box, type Geometry, niceTicks, plot } from '../analytics/chart.ts';
import { formatList, formatNumber, formatPercent } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';

/**
 * Rank versus downloads in the web (docs/api/aso.md): the shape of `GET /aso/rank-vs-downloads` and the pure logic of the view. The numbers
 * are worked out on the server (core `buildRankVsDownloads`); this module only lays them out: an inverted rank panel (rank 1 on top)
 * over a downloads panel on the same days, the markers of the big moves, and the words. Written for the ES2017 web build.
 *
 * It is a correlation view. Every sentence about a move carries "Correlation, not proof." and the number of days it compared, and none
 * says that a rank move changed downloads.
 */

export type RankKeywordChoice = {
  id: string;
  term: string;
  locale: string;
  priority: number;
  checks: number;
  lastCheckedAt: number | null;
};

export type RankVsDownloadsResponse = RankDownloadsView & {
  appId: string;
  platform: 'ios' | 'macos' | 'android';
  country: string | null;
  /** The storefronts that have tracked keywords. Absent from an older server. */
  countries?: string[];
  /** The tracked keywords of the storefront that can be chosen, with the checks each has in the range. */
  available: RankKeywordChoice[];
  /** The keyword ids drawn. */
  selected: string[];
};

export type RankVsDownloadsQuery = { country?: string; keywords?: string[]; days?: number };

/** The ranges the view offers, in days. */
export const rangeChoices: { days: number }[] = [{ days: 30 }, { days: 60 }, { days: 90 }, { days: 180 }];
/** "Last 30 days". */
export const rangeLabel = (days: number): string => t('aso:rd.rangeLast', { count: days });
export const DEFAULT_DAYS = 90;
/** The keywords drawn at once: each has its own line pattern, so the lines can be told apart without color. */
export const MAX_DRAWN = 3;
export const dashes: string[] = ['', '7 4', '2 4'];

export function queryText(query: {
  country?: string;
  keywords?: readonly string[];
  from?: string;
  to?: string;
}): string {
  const params: string[] = [];
  if (query.country) params.push(`country=${encodeURIComponent(query.country)}`);
  if (query.keywords && query.keywords.length > 0)
    params.push(`keywords=${query.keywords.map(encodeURIComponent).join(',')}`);
  if (query.from) params.push(`from=${encodeURIComponent(query.from)}`);
  if (query.to) params.push(`to=${encodeURIComponent(query.to)}`);
  return params.length === 0 ? '' : `?${params.join('&')}`;
}

/** The ids to draw after a person ticks or unticks one: at most `MAX_DRAWN`, the oldest choice dropped when a fourth is ticked. */
export function toggleKeyword(
  selected: readonly string[],
  id: string,
  limit = MAX_DRAWN,
): string[] {
  if (selected.indexOf(id) >= 0) return selected.filter((s) => s !== id);
  const next = selected.concat(id);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// ---------------------------------------------------------------------------------------------
// What the view says when it does not draw

export type Gate =
  /** Draw the chart. */
  | { kind: 'chart' }
  /** Hidden: not enough days, with the counts. */
  | { kind: 'too_few'; text: string }
  /** Hidden: something is missing, said plainly. */
  | { kind: 'missing'; text: string; action: 'analytics' | 'keywords' | 'refresh' | 'none' };

const missingText: Record<
  RankDownloadsMissing,
  { textKey: string; action: 'analytics' | 'keywords' | 'refresh' | 'none' }
> = {
  turn_on_analytics: { textKey: k('aso:rd.missing.turnOnAnalytics'), action: 'analytics' },
  no_downloads: { textKey: k('aso:rd.missing.noDownloads'), action: 'analytics' },
  no_rank_checks: { textKey: k('aso:rd.missing.noRankChecks'), action: 'refresh' },
};

/** Whether to draw, and what to say when not. Fewer than 14 days of either series hides the chart and the comparisons. */
export function gateOf(
  view: Pick<RankVsDownloadsResponse, 'enough' | 'missing' | 'coverage' | 'available' | 'selected'>,
): Gate {
  if (view.available.length === 0)
    return {
      kind: 'missing',
      text: t('aso:rd.gate.noKeywords'),
      action: 'keywords',
    };
  if (view.missing) {
    const m = missingText[view.missing];
    return { kind: 'missing', text: t(m.textKey), action: m.action };
  }
  if (view.selected.length === 0)
    return { kind: 'missing', text: t('aso:rd.gate.choose'), action: 'none' };
  if (!view.enough) {
    const c = view.coverage;
    return {
      kind: 'too_few',
      text: t('aso:rd.gate.tooFew', {
        min: c.minDays,
        count: c.rankDays,
        downloadDays: formatCountExact(c.downloadDays),
      }),
    };
  }
  return { kind: 'chart' };
}

/** The delay line: how late the store's numbers arrive, and what is shaded. */
export function delayLine(view: Pick<RankVsDownloadsResponse, 'downloads'>): string | null {
  const d = view.downloads;
  if (!d) return null;
  return t(d.source === 'apple' ? 'aso:rd.delay.apple' : 'aso:rd.delay.play', {
    date: formatDay(d.settledThrough, true),
  });
}

/** "First-time downloads, from Apple" and the like. */
export function downloadsName(view: Pick<RankVsDownloadsResponse, 'downloads'>): string {
  const d = view.downloads;
  if (!d) return t('aso:rd.downloads');
  return t('aso:rd.downloadsFrom', {
    label: d.label,
    source: d.source === 'apple' ? 'Apple' : 'Google Play',
  });
}

// ---------------------------------------------------------------------------------------------
// The panels

export type RankLine = {
  id: string;
  term: string;
  /** Index into `dashes`. */
  pattern: number;
  runs: { d: string; points: { x: number; y: number; i: number; rank: number | null }[] }[];
  last: { x: number; y: number; i: number; rank: number | null } | null;
};

export type MarkerShape = {
  keywordId: string;
  term: string;
  /** `better` points up (a better rank), `worse` points down. */
  direction: 'better' | 'worse';
  x: number;
  y: number;
  i: number;
  day: string;
  /** For a screen reader and the tooltip. */
  text: string;
};

export type RankGeometry = {
  box: Box;
  plotW: number;
  plotH: number;
  slot: number;
  count: number;
  /** The rank at the top (1 or the best seen) and at the bottom. */
  top: number;
  bottom: number;
  ticks: { value: number; y: number; label: string }[];
  lines: RankLine[];
  markers: MarkerShape[];
  xCenter: (i: number) => number;
  y: (rank: number) => number;
};

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Where a "not in the first N results" check sits: one past the deepest result seen. */
function outLevel(series: readonly RankSeries[]): { out: number; anyOut: boolean; total: number } {
  let deepest = 1;
  let anyOut = false;
  let total = 0;
  for (const s of series) {
    for (const sample of s.samples) {
      if (!sample) continue;
      if (sample.rank === null) {
        anyOut = true;
        total = Math.max(total, sample.total);
      } else deepest = Math.max(deepest, sample.rank);
    }
  }
  return { out: Math.max(deepest, total) + 1, anyOut, total };
}

/** The words of a marker: "coffee timer: 30 to 5 on 2026-10-12". */
export function markerText(m: RankMarker, term: string): string {
  const params = { term, from: m.from ?? '', to: m.to ?? '', day: formatDay(m.day, true) };
  return t(
    m.kind === 'entered'
      ? 'aso:rd.marker.entered'
      : m.kind === 'dropped'
        ? 'aso:rd.marker.dropped'
        : 'aso:rd.marker.moved',
    params,
  );
}

/** The inverted rank panel: rank 1 at the top, "not ranked" at the bottom, a gap where there was no check, a marker where a big move showed. */
export function rankPanel(
  view: Pick<RankVsDownloadsResponse, 'days' | 'keywords' | 'markers' | 'selected'>,
  box: Box,
): RankGeometry {
  const n = Math.max(1, view.days.length);
  const plotW = Math.max(1, box.width - box.left - box.right);
  const plotH = Math.max(1, box.height - box.top - box.bottom);
  const slot = plotW / n;
  const xCenter = (i: number): number => box.left + (i + 0.5) * slot;
  const { out, anyOut, total } = outLevel(view.keywords);
  let best = Number.POSITIVE_INFINITY;
  for (const s of view.keywords)
    for (const sample of s.samples)
      if (sample && sample.rank !== null) best = Math.min(best, sample.rank);
  const top = Number.isFinite(best) ? Math.min(best, 1) : 1;
  const bottom = Math.max(top + 1, anyOut ? out : maxRank(view.keywords));
  const y = (rank: number): number =>
    box.top + plotH * ((Math.min(bottom, Math.max(top, rank)) - top) / (bottom - top));

  // Rank 1 is always labelled at the top; the other ticks are clean numbers that keep clear of it.
  const ticks: RankGeometry['ticks'] = [{ value: top, y: y(top), label: String(top) }];
  for (const value of niceTicks(top, bottom, 3)) {
    if (value <= top || value > bottom) continue;
    if (Math.abs(y(value) - y(top)) < 16) continue;
    ticks.push({ value, y: y(value), label: String(value) });
  }
  if (anyOut) ticks.push({ value: bottom, y: y(bottom), label: `${total}+` });

  const index: Record<string, number> = {};
  const lines: RankLine[] = view.keywords.map((s, pattern) => {
    index[s.id] = pattern;
    const runs: RankLine['runs'] = [];
    let current: RankLine['runs'][number] | null = null;
    s.samples.forEach((sample, i) => {
      if (!sample) {
        current = null;
        return;
      }
      const p = {
        x: r1(xCenter(i)),
        y: r1(y(sample.rank === null ? out : sample.rank)),
        i,
        rank: sample.rank,
      };
      if (!current) {
        current = { d: '', points: [] };
        runs.push(current);
      }
      current.points.push(p);
      current.d += `${current.points.length === 1 ? 'M' : 'L'}${p.x},${p.y}`;
    });
    const lastRun = runs[runs.length - 1];
    return {
      id: s.id,
      term: s.term,
      pattern: pattern % dashes.length,
      runs,
      last: lastRun ? (lastRun.points[lastRun.points.length - 1] ?? null) : null,
    };
  });

  const markers: MarkerShape[] = [];
  const dayIndex: Record<string, number> = {};
  view.days.forEach((d, i) => {
    dayIndex[d] = i;
  });
  for (const m of view.markers) {
    const i = dayIndex[m.day];
    const s = view.keywords.filter((row) => row.id === m.keywordId)[0];
    if (i === undefined || !s) continue;
    const sample = s.samples[i];
    if (!sample) continue;
    const better = m.kind === 'up' || m.kind === 'entered';
    markers.push({
      keywordId: m.keywordId,
      term: s.term,
      direction: better ? 'better' : 'worse',
      x: r1(xCenter(i)),
      y: r1(y(sample.rank === null ? out : sample.rank)),
      i,
      day: m.day,
      text: markerText(m, s.term),
    });
  }
  return { box, plotW, plotH, slot, count: n, top, bottom, ticks, lines, markers, xCenter, y };
}

function maxRank(series: readonly RankSeries[]): number {
  let deepest = 1;
  for (const s of series)
    for (const sample of s.samples)
      if (sample && sample.rank !== null) deepest = Math.max(deepest, sample.rank);
  return deepest;
}

/** The first index of a day after the newest settled day (the store may still change it), or -1 when every day is settled. */
export function firstUnsettled(days: readonly string[], settledThrough: string): number {
  for (let i = 0; i < days.length; i += 1) if ((days[i] as string) > settledThrough) return i;
  return -1;
}

/** The downloads panel: columns from zero, hatched days with no number, a wash on days the store may still change. */
export function downloadsPanel(
  view: Pick<RankVsDownloadsResponse, 'days' | 'downloads'>,
  box: Box,
): Geometry | null {
  const d = view.downloads;
  if (!d) return null;
  const from = firstUnsettled(view.days, d.settledThrough);
  return plot({
    box,
    count: view.days.length,
    kind: 'columns',
    series: [{ key: 'downloads', color: 2, values: d.values }],
    domain: 'zero',
    ...(from >= 0 ? { provisionalFrom: from } : {}),
  });
}

/** The day under a horizontal position (inside the plot), or null outside it. */
export function dayIndexAt(
  geo: Pick<RankGeometry, 'box' | 'slot' | 'count'>,
  x: number,
): number | null {
  const rel = x - geo.box.left;
  if (rel < 0 || rel > geo.slot * geo.count) return null;
  return Math.max(0, Math.min(geo.count - 1, Math.floor(rel / geo.slot)));
}

export type Tip = {
  heading: string;
  downloads: string;
  provisional: boolean;
  ranks: { id: string; term: string; pattern: number; text: string }[];
};

/** What the tooltip of one day lists: each keyword's rank (or "no check") and the downloads. */
export function tipFor(
  view: Pick<RankVsDownloadsResponse, 'days' | 'keywords' | 'downloads'>,
  i: number,
): Tip | null {
  const day = view.days[i];
  if (day === undefined) return null;
  const d = view.downloads;
  const value = d ? d.values[i] : null;
  const from = d ? firstUnsettled(view.days, d.settledThrough) : -1;
  const provisional = from >= 0 && i >= from;
  return {
    heading: formatDay(day, true),
    downloads:
      value === null || value === undefined ? t('aso:rd.tip.noNumber') : formatCountExact(value),
    provisional,
    ranks: view.keywords.map((s, pattern) => {
      const sample = s.samples[i];
      const text = !sample
        ? t('aso:rd.tip.noCheck')
        : sample.rank === null
          ? t('aso:rd.tip.outside', { count: sample.total })
          : t('aso:rd.tip.rank', { rank: sample.rank });
      return { id: s.id, term: s.term, pattern: pattern % dashes.length, text };
    }),
  };
}

/** The name a screen reader gets for the chart: what it shows and the span. */
export function chartName(
  view: Pick<RankVsDownloadsResponse, 'days' | 'keywords' | 'downloads'>,
): string {
  const first = view.days[0];
  const last = view.days[view.days.length - 1];
  const terms = formatList(
    view.keywords.map((row) => row.term),
    { type: 'unit' },
  );
  return t('aso:rd.chart', {
    terms,
    what: view.downloads ? view.downloads.label.toLowerCase() : t('aso:rd.chartDownloads'),
    from: first ? formatDay(first, true) : '',
    to: last ? formatDay(last, true) : '',
  });
}

// ---------------------------------------------------------------------------------------------
// "What changed" per big move

export type WhatChanged = {
  keywordId: string;
  /** "coffee timer moved from 30 to 5 on 12 Oct 2026". */
  head: string;
  /** The count before and after, or why there is none. */
  detail: string;
  /** Always "Correlation, not proof", and how many days were compared. */
  label: string;
  /** The change of the daily average in percent, or null. */
  percent: number | null;
  status: MoveComparison['status'];
  /** Another move falls in the same days. */
  overlap: string | null;
  /** The check before it was more than a day earlier, so the move could have happened on any day in between. */
  gap: string | null;
};

const avg = (n: number | null): string =>
  n === null ? t('aso:value.none') : formatNumber(n, { maximumFractionDigits: 1 });

/** A plain sentence per comparison. No causal wording; the days compared are in the label. */
export function whatChanged(c: MoveComparison, term: string): WhatChanged {
  const m = c.marker;
  const head = t(
    m.kind === 'entered'
      ? 'aso:rd.head.entered'
      : m.kind === 'dropped'
        ? 'aso:rd.head.dropped'
        : 'aso:rd.head.moved',
    { term, from: m.from ?? '', to: m.to ?? '', day: formatDay(m.day, true) },
  );
  let detail: string;
  let label: string;
  if (c.status === 'waiting') {
    detail = c.settledNeededThrough
      ? t('aso:rd.detail.waiting', { date: formatDay(c.settledNeededThrough, true) })
      : t('aso:rd.detail.waitingLater');
    label = t('aso:rd.label.waiting');
  } else if (c.status === 'too_few_days') {
    detail = t('aso:rd.detail.tooFew', {
      before: c.before.days,
      after: c.after.days,
      min: rankDownloadsLimits.minWindowDays,
    });
    label = t('aso:rd.label.tooFew', { before: c.before.days, after: c.after.days });
  } else {
    const pct =
      c.changePercent === null
        ? t('aso:rd.pct.none')
        : formatPercent(c.changePercent / 100, { signDisplay: 'exceptZero', maximumFractionDigits: 2 });
    detail = t('aso:rd.detail.ok', {
      before: avg(c.before.perDay),
      beforeDays: c.before.days,
      after: avg(c.after.perDay),
      afterDays: c.after.days,
      pct,
    });
    label = t('aso:rd.label.ok', { before: c.before.days, after: c.after.days });
  }
  return {
    keywordId: m.keywordId,
    head,
    detail,
    label,
    percent: c.status === 'ok' ? c.changePercent : null,
    status: c.status,
    overlap: c.overlapsOtherMove ? t('aso:rd.overlap') : null,
    gap: c.checkGapDays > 1 ? t('aso:rd.gap', { count: c.checkGapDays }) : null,
  };
}

export const whatChangedList = (
  view: Pick<RankVsDownloadsResponse, 'comparisons' | 'keywords'>,
): WhatChanged[] =>
  view.comparisons.map((c) =>
    whatChanged(
      c,
      view.keywords.filter((row) => row.id === c.marker.keywordId)[0]?.term ?? t('aso:rd.aKeyword'),
    ),
  );
