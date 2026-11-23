import {
  type AnalyticsDimension,
  addDays,
  type Comparison,
  compareWith,
  dateToDay,
  dayToMs,
  daysBetween,
  DEFAULT_IMPACT_DAYS,
  dailyValue,
  figureFor,
  type Impact,
  type ImpactVerdict,
  impactOf,
  isIsoDate,
  latestCompletePeriod,
  liveDayOf,
  mergeEvents,
  type ReportFigure,
  type ReportKind,
  relativeChange,
  sinceWindowDays,
  type SeriesLike,
  type TimelineEvent,
  type TimelineMetric,
  timelineMetricDefs,
  timelineMetricsFrom,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { coded } from '../../i18n/problem.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { type Overview, overview, MAX_OVERVIEW_DAYS } from '../analytics/query.ts';
import {
  countManual,
  createEventBody,
  deleteManual,
  getManual,
  insertManual,
  kilnEvents,
  manualEvents,
  MAX_EVENTS_PER_APP,
  saveManual,
  type updateEventBody,
} from './events.ts';
import type { z } from 'zod';

export type TimelineContext = { db: Database; now: () => number };
type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

export const IMPACT_DAYS = [7, 14, 28] as const;

export type EventView = TimelineEvent & {
  /** The day the change reached the store, or null while it waits for a release. */
  liveDay: string | null;
  /** What happened around it, for the chosen metric; null when the metric has no data around it or the app has no chart. */
  impact: (Impact & { verdict: ImpactVerdict; others: number }) | null;
};

const appView = (a: ManagedApp) => ({ id: a.id, name: a.name, platform: a.platform, store: a.platform === 'android' ? 'google_play' : 'app_store' });

const notFound = (): Failure => failure(404, 'not_found');
const eventNotFound = (): Failure => failure(404, 'event_not_found', 'No such event.', coded('timeline.eventNotFound'));
const tooMany = (): Failure =>
  failure(409, 'too_many_events', `An app can have ${MAX_EVENTS_PER_APP} events of its own. Delete one first.`, coded('timeline.tooManyEvents', { limit: MAX_EVENTS_PER_APP }));
const badRange = (message: string, path: string): Failure =>
  failure(422, 'invalid_range', message, { issues: [{ path, message }], ...coded('timeline.invalidRange') });

/** The most days the finished days of a metric lag behind today: the biggest `delayDays` of the series it is made from. */
function delayOf(metric: TimelineMetric, series: Overview['series']): number {
  const ids = metric.currency ? [metric.id] : timelineMetricDefs.filter((d) => d.id === metric.metric).reduce<string[]>((acc, d) => acc.concat([d.num], d.den ? [d.den] : []), []);
  let delay = 0;
  for (const s of series) if (ids.indexOf(s.id) !== -1) delay = Math.max(delay, s.delayDays);
  return delay;
}

/** The newest day with a value for every part of the metric that the store has finished changing. */
function latestFinal(metric: TimelineMetric, delay: number, now: number, to: string): string {
  let last = '';
  metric.values.forEach((_v, day) => {
    if (day > last && (!metric.denominators || metric.denominators.has(day))) last = day;
  });
  const final = addDays(dateToDay(now), -delay - 1);
  const cap = to < final ? to : final;
  return last === '' || last > cap ? cap : last;
}

function impactFor(
  metric: TimelineMetric,
  event: TimelineEvent,
  liveDay: string | null,
  all: ReadonlyArray<TimelineEvent>,
  latest: string,
  days: number,
): EventView['impact'] {
  if (liveDay === null) return null;
  const from = addDays(liveDay, -days);
  const to = addDays(liveDay, days);
  // Everything else inside the two windows could have moved the numbers; the release that carried this change is the change itself.
  const others = all.filter(
    (o) => o.id !== event.id && o.day >= from && o.day <= to && !(event.waitsForRelease && o.kind === 'release' && o.day === liveDay),
  ).length;
  const impact = impactOf({ kind: metric.kind, values: metric.values, denominators: metric.denominators, anchor: liveDay, latest, days, otherEvents: others });
  return { ...impact, others };
}

export async function addOverviewRange(ctx: TimelineContext, app: ManagedApp, workspaceId: string, from: string, to: string, breakdown?: AnalyticsDimension): Promise<Overview> {
  return overview(ctx.db, { workspaceId, app, from, to, granularity: 'day', ...(breakdown ? { breakdown } : {}), now: ctx.now() });
}

export type TimelineQuery = { metric?: string | undefined; from?: string | undefined; to?: string | undefined; days?: number | undefined };

export async function buildTimeline(ctx: TimelineContext, input: { workspaceId: string; appId: string; query: TimelineQuery }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  const now = ctx.now();
  const days = input.query.days ?? DEFAULT_IMPACT_DAYS;
  const to = input.query.to && isIsoDate(input.query.to) ? (input.query.to > dateToDay(now) ? dateToDay(now) : input.query.to) : addDays(dateToDay(now), -1);
  const from = input.query.from && isIsoDate(input.query.from) ? input.query.from : addDays(to, -89);
  if (from > to) return badRange('from must not be after to.', 'from');
  if (daysBetween(from, to) + 1 + days > MAX_OVERVIEW_DAYS) return badRange(`At most ${MAX_OVERVIEW_DAYS - days} days at a time.`, 'from');
  const read = await addOverviewRange(ctx, app, input.workspaceId, addDays(from, -days), to);
  const metrics = timelineMetricsFrom(read.series as SeriesLike[]);
  const chosen = metrics.find((m) => m.id === input.query.metric) ?? metrics.find((m) => m.id === 'downloads_first_time') ?? metrics[0];
  const all = mergeEvents([await kilnEvents(ctx.db, input.workspaceId, app), await manualEvents(ctx.db, input.workspaceId, app.id)]);
  const releaseDays = all.filter((e) => e.kind === 'release').map((e) => e.day);
  const latest = chosen ? latestFinal(chosen, delayOf(chosen, read.series), now, to) : to;
  const events: EventView[] = all
    .filter((e) => e.day >= from && e.day <= to)
    .map((e) => {
      const liveDay = liveDayOf(e, releaseDays);
      return { ...e, liveDay, impact: chosen ? impactFor(chosen, e, liveDay, all, latest, days) : null };
    });
  const points: { date: string; value: number | null }[] = [];
  if (chosen) for (let d = from; d <= to; d = addDays(d, 1)) points.push({ date: d, value: dailyValue(chosen, d) });
  return {
    ok: true as const,
    view: {
      app: appView(app),
      metrics: metrics.map((m) => ({ id: m.id, metric: m.metric, currency: m.currency, kind: m.kind, days: m.days })),
      metric: chosen ? { id: chosen.id, metric: chosen.metric, currency: chosen.currency, kind: chosen.kind } : null,
      from,
      to,
      days,
      latest,
      points,
      events,
    },
  };
}

/** "Did the newest graphics change work?": the days since it went live against the same number of days before it. */
export async function graphicsImpact(ctx: TimelineContext, input: { workspaceId: string; appId: string }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  const now = ctx.now();
  const all = mergeEvents([await kilnEvents(ctx.db, input.workspaceId, app), await manualEvents(ctx.db, input.workspaceId, app.id)]);
  const graphics = all.filter((e) => e.kind === 'graphics').pop();
  const empty = { app: appView(app), state: 'no_change' as const, change: null, liveDay: null, days: 0, daysSince: 0, rate: null, downloads: null, others: 0 };
  if (!graphics) return { ok: true as const, view: empty };
  const releaseDays = all.filter((e) => e.kind === 'release').map((e) => e.day);
  const liveDay = liveDayOf(graphics, releaseDays);
  const change = { id: graphics.id, day: graphics.day, label: graphics.label };
  if (liveDay === null) return { ok: true as const, view: { ...empty, state: 'waiting' as const, change } };
  const today = dateToDay(now);
  const to = addDays(liveDay, 28) < addDays(today, -1) ? addDays(liveDay, 28) : addDays(today, -1);
  const from = addDays(liveDay, -28);
  const read = await addOverviewRange(ctx, app, input.workspaceId, from, to < from ? from : to);
  const metrics = timelineMetricsFrom(read.series as SeriesLike[]);
  const rate = metrics.find((m) => m.id === 'product_page_conversion');
  const downloads = metrics.find((m) => m.id === 'downloads_first_time') ?? metrics.find((m) => m.id === 'store_listing_acquisitions') ?? metrics.find((m) => m.id === 'installs_user');
  const probe = rate ?? downloads;
  const latest = probe ? latestFinal(probe, delayOf(probe, read.series), now, to) : to;
  const window = sinceWindowDays(liveDay, latest);
  const others = all.filter((o) => o.id !== graphics.id && o.day >= addDays(liveDay, -window) && o.day <= addDays(liveDay, window) && !(graphics.waitsForRelease && o.kind === 'release' && o.day === liveDay)).length;
  const run = (m: TimelineMetric | undefined) =>
    m ? { id: m.id, impact: impactOf({ kind: m.kind, values: m.values, denominators: m.denominators, anchor: liveDay, latest, days: Math.max(1, window), fullDays: 14, otherEvents: others }) } : null;
  return {
    ok: true as const,
    view: { app: appView(app), state: 'ok' as const, change, liveDay, days: window, daysSince: latest > liveDay ? daysBetween(liveDay, latest) : 0, rate: run(rate), downloads: run(downloads), others },
  };
}

export async function createEvent(ctx: TimelineContext, input: { workspaceId: string; appId: string; actor: Actor; event: z.infer<typeof createEventBody> }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  if ((await countManual(ctx.db, input.workspaceId, app.id)) >= MAX_EVENTS_PER_APP) return tooMany();
  const at = ctx.now();
  const event = await ctx.db.transaction(async (tx) => {
    const created = await insertManual(tx, { workspaceId: input.workspaceId, appId: app.id, actorId: input.actor.id, at, event: input.event });
    // The id, the kind and the day: never the title or the note.
    await recordAudit(tx, { workspaceId: input.workspaceId, actor: input.actor, action: 'timeline.event_created', target: { type: 'app', id: app.id }, detail: { appId: app.id, eventId: created.id.slice(2), kind: created.kind, day: created.day }, at });
    return created;
  });
  return { ok: true as const, event };
}

export async function updateEvent(ctx: TimelineContext, input: { workspaceId: string; appId: string; eventId: string; actor: Actor; changes: z.infer<typeof updateEventBody> }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  const current = await getManual(ctx.db, input.workspaceId, app.id, input.eventId);
  if (!current) return eventNotFound();
  const next: TimelineEvent = {
    ...current,
    kind: input.changes.kind ?? current.kind,
    day: input.changes.day ?? current.day,
    title: input.changes.title ?? current.title,
    note: input.changes.note ?? current.note,
  };
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await saveManual(tx, { workspaceId: input.workspaceId, appId: app.id, id: input.eventId, at, event: next });
    await recordAudit(tx, { workspaceId: input.workspaceId, actor: input.actor, action: 'timeline.event_updated', target: { type: 'app', id: app.id }, detail: { appId: app.id, eventId: input.eventId, kind: next.kind, day: next.day }, at });
  });
  return { ok: true as const, event: next };
}

export async function removeEvent(ctx: TimelineContext, input: { workspaceId: string; appId: string; eventId: string; actor: Actor }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  const at = ctx.now();
  const removed = await ctx.db.transaction(async (tx) => {
    const n = await deleteManual(tx, input.workspaceId, app.id, input.eventId);
    if (n > 0)
      await recordAudit(tx, { workspaceId: input.workspaceId, actor: input.actor, action: 'timeline.event_deleted', target: { type: 'app', id: app.id }, detail: { appId: app.id, eventId: input.eventId }, at });
    return n;
  });
  return removed > 0 ? { ok: true as const } : eventNotFound();
}

// ---------------------------------------------------------------------------------------------
// Reports

const merge = (a: Overview, b: Overview): SeriesLike[] => {
  const byId = new Map<string, SeriesLike>();
  for (const s of a.series) byId.set(s.id, { id: s.id, cadence: s.cadence, points: s.points.slice() });
  for (const s of b.series) {
    const have = byId.get(s.id);
    if (have) (have.points as { date: string; value: number | null }[]).push(...s.points);
    else byId.set(s.id, { id: s.id, cadence: s.cadence, points: s.points.slice() });
  }
  return [...byId.values()];
};

const emptyOverview = (a: Overview): Overview => ({ ...a, series: [] });

const DOWNLOAD_METRICS = ['downloads_first_time', 'store_listing_acquisitions', 'installs_user'];

export type ReportQuery = { kind: ReportKind; day?: string | undefined };

export async function buildReport(ctx: TimelineContext, input: { workspaceId: string; appId: string; query: ReportQuery }) {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return notFound();
  const now = ctx.now();
  const through = addDays(dateToDay(now), -1);
  const day = input.query.day && isIsoDate(input.query.day) ? input.query.day : latestCompletePeriod(input.query.kind, through).from;
  const cmp: Comparison = compareWith(input.query.kind, day, through);
  const empty = cmp.currentDays === 0;
  const span = (w: { from: string; to: string }) => (w.to < w.from ? null : w);
  const cur = span(cmp.current);
  const prev = span(cmp.previous);
  const read = async (w: { from: string; to: string } | null, breakdown?: AnalyticsDimension): Promise<Overview | null> =>
    w ? addOverviewRange(ctx, app, input.workspaceId, w.from, w.to, breakdown) : null;
  const curT = await read(cur, 'territory');
  const prevT = await read(prev, 'territory');
  const curS = await read(cur, 'source_type');
  const blank = curT ?? prevT;
  const metrics = blank ? timelineMetricsFrom(merge(curT ?? emptyOverview(blank), prevT ?? emptyOverview(blank))) : [];
  const figures: ReportFigure[] = metrics.map((m) => figureFor(m, cmp));
  const comparable = (metricId: string) => figures.find((f) => f.id === metricId)?.uncompared === null;

  // Countries: the downloads of the top places, against the period before.
  const dlId = DOWNLOAD_METRICS.find((id) => curT?.series.some((s) => s.id === id && s.breakdown && s.breakdown.items.length > 0));
  const countries: { code: string; value: number; share: number | null; change: number | null }[] = [];
  if (curT && dlId) {
    const s = curT.series.find((x) => x.id === dlId);
    const before = new Map<string, number>();
    for (const i of prevT?.series.find((x) => x.id === dlId)?.breakdown?.items ?? []) before.set(i.value, i.total);
    for (const i of (s?.breakdown?.items ?? []).slice(0, 8)) {
      countries.push({ code: i.value, value: i.total, share: s?.total ? i.total / s.total : null, change: comparable(dlId) && before.has(i.value) ? relativeChange(i.total, before.get(i.value) ?? null) : null });
    }
  }

  // How people found the app: the sources the store splits the numbers by (App Store only).
  const sources: { source: string; seen: number | null; pageViews: number | null; downloads: number }[] = [];
  const dl = curS?.series.find((s) => s.id === 'downloads_first_time');
  if (curS && dl?.breakdown) {
    const item = (id: string, key: string) => curS.series.find((s) => s.id === id)?.breakdown?.items.find((i) => i.value === key)?.total ?? null;
    for (const i of dl.breakdown.items.slice(0, 8)) sources.push({ source: i.value, seen: item('impressions', i.value), pageViews: item('product_page_views', i.value), downloads: i.total });
  }

  const reviewsIn = async (w: { from: string; to: string } | null) => {
    if (!w) return { count: 0, average: null as number | null, lowUnanswered: 0 };
    const r = (await ctx.db.query(
      `SELECT COUNT(*) AS n, AVG(rating) AS avg_rating,
              SUM(CASE WHEN rating <= 2 AND (developer_response IS NULL OR developer_response = '') THEN 1 ELSE 0 END) AS low
         FROM app_reviews WHERE workspace_id = ? AND app_id = ? AND created_at >= ? AND created_at < ?`,
      [input.workspaceId, app.id, dayToMs(w.from), dayToMs(addDays(w.to, 1))],
    ))[0];
    const n = Number(r?.n ?? 0);
    return { count: n, average: n > 0 ? Math.round(Number(r?.avg_rating) * 100) / 100 : null, lowUnanswered: Number(r?.low ?? 0) };
  };
  const reviews = { current: await reviewsIn(cur), previous: await reviewsIn(prev) };

  const all = mergeEvents([await kilnEvents(ctx.db, input.workspaceId, app), await manualEvents(ctx.db, input.workspaceId, app.id)]);
  const events = all.filter((e) => cur && e.day >= cur.from && e.day <= cur.to);
  // Days of the period without a value in the first figure: the report says when the numbers are not all there yet.
  const missingDays = empty ? 0 : Math.max(0, cmp.currentDays - Math.max(0, ...figures.map((f) => f.days)));
  return {
    ok: true as const,
    view: { app: appView(app), kind: input.query.kind, through, comparison: cmp, figures, countries, sources, reviews, events, missingDays, downloadMetric: dlId ?? null },
  };
}
