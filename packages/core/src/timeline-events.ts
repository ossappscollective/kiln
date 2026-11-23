// Adapted from Open Screenshot Generator (MIT), see THIRD_PARTY_NOTICES.md
//
// The timeline's vocabulary: events, the metrics a chart can show, and how events from Kiln and from people are merged
// (docs/adr/0053-timeline-and-reports.md). Pure; ES2017.
import { addDays } from './analytics.ts';
import type { DayValues, ImpactKind } from './timeline-impact.ts';

export const kilnEventKinds = [
  'release',
  'rollout',
  'listing_text',
  'listing_drift',
  'graphics',
  'experiment_started',
  'experiment_ended',
] as const;
export const manualEventKinds = ['ad_campaign', 'price_change', 'press', 'other'] as const;
export const timelineEventKinds = [...kilnEventKinds, ...manualEventKinds] as const;
export type KilnEventKind = (typeof kilnEventKinds)[number];
export type ManualEventKind = (typeof manualEventKinds)[number];
export type TimelineEventKind = (typeof timelineEventKinds)[number];
export const isManualEventKind = (v: unknown): v is ManualEventKind =>
  typeof v === 'string' && (manualEventKinds as readonly string[]).indexOf(v) !== -1;

/** What a Kiln event says, as a code and parameters: the screens translate it, so the server never writes a sentence. */
export type EventLabel = { code: string; params: Record<string, string | number> };

export type TimelineEvent = {
  /** `m:<id>` for a person's event, `k:<source>:<ref>` for one Kiln derived. Stable across reads. */
  id: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  kind: TimelineEventKind;
  origin: 'kiln' | 'manual';
  /** Kiln events only. */
  label: EventLabel | null;
  /** Manual events only: the title the person wrote (up to 120 characters). */
  title: string | null;
  /** Manual events only (up to 500 characters). */
  note: string | null;
  /** The store version it is about, when it is about one. */
  version: string | null;
  /** The day the change reached the store, when it differs from `day` or is not known yet (null while it waits for a release). */
  liveDay: string | null;
  /** True for a change that reaches an App Store listing only with a version (`liveDay` is null until that version is out). */
  waitsForRelease: boolean;
};

const kindRank: Record<TimelineEventKind, number> = {
  release: 0,
  rollout: 1,
  graphics: 2,
  listing_text: 3,
  listing_drift: 4,
  experiment_started: 5,
  experiment_ended: 6,
  ad_campaign: 7,
  price_change: 8,
  press: 9,
  other: 10,
};

/** Is it a change of the store page that could move the download rate (graphics or listing text)? */
export const isPageChange = (kind: TimelineEventKind): boolean =>
  kind === 'graphics' || kind === 'listing_text' || kind === 'listing_drift';

/**
 * Events from several sources as one list, oldest first. Rules: the same id once; the same version released and rolled out
 * on the same day as one `release`; a store listing change that Kiln did not make (`listing_drift`) is dropped when Kiln pushed a
 * listing text the same day or the day before (Kiln's own change, seen again by the next read).
 */
export function mergeEvents(lists: ReadonlyArray<ReadonlyArray<TimelineEvent>>): TimelineEvent[] {
  const seen = new Set<string>();
  const all: TimelineEvent[] = [];
  for (const list of lists) {
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
  }
  const pushed = all.filter((e) => e.kind === 'listing_text').map((e) => e.day);
  const releases = new Set<string>();
  const kept = all.filter((e) => {
    if (e.kind === 'listing_drift') {
      return !pushed.some((d) => d === e.day || addDays(d, 1) === e.day);
    }
    if (e.kind === 'release' && e.version) {
      const key = `${e.version}|${e.day}`;
      if (releases.has(key)) return false;
      releases.add(key);
    }
    return true;
  });
  return kept.sort(
    (a, b) =>
      (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
      kindRank[a.kind] - kindRank[b.kind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The day a change reached the store, or null while it waits. A graphics or listing text change of an App Store app goes live with
 * the next version that comes out on or after the day it was made (Kiln writes to the version being prepared); every other event
 * is live the day it happened (Google Play shows new graphics once checked, usually within days: measured from the upload day).
 */
export function liveDayOf(event: TimelineEvent, releaseDays: ReadonlyArray<string>): string | null {
  if (!event.waitsForRelease) return event.day;
  const next = releaseDays.filter((d) => d >= event.day).sort()[0];
  return next === undefined ? null : next;
}

export type TimelineMetricId =
  | 'impressions'
  | 'product_page_views'
  | 'downloads_first_time'
  | 'download_rate'
  | 'product_page_conversion'
  | 'downloads_redownload'
  | 'installs_user'
  | 'store_listing_visitors'
  | 'store_listing_acquisitions'
  | 'sales_units'
  | 'sales_proceeds'
  | 'sales_gross';

type Def = {
  id: TimelineMetricId;
  kind: ImpactKind;
  /** Series ids (money: the metric name, one entry per currency) the metric is made from. */
  num: string;
  den?: string;
  /** Money metrics are one chart per currency. */
  money?: boolean;
};

export const timelineMetricDefs: readonly Def[] = [
  { id: 'impressions', kind: 'count', num: 'impressions' },
  { id: 'product_page_views', kind: 'count', num: 'product_page_views' },
  { id: 'downloads_first_time', kind: 'count', num: 'downloads_first_time' },
  { id: 'download_rate', kind: 'ratio', num: 'downloads_first_time', den: 'impressions' },
  { id: 'product_page_conversion', kind: 'ratio', num: 'downloads_first_time', den: 'product_page_views' },
  { id: 'downloads_redownload', kind: 'count', num: 'downloads_redownload' },
  { id: 'installs_user', kind: 'count', num: 'installs_user' },
  { id: 'store_listing_visitors', kind: 'count', num: 'store_listing_visitors' },
  { id: 'store_listing_acquisitions', kind: 'count', num: 'store_listing_acquisitions' },
  // On Google Play the page download rate is acquisitions over visitors.
  { id: 'product_page_conversion', kind: 'ratio', num: 'store_listing_acquisitions', den: 'store_listing_visitors' },
  { id: 'sales_units', kind: 'count', num: 'sales_units' },
  { id: 'sales_proceeds', kind: 'level', num: 'sales_proceeds', money: true },
  { id: 'sales_gross', kind: 'level', num: 'sales_gross', money: true },
];

export type SeriesLike = {
  id: string;
  cadence?: 'monthly' | undefined;
  points: ReadonlyArray<{ date: string; value: number | null }>;
};

export type TimelineMetric = {
  /** `impressions`, `product_page_conversion`, `sales_proceeds:EUR`. */
  id: string;
  metric: TimelineMetricId;
  currency: string | null;
  kind: ImpactKind;
  values: DayValues;
  denominators: DayValues | undefined;
  /** Days with a value in what was read. */
  days: number;
};

const dayMap = (s: SeriesLike | undefined): Map<string, number> => {
  const m = new Map<string, number>();
  if (s && s.cadence !== 'monthly') for (const p of s.points) if (p.value !== null) m.set(p.date, p.value);
  return m;
};

/**
 * The metrics a chart can show for what was read (one daily series each, a rate from two of them): only those with at least one day
 * of data. `series` is a day-granularity overview. Order: the order of `timelineMetricDefs`; a metric id appears once.
 */
export function timelineMetricsFrom(series: ReadonlyArray<SeriesLike>): TimelineMetric[] {
  const byId = new Map<string, SeriesLike>();
  for (const s of series) byId.set(s.id, s);
  const out: TimelineMetric[] = [];
  const have = new Set<string>();
  for (const def of timelineMetricDefs) {
    if (def.money) {
      for (const s of series) {
        if (s.id.indexOf(`${def.num}:`) !== 0) continue;
        const values = dayMap(s);
        if (values.size === 0) continue;
        out.push({ id: s.id, metric: def.id, currency: s.id.slice(def.num.length + 1), kind: def.kind, values, denominators: undefined, days: values.size });
      }
      continue;
    }
    if (have.has(def.id)) continue;
    const values = dayMap(byId.get(def.num));
    const denominators = def.den ? dayMap(byId.get(def.den)) : undefined;
    if (values.size === 0 || (denominators && denominators.size === 0)) continue;
    have.add(def.id);
    out.push({ id: def.id, metric: def.id, currency: null, kind: def.kind, values, denominators, days: values.size });
  }
  return out;
}

/** A rate's chart value for a day: numerator over denominator, null where either is missing or the denominator is zero. */
export function dailyValue(m: Pick<TimelineMetric, 'values' | 'denominators' | 'kind'>, day: string): number | null {
  const v = m.values.get(day);
  if (v === undefined) return null;
  if (m.kind !== 'ratio') return v;
  const d = m.denominators ? m.denominators.get(day) : undefined;
  return d === undefined || d <= 0 ? null : v / d;
}
