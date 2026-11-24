// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// The numbers table of a report: one figure per metric, a period against the one before (docs/adr/0053-timeline-and-reports.md).
// A change is only given when both periods have a value for nearly every day (`MIN_COVERAGE`): a store's history often starts
// part way through the period before, and against a half empty period any period reads as a leap. Pure; ES2017.
import { MIN_COVERAGE, relativeChange, windowStats } from './timeline-impact.ts';
import type { TimelineMetric } from './timeline-events.ts';
import type { Comparison } from './timeline-periods.ts';

export type ReportFigure = {
  id: string;
  metric: TimelineMetric['metric'];
  currency: string | null;
  kind: TimelineMetric['kind'];
  /** A count or an amount: the total of the period. A rate: the period's rate. Null without data. */
  value: number | null;
  previous: number | null;
  /** Relative change, or null when not comparable. */
  change: number | null;
  /** Why there is no change: `no_data`, `previous_incomplete`, `current_incomplete`; null when there is one. */
  uncompared: 'no_data' | 'previous_incomplete' | 'current_incomplete' | null;
  /** Days with a value in the period and in the previous one. */
  days: number;
  previousDays: number;
};

const total = (kind: TimelineMetric['kind'], w: ReturnType<typeof windowStats>): number | null =>
  w.dataDays === 0 ? null : kind === 'ratio' ? w.value : w.sum;

export function figureFor(m: TimelineMetric, cmp: Comparison): ReportFigure {
  const cur = windowStats(m.kind, m.values, m.denominators, cmp.current.from, cmp.current.to);
  const prev = windowStats(m.kind, m.values, m.denominators, cmp.previous.from, cmp.previous.to);
  const value = total(m.kind, cur);
  const previous = total(m.kind, prev);
  let uncompared: ReportFigure['uncompared'] = null;
  if (value === null) uncompared = 'no_data';
  else if (previous === null || prev.dataDays < prev.calendarDays * MIN_COVERAGE)
    uncompared = 'previous_incomplete';
  else if (cur.dataDays < cur.calendarDays * MIN_COVERAGE) uncompared = 'current_incomplete';
  return {
    id: m.id,
    metric: m.metric,
    currency: m.currency,
    kind: m.kind,
    value,
    previous,
    change: uncompared === null ? relativeChange(value, previous) : null,
    uncompared,
    days: cur.dataDays,
    previousDays: prev.dataDays,
  };
}
