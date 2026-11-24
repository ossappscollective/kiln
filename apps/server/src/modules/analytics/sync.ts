import {
  AnalyticsError,
  type AnalyticsPoint,
  AppleAnalyticsConnector,
  type AppleAnalyticsPort,
  appleReportKindFromName,
  mapAppleSalesTable,
  mapAppleSubscriptionEventTable,
  mapAppleSubscriptionTable,
  mapAppleTable,
  PlayEarningsConnector,
  type PlayEarningsPort,
  PlayReportsConnector,
  type PlayReportsPort,
  PlaySalesConnector,
  type PlaySalesPort,
  PlaySubscriptionsConnector,
  type PlaySubscriptionsPort,
  PlayVitalsConnector,
  type PlayVitalsPort,
  parseTable,
  StoreError,
  StoreRateLimitError,
} from '@kiln/connectors';
import {
  type ActorType,
  type AnalyticsErrorCode,
  type AnalyticsSource,
  isAnalyticsSource,
  addDays,
  analyticsErrorMessages,
  analyticsLimits,
  dateToDay,
  moneyMetrics,
  sourcesForPlatform,
  splitProductDimValue,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { enqueue, type JobHandler } from '../../jobs.ts';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { getSettings } from '../../services/workspace-settings.ts';
import {
  capProductPoints,
  storedProductIds,
  storedStoreProductIds,
  storedStoreRefs,
} from './product-sales.ts';
import {
  getAppConfig,
  listReportRequests,
  markReportRequest,
  type RunTrigger,
  recordRun,
  resolveAppleVendor,
  resolvePlayBucket,
  type SyncRun,
  saveInstance,
  saveSourceState,
  settledInstances,
  upsertPoints,
} from './store.ts';

import { coded } from '../../i18n/problem.ts';
import {
  credentialLane,
  syncActivity,
  mapPool,
  pipelineSettings,
} from '../../services/sync-pipeline.ts';
/**
 * Reads the analytics of an app from its stores into `analytics_daily` (docs/adr/0017-analytics-foundation.md). Read only toward the
 * stores: the one store write of analytics (creating an Apple report request) is a separate, explicit action (analytics-enable.ts).
 *
 * - Sources by platform: iOS and macOS `apple_analytics` (the Analytics Reports of an ONGOING request) and `apple_sales` (Sales and
 *   Trends, needs the vendor number); Android `play_vitals` (Reporting API) and `play_reports` (Cloud Storage CSVs, needs the bucket id).
 * - Idempotent: a point is written by key and only replaced by a later processing date (analytics-store.ts); an Apple instance is read
 *   once. A segment download link lasts 5 minutes, so it is fetched at once and never logged or stored.
 * - A source that cannot run yet (no request, no vendor number, no bucket id) is skipped with its setup code and is not a failure.
 * - A failure is a code from a FIXED vocabulary (`analyticsErrorCodes`), kept on the source state and in the run; no store text.
 * - Audit: one `analytics.sync` per call with ids, counts and codes. Event: `analytics.synced` (ids and counts) when something new was stored.
 */

type Actor = { type: ActorType; id: string };

export const ANALYTICS_SYNC_QUEUE = 'analytics.sync';
export const DEFAULT_ANALYTICS_TIMEOUT_MS = 120_000;

/** How far back a first read goes, and how far a later read overlaps the newest stored day (days restated by the store). */
export const analyticsWindows = {
  /** Apple instances read in one sync; the backlog continues the next time. */
  maxInstancesPerSync: 60,
  salesFirstDays: 30,
  salesMaxDaysPerSync: 31,
  salesOverlapDays: 2,
  vitalsFirstDays: 90,
  vitalsOverlapDays: 7,
  playFirstMonths: 3,
  /** The Earnings report is a monthly statement: a first read goes further back than the statistics. */
  earningsFirstMonths: 6,
} as const;

export type AnalyticsConnectorFactory = {
  apple(input: { secret: string; fetch: typeof fetch }): AppleAnalyticsPort;
  playVitals(input: { secret: string; packageName: string; fetch: typeof fetch }): PlayVitalsPort;
  playReports(input: {
    secret: string;
    packageName: string;
    bucketId: string;
    fetch: typeof fetch;
  }): PlayReportsPort;
  /** The Estimated sales reports of the same bucket (needs the Play Console permission View financial data). */
  playSales(input: {
    secret: string;
    packageName: string;
    bucketId: string;
    fetch: typeof fetch;
  }): PlaySalesPort;
  /** The monthly Earnings report of the same bucket (needs View financial data). docs/adr/0042-earnings-and-subscription-metrics.md */
  playEarnings(input: {
    secret: string;
    packageName: string;
    bucketId: string;
    fetch: typeof fetch;
  }): PlayEarningsPort;
  /** The subscription statistics (`financial-stats/subscriptions`) of the same bucket (needs View financial data). */
  playSubscriptions(input: {
    secret: string;
    packageName: string;
    bucketId: string;
    fetch: typeof fetch;
  }): PlaySubscriptionsPort;
};

export const defaultAnalyticsConnectors: AnalyticsConnectorFactory = {
  apple: (input) => AppleAnalyticsConnector.fromSecret(input.secret, { fetch: input.fetch }),
  playVitals: (input) =>
    new PlayVitalsConnector({
      serviceAccount: input.secret,
      packageName: input.packageName,
      fetch: input.fetch,
    }),
  playReports: (input) =>
    new PlayReportsConnector({
      serviceAccount: input.secret,
      packageName: input.packageName,
      bucketId: input.bucketId,
      fetch: input.fetch,
    }),
  playSales: (input) =>
    new PlaySalesConnector({
      serviceAccount: input.secret,
      packageName: input.packageName,
      bucketId: input.bucketId,
      fetch: input.fetch,
    }),
  playEarnings: (input) =>
    new PlayEarningsConnector({
      serviceAccount: input.secret,
      packageName: input.packageName,
      bucketId: input.bucketId,
      fetch: input.fetch,
    }),
  playSubscriptions: (input) =>
    new PlaySubscriptionsConnector({
      serviceAccount: input.secret,
      packageName: input.packageName,
      bucketId: input.bucketId,
      fetch: input.fetch,
    }),
};

export type AnalyticsContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  connectors: AnalyticsConnectorFactory;
  /** Longest one source may take. Default 120 seconds. */
  timeoutMs: number;
};

// ---------------------------------------------------------------------------------------------
// Failures

class SyncTimeout extends Error {}

export type Classified = {
  code: AnalyticsErrorCode;
  status: 409 | 422 | 429 | 502 | 504;
  transient: boolean;
};

/** Turns anything a connector throws into a code of the fixed vocabulary. Nothing of the original message is kept. */
export function classifyAnalyticsError(error: unknown): Classified {
  if (error instanceof SyncTimeout) return { code: 'timeout', status: 504, transient: true };
  if (error instanceof AnalyticsError) {
    switch (error.code) {
      case 'segment_expired':
      case 'report_not_ready':
        return { code: error.code, status: 502, transient: true };
      case 'rate_limited':
        return { code: 'rate_limited', status: 429, transient: true };
      case 'store_unavailable':
      case 'timeout':
        return { code: error.code, status: 502, transient: true };
      default:
        return { code: error.code, status: 422, transient: false };
    }
  }
  if (error instanceof StoreRateLimitError)
    return { code: 'rate_limited', status: 429, transient: true };
  if (error instanceof StoreError) {
    switch (error.kind) {
      case 'auth':
      case 'clock_skew':
      case 'invalid_input':
        return { code: 'store_auth', status: 422, transient: false };
      case 'forbidden':
      case 'api_disabled':
        return { code: 'store_forbidden', status: 422, transient: false };
      case 'not_found':
        return { code: 'store_not_found', status: 422, transient: false };
      case 'server':
      case 'network':
        return { code: 'store_unavailable', status: 502, transient: true };
      case 'unexpected':
        // An HTTP 4xx the store sent that has no meaning of its own: a request it refused, not an outage.
        if (error.status !== undefined && error.status >= 400 && error.status < 500)
          return { code: 'store_rejected', status: 422, transient: false };
        return { code: 'store_unavailable', status: 502, transient: false };
      default:
        return { code: 'store_unavailable', status: 502, transient: false };
    }
  }
  return { code: 'sync_failed', status: 502, transient: false };
}

// ---------------------------------------------------------------------------------------------
// Results

export type SourceResult =
  | {
      source: AnalyticsSource;
      status: 'ok' | 'partial';
      points: number;
      reports: number;
      dayFrom: string | null;
      dayTo: string | null;
      errorCode?: AnalyticsErrorCode;
    }
  | { source: AnalyticsSource; status: 'failed'; errorCode: AnalyticsErrorCode; transient: boolean }
  | { source: AnalyticsSource; status: 'skipped'; setup: string };

export type AnalyticsSyncResult = {
  at: number;
  sources: SourceResult[];
  /** Points inserted or changed in all sources. */
  pointsWritten: number;
};

type Env = {
  ctx: AnalyticsContext;
  app: ManagedApp;
  workspaceId: string;
  actor: Actor;
  trigger: RunTrigger;
  /** The app's store credential (decrypted). */
  secret: string;
  fetch: typeof fetch;
  vendorNumber: string;
  bucketId: string | null;
};

type Outcome =
  | {
      kind: 'done';
      status: 'ok' | 'partial';
      points: number;
      reports: number;
      dayFrom: string | null;
      dayTo: string | null;
      errorCode?: AnalyticsErrorCode;
    }
  | { kind: 'skip'; setup: string };

/** The calendar day (YYYY-MM-DD) of a moment in Pacific Time, the time zone of Apple's sales days. */
const pacificFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const pacificDay = (ms: number): string => pacificFormat.format(new Date(ms));

const range = (points: AnalyticsPoint[]): { from: string | null; to: string | null } => {
  let from: string | null = null;
  let to: string | null = null;
  for (const p of points) {
    if (from === null || p.date < from) from = p.date;
    if (to === null || p.date > to) to = p.date;
  }
  return { from, to };
};

const platformOf = (app: ManagedApp): 'ios' | 'macos' | undefined =>
  app.platform === 'macos' ? 'macos' : app.platform === 'ios' ? 'ios' : undefined;

// ---------------------------------------------------------------------------------------------
// Apple Analytics Reports (an ONGOING request already exists)

async function readAppleAnalytics(env: Env): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  const requests = (await listReportRequests(ctx.db, workspaceId, app.id)).filter(
    (r) => r.status !== 'missing',
  );
  const config = await getAppConfig(ctx.db, workspaceId, app.id);
  if (requests.length === 0)
    return {
      kind: 'skip',
      setup: config.appleMode === 'import' ? 'import_only' : 'create_report_request',
    };
  if (!app.storeAppId) throw new AnalyticsError('app_not_synced');
  const port = ctx.connectors.apple({ secret: env.secret, fetch: env.fetch });

  // The request may have been stopped by Apple (inactivity) or removed: one cheap listing says so.
  const known = await port.listRequests(app.storeAppId);
  const active: typeof requests = [];
  for (const request of requests) {
    const at = ctx.now();
    const theirs = known.find((k) => k.id === request.appleRequestId);
    if (!theirs)
      await markReportRequest(ctx.db, request.id, {
        status: 'missing',
        errorCode: 'analytics_request_missing',
        now: at,
      });
    else if (theirs.stoppedDueToInactivity)
      await markReportRequest(ctx.db, request.id, {
        status: 'stopped',
        errorCode: 'analytics_request_stopped',
        now: at,
      });
    else {
      await markReportRequest(ctx.db, request.id, { status: 'active', now: at });
      active.push(request);
    }
  }
  if (active.length === 0) {
    throw new AnalyticsError(
      requests.some((r) => r.status === 'stopped') || known.some((k) => k.stoppedDueToInactivity)
        ? 'analytics_request_stopped'
        : 'analytics_request_missing',
    );
  }

  const settled = await settledInstances(ctx.db, workspaceId, app.id);
  const platform = platformOf(app);
  let budget = analyticsWindows.maxInstancesPerSync;
  let points = 0;
  let reports = 0;
  let failed: AnalyticsErrorCode | undefined;
  let from: string | null = null;
  let to: string | null = null;

  for (const request of active) {
    const refs = await port.listReports(request.appleRequestId);
    for (const ref of refs) {
      const kind = appleReportKindFromName(ref.name);
      if (!kind) continue;
      const instances = (await port.listInstances(ref.id)).filter(
        (i) => i.granularity === '' || i.granularity.toUpperCase() === 'DAILY',
      );
      for (const instance of instances) {
        if (settled.has(instance.id)) continue;
        if (budget <= 0) break;
        budget--;
        const at = ctx.now();
        const record = (
          status: 'read' | 'failed',
          extra: { errorCode?: string; segments?: number; points?: number },
        ) =>
          saveInstance(ctx.db, {
            workspaceId,
            appId: app.id,
            appleInstanceId: instance.id,
            appleReportId: ref.id,
            reportKind: kind,
            processingDate: instance.processingDate,
            status,
            ...extra,
            now: at,
          });
        try {
          const read = await port.readInstance(instance.id);
          let instancePoints: AnalyticsPoint[] = [];
          for (const text of read.texts) {
            const table = parseTable(text, {
              maxRows: analyticsLimits.maxRows,
              maxColumns: analyticsLimits.maxColumns,
            });
            const parsed = mapAppleTable(table, {
              reportName: ref.name,
              ...(platform ? { platform } : {}),
            });
            instancePoints = instancePoints.concat(parsed.points);
          }
          const result = await upsertPoints(
            ctx.db,
            {
              workspaceId,
              appId: app.id,
              platform: app.platform,
              source: 'apple_analytics',
              processingDate: instance.processingDate,
              origin: 'sync',
              now: at,
            },
            instancePoints,
          );
          points += result.written;
          reports++;
          const r = range(instancePoints);
          if (r.from !== null && (from === null || r.from < from)) from = r.from;
          if (r.to !== null && (to === null || r.to > to)) to = r.to;
          await record('read', { segments: read.segments, points: instancePoints.length });
        } catch (error) {
          const c = classifyAnalyticsError(error);
          // A report with no usable row is a fact about the report, not a failure of the sync.
          if (c.code === 'no_rows') {
            await record('read', { segments: 0, points: 0 });
            reports++;
            continue;
          }
          if (
            c.code === 'store_auth' ||
            c.code === 'store_forbidden' ||
            c.code === 'analytics_role_required' ||
            c.code === 'rate_limited'
          )
            throw error;
          failed = c.code;
          await record('failed', { errorCode: c.code });
        }
      }
    }
  }
  return {
    kind: 'done',
    status: failed ? 'partial' : 'ok',
    points,
    reports,
    dayFrom: from,
    dayTo: to,
    ...(failed ? { errorCode: failed } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Apple Sales and Trends (optional: needs the vendor number)

async function readAppleSales(env: Env, newestDay: string | null): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.vendorNumber === '') return { kind: 'skip', setup: 'vendor_number_missing' };
  if (!app.storeAppId) throw new AnalyticsError('app_not_synced');
  const port = ctx.connectors.apple({ secret: env.secret, fetch: env.fetch });
  const platform = platformOf(app);
  const now = ctx.now();
  // Apple's sales days run on Pacific Time and the report of day D is posted the next day: the newest day asked for is yesterday
  // in Pacific Time (yesterday in UTC is still "today" there for the first hours of the UTC day, and has no report yet).
  const last = addDays(pacificDay(now), -1);
  const first = newestDay
    ? addDays(newestDay, -analyticsWindows.salesOverlapDays)
    : addDays(dateToDay(now), -analyticsWindows.salesFirstDays);
  const days: string[] = [];
  for (
    let day = first < last ? first : last;
    day <= last && days.length < analyticsWindows.salesMaxDaysPerSync;
    day = addDays(day, 1)
  )
    days.push(day);

  let points = 0;
  let reports = 0;
  let from: string | null = null;
  let to: string | null = null;
  // In-app rows are matched to the app by the SKUs of its stored products (the Products page snapshot; no store call).
  const knownSkus = await storedStoreProductIds(ctx.db, workspaceId, app.id);
  const stored = await storedProductIds(ctx.db, {
    workspaceId,
    appId: app.id,
    platform: app.platform,
    source: 'apple_sales',
  });
  for (const day of days) {
    const text = await port.fetchSalesReport({ vendorNumber: env.vendorNumber, date: day });
    if (text === null) continue;
    const table = parseTable(text, {
      maxRows: analyticsLimits.maxRows,
      maxColumns: analyticsLimits.maxColumns,
    });
    const read = mapAppleSalesTable(table, {
      appleId: app.storeAppId,
      knownSkus,
      ...(platform ? { platform } : {}),
    });
    const capped = capProductPoints(read.points, stored);
    // Products kept now count against the cap of the next day of this sync.
    for (const p of capped.points)
      if (p.dimension?.type === 'product')
        stored.add(
          splitProductDimValue(p.dimension.value, p.metric === 'sales_proceeds').productId,
        );
    const parsed = { ...read, points: capped.points };
    reports++;
    const result = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'apple_sales',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      parsed.points,
    );
    points += result.written;
    const r = range(parsed.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

// ---------------------------------------------------------------------------------------------
// Apple subscription reports (same vendor number as Sales and Trends; docs/adr/0042-earnings-and-subscription-metrics.md)

/**
 * The Subscription (snapshot of the day) and Subscription Event reports of Sales and Trends, one pair per day, for this app only.
 * A day Apple has no report for is skipped (a 404 is "no report", not an error). The per-subscriber SUBSCRIBER report is never read.
 */
async function readAppleSubscriptions(env: Env, newestDay: string | null): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.vendorNumber === '') return { kind: 'skip', setup: 'vendor_number_missing' };
  if (!app.storeAppId) throw new AnalyticsError('app_not_synced');
  const port = ctx.connectors.apple({ secret: env.secret, fetch: env.fetch });
  const platform = platformOf(app);
  const now = ctx.now();
  const last = addDays(pacificDay(now), -1);
  const first = newestDay
    ? addDays(newestDay, -analyticsWindows.salesOverlapDays)
    : addDays(dateToDay(now), -analyticsWindows.salesFirstDays);
  const days: string[] = [];
  for (
    let day = first < last ? first : last;
    day <= last && days.length < analyticsWindows.salesMaxDaysPerSync;
    day = addDays(day, 1)
  )
    days.push(day);

  // The Subscription Apple ID of a row is the `storeRef` of the stored product (the Products page snapshot; no store call).
  const refs = await storedStoreRefs(ctx.db, workspaceId, app.id);
  const stored = await storedProductIds(ctx.db, {
    workspaceId,
    appId: app.id,
    platform: app.platform,
    source: 'apple_subscriptions',
  });
  let points = 0;
  let reports = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const day of days) {
    const options = {
      appleId: app.storeAppId,
      date: day,
      ...(platform ? { platform } : {}),
      productOf: (id: string) => refs.get(id),
    };
    const dayPoints: AnalyticsPoint[] = [];
    for (const kind of ['subscription', 'subscription_event'] as const) {
      const text = await port.fetchSubscriptionReport({
        kind,
        vendorNumber: env.vendorNumber,
        date: day,
      });
      if (text === null) continue;
      const table = parseTable(text, {
        maxRows: analyticsLimits.maxRows,
        maxColumns: analyticsLimits.maxColumns,
      });
      const read =
        kind === 'subscription'
          ? mapAppleSubscriptionTable(table, options)
          : mapAppleSubscriptionEventTable(table, options);
      dayPoints.push(...read.points);
      reports++;
    }
    if (dayPoints.length === 0) continue;
    const capped = capProductPoints(dayPoints, stored);
    for (const p of capped.points)
      if (p.dimension?.type === 'product')
        stored.add(splitProductDimValue(p.dimension.value, false).productId);
    const result = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'apple_subscriptions',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      capped.points,
    );
    points += result.written;
    const r = range(capped.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

// ---------------------------------------------------------------------------------------------
// Google Play: vitals (Reporting API) and the monthly Cloud Storage reports

async function readPlayVitals(env: Env, newestDay: string | null): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  const port = ctx.connectors.playVitals({
    secret: env.secret,
    packageName: app.identifier,
    fetch: env.fetch,
  });
  const now = ctx.now();
  const to = addDays(dateToDay(now), -1);
  const from = newestDay
    ? addDays(newestDay, -analyticsWindows.vitalsOverlapDays)
    : addDays(dateToDay(now), -analyticsWindows.vitalsFirstDays);
  const result = await port.rates({ from: from < to ? from : to, to });
  // A first read that finds nothing says so, instead of an empty chart with no reason. Later reads may find nothing new.
  if (newestDay === null && result.rows === 0) throw new AnalyticsError('play_vitals_no_data');
  const written = await upsertPoints(
    ctx.db,
    {
      workspaceId,
      appId: app.id,
      platform: app.platform,
      source: 'play_vitals',
      processingDate: dateToDay(ctx.now()),
      origin: 'sync',
      now: ctx.now(),
    },
    result.points,
  );
  const r = range(result.points);
  return {
    kind: 'done',
    status: 'ok',
    points: written.written,
    reports: 1,
    dayFrom: r.from,
    dayTo: r.to,
  };
}

/** `YYYYMM` of the month of a day, and of the month before. */
const monthOf = (day: string): string => day.slice(0, 4) + day.slice(5, 7);
function monthsBack(now: number, count: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(monthOf(m.toISOString().slice(0, 10)));
  }
  return out.reverse();
}

async function readPlayReports(env: Env, firstRead: boolean): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.bucketId === null) return { kind: 'skip', setup: 'bucket_id_missing' };
  const port = ctx.connectors.playReports({
    secret: env.secret,
    packageName: app.identifier,
    bucketId: env.bucketId,
    fetch: env.fetch,
  });
  // The current month is read again every time (the file grows); a first read also takes earlier months.
  const months = monthsBack(ctx.now(), firstRead ? analyticsWindows.playFirstMonths : 2);
  let points = 0;
  let reports = 0;
  let found = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const month of months) {
    let result: Awaited<ReturnType<typeof port.readMonth>>;
    try {
      result = await port.readMonth(month);
    } catch (error) {
      // A month that has no file yet is expected for the current and sometimes the previous month.
      if (error instanceof AnalyticsError && error.code === 'reports_not_found') continue;
      throw error;
    }
    found += result.files.length;
    reports += result.files.length;
    const written = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'play_reports',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      result.points,
    );
    points += written.written;
    const r = range(result.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  if (found === 0) {
    // Reports are organised by package name in ONE bucket per Play account: a package that is nowhere in the bucket means the bucket
    // belongs to another account (or the app has no reports at all), which is a different next step from "no file for this month yet".
    if (port.hasPackage && !(await port.hasPackage()))
      throw new AnalyticsError('package_not_in_bucket');
    // The bucket is readable and holds this package's folder, but no file of the months asked for yet: nothing yet, not a failure
    // (a new app, or the first file of a month that Google writes a few days late).
    return { kind: 'done', status: 'ok', points: 0, reports: 0, dayFrom: null, dayTo: null };
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

/**
 * Google Play estimated sales (docs/adr/0038-sales-analytics.md): the monthly `sales/salesreport_YYYYMM.zip` of the SAME bucket as
 * the statistics, for this package only. The current month is read again every time (Google adds to it daily). A month without a
 * file is expected (a new month, an app that has never sold); a refused folder is `play_sales_forbidden`.
 */
async function readPlaySales(env: Env, firstRead: boolean): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.bucketId === null) return { kind: 'skip', setup: 'bucket_id_missing' };
  const port = ctx.connectors.playSales({
    secret: env.secret,
    packageName: app.identifier,
    bucketId: env.bucketId,
    fetch: env.fetch,
  });
  const months = monthsBack(ctx.now(), firstRead ? analyticsWindows.playFirstMonths : 2);
  const stored = await storedProductIds(ctx.db, {
    workspaceId,
    appId: app.id,
    platform: app.platform,
    source: 'play_sales',
  });
  let points = 0;
  let reports = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const month of months) {
    let result: Awaited<ReturnType<typeof port.readMonth>>;
    try {
      result = await port.readMonth(month);
    } catch (error) {
      if (error instanceof AnalyticsError && error.code === 'reports_not_found') continue;
      throw error;
    }
    reports++;
    const capped = capProductPoints(result.points, stored);
    for (const p of capped.points)
      if (p.dimension?.type === 'product')
        stored.add(splitProductDimValue(p.dimension.value, isMoneyMetric(p.metric)).productId);
    const written = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'play_sales',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      capped.points,
    );
    points += written.written;
    const r = range(capped.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

/**
 * Google Play Earnings (docs/adr/0042-earnings-and-subscription-metrics.md): the monthly `earnings/earnings_YYYYMM*.zip` of the SAME
 * bucket, for this package only, stored on the FIRST day of the month. A month with no file is "not available yet" (the report appears
 * about the 5th of the next month; the current month never has one): skipped, not an error. A refused folder is `play_sales_forbidden`.
 */
async function readPlayEarnings(env: Env, firstRead: boolean): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.bucketId === null) return { kind: 'skip', setup: 'bucket_id_missing' };
  const port = ctx.connectors.playEarnings({
    secret: env.secret,
    packageName: app.identifier,
    bucketId: env.bucketId,
    fetch: env.fetch,
  });
  const months = monthsBack(ctx.now(), firstRead ? analyticsWindows.earningsFirstMonths : 2);
  const stored = await storedProductIds(ctx.db, {
    workspaceId,
    appId: app.id,
    platform: app.platform,
    source: 'play_earnings',
  });
  let points = 0;
  let reports = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const month of months) {
    let result: Awaited<ReturnType<typeof port.readMonth>>;
    try {
      result = await port.readMonth(month);
    } catch (error) {
      if (error instanceof AnalyticsError && error.code === 'reports_not_found') continue;
      throw error;
    }
    reports++;
    const capped = capProductPoints(result.points, stored);
    for (const p of capped.points)
      if (p.dimension?.type === 'product')
        stored.add(splitProductDimValue(p.dimension.value, isMoneyMetric(p.metric)).productId);
    const written = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'play_earnings',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      capped.points,
    );
    points += written.written;
    const r = range(capped.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

/**
 * Google Play subscription statistics (docs/adr/0042-earnings-and-subscription-metrics.md): `financial-stats/subscriptions/` of the SAME
 * bucket, per product and month, summed per day. A month with no file is expected (an app with no subscription); a refused folder is
 * `play_sales_forbidden` (they also need View financial data).
 */
async function readPlaySubscriptions(env: Env, firstRead: boolean): Promise<Outcome> {
  const { ctx, app, workspaceId } = env;
  if (env.bucketId === null) return { kind: 'skip', setup: 'bucket_id_missing' };
  const port = ctx.connectors.playSubscriptions({
    secret: env.secret,
    packageName: app.identifier,
    bucketId: env.bucketId,
    fetch: env.fetch,
  });
  const months = monthsBack(ctx.now(), firstRead ? analyticsWindows.playFirstMonths : 2);
  const stored = await storedProductIds(ctx.db, {
    workspaceId,
    appId: app.id,
    platform: app.platform,
    source: 'play_subscriptions',
  });
  let points = 0;
  let reports = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const month of months) {
    let result: Awaited<ReturnType<typeof port.readMonth>>;
    try {
      result = await port.readMonth(month);
    } catch (error) {
      if (error instanceof AnalyticsError && error.code === 'reports_not_found') continue;
      throw error;
    }
    reports++;
    const capped = capProductPoints(result.points, stored);
    for (const p of capped.points)
      if (p.dimension?.type === 'product')
        stored.add(splitProductDimValue(p.dimension.value, false).productId);
    const written = await upsertPoints(
      ctx.db,
      {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source: 'play_subscriptions',
        processingDate: dateToDay(ctx.now()),
        origin: 'sync',
        now: ctx.now(),
      },
      capped.points,
    );
    points += written.written;
    const r = range(capped.points);
    if (r.from !== null && (from === null || r.from < from)) from = r.from;
    if (r.to !== null && (to === null || r.to > to)) to = r.to;
  }
  return { kind: 'done', status: 'ok', points, reports, dayFrom: from, dayTo: to };
}

const isMoneyMetric = (metric: string) =>
  moneyMetrics.indexOf(metric as (typeof moneyMetrics)[number]) >= 0;

// ---------------------------------------------------------------------------------------------
// The sync

/** Apps being read right now, in this process. */
const running = new Set<string>();
function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  return credentialLane(key, job);
}

export type AnalyticsSyncOptions = {
  /** Only these sources. Default: every source of the app's platform. */
  sources?: AnalyticsSource[];
  trigger: RunTrigger;
};

export type AnalyticsSyncOutcome =
  | { ok: true; sync: AnalyticsSyncResult }
  | (Failure & { transient: boolean });

/**
 * Syncs one app. Never throws: a failure is recorded on the source state and the run, and returned. A manual call needs the
 * workspace setting `analytics.enabled`, like the scheduler (`409 analytics_disabled`).
 */
export async function syncAnalytics(
  ctx: AnalyticsContext,
  input: { workspaceId: string; appId: string },
  actor: Actor,
  options: AnalyticsSyncOptions,
): Promise<AnalyticsSyncOutcome> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return { ...failure(404, 'not_found'), transient: false };
  const settings = (await getSettings(ctx.db, input.workspaceId)).values;
  if (settings['analytics.enabled'] !== true) {
    return {
      ...failure(
        409,
        'analytics_disabled',
        'Analytics is off for this workspace. An admin turns it on in the settings (analytics.enabled).',
        coded('analytics.off'),
      ),
      transient: false,
    };
  }
  if (running.has(app.id)) {
    return {
      ...failure(
        409,
        'sync_in_progress',
        'The analytics of this app are already being read.',
        coded('analytics.alreadyReading'),
      ),
      transient: false,
    };
  }
  running.add(app.id);
  const endActivity = syncActivity.begin(input.workspaceId, app.id, 'analytics', ctx.now());
  try {
    return await run(ctx, app, input.workspaceId, actor, options, settings);
  } catch {
    // Nothing may escape: a bug here must not stop the scheduler or the worker.
    return { ...failure(502, 'sync_failed', analyticsErrorMessages.sync_failed), transient: false };
  } finally {
    running.delete(app.id);
    endActivity();
  }
}

async function run(
  ctx: AnalyticsContext,
  app: ManagedApp,
  workspaceId: string,
  actor: Actor,
  options: AnalyticsSyncOptions,
  settings: Record<string, unknown>,
): Promise<AnalyticsSyncOutcome> {
  const wanted = sourcesForPlatform(app.platform).filter(
    (s) => !options.sources || options.sources.includes(s),
  );
  const startedBy = actor.type === 'user' || actor.type === 'token' ? actor.id : null;

  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: ANALYTICS_SYNC_QUEUE },
      actor,
      ctx.now(),
    );
  } catch {
    secret = undefined;
    return failAll(
      ctx,
      app,
      workspaceId,
      wanted,
      'credential_unreadable',
      actor,
      options.trigger,
      startedBy,
    );
  }
  if (secret === undefined)
    return failAll(
      ctx,
      app,
      workspaceId,
      wanted,
      'credential_not_found',
      actor,
      options.trigger,
      startedBy,
    );

  // The vendor number of the app's Apple team (its credential), else the workspace default.
  const vendorNumber = (await resolveAppleVendor(ctx.db, { workspaceId, app, settings }))
    .vendorNumber;
  // The app's own override, else its Play developer account's bucket, else the workspace setting.
  const bucketId = (await resolvePlayBucket(ctx.db, { workspaceId, app, settings })).bucketId;

  const results: SourceResult[] = [];
  const states = await ctx.db.query(
    'SELECT source, newest_day, last_ok_at FROM analytics_source_state WHERE app_id = ? AND platform = ?',
    [app.id, app.platform],
  );
  const stateOf = (source: AnalyticsSource) => states.find((r) => String(r.source) === source);

  const readSource = async (source: AnalyticsSource): Promise<void> => {
    const startedAt = ctx.now();
    const base = {
      workspaceId,
      appId: app.id,
      platform: app.platform,
      source,
      trigger: options.trigger,
      startedBy,
      startedAt,
    };
    const controller = new AbortController();
    const baseFetch = globalThis.fetch;
    const guarded: typeof fetch = (target, init) =>
      baseFetch(target, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal,
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SyncTimeout('timeout'));
      }, ctx.timeoutMs);
    });
    const env: Env = {
      ctx,
      app,
      workspaceId,
      actor,
      trigger: options.trigger,
      secret,
      fetch: guarded,
      vendorNumber,
      bucketId,
    };
    const newest = stateOf(source)?.newest_day;
    const newestDay = newest === null || newest === undefined ? null : String(newest);
    const firstRead =
      stateOf(source)?.last_ok_at === null || stateOf(source)?.last_ok_at === undefined;
    try {
      const work = serialized(app.credentialId, () =>
        source === 'apple_analytics'
          ? readAppleAnalytics(env)
          : source === 'apple_sales'
            ? readAppleSales(env, newestDay)
            : source === 'play_vitals'
              ? readPlayVitals(env, newestDay)
              : source === 'play_sales'
                ? readPlaySales(env, firstRead)
                : source === 'play_earnings'
                  ? readPlayEarnings(env, firstRead)
                  : source === 'play_subscriptions'
                    ? readPlaySubscriptions(env, firstRead)
                    : source === 'apple_subscriptions'
                      ? readAppleSubscriptions(env, newestDay)
                      : readPlayReports(env, firstRead),
      );
      work.catch(() => undefined);
      const outcome = await Promise.race([work, timedOut]);
      const at = ctx.now();
      if (outcome.kind === 'skip') {
        await saveSourceState(ctx.db, {
          workspaceId,
          appId: app.id,
          platform: app.platform,
          source,
          now: at,
          ok: true,
          attempted: false,
        });
        results.push({ source, status: 'skipped', setup: outcome.setup });
        return;
      }
      await recordRun(ctx.db, {
        ...base,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        pointsWritten: outcome.points,
        reportsRead: outcome.reports,
        dayFrom: outcome.dayFrom,
        dayTo: outcome.dayTo,
        finishedAt: at,
      });
      await saveSourceState(ctx.db, {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source,
        now: at,
        ok: outcome.status === 'ok',
        errorCode: outcome.errorCode ?? null,
        dayFrom: outcome.dayFrom,
        dayTo: outcome.dayTo,
      });
      results.push({
        source,
        status: outcome.status,
        points: outcome.points,
        reports: outcome.reports,
        dayFrom: outcome.dayFrom,
        dayTo: outcome.dayTo,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      });
    } catch (error) {
      const c = classifyAnalyticsError(error);
      const at = ctx.now();
      // Only the code is kept, never the text of the error.
      await recordRun(ctx.db, {
        ...base,
        status: 'failed',
        errorCode: c.code,
        finishedAt: at,
      }).catch(() => undefined);
      await saveSourceState(ctx.db, {
        workspaceId,
        appId: app.id,
        platform: app.platform,
        source,
        now: at,
        ok: false,
        errorCode: c.code,
      }).catch(() => undefined);
      results.push({ source, status: 'failed', errorCode: c.code, transient: c.transient });
    } finally {
      clearTimeout(timer);
    }
  };
  // The sources are independent feeds: each keeps its own run record and state, and one failing never stops another.
  await mapPool(wanted, pipelineSettings().analyticsSources, readSource);
  results.sort((a, b) => wanted.indexOf(a.source) - wanted.indexOf(b.source));
  return finalize(ctx, app, workspaceId, actor, options.trigger, results);
}

async function failAll(
  ctx: AnalyticsContext,
  app: ManagedApp,
  workspaceId: string,
  sources: AnalyticsSource[],
  code: AnalyticsErrorCode,
  actor: Actor,
  trigger: RunTrigger,
  startedBy: string | null,
): Promise<AnalyticsSyncOutcome> {
  const results: SourceResult[] = [];
  for (const source of sources) {
    const at = ctx.now();
    await recordRun(ctx.db, {
      workspaceId,
      appId: app.id,
      platform: app.platform,
      source,
      trigger,
      startedBy,
      status: 'failed',
      errorCode: code,
      startedAt: at,
      finishedAt: at,
    });
    await saveSourceState(ctx.db, {
      workspaceId,
      appId: app.id,
      platform: app.platform,
      source,
      now: at,
      ok: false,
      errorCode: code,
    });
    results.push({ source, status: 'failed', errorCode: code, transient: false });
  }
  return finalize(ctx, app, workspaceId, actor, trigger, results);
}

async function finalize(
  ctx: AnalyticsContext,
  app: ManagedApp,
  workspaceId: string,
  actor: Actor,
  trigger: RunTrigger,
  results: SourceResult[],
): Promise<AnalyticsSyncOutcome> {
  const at = ctx.now();
  const pointsWritten = results.reduce(
    (sum, r) => sum + (r.status === 'ok' || r.status === 'partial' ? r.points : 0),
    0,
  );
  const summary = results.map((r) => ({
    source: r.source,
    status: r.status,
    ...(r.status === 'ok' || r.status === 'partial' ? { points: r.points } : {}),
    ...(r.status === 'failed' ? { code: r.errorCode } : {}),
    ...(r.status === 'partial' && r.errorCode ? { code: r.errorCode } : {}),
    ...(r.status === 'skipped' ? { setup: r.setup } : {}),
  }));
  await ctx.db.transaction(async (tx) => {
    const [still] = await tx.query('SELECT id FROM apps WHERE id = ? AND workspace_id = ?', [
      app.id,
      workspaceId,
    ]);
    if (!still) return;
    // Ids, counts and fixed codes only: no report row, no URL, no store text.
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'analytics.sync',
      target: { type: 'app', id: app.id },
      detail: { trigger, sources: summary, pointsWritten },
      at,
    });
    if (pointsWritten > 0) {
      await emitEvent(tx, {
        workspaceId,
        type: 'analytics.synced',
        subject: { appId: app.id },
        payload: {
          appId: app.id,
          platform: app.platform,
          trigger,
          pointsWritten,
          sources: summary,
        },
        at,
      });
    }
  });
  return { ok: true, sync: { at, sources: results, pointsWritten } };
}

// ---------------------------------------------------------------------------------------------
// As a job

export type AnalyticsSyncPayload = {
  workspaceId: string;
  appId: string;
  requestedBy: string;
  /** Only these sources (a retry of the failed ones); absent: every source of the platform. */
  sources?: AnalyticsSource[];
};

export function enqueueAnalyticsSync(
  ctx: Pick<AnalyticsContext, 'db' | 'now'>,
  payload: AnalyticsSyncPayload,
  options: { runAt?: number } = {},
): Promise<string> {
  return enqueue(ctx.db, ANALYTICS_SYNC_QUEUE, payload, {
    now: ctx.now(),
    ...(options.runAt !== undefined ? { runAt: options.runAt } : {}),
  });
}

const isPayload = (value: unknown): value is AnalyticsSyncPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AnalyticsSyncPayload).workspaceId === 'string' &&
  typeof (value as AnalyticsSyncPayload).appId === 'string' &&
  typeof (value as AnalyticsSyncPayload).requestedBy === 'string';

/** The worker's handler for `analytics.sync`. A failure is recorded on the source state; this never throws. */
export function createAnalyticsSyncHandler(ctx: AnalyticsContext): JobHandler {
  return async (payload) => {
    if (!isPayload(payload)) return;
    await syncAnalytics(
      ctx,
      { workspaceId: payload.workspaceId, appId: payload.appId },
      { type: 'system', id: ANALYTICS_SYNC_QUEUE },
      {
        trigger: 'schedule',
        ...(Array.isArray(payload.sources) && payload.sources.length > 0
          ? { sources: payload.sources.filter((s): s is AnalyticsSource => isAnalyticsSource(s)) }
          : {}),
      },
    ).catch(() => undefined);
  };
}

export type { SyncRun };

/** Runs `job` with a `fetch` that is aborted after `ms`; a job that runs over is a `timeout`. */
export async function withDeadline<T>(
  ms: number,
  job: (fetch: typeof globalThis.fetch) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const baseFetch = globalThis.fetch;
  const guarded: typeof fetch = (target, init) =>
    baseFetch(target, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SyncTimeout('timeout'));
    }, ms);
  });
  try {
    const work = job(guarded);
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
