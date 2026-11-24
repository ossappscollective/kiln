// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// What happened around an event: the days before it against the days after it (docs/adr/0053-timeline-and-reports.md).
// Pure: no I/O. Written for the ES2017 web build (no flatMap, no fromEntries).
//
// The rules, in one place (docs/api/timeline.md repeats them for users):
// - The day the change reached the store (the anchor) is left out: it is half old and half new.
// - The before window is the `days` days before the anchor, the after window the `days` days after it, but never past `latest`, the
//   newest day whose number the store has finished changing. A window still filling is compared on what it has.
// - A day with no value is a gap, not a zero: it is not counted. A window with fewer than 80% of its days is flagged `gaps`.
// - No answer on fewer than 7 whole days after the change (`too_early`): a few days would set a weekend against a fortnight.
// - A rate (downloads over visits) is compared with a two-proportion z-test, a count with a Poisson approximation of the difference
//   of the two totals (scaled to the same number of days), money and other levels are not tested. The result says so (`not_tested`).
// - The bar for a verdict is 90% confidence once the after window is full, and 99% while it is still filling (it is read again every
//   day, which makes a fluke likelier to slip through), and the change must be at least 2%.
// - Daily counts vary more than a Poisson count does, so the confidence of a count is a lower bar than it should be. That is why the
//   wording is "went up" and "went down", never "worked", and every result carries what else happened in the same weeks.
// This is a before and after comparison, not a controlled test: a season, a price change or a feature moves the same numbers.
import { addDays, daysBetween } from './analytics.ts';

export type ImpactKind = 'count' | 'ratio' | 'level';
export type ImpactVerdict =
  | 'higher'
  | 'lower'
  | 'no_clear_difference'
  | 'too_early'
  | 'not_tested'
  | 'not_live'
  | 'no_data';
export type ImpactCaveat =
  | 'short_window'
  | 'gaps'
  | 'small_numbers'
  | 'not_tested'
  | 'approximate_test'
  | 'other_events';

export type DayValues = ReadonlyMap<string, number>;

/** A change only reads as real above this confidence, once the after window is full. */
export const CONFIDENT = 0.9;
/** The bar while the after window is still filling. */
export const EARLY_CONFIDENT = 0.99;
/** No verdict on fewer days after the change than this: one of each weekday. */
export const MIN_DAYS_AFTER = 7;
/** The smallest relative change that reads as a change. */
export const MIN_CHANGE = 0.02;
/** A window needs this share of its days to have a value, or it is flagged `gaps`. */
export const MIN_COVERAGE = 0.8;
/** Fewer than this many visits (rates) or events (counts) in a window and the result is flagged `small_numbers`. */
export const SMALL_NUMBERS = 100;
export const DEFAULT_IMPACT_DAYS = 14;
export const IMPACT_DAYS_CHOICES = [7, 14, 28] as const;

/** The standard normal CDF, by the Abramowitz and Stegun erf approximation (7.1.26). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-proportion z-test: the two-sided confidence (0 to 1) that the rates differ, or null when a side has no trials. */
export function proportionConfidence(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
): number | null {
  if (trialsA <= 0 || trialsB <= 0) return null;
  const pA = Math.min(1, successesA / trialsA);
  const pB = Math.min(1, successesB / trialsB);
  const pooled = Math.min(1, (successesA + successesB) / (trialsA + trialsB));
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return pA === pB ? 0 : 1;
  return 2 * normalCdf(Math.abs(pB - pA) / se) - 1;
}

/** Two counts compared by a Poisson approximation: the confidence that they differ, or null when both are zero. */
export function countConfidence(before: number, after: number): number | null {
  if (before + after <= 0) return null;
  const z = Math.abs(after - before) / Math.sqrt(before + after);
  return 2 * normalCdf(z) - 1;
}

/** Relative change, 0.18 for +18%; null when either side is missing or the base is zero. */
export function relativeChange(now: number | null, then: number | null): number | null {
  if (now === null || then === null || then === 0) return null;
  const change = (now - then) / Math.abs(then);
  return Number.isFinite(change) ? change : null;
}

/** The confidence a verdict needs with this many days measured: none before a week, 99% until the window is full, 90% after. */
export function confidenceBar(daysAfter: number, fullDays: number): number | null {
  if (daysAfter >= fullDays) return CONFIDENT;
  if (daysAfter >= Math.min(MIN_DAYS_AFTER, fullDays)) return EARLY_CONFIDENT;
  return null;
}

export type WindowStats = {
  from: string;
  to: string;
  /** Days in the window, with or without a value. */
  calendarDays: number;
  /** Days with a value. */
  dataDays: number;
  /** Sum of the metric (the numerator of a rate) over the days with a value. */
  sum: number;
  /** Sum of the denominator over the same days (rates only; 0 otherwise). */
  denominator: number;
  /** A rate: sum over denominator. A count or level: the mean per day with a value. Null without data. */
  value: number | null;
};

const EMPTY_AFTER = (from: string): WindowStats => ({
  from,
  to: addDays(from, -1),
  calendarDays: 0,
  dataDays: 0,
  sum: 0,
  denominator: 0,
  value: null,
});

/**
 * One window of a metric. For a rate a day counts only when both its numerator and its denominator are present.
 * Pure over the maps; `from > to` is an empty window.
 */
export function windowStats(
  kind: ImpactKind,
  values: DayValues,
  denominators: DayValues | undefined,
  from: string,
  to: string,
): WindowStats {
  if (from > to) return EMPTY_AFTER(from);
  const calendarDays = daysBetween(from, to) + 1;
  let dataDays = 0;
  let sum = 0;
  let denominator = 0;
  for (let day = from, i = 0; i < calendarDays; i += 1, day = addDays(day, 1)) {
    const v = values.get(day);
    if (v === undefined) continue;
    if (kind === 'ratio') {
      const d = denominators ? denominators.get(day) : undefined;
      if (d === undefined) continue;
      denominator += d;
    }
    dataDays += 1;
    sum += v;
  }
  const value =
    dataDays === 0
      ? null
      : kind === 'ratio'
        ? denominator > 0
          ? sum / denominator
          : null
        : sum / dataDays;
  return { from, to, calendarDays, dataDays, sum, denominator, value };
}

export type ImpactInput = {
  kind: ImpactKind;
  values: DayValues;
  /** The denominator of a rate. */
  denominators?: DayValues | undefined;
  /** The day the change reached the store. */
  anchor: string;
  /** The newest day whose number is final. */
  latest: string;
  /** Days on each side (7, 14 or 28). */
  days: number;
  /** After this many days the window counts as full (the 90% bar). Default: `days`. */
  fullDays?: number | undefined;
  /** Whether other events fall inside the two windows (adds the `other_events` caveat). */
  otherEvents?: number | undefined;
};

export type Impact = {
  anchor: string;
  days: number;
  before: WindowStats;
  after: WindowStats;
  /** Whole days from the day after the anchor to `latest` (at most `days`). */
  daysAfter: number;
  /** Days still to wait for a first reading (a week after the change), 0 once it is possible. */
  daysToFirstRead: number;
  /** Days still to wait for the full window. */
  daysToFull: number;
  /** Relative change of the after window against the before window, or null. */
  change: number | null;
  /** Two-sided confidence that the two windows differ, or null when not tested or not computable. */
  confidence: number | null;
  verdict: ImpactVerdict;
  caveats: ImpactCaveat[];
};

export function impactOf(input: ImpactInput): Impact {
  const { kind, anchor, days } = input;
  const fullDays = input.fullDays ?? days;
  const before = windowStats(
    kind,
    input.values,
    input.denominators,
    addDays(anchor, -days),
    addDays(anchor, -1),
  );
  const afterStart = addDays(anchor, 1);
  const afterEnd = addDays(anchor, days);
  const afterTo = input.latest < afterEnd ? input.latest : afterEnd;
  const daysAfter = Math.max(0, afterTo >= afterStart ? daysBetween(afterStart, afterTo) + 1 : 0);
  const after =
    daysAfter > 0
      ? windowStats(kind, input.values, input.denominators, afterStart, afterTo)
      : EMPTY_AFTER(afterStart);
  const base = {
    anchor,
    days,
    before,
    after,
    daysAfter,
    daysToFirstRead: Math.max(0, Math.min(MIN_DAYS_AFTER, fullDays) - daysAfter),
    daysToFull: Math.max(0, fullDays - daysAfter),
  };
  const caveats: ImpactCaveat[] = [];
  if (daysAfter < fullDays) caveats.push('short_window');
  const thin = (w: WindowStats) => w.calendarDays > 0 && w.dataDays < w.calendarDays * MIN_COVERAGE;
  if (thin(before) || thin(after)) caveats.push('gaps');
  if ((input.otherEvents ?? 0) > 0) caveats.push('other_events');

  if (before.dataDays === 0 || (daysAfter > 0 && after.dataDays === 0)) {
    return {
      ...base,
      change: null,
      confidence: null,
      verdict: daysAfter === 0 ? 'too_early' : 'no_data',
      caveats,
    };
  }
  const change = relativeChange(after.value, before.value);
  let confidence: number | null = null;
  if (daysAfter > 0 && after.value !== null) {
    if (kind === 'ratio') {
      confidence = proportionConfidence(
        before.sum,
        before.denominator,
        after.sum,
        after.denominator,
      );
      if (Math.min(before.denominator, after.denominator) < SMALL_NUMBERS)
        caveats.push('small_numbers');
    } else if (kind === 'count') {
      const scaledBefore = (before.value ?? 0) * after.dataDays;
      confidence = countConfidence(scaledBefore, after.sum);
      caveats.push('approximate_test');
      if (Math.min(scaledBefore, after.sum) < SMALL_NUMBERS) caveats.push('small_numbers');
    } else {
      caveats.push('not_tested');
    }
  }
  if (daysAfter === 0 || change === null)
    return { ...base, change, confidence, verdict: 'too_early', caveats };
  if (kind === 'level')
    return {
      ...base,
      change,
      confidence,
      verdict: daysAfter >= MIN_DAYS_AFTER ? 'not_tested' : 'too_early',
      caveats,
    };
  return {
    ...base,
    change,
    confidence,
    verdict: verdictFor(change, confidence, daysAfter, fullDays),
    caveats,
  };
}

export function verdictFor(
  change: number | null,
  confidence: number | null,
  daysAfter: number,
  fullDays: number,
): ImpactVerdict {
  if (daysAfter === 0 || change === null || confidence === null) return 'too_early';
  const bar = confidenceBar(daysAfter, fullDays);
  if (bar !== null && confidence >= bar && Math.abs(change) >= MIN_CHANGE)
    return change > 0 ? 'higher' : 'lower';
  // A full window that still cannot tell the two apart is an answer.
  if (daysAfter >= fullDays) return 'no_clear_difference';
  return 'too_early';
}

/**
 * The windows of "did the newest graphics change work": the days since the change against the same number of days before it
 * (at most 28 each). Returns the number of days to compare, or 0 when the change is not a day old yet.
 */
export function sinceWindowDays(anchor: string, latest: string, cap = 28): number {
  const since = latest > anchor ? daysBetween(anchor, latest) : 0;
  return Math.min(cap, since);
}
