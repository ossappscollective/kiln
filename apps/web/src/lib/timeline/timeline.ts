/**
 * The Timeline tab of Insights (docs/adr/0053-timeline-and-reports.md): the pure view model of the event list and of the markers drawn on
 * the charts. Events come from `GET .../apps/{appId}/timeline` (docs/api/timeline.md); a Kiln event is a code with parameters and is
 * translated here, a person's own event carries the title they wrote. Nothing in this file reads the network or the clock.
 */
import { type Platform, type TimelineEvent, type TimelineEventKind, addDays, daysBetween, timelineEventKinds } from '@kiln/core';
import { type PlatformScope, appAddress } from '../app-scope.ts';
import { formatDay } from '../analytics/analytics.ts';
import { asoViewHref } from '../aso/aso.ts';
import { k, t } from '../i18n/t.ts';
import type { IconName } from '../icons.ts';

/** An event with the app record it belongs to (the page may show several platforms). */
export type TimelineEntry = TimelineEvent & { appId: string; platform: Platform };

/** What the timeline endpoint answers, as far as the screens read it. */
export type TimelineApi = {
  app: { id: string; name: string; platform: Platform };
  from: string;
  to: string;
  events: TimelineEvent[];
};

export const kindLabelKeys: Record<TimelineEventKind, string> = {
  release: k('timeline:kind.release'),
  rollout: k('timeline:kind.rollout'),
  listing_text: k('timeline:kind.listingText'),
  listing_drift: k('timeline:kind.listingDrift'),
  graphics: k('timeline:kind.graphics'),
  experiment_started: k('timeline:kind.experimentStarted'),
  experiment_ended: k('timeline:kind.experimentEnded'),
  competitor_change: k('timeline:kind.competitorChange'),
  ad_campaign: k('timeline:kind.adCampaign'),
  price_change: k('timeline:kind.priceChange'),
  press: k('timeline:kind.press'),
  other: k('timeline:kind.other'),
};

/** One icon per kind; the kind is also always written, so the icon is never the only carrier. */
export const kindIcons: Record<TimelineEventKind, IconName> = {
  release: 'rocket',
  rollout: 'layers',
  listing_text: 'file-text',
  listing_drift: 'history',
  graphics: 'image',
  experiment_started: 'play',
  experiment_ended: 'stop',
  competitor_change: 'eye',
  ad_campaign: 'trending-up',
  price_change: 'tag',
  press: 'message',
  other: 'flag',
};

const labelKeys = {
  release: k('timeline:event.release'),
  releaseTrack: k('timeline:event.releaseTrack'),
  releaseRollingOut: k('timeline:event.releaseRollingOut'),
  rolloutStep: k('timeline:event.rolloutStep'),
  graphics: k('timeline:event.graphics'),
  listingText: k('timeline:event.listingText'),
  listingDrift: k('timeline:event.listingDrift'),
  experimentStarted: k('timeline:event.experimentStarted'),
  experimentEnded: k('timeline:event.experimentEnded'),
  competitorChange: k('timeline:event.competitorChange'),
};

/** The words for the kinds of change of a competitor listing (the codes the server sends in `kinds`, separated by commas). */
const competitorKindKeys: Record<string, string> = {
  screenshots: k('timeline:event.competitorKind.screenshots'),
  icon: k('timeline:event.competitorKind.icon'),
  name: k('timeline:event.competitorKind.name'),
  description: k('timeline:event.competitorKind.description'),
  releaseNotes: k('timeline:event.competitorKind.releaseNotes'),
  category: k('timeline:event.competitorKind.category'),
  price: k('timeline:event.competitorKind.price'),
  version: k('timeline:event.competitorKind.version'),
};

/** The sentence of an event: a person's title as written, a Kiln event from its code (an unknown code reads as its kind). */
export function eventText(e: Pick<TimelineEvent, 'kind' | 'origin' | 'title' | 'label'>): string {
  if (e.origin === 'manual') return e.title ?? t(kindLabelKeys[e.kind]);
  const label = e.label;
  const p = label?.params ?? {};
  const count = Number(p.count ?? 0);
  switch (label?.code) {
    case 'release':
      return p.track ? t(labelKeys.releaseTrack, { version: String(p.version ?? ''), track: String(p.track) }) : t(labelKeys.release, { version: String(p.version ?? '') });
    case 'releaseRollingOut':
      return t(labelKeys.releaseRollingOut, { version: String(p.version ?? '') });
    case 'rolloutStep':
      return t(labelKeys.rolloutStep, { version: String(p.version ?? ''), percent: Number(p.percent ?? 0) });
    case 'graphics':
      return t(labelKeys.graphics, { count });
    case 'listingText':
      return t(labelKeys.listingText, { count });
    case 'listingDrift':
      return t(labelKeys.listingDrift, { count });
    case 'experimentStarted':
      return t(labelKeys.experimentStarted, { name: String(p.name ?? '') });
    case 'experimentEnded':
      return t(labelKeys.experimentEnded, { name: String(p.name ?? '') });
    case 'competitorChange': {
      const what = String(p.kinds ?? '')
        .split(',')
        .map((kind) => competitorKindKeys[kind])
        .filter((key): key is string => key !== undefined)
        .map((key) => t(key))
        .join(', ');
      return t(labelKeys.competitorChange, { name: String(p.name ?? ''), what });
    }
    default:
      return t(kindLabelKeys[e.kind]);
  }
}

const withParam = (href: string, key: string, value: string): string => `${href}${href.indexOf('?') < 0 ? '?' : '&'}${key}=${value}`;

/**
 * The page of the object an event is about, or null (a person's own event, a version that is not known). Release and rollout events
 * open the release; page changes open the Store listing (graphics: its Graphics view); experiments open Insights, Experiments.
 * The API has no review or build events, so there is no link to either.
 */
export function eventHref(e: Pick<TimelineEntry, 'kind' | 'origin' | 'version' | 'appId' | 'platform'>): string | null {
  if (e.origin === 'manual') return null;
  const scope: PlatformScope = e.platform;
  switch (e.kind) {
    case 'release':
    case 'rollout':
      return e.version ? appAddress(e.appId, 'releases', scope, e.version) : appAddress(e.appId, 'releases', scope);
    case 'graphics':
      return withParam(appAddress(e.appId, 'listing', scope), 'view', 'graphics');
    case 'listing_text':
    case 'listing_drift':
      return appAddress(e.appId, 'listing', scope);
    case 'experiment_started':
    case 'experiment_ended':
      return withParam(appAddress(e.appId, 'insights', scope), 'view', 'experiments');
    case 'competitor_change':
      return asoViewHref(e.appId, 'competitors', scope);
    default:
      return null;
  }
}

const kindOrder = (kind: TimelineEventKind): number => (timelineEventKinds as readonly string[]).indexOf(kind);

/** Newest day first; inside a day the order of kinds the server uses, then the platform, then the id (stable across reads). */
export function sortEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries
    .slice()
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || kindOrder(a.kind) - kindOrder(b.kind) || (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The events of every app record as one list (an event id is only unique inside one app, so the app is part of the key). */
export const entriesOf = (reads: readonly { app: { id: string; platform: Platform }; events: readonly TimelineEvent[] }[]): TimelineEntry[] =>
  sortEntries(reads.flatMap((r) => r.events.map((e) => ({ ...e, appId: r.app.id, platform: r.app.platform }))));

export const entryKey = (e: Pick<TimelineEntry, 'appId' | 'id'>): string => `${e.appId}/${e.id}`;

/** The chips of the filter row: only kinds that occur, in the fixed order, each with its count. */
export function kindCounts(entries: readonly TimelineEntry[]): { kind: TimelineEventKind; count: number }[] {
  const counts = new Map<TimelineEventKind, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return timelineEventKinds.filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

/** No chip pressed means every kind. */
export const filterEntries = (entries: readonly TimelineEntry[], kinds: ReadonlySet<TimelineEventKind>): TimelineEntry[] =>
  kinds.size === 0 ? entries.slice() : entries.filter((e) => kinds.has(e.kind));

/** One chip toggled; the set is never mutated. */
export function toggleKind(kinds: ReadonlySet<TimelineEventKind>, kind: TimelineEventKind): Set<TimelineEventKind> {
  const next = new Set(kinds);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

export type DayGroup = { day: string; entries: TimelineEntry[] };

/** Consecutive entries of one day (the input is sorted by `sortEntries`). */
export function groupByDay(entries: readonly TimelineEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.day === e.day) last.entries.push(e);
    else groups.push({ day: e.day, entries: [e] });
  }
  return groups;
}

/** A page of the list stays small even with thousands of events; "Show more" adds another page. */
export const PAGE_SIZE = 60;

/** The first `limit` events as day groups (a burst on one day may be cut in the middle), and how many are left. */
export function pageOf(entries: readonly TimelineEntry[], limit: number): { groups: DayGroup[]; shown: number; rest: number } {
  const shown = Math.min(entries.length, Math.max(0, limit));
  return { groups: groupByDay(entries.slice(0, shown)), shown, rest: entries.length - shown };
}

/** The day heading: a date, with the year when it is not the year of `today`. */
export const dayHeading = (day: string, today: string): string => formatDay(day, day.slice(0, 4) !== today.slice(0, 4));

// ---------------------------------------------------------------------------------------------
// Markers on the charts

/** One marker of a chart: a day with events, the position of that day in the chart, how many events it stands for and the first few lines. */
export type DayMarker = { i: number; day: string; count: number; lines: string[]; more: number };

/** At most this many markers on one chart: more would be a picket fence that says nothing. */
export const MAX_MARKERS = 24;
/** Lines of one marker's tooltip; the rest is "+ N more". */
export const MARKER_LINES = 3;

/**
 * The markers for the days of a chart: only events inside `dates`, one marker per day (a busy day is one marker with a count), and
 * at most `cap` markers. When more days have events, the days with the most events stay (the newest first among equals); `hidden`
 * is how many days were left out, so the screen can say so.
 */
export function markersFor(entries: readonly Pick<TimelineEntry, 'day' | 'kind' | 'origin' | 'title' | 'label'>[], dates: readonly string[], cap = MAX_MARKERS): { markers: DayMarker[]; hidden: number } {
  const index = new Map<string, number>();
  dates.forEach((d, i) => index.set(d, i));
  const perDay = new Map<string, typeof entries[number][]>();
  for (const e of entries) {
    if (!index.has(e.day)) continue;
    const list = perDay.get(e.day);
    if (list) list.push(e);
    else perDay.set(e.day, [e]);
  }
  const all: DayMarker[] = [];
  perDay.forEach((list, day) => {
    const sorted = list.slice().sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    all.push({ i: index.get(day) ?? 0, day, count: sorted.length, lines: sorted.slice(0, MARKER_LINES).map(eventText), more: Math.max(0, sorted.length - MARKER_LINES) });
  });
  const kept = all.length <= cap ? all : all.slice().sort((a, b) => b.count - a.count || b.i - a.i).slice(0, Math.max(0, cap));
  return { markers: kept.sort((a, b) => a.i - b.i), hidden: all.length - kept.length };
}

/** The sentence a screen reader hears for the marker of the day the cursor is on. */
export const markerSpeech = (m: DayMarker): string => t('timeline:marker.spoken', { count: m.count, events: m.lines.join('; ') });

// ---------------------------------------------------------------------------------------------
// Address

/** `?view=timeline&section=events|reports`; `events` is the default and is not written. Other query parts stay. */
export function withTimelineSection(hash: string, id: string): string {
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.set('view', 'timeline');
  if (id === 'events') params.delete('section');
  else params.set('section', id);
  return `${path}?${params.toString()}`;
}

/** The API reads at most 400 days including its impact window; a range as long as that is cut to its newest days. */
export const MAX_WINDOW_DAYS = 380;
export function windowFor(from: string, to: string): { from: string; to: string; cut: boolean } {
  return daysBetween(from, to) + 1 > MAX_WINDOW_DAYS ? { from: addDays(to, -(MAX_WINDOW_DAYS - 1)), to, cut: true } : { from, to, cut: false };
}

/** The id the API takes for a person's own event (`m:<id>` in a list, `<id>` in the address). */
export const manualId = (e: Pick<TimelineEvent, 'id'>): string => (e.id.indexOf('m:') === 0 ? e.id.slice(2) : e.id);
