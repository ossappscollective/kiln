import { daysBetween } from '@kiln/core';
import { missingRuns, presentRuns, type Run } from './analytics.ts';
import type { PanelKind } from './view.ts';

/**
 * The geometry of one chart panel, as pure functions: scales, clean ticks, line runs (a gap is a gap), column paths with a
 * 4px rounded data end and a 2px surface gap between stacked parts, hatched bands for missing days and a wash for days the
 * store may still change. The SVG components only draw what comes out of here. No `window`, no `document`.
 *
 * Marks follow the dataviz rules: 2px lines, columns at most 24px thick growing from one baseline, hairline recessive grid.
 */

export type Box = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type PlotSeries = { key: string; color: 1 | 2; values: (number | null)[] };

export type PlotInput = {
  box: Box;
  count: number;
  kind: PanelKind;
  series: PlotSeries[];
  domain: 'zero' | 'tight';
  /** Hard limits of a tight domain (a rating is between 1 and 5). */
  bounds?: [number, number];
  /** The first index the store may still change; days from here on get a wash. */
  provisionalFrom?: number;
};

export type Pt = { x: number; y: number; i: number; value: number };
export type LineGeometry = {
  key: string;
  color: 1 | 2;
  runs: { d: string; points: Pt[] }[];
  last: Pt | null;
};
export type BarGeometry = {
  key: string;
  color: 1 | 2;
  i: number;
  d: string;
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
};
export type Band = { x: number; w: number; from: number; to: number };
export type Tick = { value: number; y: number };

export type Geometry = {
  box: Box;
  plotW: number;
  plotH: number;
  slot: number;
  count: number;
  min: number;
  max: number;
  baseline: number;
  ticks: Tick[];
  lines: LineGeometry[];
  bars: BarGeometry[];
  missing: Band[];
  provisional: Band | null;
  xCenter: (i: number) => number;
  y: (v: number) => number;
};

/** A step of 1, 2 or 5 times a power of ten that fits about `count` steps in `range`. */
export function niceStep(range: number, count: number): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(1, count);
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

const clean = (n: number): number => Number(n.toPrecision(12));

/** Clean tick values that cover [min, max]; the first and last are the ends of the axis. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [clean(min), clean(min + 1)];
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 1e-6 && out.length < 12; v += step) out.push(clean(v));
  return out;
}

/** The axis range for the values: from zero (counts, rates, money), or following the data inside `bounds` (a rating). */
export function domainOf(
  values: readonly number[],
  domain: 'zero' | 'tight',
  bounds?: [number, number],
): [number, number] {
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  if (domain === 'zero') {
    const min = Math.min(0, lo);
    const max = hi > min ? hi : min + 1;
    const ticks = niceTicks(min, max);
    return [ticks[0] as number, ticks[ticks.length - 1] as number];
  }
  const span = hi - lo;
  const pad = span > 0 ? span * 0.2 : 0.25;
  let a = lo - pad;
  let b = hi + pad;
  if (bounds) {
    a = Math.max(bounds[0], a);
    b = Math.min(bounds[1], b);
  }
  const ticks = niceTicks(a, b, 3);
  const first = ticks[0] as number;
  const last = ticks[ticks.length - 1] as number;
  return bounds ? [Math.max(bounds[0], first), Math.min(bounds[1], last)] : [first, last];
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** A column from `yBase` to `yTip`: the data end is rounded (4px), the baseline end is square. */
export function columnPath(
  x: number,
  w: number,
  yBase: number,
  yTip: number,
  radius: number,
  roundEnd: boolean,
): string {
  const up = yTip <= yBase;
  const h = Math.abs(yBase - yTip);
  const r = roundEnd ? Math.min(radius, w / 2, h) : 0;
  if (r <= 0) return `M${f(x)},${f(yBase)}V${f(yTip)}H${f(x + w)}V${f(yBase)}Z`;
  if (up)
    return `M${f(x)},${f(yBase)}V${f(yTip + r)}A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(yTip)}H${f(x + w - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w)},${f(yTip + r)}V${f(yBase)}Z`;
  return `M${f(x)},${f(yBase)}V${f(yTip - r)}A${f(r)},${f(r)} 0 0 0 ${f(x + r)},${f(yTip)}H${f(x + w - r)}A${f(r)},${f(r)} 0 0 0 ${f(x + w)},${f(yTip - r)}V${f(yBase)}Z`;
}

const bandsOf = (runs: Run[], left: number, slot: number): Band[] =>
  runs.map((r) => ({
    x: left + r.start * slot,
    w: (r.end - r.start + 1) * slot,
    from: r.start,
    to: r.end,
  }));

/** Everything a panel draws. */
export function plot(input: PlotInput): Geometry {
  const { box, count, kind, series } = input;
  const plotW = Math.max(1, box.width - box.left - box.right);
  const plotH = Math.max(1, box.height - box.top - box.bottom);
  const n = Math.max(1, count);
  const slot = plotW / n;
  const xCenter = (i: number): number => box.left + (i + 0.5) * slot;
  const stacked = kind !== 'line' && series.length > 1;

  // The values that set the axis: each value, or for a stack the sum of the parts of a day.
  const forDomain: number[] = [];
  if (stacked) {
    for (let i = 0; i < n; i += 1) {
      const parts = series.map((s) => s.values[i] ?? null).filter((v): v is number => v !== null);
      if (parts.length > 0) forDomain.push(parts.reduce((a, b) => a + b, 0));
    }
  } else {
    for (const s of series) for (const v of s.values) if (v !== null) forDomain.push(v);
  }
  const [min, max] = domainOf(forDomain, input.domain, input.bounds);
  const y = (v: number): number => box.top + plotH * (1 - (v - min) / (max - min));
  const baseline = y(Math.max(min, Math.min(0, max)));
  const ticks = niceTicks(min, max, input.domain === 'tight' ? 3 : 4)
    .filter((t) => t >= min - 1e-9 && t <= max + 1e-9)
    .map((value) => ({ value, y: y(value) }));

  const lines: LineGeometry[] = [];
  const bars: BarGeometry[] = [];
  if (kind === 'line') {
    for (const s of series) {
      const runs = presentRuns(s.values).map((r) => {
        const points: Pt[] = [];
        for (let i = r.start; i <= r.end; i += 1)
          points.push({
            x: xCenter(i),
            y: y(s.values[i] as number),
            i,
            value: s.values[i] as number,
          });
        return {
          d: points.map((p, k) => `${k === 0 ? 'M' : 'L'}${f(p.x)},${f(p.y)}`).join(''),
          points,
        };
      });
      const lastRun = runs[runs.length - 1];
      lines.push({
        key: s.key,
        color: s.color,
        runs,
        last: lastRun ? (lastRun.points[lastRun.points.length - 1] as Pt) : null,
      });
    }
  } else {
    const w = Math.max(1, Math.min(24, slot - 2));
    for (let i = 0; i < n; i += 1) {
      const x = xCenter(i) - w / 2;
      let cumulative = 0;
      let drawn = 0;
      // The last part of a day with a value is the one with the rounded end.
      let topIndex = -1;
      series.forEach((s, j) => {
        const v = s.values[i];
        if (v !== null && v !== undefined && v !== 0) topIndex = j;
      });
      series.forEach((s, j) => {
        const v = s.values[i];
        if (v === null || v === undefined || v === 0) return;
        const from = stacked ? cumulative : 0;
        const to = from + v;
        cumulative = to;
        let yBase = y(from);
        const yTip = y(to);
        if (stacked && drawn > 0) yBase -= 2; // the 2px surface gap between parts
        drawn += 1;
        const h = Math.abs(yBase - yTip);
        if (h < 0.5) return;
        bars.push({
          key: s.key,
          color: s.color,
          i,
          d: columnPath(x, w, yBase, yTip, 4, j === topIndex),
          x,
          y: Math.min(yBase, yTip),
          w,
          h,
          value: v,
        });
      });
    }
  }

  // A day is missing when no series of the panel has a value for it: hatched, never a zero.
  const allNull = Array.from({ length: n }, (_, i) =>
    series.every((s) => (s.values[i] ?? null) === null),
  );
  const missing = bandsOf(missingRuns(allNull.map((m) => (m ? null : 0))), box.left, slot);
  const from = input.provisionalFrom;
  const provisional =
    from !== undefined && from >= 0 && from < n
      ? { x: box.left + from * slot, w: (n - from) * slot, from, to: n - 1 }
      : null;

  return {
    box,
    plotW,
    plotH,
    slot,
    count: n,
    min,
    max,
    baseline,
    ticks,
    lines,
    bars,
    missing,
    provisional,
    xCenter,
    y,
  };
}

/** The index of the day under a horizontal position (inside the plot), or null outside it. */
export function indexAt(
  geometry: Pick<Geometry, 'box' | 'slot' | 'count'>,
  x: number,
): number | null {
  const rel = x - geometry.box.left;
  if (rel < 0 || rel > geometry.slot * geometry.count) return null;
  return Math.max(0, Math.min(geometry.count - 1, Math.floor(rel / geometry.slot)));
}

/** Indexes for the date labels under the axis: first, last and evenly between, no more than `max`. */
export function xTickIndexes(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  const steps = Math.max(1, max - 1);
  for (let k = 0; k <= steps; k += 1) {
    const i = Math.round((k * (count - 1)) / steps);
    if (out.indexOf(i) < 0) out.push(i);
  }
  return out;
}

/** The first index whose day the store may still change (`delayDays` behind `today`), or -1 when none is in range. */
export function provisionalIndex(
  dates: readonly string[],
  today: string,
  delayDays: number,
): number {
  for (let i = 0; i < dates.length; i += 1)
    if (daysBetween(dates[i] as string, today) <= delayDays) return i;
  return -1;
}

/** Whether two end labels would overlap (they are 12px high), so the second is left to the legend and the tooltip. */
export const labelsCollide = (a: number, b: number, height = 14): boolean =>
  Math.abs(a - b) < height;
