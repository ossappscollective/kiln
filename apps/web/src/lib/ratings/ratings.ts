import { formatNumber, formatPercent } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { type AnalyticsSeries, type Delta, deltaTone, formatDay, formatRating } from '../analytics/analytics.ts';
import type { ChartPanel, StatChipModel } from '../analytics/view.ts';

/**
 * Ratings and app health of Insights (docs/adr/0052-ratings-health.md, docs/api/ratings.md): the API shapes and the pure view model.
 * Honesty rules, kept here and tested: `null` is never zero; the stores give no rating history, so a trend starts the day Kiln first read the
 * rating (`since`); a count can fall (Apple); a small count is shown as a count with a "low sample" hint, never as a percentage; a comparison
 * needs data on both sides, else it says so.
 */

// ---------------------------------------------------------------------------------------------
// The API shapes (apps/server/src/modules/ratings/operations.ts)

export type RatingsBucket = {
  start: string;
  end: string;
  count: number | null;
  average: number | null;
  newCount: number;
  newAverage: number | null;
  newStars: number[] | null;
  newUnknown: number;
  dayAverage: number | null;
  reset: boolean;
  spansGap: boolean;
};
export type RatingsCountry = { territory: string; average: number; count: number | null; newCount: number; newAverage: number | null; change: number | null; day: string };
export type WrittenBucket = { start: string; end: string; stars: number[]; count: number; average: number | null };
export type RatingsView = {
  store: string;
  from: string;
  to: string;
  granularity: 'day' | 'week' | 'month';
  country: string;
  countries: RatingsCountry[];
  historyStart: string | null;
  capabilities: { count: boolean; stars: boolean };
  summary: {
    average: number | null;
    count: number | null;
    newCount: number;
    newRatingsKnown: boolean;
    written: { count: number; stars: number[]; average: number | null };
  };
  buckets: RatingsBucket[];
  written: WrittenBucket[];
};
export type VitalRate = { rate: number | null; volume: number; events?: number; days?: number; coveredDays?: number; steady: boolean };
export type HealthVersion = {
  version: string;
  name: string | null;
  from: string;
  to: string;
  crash: VitalRate;
  freeze: VitalRate | null;
  change: { kind: 'worse' | 'better'; previous: string; before: number; after: number; overLine: boolean } | null;
  reviews: number;
  crashReviews: number;
};
export type HealthFinding = {
  kind: 'worse' | 'better';
  measure: 'crash' | 'freeze';
  version: string;
  name: string | null;
  previous: string;
  before: number;
  after: number;
  overLine: boolean;
  from: string;
  to: string;
  mentions: number;
};
export type HealthView = {
  store: string;
  from: string;
  to: string;
  unit: 'perSessions' | 'share';
  setup: { setupCode: string | null; lastErrorCode: string | null; lastOkAt: number | null } | null;
  hasData: boolean;
  days: { day: string; crash: number | null; freeze: number | null; crashMentions: number }[];
  versions: HealthVersion[];
  finding: HealthFinding | null;
};

// ---------------------------------------------------------------------------------------------
// Days and windows

/** Fewer ratings than this is a small sample: shown as a number with a hint, never as a share. */
export const LOW_SAMPLE = 30;
export const lowSample = (n: number | null | undefined): boolean => n !== null && n !== undefined && n < LOW_SAMPLE;
/** A window needs this share of its days with a value before it is compared with another (the Overview uses the same). */
export const MIN_COVERAGE = 0.6;
/** Stars at or below this are "low". */
export const LOW_STARS = 2;

const DAY = 86_400_000;
const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const shiftDay = (day: string, by: number): string => new Date(ms(day) + by * DAY).toISOString().slice(0, 10);
const between = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY);

export type Windows = { current: { from: string; to: string }; previous: { from: string; to: string }; days: number };
/** The range and the same number of days before it. */
export function windowsOf(to: string, days: number): Windows {
  const from = shiftDay(to, -(days - 1));
  return { current: { from, to }, previous: { from: shiftDay(from, -days), to: shiftDay(from, -1) }, days };
}
/** What to ask the API for (days back from today): the range and the period before it, 7 to 730 days. `rangeFrom` is the first day of the range. */
export const fetchDays = (days: number, rangeFrom?: string, today?: string): number =>
  Math.min(730, Math.max(7, rangeFrom && today ? between(shiftDay(rangeFrom, -days), today) + 1 : days * 2));
const within = (day: string, w: { from: string; to: string }): boolean => day >= w.from && day <= w.to;

export type Change =
  | { kind: 'none'; reason: 'no_data' | 'no_previous' | 'not_enough_data' | 'one_reading' }
  | { kind: 'flat' }
  /** `value` in stars (ratings) or a fraction (rates: 0.2 is +20%). `basis`: the previous period, or the start of the range when the history is shorter. */
  | { kind: 'change'; direction: 'up' | 'down'; value: number; basis: 'previous' | 'range'; since: string | null };

// ---------------------------------------------------------------------------------------------
// Ratings

export type RatingsOverview = {
  /** `none`: no reading yet; `one`: a single day (no trend, no change); `series`: two or more. */
  state: 'none' | 'one' | 'series';
  average: number | null;
  count: number | null;
  countKnown: boolean;
  lowSample: boolean;
  /** The first day Kiln has a reading (the store keeps no history). */
  since: string | null;
  readings: number;
  /** The average per day of the range, `null` for a day without a reading (drawn as a gap, never zero). */
  points: { date: string; value: number | null }[];
  change: Change;
  newCount: number;
  newCountPrevious: number | null;
  newKnown: boolean;
  /** The count fell between two readings in the range (the store took ratings away, or reset the summary). */
  countDropped: boolean;
  reset: boolean;
  spansGap: boolean;
  /** New ratings by stars over the range; null when the store gives no stars (Google Play). */
  newStars: number[] | null;
};

const EMPTY_OVERVIEW: RatingsOverview = {
  state: 'none', average: null, count: null, countKnown: false, lowSample: false, since: null, readings: 0, points: [],
  change: { kind: 'none', reason: 'no_data' }, newCount: 0, newCountPrevious: null, newKnown: false, countDropped: false, reset: false, spansGap: false, newStars: null,
};

const lastWith = (buckets: readonly RatingsBucket[], w: { from: string; to: string }): RatingsBucket | null => {
  let found: RatingsBucket | null = null;
  for (const b of buckets) if (b.average !== null && within(b.start, w)) found = b;
  return found;
};

export function ratingsOverview(view: RatingsView | null, days: number, to?: string): RatingsOverview {
  if (!view) return EMPTY_OVERVIEW;
  const w = windowsOf(to ?? view.to, days);
  const withAverage = view.buckets.filter((b) => b.average !== null);
  const inRange = view.buckets.filter((b) => within(b.start, w.current));
  const readingsInRange = inRange.filter((b) => b.average !== null);
  const average = view.summary.average ?? lastWith(view.buckets, w.current)?.average ?? null;
  if (average === null && withAverage.length === 0) return { ...EMPTY_OVERVIEW, since: view.historyStart };
  const count = view.summary.count;
  const endNow = lastWith(view.buckets, w.current);
  const endBefore = lastWith(view.buckets, w.previous);
  const firstIn = readingsInRange[0] ?? null;
  let change: Change;
  if (!endNow) change = { kind: 'none', reason: 'no_data' };
  else if (endBefore && endNow.average !== null && endBefore.average !== null) change = deltaStars(endNow.average, endBefore.average, 'previous', null);
  else if (firstIn && firstIn !== endNow && endNow.average !== null && firstIn.average !== null) change = deltaStars(endNow.average, firstIn.average, 'range', firstIn.start);
  else change = { kind: 'none', reason: readingsInRange.length <= 1 ? 'one_reading' : 'no_previous' };
  let countDropped = false;
  let last: number | null = null;
  for (const b of inRange) {
    if (b.count === null) continue;
    if (last !== null && b.count < last) countDropped = true;
    last = b.count;
  }
  const previousRead = view.buckets.some((b) => within(b.start, w.previous) && b.average !== null);
  const stars = [0, 0, 0, 0, 0];
  let anyStars = false;
  for (const b of inRange) if (b.newStars) { anyStars = true; b.newStars.forEach((n, i) => (stars[i] = (stars[i] ?? 0) + n)); }
  return {
    state: withAverage.length >= 2 ? 'series' : 'one',
    average,
    count,
    countKnown: count !== null,
    lowSample: lowSample(count),
    since: view.historyStart,
    readings: withAverage.length,
    points: inRange.map((b) => ({ date: b.start, value: b.average })),
    change,
    newCount: inRange.reduce((n, b) => n + b.newCount, 0),
    newCountPrevious: previousRead ? view.buckets.filter((b) => within(b.start, w.previous)).reduce((n, b) => n + b.newCount, 0) : null,
    newKnown: view.summary.newRatingsKnown && readingsInRange.length >= 2,
    countDropped,
    reset: inRange.some((b) => b.reset),
    spansGap: inRange.some((b) => b.spansGap),
    newStars: view.capabilities.stars && anyStars ? stars : null,
  };
}

/** Averages are kept in thousandths: a move under one hundredth of a star is "the same". */
function deltaStars(now: number, before: number, basis: 'previous' | 'range', since: string | null): Change {
  const d = Math.round((now - before) * 100) / 100;
  return d === 0 ? { kind: 'flat' } : { kind: 'change', direction: d > 0 ? 'up' : 'down', value: Math.abs(d), basis, since };
}

// ---------------------------------------------------------------------------------------------
// Written reviews (the stars of the reviews Kiln stored, not the store's ratings)

export type ReviewSignal = {
  count: number;
  low: number;
  /** The share of 1 and 2 star reviews; null for a small sample (the count is shown instead). */
  lowShare: number | null;
  lowSample: boolean;
  stars: number[];
  previous: { count: number; low: number; lowShare: number | null; lowSample: boolean } | null;
  /** A change in the low share, in points of a share (0.05 is 5 points); null when either side is a small sample. */
  shareChange: Change;
  points: { date: string; value: number | null }[];
};

const sumWritten = (rows: readonly WrittenBucket[]) => {
  const stars = [0, 0, 0, 0, 0];
  for (const r of rows) r.stars.forEach((n, i) => (stars[i] = (stars[i] ?? 0) + n));
  const count = stars.reduce((a, b) => a + b, 0);
  const low = stars.slice(0, LOW_STARS).reduce((a, b) => a + b, 0);
  return { stars, count, low };
};

export function reviewSignal(view: RatingsView | null, days: number, to?: string): ReviewSignal {
  const empty: ReviewSignal = { count: 0, low: 0, lowShare: null, lowSample: false, stars: [0, 0, 0, 0, 0], previous: null, shareChange: { kind: 'none', reason: 'no_data' }, points: [] };
  if (!view) return empty;
  const w = windowsOf(to ?? view.to, days);
  const now = view.written.filter((r) => within(r.start, w.current));
  const before = view.written.filter((r) => within(r.start, w.previous));
  const a = sumWritten(now);
  const b = sumWritten(before);
  const share = (x: { count: number; low: number }) => (x.count >= LOW_SAMPLE ? x.low / x.count : null);
  const prevShare = share(b);
  const nowShare = share(a);
  const previous = view.written.some((r) => within(r.start, w.previous)) ? { ...b, lowShare: prevShare, lowSample: b.count < LOW_SAMPLE } : null;
  let shareChange: Change = { kind: 'none', reason: previous === null ? 'no_previous' : 'not_enough_data' };
  if (nowShare !== null && prevShare !== null) {
    const d = Math.round((nowShare - prevShare) * 1000) / 1000;
    shareChange = d === 0 ? { kind: 'flat' } : { kind: 'change', direction: d > 0 ? 'up' : 'down', value: Math.abs(d), basis: 'previous', since: null };
  }
  return {
    count: a.count,
    low: a.low,
    lowShare: nowShare,
    lowSample: a.count < LOW_SAMPLE,
    stars: a.stars,
    previous,
    shareChange,
    points: now.map((r) => ({ date: r.start, value: (r.stars[0] ?? 0) + (r.stars[1] ?? 0) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Stability (crashes and freezes)

export type Measure = {
  points: { date: string; value: number | null }[];
  /** The mean of the days with a value in the range; null with none. */
  current: number | null;
  previous: number | null;
  daysWithData: number;
  coverage: number;
  change: Change;
};
export type Stability = {
  /** `setup`: the source needs turning on; `error`: the last read failed; `none`: nothing stored yet; `data`. */
  state: 'data' | 'setup' | 'error' | 'none';
  unit: 'perSessions' | 'share';
  crash: Measure;
  /** ANR (Google Play) or freeze: null when the store gives none (App Store). */
  freeze: Measure | null;
  finding: HealthFinding | null;
  setupCode: string | null;
};

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function measureOf(rows: { day: string; value: number | null }[], w: Windows): Measure {
  const now = rows.filter((r) => within(r.day, w.current));
  const before = rows.filter((r) => within(r.day, w.previous));
  const nowValues = now.flatMap((r) => (r.value === null ? [] : [r.value]));
  const beforeValues = before.flatMap((r) => (r.value === null ? [] : [r.value]));
  const coverage = nowValues.length / w.days;
  const beforeCoverage = beforeValues.length / w.days;
  const current = mean(nowValues);
  const previous = mean(beforeValues);
  let change: Change;
  if (current === null) change = { kind: 'none', reason: 'no_data' };
  else if (previous === null) change = { kind: 'none', reason: 'no_previous' };
  else if (coverage < MIN_COVERAGE || beforeCoverage < MIN_COVERAGE) change = { kind: 'none', reason: 'not_enough_data' };
  else if (previous === 0) change = current === 0 ? { kind: 'flat' } : { kind: 'none', reason: 'not_enough_data' };
  else {
    const rel = Math.round(((current - previous) / previous) * 1000) / 1000;
    change = rel === 0 ? { kind: 'flat' } : { kind: 'change', direction: rel > 0 ? 'up' : 'down', value: Math.abs(rel), basis: 'previous', since: null };
  }
  return { points: now.map((r) => ({ date: r.day, value: r.value })), current, previous, daysWithData: nowValues.length, coverage, change };
}

export function stability(view: HealthView | null, days: number, to?: string): Stability {
  const w = windowsOf(to ?? view?.to ?? shiftDay(new Date().toISOString().slice(0, 10), -1), days);
  const empty = measureOf([], w);
  if (!view) return { state: 'none', unit: 'perSessions', crash: empty, freeze: null, finding: null, setupCode: null };
  const crash = measureOf(view.days.map((d) => ({ day: d.day, value: d.crash })), w);
  const hasFreeze = view.days.some((d) => d.freeze !== null);
  const state: Stability['state'] = view.hasData ? 'data' : view.setup?.setupCode ? 'setup' : view.setup?.lastErrorCode ? 'error' : 'none';
  return {
    state,
    unit: view.unit,
    crash,
    freeze: hasFreeze ? measureOf(view.days.map((d) => ({ day: d.day, value: d.freeze })), w) : null,
    finding: view.finding,
    setupCode: view.setup?.setupCode ?? null,
  };
}

/** A rate as a percentage with enough digits for small numbers: 0.0021 is "0.21%". */
export const formatRate = (value: number): string => formatPercent(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------------------------
// Release impact: stability and rating around the day each version appeared

export type ReleaseRow = {
  version: string;
  name: string | null;
  day: string;
  crashChange: HealthVersion['change'];
  /** `null` when the history has no reading on that side (it starts after the release, or the release is too recent). */
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: Change;
  /** `too_early`: less than a week since the release. */
  ratingState: 'ok' | 'too_early' | 'no_history';
  reviews: number;
  crashReviews: number;
};
export const AFTER_DAYS = 14;
export const MIN_AFTER_DAYS = 7;

const averageAt = (buckets: readonly RatingsBucket[], from: string, to: string): number | null => {
  let found: number | null = null;
  for (const b of buckets) if (b.average !== null && b.start >= from && b.start <= to) found = b.average;
  return found;
};

export function releaseRows(health: HealthView | null, ratings: RatingsView | null, limit = 8): ReleaseRow[] {
  if (!health) return [];
  const today = health.to;
  return health.versions.slice(0, limit).map((v) => {
    const before = ratings ? averageAt(ratings.buckets, shiftDay(v.from, -AFTER_DAYS), shiftDay(v.from, -1)) : null;
    const age = between(v.from, today);
    const after = ratings && age >= MIN_AFTER_DAYS ? averageAt(ratings.buckets, shiftDay(v.from, MIN_AFTER_DAYS), shiftDay(v.from, AFTER_DAYS)) : null;
    const state: ReleaseRow['ratingState'] = age < MIN_AFTER_DAYS ? 'too_early' : before === null || after === null ? 'no_history' : 'ok';
    return {
      version: v.version,
      name: v.name,
      day: v.from,
      crashChange: v.change,
      ratingBefore: before,
      ratingAfter: after,
      ratingChange: before !== null && after !== null ? deltaStars(after, before, 'previous', null) : { kind: 'none', reason: 'no_data' },
      ratingState: state,
      reviews: v.reviews,
      crashReviews: v.crashReviews,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Countries

export type CountryRow = RatingsCountry & { lowSample: boolean };
/** Countries with the most ratings first (a country without a count last), then by name. */
export function countryRows(view: RatingsView | null): CountryRow[] {
  if (!view) return [];
  return view.countries
    .map((c) => ({ ...c, lowSample: lowSample(c.count) }))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.territory.localeCompare(b.territory));
}

// ---------------------------------------------------------------------------------------------
// The chart of an average (a ChartPanel for components/analytics/Chart.svelte)

export function panelOf(id: string, unit: 'rating' | 'ratio' | 'count', label: string, points: { date: string; value: number | null }[]): ChartPanel | null {
  if (!points.some((p) => p.value !== null)) return null;
  const withValue = points.filter((p) => p.value !== null);
  const series: AnalyticsSeries = {
    id,
    metric: id,
    label,
    unit,
    aggregation: 'mean',
    source: 'kiln',
    derived: true,
    currency: null,
    delayDays: 0,
    total: null,
    points,
    coverage: {
      state: withValue.length === points.length ? 'complete' : 'partial',
      firstDay: withValue[0]?.date ?? null,
      lastDay: withValue[withValue.length - 1]?.date ?? null,
      days: withValue.length,
      gapDays: points.length - withValue.length,
      notes: [],
    },
  };
  return { id, title: null, kind: 'line', unit, currency: null, domain: unit === 'rating' ? 'tight' : 'zero', series: [{ key: id, label, color: 1, series }] };
}

// ---------------------------------------------------------------------------------------------
// The rail and the address

export type HealthPart = 'ratings' | 'reviews' | 'stability' | 'releases' | 'countries';
export const HEALTH_PARTS: readonly HealthPart[] = ['ratings', 'reviews', 'stability', 'releases', 'countries'];

export type PlatformSnapshot = {
  platform: string;
  appId: string;
  /** Null while loading or when the read failed. */
  ratings: RatingsOverview;
  reviews: ReviewSignal;
  stability: Stability;
  releases: ReleaseRow[];
  countries: CountryRow[];
};

/** Which sections exist for the data at hand: a section with nothing to say is not listed (Ratings always is, and says why there is nothing). */
export function availableParts(snaps: readonly PlatformSnapshot[]): HealthPart[] {
  const parts: HealthPart[] = ['ratings'];
  if (snaps.some((s) => s.reviews.count > 0 || s.reviews.previous !== null)) parts.push('reviews');
  if (snaps.some((s) => s.stability.state !== 'none')) parts.push('stability');
  if (snaps.some((s) => s.releases.length > 0)) parts.push('releases');
  if (snaps.some((s) => s.countries.length > 0)) parts.push('countries');
  return parts;
}

/** The address of a section of this tab: `?view=ratings&section=...` (the shared rail helper drops `view`, which this tab needs). */
export function withHealthSection(hash: string, id: string): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.set('view', 'ratings');
  if (id === 'ratings') params.delete('section');
  else params.set('section', id);
  return `${path}?${params.toString()}`;
}

/** The count of a section, for the rail. */
export function partCount(part: HealthPart, snaps: readonly PlatformSnapshot[]): number | null {
  switch (part) {
    case 'reviews':
      return snaps.reduce((n, s) => n + s.reviews.low, 0);
    case 'releases':
      return snaps.reduce((n, s) => n + s.releases.length, 0);
    case 'countries':
      return Math.max(0, ...snaps.map((s) => s.countries.length));
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Words

/** "+0.12 stars vs previous 28 days", "since Nov 3", or what is missing. */
export function ratingChangeText(change: Change, days: number): string {
  switch (change.kind) {
    case 'change': {
      const text = `${change.direction === 'up' ? '+' : '−'}${formatRating(change.value)}`;
      return change.basis === 'previous' || change.since === null
        ? t('ratings:change.vsPrevious', { text, count: days })
        : t('ratings:change.sinceDay', { text, date: formatDay(change.since) });
    }
    case 'flat':
      return t('ratings:change.same', { count: days });
    default:
      return t(CHANGE_NONE[change.reason]);
  }
}
const CHANGE_NONE: Record<Extract<Change, { kind: 'none' }>['reason'], string> = {
  no_data: k('ratings:change.noData'),
  no_previous: k('ratings:change.noPrevious'),
  not_enough_data: k('ratings:change.notEnough'),
  one_reading: k('ratings:change.oneReading'),
};

/** "+12%" or "−12%" for a relative change of a rate; points for a share ("+5 points"). */
export function relativeText(change: Change, kind: 'relative' | 'points', days: number): string {
  if (change.kind === 'flat') return t('ratings:change.same', { count: days });
  if (change.kind !== 'change') return t(CHANGE_NONE[change.reason]);
  const sign = change.direction === 'up' ? '+' : '−';
  const text =
    kind === 'relative' ? `${sign}${formatPercent(change.value, { maximumFractionDigits: 0 })}` : t('ratings:change.points', { text: `${sign}${formatNumber(Math.round(change.value * 100))}` });
  return t('ratings:change.vsPrevious', { text, count: days });
}

/** "1,204 ratings", with the hint for a small sample. */
export const countText = (count: number | null): string => (count === null ? t('ratings:count.unknown') : t('ratings:count.ratings', { count, number: formatNumber(count) }));

/** The reason a platform has no rating yet, as a message key and its parameters (the screen translates it). */
export function ratingsEmptyKey(platform: string, loaded: boolean, failed: boolean): string {
  if (!loaded) return k('ratings:empty.loading');
  if (failed) return k('ratings:empty.error');
  return platform === 'ios' ? k('ratings:empty.ios') : k('ratings:empty.android');
}

export type ComparisonRow = { id: string; label: string; cells: { platform: string; text: string; hint: string }[] };

/** One row per measure, one cell per platform: the compact comparison for scope Both. Nothing is added across platforms. */
export function comparisonRows(snaps: readonly PlatformSnapshot[], days: number): ComparisonRow[] {
  const cell = (s: PlatformSnapshot, text: string, hint = '') => ({ platform: s.platform, text, hint });
  const dash = t('ratings:compare.none');
  return [
    {
      id: 'average',
      label: t('ratings:compare.average'),
      cells: snaps.map((s) => cell(s, s.ratings.average === null ? dash : formatRating(s.ratings.average), s.ratings.lowSample ? t('ratings:count.lowSample') : '')),
    },
    {
      id: 'count',
      label: t('ratings:compare.count'),
      cells: snaps.map((s) => cell(s, s.ratings.countKnown ? countText(s.ratings.count) : dash, s.ratings.countKnown ? '' : t('ratings:count.notGiven'))),
    },
    {
      id: 'change',
      label: t('ratings:compare.change'),
      cells: snaps.map((s) => cell(s, s.ratings.state === 'none' ? dash : ratingChangeText(s.ratings.change, days))),
    },
    {
      id: 'low',
      label: t('ratings:compare.lowReviews'),
      cells: snaps.map((s) =>
        s.reviews.count === 0
          ? cell(s, dash)
          : s.reviews.lowShare === null
            ? cell(s, t('ratings:reviews.lowOf', { low: s.reviews.low, count: s.reviews.count }), t('ratings:count.lowSample'))
            : cell(s, `${formatPercent(s.reviews.lowShare, { maximumFractionDigits: 0 })} (${s.reviews.low}/${s.reviews.count})`),
      ),
    },
    {
      id: 'crash',
      label: t('ratings:compare.crash'),
      cells: snaps.map((s) => cell(s, s.stability.crash.current === null ? dash : formatRate(s.stability.crash.current), s.stability.crash.current === null ? '' : relativeText(s.stability.crash.change, 'relative', days))),
    },
    {
      id: 'freeze',
      label: t('ratings:compare.freeze'),
      cells: snaps.map((s) => cell(s, s.stability.freeze?.current == null ? dash : formatRate(s.stability.freeze.current), s.stability.freeze?.current == null ? '' : relativeText(s.stability.freeze.change, 'relative', days))),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Tiles (components/analytics/StatRow.svelte takes these)

const deltaOf = (change: Change, text: string): Delta =>
  change.kind === 'change' ? { kind: 'change', direction: change.direction, text } : change.kind === 'flat' ? { kind: 'flat' } : { kind: 'none', reason: change.reason === 'no_data' ? 'no_current' : change.reason === 'not_enough_data' ? 'not_enough_data' : 'no_previous' };

function chip(id: string, label: string, value: string, title: string, change: Change, text: string, line: string, upIsGood: boolean | null): StatChipModel {
  const delta = deltaOf(change, text);
  return { id, label, value, title, delta, line, spoken: line, tone: upIsGood === null ? 'neutral' : deltaTone(delta, upIsGood) };
}

/** Average, number of ratings and new ratings: a figure the store does not give is a dash with the reason in its hover text, never a zero. */
export function ratingChips(s: PlatformSnapshot, days: number): StatChipModel[] {
  const r = s.ratings;
  if (r.state === 'none') return [];
  const sign = r.change.kind === 'change' ? (r.change.direction === 'up' ? '+' : '\u2212') : '';
  const out: StatChipModel[] = [
    chip('average', t('ratings:tile.average'), r.average === null ? t('ratings:compare.none') : formatRating(r.average), t('ratings:tile.averageTitle'), r.change, r.change.kind === 'change' ? `${sign}${formatRating(r.change.value)}` : '', ratingChangeText(r.change, days), true),
    chip('count', t('ratings:tile.count'), r.countKnown ? formatNumber(r.count ?? 0) : t('ratings:compare.none'), r.countKnown ? t('ratings:tile.countTitle') : t('ratings:count.notGiven'), { kind: 'none', reason: 'no_data' }, '', r.countKnown && r.lowSample ? t('ratings:count.lowSample') : '', null),
  ];
  if (r.newKnown) {
    const prev = r.newCountPrevious;
    const change: Change = prev === null || prev === 0 ? { kind: 'none', reason: 'no_previous' } : r.newCount === prev ? { kind: 'flat' } : { kind: 'change', direction: r.newCount > prev ? 'up' : 'down', value: Math.abs(r.newCount - prev) / prev, basis: 'previous', since: null };
    out.push(chip('new', t('ratings:tile.new'), formatNumber(r.newCount), t('ratings:tile.newTitle'), change, change.kind === 'change' ? `${change.direction === 'up' ? '+' : '\u2212'}${formatPercent(change.value, { maximumFractionDigits: 0 })}` : '', change.kind === 'none' ? '' : relativeText(change, 'relative', days), null));
  }
  return out;
}

/** Low-star reviews: the share only from a real sample, else "N of M" and the hint. */
export function reviewChips(s: PlatformSnapshot, days: number): StatChipModel[] {
  const v = s.reviews;
  if (v.count === 0) return [];
  const share = v.lowShare;
  return [
    chip('reviews', t('ratings:tile.reviews'), formatNumber(v.count), t('ratings:tile.reviewsTitle'), { kind: 'none', reason: 'no_data' }, '', v.lowSample ? t('ratings:count.lowSample') : '', null),
    chip('low', t('ratings:tile.lowReviews'), share === null ? t('ratings:reviews.lowOf', { low: v.low, count: v.count }) : `${formatPercent(share, { maximumFractionDigits: 0 })} (${v.low})`, t('ratings:tile.lowTitle', { max: LOW_STARS }), v.shareChange, v.shareChange.kind === 'change' ? `${v.shareChange.direction === 'up' ? '+' : '\u2212'}${formatNumber(Math.round(v.shareChange.value * 100))}` : '', v.shareChange.kind === 'none' && share === null ? '' : relativeText(v.shareChange, 'points', days), false),
  ];
}

/** Crash rate and ANR (Google) or freeze rate: the mean of the days that have numbers, against the period before. */
export function stabilityChips(s: PlatformSnapshot, days: number): StatChipModel[] {
  const out: StatChipModel[] = [];
  for (const [id, label, m] of [['crash', t('ratings:tile.crash'), s.stability.crash], ['freeze', t('ratings:tile.freeze'), s.stability.freeze]] as const) {
    if (!m || m.current === null) continue;
    const text = m.change.kind === 'change' ? `${m.change.direction === 'up' ? '+' : '\u2212'}${formatPercent(m.change.value, { maximumFractionDigits: 0 })}` : '';
    out.push(chip(id, label, formatRate(m.current), t('ratings:tile.rateTitle', { days: m.daysWithData }), m.change, text, relativeText(m.change, 'relative', days), false));
  }
  return out;
}
