import { manualEventKinds, PLATFORMS, reportKinds, timelineEventKinds } from '@kiln/core';
import { z } from 'zod';
import { type Draft, W } from '../../operations/shared.ts';
import { NOTE_MAX, TITLE_MAX } from './events.ts';

/** The operations of the timeline and the reports (docs/api/timeline.md, docs/api/reports.md). The registry (operations/registry.ts) lists them. */

const day = z.string().describe('YYYY-MM-DD (UTC).');
const appView = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: z.enum(['app_store', 'google_play']),
});
const label = z.object({ code: z.string(), params: z.record(z.union([z.string(), z.number()])) });

const eventSchema = z.object({
  id: z.string().describe('`m:<id>` for an event a person wrote, `k:...` for one Kiln derived.'),
  day,
  kind: z.enum(timelineEventKinds),
  origin: z.enum(['kiln', 'manual']),
  label: label
    .nullable()
    .describe(
      'Kiln events: a code and its parameters, translated by the screens. Never a sentence.',
    ),
  title: z.string().nullable().describe('Manual events: what the person wrote.'),
  note: z.string().nullable(),
  version: z.string().nullable(),
  liveDay: day
    .nullable()
    .describe('The day the change reached the store; null while it waits for a release.'),
  waitsForRelease: z.boolean(),
});

const windowSchema = z.object({
  from: day,
  to: day,
  calendarDays: z.number().int(),
  dataDays: z.number().int(),
  sum: z.number(),
  denominator: z.number(),
  value: z
    .number()
    .nullable()
    .describe('A rate: sum over denominator. A count or amount: the mean per day with a value.'),
});

const impactSchema = z.object({
  anchor: day,
  days: z.number().int(),
  before: windowSchema,
  after: windowSchema,
  daysAfter: z.number().int(),
  daysToFirstRead: z.number().int(),
  daysToFull: z.number().int(),
  change: z
    .number()
    .nullable()
    .describe('Relative change of the after window against the before window (0.18 is +18%).'),
  confidence: z
    .number()
    .nullable()
    .describe('Two-sided confidence (0 to 1) that the windows differ; null when not tested.'),
  verdict: z.enum([
    'higher',
    'lower',
    'no_clear_difference',
    'too_early',
    'not_tested',
    'not_live',
    'no_data',
  ]),
  caveats: z.array(
    z.enum([
      'short_window',
      'gaps',
      'small_numbers',
      'not_tested',
      'approximate_test',
      'other_events',
    ]),
  ),
});

const metricSchema = z.object({
  id: z.string().describe('`impressions`, `product_page_conversion`, `sales_proceeds:EUR`, ...'),
  metric: z.string(),
  currency: z.string().nullable(),
  kind: z.enum(['count', 'ratio', 'level']),
});

const timelineSchema = z.object({
  app: appView,
  metrics: z.array(metricSchema.extend({ days: z.number().int() })),
  metric: metricSchema.nullable(),
  from: day,
  to: day,
  days: z.number().int(),
  latest: day.describe('The newest day whose number the store has finished changing.'),
  points: z.array(z.object({ date: day, value: z.number().nullable() })),
  events: z.array(
    eventSchema.extend({
      impact: impactSchema
        .extend({ others: z.number().int().describe('Other events inside the two windows.') })
        .nullable(),
    }),
  ),
});

const graphicsSchema = z.object({
  app: appView,
  state: z.enum(['no_change', 'waiting', 'ok']),
  change: z.object({ id: z.string(), day, label: label.nullable() }).nullable(),
  liveDay: day.nullable(),
  days: z.number().int().describe('Days compared on each side (at most 28).'),
  daysSince: z.number().int(),
  rate: z.object({ id: z.string(), impact: impactSchema }).nullable(),
  downloads: z.object({ id: z.string(), impact: impactSchema }).nullable(),
  others: z.number().int(),
});

const figureSchema = z.object({
  id: z.string(),
  metric: z.string(),
  currency: z.string().nullable(),
  kind: z.enum(['count', 'ratio', 'level']),
  value: z.number().nullable(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  uncompared: z.enum(['no_data', 'previous_incomplete', 'current_incomplete']).nullable(),
  days: z.number().int(),
  previousDays: z.number().int(),
});
const windowDays = z.object({ from: day, to: day });
const reviewsSide = z.object({
  count: z.number().int(),
  average: z.number().nullable(),
  lowUnanswered: z.number().int(),
});

const reportSchema = z.object({
  app: appView,
  kind: z.enum(reportKinds),
  through: day.describe('The newest day with numbers the report counts on (yesterday).'),
  comparison: z.object({
    kind: z.enum(reportKinds),
    period: windowDays,
    current: windowDays,
    previous: windowDays,
    currentDays: z.number().int(),
    previousDays: z.number().int(),
    partial: z.boolean(),
    lengthsDiffer: z.boolean(),
  }),
  figures: z.array(figureSchema),
  countries: z.array(
    z.object({
      code: z.string(),
      value: z.number(),
      share: z.number().nullable(),
      change: z.number().nullable(),
    }),
  ),
  sources: z.array(
    z.object({
      source: z.string(),
      seen: z.number().nullable(),
      pageViews: z.number().nullable(),
      downloads: z.number(),
    }),
  ),
  reviews: z.object({ current: reviewsSide, previous: reviewsSide }),
  events: z.array(eventSchema),
  missingDays: z.number().int(),
  downloadMetric: z.string().nullable(),
});

const appScope = { kind: 'param', name: 'appId' } as const;
const body = {
  kind: z.enum(manualEventKinds),
  day: day.describe('A real date.'),
  title: z.string().min(1).max(TITLE_MAX).describe(`One line, 1 to ${TITLE_MAX} characters.`),
  note: z.string().max(NOTE_MAX).describe(`Free text, up to ${NOTE_MAX} characters.`),
};

export const timelineOperations: Draft[] = [
  {
    id: 'getAppTimeline',
    method: 'get',
    path: `${W}/apps/{appId}/timeline`,
    tags: ['timeline'],
    summary:
      'One metric as a daily series, with the events of the app and what happened around each',
    description:
      'Read-only, from what is stored (no store is contacted). `metric` is one of the `metrics` of the answer (only those with data; default first-time downloads). `from` and `to` default to the last 90 days up to yesterday; the range plus `days` is at most 400 days. Events come from Kiln (versions released or rolling out, phased rollout steps, texts and graphics pushed to a store draft, changes seen in the live listing, experiments) and from people (`ad_campaign`, `price_change`, `press`, `other`). `impact` compares the metric’s `days` days before the day the change reached the store with the days after it: a rate by a two-proportion z-test, a count by a Poisson approximation, an amount not at all (`not_tested`). A verdict needs a whole week of days after the change; below that it says `too_early`. It is a before and after comparison, never proof of cause: `others` counts the other events in the same weeks. Graphics and listing text of an App Store app go live with the next version released on or after the day they were pushed (`liveDay`; null while none is out).',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope,
    query: z.object({
      metric: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      days: z.number().int().optional().describe('7, 14 (default) or 28.'),
    }),
    responses: { '200': { description: 'The series and the events.', schema: timelineSchema } },
  },
  {
    id: 'getAppGraphicsImpact',
    method: 'get',
    path: `${W}/apps/{appId}/timeline/graphics-impact`,
    tags: ['timeline'],
    summary:
      'Did the newest screenshots and graphics work: the days since they went live against as many days before',
    description:
      'Read-only. Takes the newest graphics push Kiln made, finds the day it went live, and compares the page download rate and the downloads of the days since (at most 28) with the same number of days before. `state`: `no_change` (Kiln has seen no graphics push), `waiting` (pushed, but the App Store version carrying it is not out yet), `ok`. Each result has the same `verdict` words as the timeline; before a week of days it says `too_early` and `daysToFirstRead`. Not proof of cause.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope,
    responses: { '200': { description: 'The comparison.', schema: graphicsSchema } },
  },
  {
    id: 'createTimelineEvent',
    method: 'post',
    path: `${W}/apps/{appId}/timeline/events`,
    tags: ['timeline'],
    summary: 'Add an event of your own to the timeline of an app',
    description:
      'An ad campaign, a price change, press or anything else, on a day. Kiln’s own data: nothing is sent to a store. At most 500 per app (`409 too_many_events`). Audited as `timeline.event_created` with the id, the kind and the day, never the title or the note.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope,
    body: z.object({
      kind: body.kind,
      day: body.day,
      title: body.title,
      note: body.note.optional(),
    }),
    responses: { '201': { description: 'The event.', schema: z.object({ event: eventSchema }) } },
  },
  {
    id: 'updateTimelineEvent',
    method: 'patch',
    path: `${W}/apps/{appId}/timeline/events/{eventId}`,
    tags: ['timeline'],
    summary: 'Change an event of your own',
    description:
      'Only the fields sent change. `eventId` is the part after `m:`. `404 event_not_found`. Audited as `timeline.event_updated`.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope,
    body: z.object({
      kind: body.kind.optional(),
      day: body.day.optional(),
      title: body.title.optional(),
      note: body.note.optional(),
    }),
    responses: { '200': { description: 'The event.', schema: z.object({ event: eventSchema }) } },
  },
  {
    id: 'deleteTimelineEvent',
    method: 'delete',
    path: `${W}/apps/{appId}/timeline/events/{eventId}`,
    tags: ['timeline'],
    summary: 'Delete an event of your own',
    description: '`404 event_not_found`. Audited as `timeline.event_deleted`.',
    risk: 'destructive',
    access: { action: 'aso.write' },
    appScope,
    responses: { '200': { description: 'Deleted.', schema: z.object({ ok: z.literal(true) }) } },
  },
  {
    id: 'getAppReport',
    method: 'get',
    path: `${W}/apps/{appId}/reports`,
    tags: ['reports'],
    summary: 'A weekly, monthly or yearly report of an app: the period against the one before',
    description:
      'Read-only, from what is stored. `kind` is `week` (Monday to Sunday), `month` or `year` (calendar, UTC days); `day` is any day inside the period (default: the newest period that has ended). A period still running is `partial`: it is compared with the same number of days at the start of the one before. Whole periods of different length (February against March, a leap year) say `lengthsDiffer`: totals are not like for like. A figure has a `change` only when both periods have a value for at least 80% of their days (`uncompared` says why not). Also: the top countries by downloads, the sources the store splits the numbers by (App Store), the reviews written in the period with the average and low ratings still without a reply (counts only; no review text), and the timeline events of the period.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope,
    query: z.object({ kind: z.enum(reportKinds).optional(), day: z.string().optional() }),
    responses: { '200': { description: 'The report.', schema: reportSchema } },
  },
];
