// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// Report periods (docs/adr/0053-timeline-and-reports.md). A week runs Monday to Sunday (UTC days, like the analytics store), a month is
// a calendar month, a year a calendar year. A period still running is compared with the same number of days of the one before, so a
// half week never reads as a bad week. Pure; ES2017.
import { addDays, bucketStart, daysBetween } from './analytics.ts';

export const reportKinds = ['week', 'month', 'year'] as const;
export type ReportKind = (typeof reportKinds)[number];
export const isReportKind = (v: unknown): v is ReportKind =>
  typeof v === 'string' && (reportKinds as readonly string[]).indexOf(v) !== -1;

export type DayWindow = { from: string; to: string };

const monthEnd = (day: string): string => {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
};

/** The whole week, month or year that holds `day`. */
export function periodContaining(kind: ReportKind, day: string): DayWindow {
  if (kind === 'week') {
    const from = bucketStart(day, 'week');
    return { from, to: addDays(from, 6) };
  }
  if (kind === 'month') return { from: `${day.slice(0, 8)}01`, to: monthEnd(day) };
  return { from: `${day.slice(0, 4)}-01-01`, to: `${day.slice(0, 4)}-12-31` };
}

/** The whole period before a whole period. */
export function periodBefore(kind: ReportKind, window: DayWindow): DayWindow {
  return periodContaining(kind, addDays(window.from, -1));
}

/** The whole period after a whole period. */
export function periodAfter(kind: ReportKind, window: DayWindow): DayWindow {
  return periodContaining(kind, addDays(window.to, 1));
}

export type Comparison = {
  kind: ReportKind;
  /** The whole period asked for. */
  period: DayWindow;
  /** The days of it that have numbers (up to `through`). Empty (`currentDays` 0) when the period has not started. */
  current: DayWindow;
  previous: DayWindow;
  currentDays: number;
  previousDays: number;
  /** The period is still running: `current` is shorter than `period`, and `previous` is cut to the same number of days. */
  partial: boolean;
  /** The two spans have different numbers of days (February against March, a leap year): totals are not like for like. */
  lengthsDiffer: boolean;
};

/**
 * The period containing `day` against the one before it. `through` is the newest day with final numbers; a period that ends after it
 * is partial and is compared with the same number of days from the start of the period before.
 */
export function compareWith(kind: ReportKind, day: string, through: string): Comparison {
  const period = periodContaining(kind, day);
  const before = periodBefore(kind, period);
  const partial = period.to > through;
  const currentTo = partial ? through : period.to;
  const currentDays = currentTo < period.from ? 0 : daysBetween(period.from, currentTo) + 1;
  const current = { from: period.from, to: currentDays === 0 ? addDays(period.from, -1) : currentTo };
  let previous = before;
  if (partial) {
    const cut = addDays(before.from, Math.max(0, currentDays) - 1);
    previous = { from: before.from, to: cut > before.to ? before.to : cut };
  }
  const previousDays = previous.to < previous.from ? 0 : daysBetween(previous.from, previous.to) + 1;
  return { kind, period, current, previous, currentDays, previousDays, partial, lengthsDiffer: currentDays !== previousDays };
}

/** The newest period that has ended by `through` (the one a report offers first, when the running one is not wanted). */
export function latestCompletePeriod(kind: ReportKind, through: string): DayWindow {
  const running = periodContaining(kind, through);
  return running.to <= through ? running : periodBefore(kind, running);
}

/** Starting days of the periods to choose from, newest first: the running one, then the ones before it. */
export function recentPeriods(kind: ReportKind, through: string, count: number): DayWindow[] {
  const out: DayWindow[] = [];
  let w = periodContaining(kind, through);
  while (out.length < count) {
    out.push(w);
    w = periodBefore(kind, w);
  }
  return out;
}
