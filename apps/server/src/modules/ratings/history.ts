// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// The ratings history: what an app's star rating was on each day a read saw it, per country, and the new ratings worked out from it. The
// stores keep no history, so "new ratings" are the difference between two readings of the same country:
//   - with stars at both ends the new ratings per star are the difference per star (exact);
//   - otherwise the count difference is the number of new ratings, and the sum of their stars is average x count now less before. Apple rounds
//     its average, so with many ratings and few new ones the rounding is bigger than the change and the new ratings get NO average;
//   - a count that falls is not new ratings; one that falls under half is a reset by the store (a developer can reset the summary rating with a
//     release), and the ratings counted since are all new; a smaller fall is ratings taken away and counts as none.
// A day without a reading is carried over: the difference between two readings lands on the later one, and `spansGap` says it.
import { addDays, bucketsIn, dayRange, type Granularity } from './days.ts';

export type Stars = [number, number, number, number, number];
export type Reading = {
  day: string;
  territory: string;
  /** 0 to 5. */
  average: number;
  /** Null when the store gives no count (Google Play's files). */
  count: number | null;
  stars: Stars | null;
  version?: string | null;
  /** Google Play's files: the average of the ratings given that day. */
  dayAverage?: number | null;
};

const ROUNDING = 0.0005; // Kiln keeps averages in thousandths: each can be off by half of the last
export const starTotal = (s: Stars): number => s[0] + s[1] + s[2] + s[3] + s[4];
export const starSum = (s: Stars): number => s[0] + 2 * s[1] + 3 * s[2] + 4 * s[3] + 5 * s[4];
export const addStars = (a: Stars, b: Stars): Stars => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
  a[3] + b[3],
  a[4] + b[4],
];

export type Step = {
  day: string;
  since: string;
  territory: string;
  newCount: number;
  /** The new ratings' stars added up, or null when the readings cannot say. */
  newSum: number | null;
  newStars: Stars | null;
  reset: boolean;
};

function stepBetween(a: Reading, b: Reading): Omit<Step, 'day' | 'since' | 'territory'> | null {
  if (a.count === null || b.count === null) return null;
  if (b.count < a.count) {
    if (b.count < a.count / 2) {
      return {
        newCount: b.count,
        newSum: b.stars ? starSum(b.stars) : b.average * b.count,
        newStars: b.stars,
        reset: true,
      };
    }
    return { newCount: 0, newSum: null, newStars: null, reset: false };
  }
  if (a.stars && b.stars) {
    const d = b.stars.map((v, i) => v - a.stars![i]!) as Stars;
    if (d.every((v) => v >= 0))
      return { newCount: starTotal(d), newSum: starSum(d), newStars: d, reset: false };
  }
  const newCount = b.count - a.count;
  if (newCount === 0) return { newCount: 0, newSum: null, newStars: null, reset: false };
  const sum = b.average * b.count - a.average * a.count;
  const error = ROUNDING * (a.count + b.count);
  const usable = error <= newCount * 0.25 && sum >= newCount - error && sum <= newCount * 5 + error;
  return {
    newCount,
    newSum: usable ? Math.min(newCount * 5, Math.max(newCount, sum)) : null,
    newStars: null,
    reset: false,
  };
}

const byDay = (list: Reading[]) => [...list].sort((a, b) => a.day.localeCompare(b.day));

export function stepsOf(readings: Reading[], territory: string): Step[] {
  const sorted = byDay(readings);
  const steps: Step[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const step = stepBetween(sorted[i - 1]!, sorted[i]!);
    if (step) steps.push({ ...step, day: sorted[i]!.day, since: sorted[i - 1]!.day, territory });
  }
  return steps;
}

export const group = (readings: Reading[]): Map<string, Reading[]> => {
  const m = new Map<string, Reading[]>();
  for (const r of readings) m.set(r.territory, [...(m.get(r.territory) ?? []), r]);
  return m;
};

/** Every country with a reading, by its newest count, biggest first. */
export function territoriesOf(readings: Reading[]): string[] {
  return [...group(readings).entries()]
    .map(([t, list]) => [t, byDay(list).at(-1)?.count ?? 0] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

export type Bucket = {
  start: string;
  end: string;
  /** All ratings at the end of the bucket: each country's newest reading up to then, added up. Null before the first reading or without counts. */
  count: number | null;
  average: number | null;
  newCount: number;
  newAverage: number | null;
  newStars: Stars | null;
  /** New ratings whose stars the readings cannot tell: the grey share. */
  newUnknown: number;
  dayAverage: number | null;
  reset: boolean;
  spansGap: boolean;
};

export function ratingBuckets(
  readings: Reading[],
  o: { country: string; granularity: Granularity; from: string; to: string },
): Bucket[] {
  const groups = group(readings);
  const codes = o.country === 'all' ? [...groups.keys()] : [o.country];
  const steps = codes.flatMap((c) => stepsOf(groups.get(c) ?? [], c));
  return bucketsIn(o.from, o.to, o.granularity).map(({ start, end }) => {
    let count = 0;
    let sum = 0;
    let counted = false;
    const averages: number[] = [];
    for (const c of codes) {
      let newest: Reading | null = null;
      for (const r of byDay(groups.get(c) ?? [])) {
        if (r.day > end) break;
        newest = r;
      }
      if (!newest) continue;
      if (newest.count === null) averages.push(newest.average);
      else {
        counted = true;
        count += newest.count;
        sum += newest.average * newest.count;
      }
    }
    const inside = steps.filter((s) => s.day >= start && s.day <= end);
    const newCount = inside.reduce((t, s) => t + s.newCount, 0);
    const summed = inside.filter((s) => s.newSum !== null && s.newCount > 0);
    const summedCount = summed.reduce((t, s) => t + s.newCount, 0);
    const withStars = inside.filter((s) => s.newCount > 0 && s.newStars);
    const days = codes.flatMap((c) =>
      (groups.get(c) ?? [])
        .filter((r) => r.day >= start && r.day <= end && r.dayAverage != null)
        .map((r) => r.dayAverage as number),
    );
    return {
      start,
      end,
      count: counted ? count : null,
      average:
        counted && count > 0
          ? sum / count
          : !counted && averages.length > 0
            ? averages.reduce((a, b) => a + b, 0) / averages.length
            : null,
      newCount,
      newAverage:
        summedCount > 0 ? summed.reduce((t, s) => t + (s.newSum ?? 0), 0) / summedCount : null,
      newStars:
        withStars.length > 0
          ? withStars.reduce((t, s) => addStars(t, s.newStars!), [0, 0, 0, 0, 0] as Stars)
          : null,
      newUnknown: inside
        .filter((s) => s.newCount > 0 && !s.newStars)
        .reduce((t, s) => t + s.newCount, 0),
      dayAverage: days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : null,
      reset: inside.some((s) => s.reset),
      spansGap: inside.some((s) => s.since < start && s.newCount > 0),
    };
  });
}

export type CountryRow = {
  territory: string;
  average: number;
  count: number | null;
  newCount: number;
  newAverage: number | null;
  change: number | null;
  day: string;
};

/** Each country as of its newest reading, with what the history says about the window. */
export function countryRows(readings: Reading[], from: string, to: string): CountryRow[] {
  return [...group(readings).entries()]
    .map(([territory, list]): CountryRow | null => {
      const sorted = byDay(list);
      const now = sorted.at(-1)!;
      // Apple answers a country with no ratings with 0 from 0: the history keeps it (the first rating there counts as new), the table does not.
      if (now.count === 0) return null;
      const steps = stepsOf(sorted, territory).filter((s) => s.day >= from && s.day <= to);
      const summed = steps.filter((s) => s.newSum !== null && s.newCount > 0);
      const summedCount = summed.reduce((t, s) => t + s.newCount, 0);
      const atStart = [...sorted].reverse().find((r) => r.day <= from);
      return {
        territory,
        average: now.average,
        count: now.count,
        newCount: steps.reduce((t, s) => t + s.newCount, 0),
        newAverage:
          summedCount > 0 ? summed.reduce((t, s) => t + (s.newSum ?? 0), 0) / summedCount : null,
        change: atStart ? now.average - atStart.average : null,
        day: now.day,
      };
    })
    .filter((r): r is CountryRow => !!r)
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.territory.localeCompare(b.territory));
}

export type ReviewBucket = {
  start: string;
  end: string;
  stars: Stars;
  count: number;
  average: number | null;
};

/** Written reviews in buckets, per star: the one history every store gives in full. */
export function reviewBuckets(
  reviews: { day: string; rating: number; territory?: string | null }[],
  o: { country: string; granularity: Granularity; from: string; to: string },
): ReviewBucket[] {
  const buckets: ReviewBucket[] = bucketsIn(o.from, o.to, o.granularity).map((b) => ({
    ...b,
    stars: [0, 0, 0, 0, 0],
    count: 0,
    average: null,
  }));
  for (const r of reviews) {
    if (o.country !== 'all' && (r.territory ?? '') !== o.country) continue;
    if (r.day < o.from || r.day > o.to) continue;
    const b = buckets.find((x) => r.day >= x.start && r.day <= x.end);
    if (!b) continue;
    b.stars[Math.min(5, Math.max(1, Math.round(r.rating))) - 1]! += 1;
    b.count += 1;
  }
  for (const b of buckets) b.average = b.count > 0 ? starSum(b.stars) / b.count : null;
  return buckets;
}

export { addDays, dayRange };
