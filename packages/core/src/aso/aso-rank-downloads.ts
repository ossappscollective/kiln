/**
 * Rank versus downloads, pure (docs/api/aso.md, "Rank versus downloads"): the rank history of some tracked keywords laid on the
 * same days as the downloads of the app, rank moves marked, and for each big move the downloads in the 7 days before and the 7 days
 * after it. No I/O, no clock (the caller passes `today`). Kept to ES2017 library calls because the web draws the result.
 *
 * What it is: two series on one calendar and a plain before and after count. What it is NOT: evidence that a rank move caused a change
 * in downloads. Everything here says "correlation, not proof", gives the number of days compared, and uses no causal wording. Other
 * things move downloads too (a release, a feature, a campaign, a holiday, a rating), and two moves close together share their days.
 *
 * Honest about time:
 * - A rank check is stored with a moment; it is put on its UTC day (the last check of the day is the day's rank).
 * - Store download counts lag: Apple about 2 days, Play CSV files 3 to 7 days. The newest `delayDays` days are "may still change" and a
 *   comparison whose "after" days are not yet settled waits (`status: 'waiting'`) instead of being computed on partial days.
 * - A gap is a gap: a day with no number is `null`, never zero, and is not counted in a window.
 */

import { addDays, dateToDay, daysBetween } from '../analytics.ts';
import { isBigMove, type RankChangeKind, rankChange } from './aso.ts';

export const rankDownloadsLimits = {
  /** The most keywords drawn at once. */
  maxKeywords: 5,
  /** The longest range in days. */
  maxDays: 400,
  /** Fewer days than this in either series and the view is hidden. */
  minDays: 14,
  /** Days before and after a move. */
  windowDays: 7,
  /** A window with fewer days than this with a number is not compared. */
  minWindowDays: 5,
} as const;

export type RankCheckIn = { checkedAt: number; rank: number | null; total: number };
export type RankKeywordIn = { id: string; term: string; checks: readonly RankCheckIn[] };
export type DownloadPointIn = { day: string; value: number | null };

export type DownloadsSource = 'apple' | 'play';

export type DownloadsIn = {
  /** The analytics metric the numbers are (`downloads_first_time`, `installs_user`, ...). */
  metric: string;
  label: string;
  source: DownloadsSource;
  /** Days after a date that the store may still change that date's number. */
  delayDays: number;
  /** Any days; the ones around the range are used for the windows of moves near its end. */
  points: readonly DownloadPointIn[];
};

export type DaySample = { rank: number | null; total: number };

export type RankSeries = {
  id: string;
  term: string;
  /** One entry per day of the range; null: no check that day (a gap, not "not ranked"). */
  samples: (DaySample | null)[];
  /** Days of the range with a check. */
  checkDays: number;
};

export type RankMarker = {
  keywordId: string;
  /** The day of the later check (the first one that showed the move). */
  day: string;
  /** The day of the check before it. */
  previousDay: string;
  kind: Exclude<RankChangeKind, 'first' | 'same' | 'still_unranked'>;
  from: number | null;
  to: number | null;
  /** Places gained (positive) or lost (negative) when both checks ranked. */
  delta: number | null;
};

export type WindowCount = {
  from: string;
  to: string;
  /** Days of the window that have a number. */
  days: number;
  total: number | null;
  perDay: number | null;
};

export type ComparisonStatus =
  /** Both windows have enough days. */
  | 'ok'
  /** The "after" days are not settled yet: the store may still change them. */
  | 'waiting'
  /** A window has fewer than `minWindowDays` days with a number. */
  | 'too_few_days';

export type MoveComparison = {
  marker: RankMarker;
  status: ComparisonStatus;
  before: WindowCount;
  after: WindowCount;
  /** Percent change of the daily average after against before, one decimal; null when the status is not ok or there was nothing before. */
  changePercent: number | null;
  /** Days between the two checks. More than 1 means the move could have happened on any of them. */
  checkGapDays: number;
  /** Another rank move (of any selected keyword) falls inside these days. */
  overlapsOtherMove: boolean;
  /** For `waiting`: the day the downloads must be settled through. */
  settledNeededThrough: string | null;
};

export const rankDownloadsNoteCodes = [
  'correlation_not_proof',
  'downloads_delay',
  'time_zones',
  'few_checks',
  'other_causes',
] as const;
export type RankDownloadsNoteCode = (typeof rankDownloadsNoteCodes)[number];
export type RankDownloadsNote = { code: RankDownloadsNoteCode; message: string };

export type RankDownloadsMissing =
  /** No download numbers are stored for the app and range, and analytics is off. */
  | 'turn_on_analytics'
  /** Analytics is on but no download numbers have been read for the range. */
  | 'no_downloads'
  /** No rank check of the chosen keywords in the range. */
  | 'no_rank_checks';

export type RankDownloadsView = {
  from: string;
  to: string;
  days: string[];
  keywords: RankSeries[];
  downloads: {
    metric: string;
    label: string;
    source: DownloadsSource;
    delayDays: number;
    /** One per day of the range; null: no number. */
    values: (number | null)[];
    /** The newest day the store should have settled (today minus the delay). Days after it may still change. */
    settledThrough: string;
    days: number;
  } | null;
  markers: RankMarker[];
  comparisons: MoveComparison[];
  coverage: { rankDays: number; downloadDays: number; minDays: number };
  /** At least `minDays` days of BOTH series. Without it the chart and the comparisons are not shown. */
  enough: boolean;
  /** What is missing, in a fixed vocabulary, when `enough` is false for a reason other than too few days. */
  missing: RankDownloadsMissing | null;
  threshold: number;
  windowDays: number;
  notes: RankDownloadsNote[];
};

export const rankDownloadsNoteMessages: Record<RankDownloadsNoteCode, string> = {
  correlation_not_proof:
    'Correlation, not proof: these numbers show what happened at the same time. They do not show that a rank move changed downloads.',
  downloads_delay:
    'The newest days of download numbers can still change, so they are shaded and not used in a comparison until they settle.',
  time_zones:
    'Ranks are put on UTC days. The stores count their own days (Apple and Play use Pacific Time for some reports), so a move can sit a day off.',
  few_checks:
    'Ranks are checked when a refresh runs, not every day. A move happened somewhere between two checks.',
  other_causes:
    'A release, a feature, a campaign, a holiday or a rating change can move downloads too. Two moves a few days apart share their days.',
};

const note = (code: RankDownloadsNoteCode, message?: string): RankDownloadsNote => ({
  code,
  message: message ?? rankDownloadsNoteMessages[code],
});

/** Every day from `from` to `to` inclusive (at most `maxDays`). */
export function daysOfRange(from: string, to: string): string[] {
  const out: string[] = [];
  let day = from;
  while (day <= to && out.length < rankDownloadsLimits.maxDays) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

/** The rank of each day from checks oldest first: the last check of a UTC day is the day's rank. Days with no check are absent. */
export function dailyRanks(checks: readonly RankCheckIn[]): { day: string; sample: DaySample }[] {
  const byDay: Record<string, DaySample> = {};
  const order: string[] = [];
  const sorted = checks.slice().sort((a, b) => a.checkedAt - b.checkedAt);
  for (const c of sorted) {
    const day = dateToDay(c.checkedAt);
    if (!(day in byDay)) order.push(day);
    byDay[day] = { rank: c.rank, total: c.total };
  }
  return order.map((day) => ({ day, sample: byDay[day] as DaySample }));
}

/** The big moves of one keyword, in order, from its daily ranks (the move is dated by the later check). */
export function rankMarkers(
  keywordId: string,
  daily: readonly { day: string; sample: DaySample }[],
  threshold: number,
  edgeTop?: number,
): RankMarker[] {
  const out: RankMarker[] = [];
  for (let i = 1; i < daily.length; i += 1) {
    const prev = daily[i - 1] as { day: string; sample: DaySample };
    const cur = daily[i] as { day: string; sample: DaySample };
    const change = rankChange(prev.sample, cur.sample);
    if (!isBigMove(change, threshold, edgeTop)) continue;
    if (
      change.kind !== 'up' &&
      change.kind !== 'down' &&
      change.kind !== 'entered' &&
      change.kind !== 'dropped'
    )
      continue;
    out.push({
      keywordId,
      day: cur.day,
      previousDay: prev.day,
      kind: change.kind,
      from: change.from,
      to: change.to,
      delta: change.delta === undefined ? null : change.delta,
    });
  }
  return out;
}

function windowCount(values: Record<string, number | null>, from: string, to: string): WindowCount {
  let days = 0;
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = values[d];
    if (v === null || v === undefined) continue;
    days += 1;
    total += v;
  }
  return { from, to, days, total: days > 0 ? total : null, perDay: days > 0 ? total / days : null };
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Downloads in the days before and after a move. See the module comment for what the windows are. */
export function compareMove(
  marker: RankMarker,
  values: Record<string, number | null>,
  options: {
    settledThrough: string;
    windowDays?: number;
    minWindowDays?: number;
    others?: readonly RankMarker[];
  },
): MoveComparison {
  const n = options.windowDays ?? rankDownloadsLimits.windowDays;
  const minDays = options.minWindowDays ?? rankDownloadsLimits.minWindowDays;
  // Before: the n days ending with the earlier check. After: the n days starting the day after the later check. The days between the
  // two checks are left out because the move happened somewhere in them.
  const before = windowCount(values, addDays(marker.previousDay, -(n - 1)), marker.previousDay);
  const afterFrom = addDays(marker.day, 1);
  const afterTo = addDays(marker.day, n);
  const after = windowCount(values, afterFrom, afterTo);
  const others = options.others ?? [];
  const overlapsOtherMove = others.some(
    (o) =>
      !(o.keywordId === marker.keywordId && o.day === marker.day) &&
      o.day >= before.from &&
      o.day <= afterTo,
  );
  const waiting = afterTo > options.settledThrough;
  let status: ComparisonStatus = 'ok';
  if (waiting) status = 'waiting';
  else if (before.days < minDays || after.days < minDays) status = 'too_few_days';
  const changePercent =
    status === 'ok' && before.perDay !== null && before.perDay > 0 && after.perDay !== null
      ? oneDecimal(((after.perDay - before.perDay) / before.perDay) * 100)
      : null;
  return {
    marker,
    status,
    before,
    after,
    changePercent,
    checkGapDays: daysBetween(marker.previousDay, marker.day),
    overlapsOtherMove,
    settledNeededThrough: waiting ? afterTo : null,
  };
}

/**
 * The whole view for chosen keywords over a range. `today` is the UTC day of now. With fewer than `minDays` days of either series
 * (`enough: false`) the markers and comparisons are empty and the caller shows one quiet line with the counts and what is missing.
 */
export function buildRankVsDownloads(input: {
  from: string;
  to: string;
  today: string;
  keywords: readonly RankKeywordIn[];
  downloads: DownloadsIn | null;
  /** The workspace setting `aso.rankMoveThreshold`. */
  threshold: number;
  /** Whether analytics is switched on, to tell "turn it on" from "nothing read yet". */
  analyticsEnabled: boolean;
}): RankDownloadsView {
  const days = daysOfRange(input.from, input.to);
  const index: Record<string, number> = {};
  days.forEach((d, i) => {
    index[d] = i;
  });

  const keywords: RankSeries[] = [];
  const markers: RankMarker[] = [];
  const rankDaySet: Record<string, true> = {};
  for (const k of input.keywords.slice(0, rankDownloadsLimits.maxKeywords)) {
    const daily = dailyRanks(k.checks);
    const samples: (DaySample | null)[] = days.map(() => null);
    let checkDays = 0;
    for (const d of daily) {
      const i = index[d.day];
      if (i === undefined) continue;
      samples[i] = d.sample;
      checkDays += 1;
      rankDaySet[d.day] = true;
    }
    keywords.push({ id: k.id, term: k.term, samples, checkDays });
    for (const m of rankMarkers(k.id, daily, input.threshold))
      if (m.day >= input.from && m.day <= input.to) markers.push(m);
  }
  markers.sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.keywordId < b.keywordId ? -1 : 1,
  );

  const lookup: Record<string, number | null> = {};
  let downloads: RankDownloadsView['downloads'] = null;
  let settledThrough = input.today;
  if (input.downloads) {
    const d = input.downloads;
    for (const p of d.points)
      lookup[p.day] = p.value === null || !Number.isFinite(p.value) ? null : p.value;
    settledThrough = addDays(input.today, -d.delayDays);
    const values = days.map((day) => (day in lookup ? (lookup[day] as number | null) : null));
    downloads = {
      metric: d.metric,
      label: d.label,
      source: d.source,
      delayDays: d.delayDays,
      values,
      settledThrough,
      days: values.filter((v) => v !== null).length,
    };
  }

  const rankDays = Object.keys(rankDaySet).length;
  const downloadDays = downloads ? downloads.days : 0;
  const enough =
    rankDays >= rankDownloadsLimits.minDays && downloadDays >= rankDownloadsLimits.minDays;
  let missing: RankDownloadsMissing | null = null;
  if (downloadDays === 0) missing = input.analyticsEnabled ? 'no_downloads' : 'turn_on_analytics';
  else if (rankDays === 0) missing = 'no_rank_checks';

  const comparisons: MoveComparison[] = enough
    ? markers.map((m) => compareMove(m, lookup, { settledThrough, others: markers }))
    : [];

  const notes: RankDownloadsNote[] = [note('correlation_not_proof')];
  if (enough) {
    notes.push(note('few_checks'), note('other_causes'), note('time_zones'));
    if (downloads) {
      const lag =
        downloads.source === 'play'
          ? 'Play download files arrive 3 to 7 days late'
          : 'Apple download counts lag about 2 days';
      notes.push(
        note(
          'downloads_delay',
          `${lag}. The newest ${downloads.delayDays} days of numbers can still change, so they are shaded and not used in a comparison until they settle.`,
        ),
      );
    }
  }
  return {
    from: input.from,
    to: input.to,
    days,
    keywords,
    downloads,
    markers: enough ? markers : [],
    comparisons,
    coverage: { rankDays, downloadDays, minDays: rankDownloadsLimits.minDays },
    enough,
    missing,
    threshold: input.threshold,
    windowDays: rankDownloadsLimits.windowDays,
    notes,
  };
}

/** The sentence for one comparison. Never a causal verb: it says what was counted and labels it. */
export function describeComparison(c: MoveComparison, term: string): string {
  const move =
    c.marker.kind === 'entered'
      ? `entered the results at ${c.marker.to}`
      : c.marker.kind === 'dropped'
        ? `left the results (was ${c.marker.from})`
        : `moved from ${c.marker.from} to ${c.marker.to}`;
  const head = `"${term}" ${move} on ${c.marker.day}.`;
  const label = 'Correlation, not proof.';
  if (c.status === 'waiting')
    return `${head} The days after it are not settled yet (needs numbers through ${c.settledNeededThrough}). ${label}`;
  if (c.status === 'too_few_days') {
    return `${head} Not enough days with numbers to compare (${c.before.days} before, ${c.after.days} after; at least ${rankDownloadsLimits.minWindowDays} each). ${label}`;
  }
  const avg = (w: WindowCount) => (w.perDay === null ? 'none' : String(oneDecimal(w.perDay)));
  const pct =
    c.changePercent === null
      ? 'no change figure (no downloads before)'
      : `${c.changePercent > 0 ? '+' : ''}${c.changePercent}%`;
  return `${head} Downloads per day, ${c.before.days} days before: ${avg(c.before)}; ${c.after.days} days after: ${avg(c.after)} (${pct}). ${label}`;
}
