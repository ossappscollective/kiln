import { createHash } from 'node:crypto';
import {
  AnalyticsError,
  type AnalyticsPoint,
  appleReportLabels,
  columnIndex,
  mapAppleSalesTable,
  mapAppleTable,
  mapPlayConsoleFile,
  type ParseStats,
  readTable } from '@mrm/connectors';
import { type ActorType, analyticsErrorMessages, analyticsLimits, type AnalyticsSource, metricInfo, supports, toMicro } from '@mrm/core';
import type { Database } from '@mrm/db';
import {
  getAppConfig,
  listReportRequests,
  recordRun,
  saveSourceState,
  setAppleMode,
  upsertPoints } from './store.ts';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import { type Failure, failure } from '../../services/repositories.ts';

/**
 * Importing a report file by hand (docs/adr/0017-analytics-foundation.md): the way in for an app whose key may not create report
 * requests (`analytics_role_required`), and for history. For an Android app the file is a Play Console statistics CSV (installs,
 * ratings, store listing): the way in while no reports bucket is set up. The person downloads a report from App Store Connect (Analytics) or a Sales
 * and Trends summary and uploads it as the raw request body (.tsv, .csv, or the .gz as downloaded).
 *
 * - Strict: the size is capped (compressed and decompressed), the rows and columns are capped, the columns are matched BY NAME (the
 *   report name in the file name, else the header), never by position, and a file that is not one of the reports this server maps is
 *   refused with a code (`unknown_report`, `missing_columns`, `bad_gzip`, `bad_format`, `no_rows`, `file_too_large`).
 * - Two steps: `previewImport` parses and answers what would be stored (counts per metric, a few normalised rows, the days) and a
 *   `confirmHash` of the normalised data; `applyImport` needs the same hash for the same file. Nothing is stored by a preview.
 * - Idempotent: the same file twice stores nothing new. Imported numbers never replace numbers the API read (their processing date is
 *   unknown, so any API reading wins), and a corrected file replaces an earlier import.
 * - Needs `analytics.manage`. Works whether or not the workspace setting `analytics.enabled` is on: it contacts no store.
 */

type Actor = { type: ActorType; id: string };

export type ImportPlan = {
  source: AnalyticsSource;
  /** The Apple report this was read as, or `sales_summary`. */
  report: { kind: string; label: string };
  platform: string;
  stats: ParseStats;
  dateFrom: string | null;
  dateTo: string | null;
  days: number;
  points: number;
  metrics: { metric: string; label: string; days: number; total: number | null }[];
  /** A few normalised rows. Values the file held are never repeated except as the numbers they became. */
  sample: {
    date: string;
    metric: string;
    value: number;
    dimension?: { type: string; value: string };
  }[];
  notes: string[];
};

const hashOf = (
  appId: string,
  platform: string,
  source: string,
  points: AnalyticsPoint[],
): string => {
  const rows = points
    .map(
      (p) =>
        [
          p.date,
          p.metric,
          p.dimension?.type ?? '',
          p.dimension?.value ?? '',
          toMicro(p.value),
        ] as const,
    )
    .sort((a, b) => (a[0] + a[1] + a[2] + a[3] < b[0] + b[1] + b[2] + b[3] ? -1 : 1));
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, appId, platform, source, rows }))
    .digest('hex');
};

type Parsed =
  | { ok: true; plan: ImportPlan; points: AnalyticsPoint[]; confirmHash: string }
  | Failure;

/** Parses a file for an app. Pure with respect to storage: nothing is written. */
export async function parseImport(
  db: Database,
  input: { workspaceId: string; appId: string; bytes: Uint8Array; fileName?: string },
): Promise<Parsed> {
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const android = supports(app.platform, 'playReportsBucket');
  const platform = app.platform === 'macos' ? ('macos' as const) : ('ios' as const);
  const playLabels = {
    installs: 'Play Console installs',
    ratings: 'Play Console ratings',
    store_performance: 'Play Console store listing performance' } as const;
  try {
    const table = await readTable(input.bytes, {
      maxFileBytes: analyticsLimits.maxFileBytes,
      maxTextBytes: analyticsLimits.maxTextBytes,
      maxRows: analyticsLimits.maxRows });
    const cols = columnIndex(table.header);
    let source: AnalyticsSource;
    let kind: string;
    let label: string;
    let points: AnalyticsPoint[];
    let stats: ParseStats;
    let dateFrom: string | null;
    let dateTo: string | null;
    let notes: string[];
    if (android) {
      // A Play Console statistics CSV (Download reports > Statistics): the same columns as the monthly files of the reports bucket.
      const parsed = mapPlayConsoleFile(table, app.identifier);
      if (!parsed)
        return failure(
          422,
          'unknown_report',
          'This file is not a Play Console statistics report (installs, ratings or store listing). Download it from Play Console under Download reports, Statistics.',
        );
      source = 'play_reports';
      kind = parsed.report;
      label = playLabels[parsed.report];
      points = parsed.points;
      stats = parsed.stats;
      dateFrom = parsed.points.reduce<string | null>(
        (a, p) => (a === null || p.date < a ? p.date : a),
        null,
      );
      dateTo = parsed.points.reduce<string | null>(
        (a, p) => (a === null || p.date > a ? p.date : a),
        null,
      );
      notes = [
        'Imported numbers never replace numbers Google Cloud Storage delivered, and the same file twice stores nothing new.',
      ];
    } else if (cols.has('developer proceeds') && cols.has('apple identifier')) {
      if (!app.storeAppId)
        return failure(422, 'app_not_synced', analyticsErrorMessages.app_not_synced);
      const parsed = mapAppleSalesTable(table, { appleId: app.storeAppId, platform });
      source = 'apple_sales';
      kind = 'sales_summary';
      label = 'Sales and Trends summary';
      ({ points, stats, dateFrom, dateTo, notes } = parsed);
    } else {
      const parsed = mapAppleTable(table, {
        ...(input.fileName ? { reportName: input.fileName } : {}),
        platform });
      source = 'apple_analytics';
      kind = parsed.kind;
      label = appleReportLabels[parsed.kind];
      ({ points, stats, dateFrom, dateTo, notes } = parsed);
    }
    if (points.length === 0) return failure(422, 'no_rows', analyticsErrorMessages.no_rows);
    const perMetric = new Map<string, { days: Set<string>; total: number }>();
    for (const p of points) {
      if (p.dimension) continue;
      const m = perMetric.get(p.metric) ?? { days: new Set<string>(), total: 0 };
      m.days.add(p.date);
      m.total += p.value;
      perMetric.set(p.metric, m);
    }
    const dayCount = new Set(points.map((p) => p.date)).size;
    const plan: ImportPlan = {
      source,
      report: { kind, label },
      platform: app.platform,
      stats,
      dateFrom,
      dateTo,
      days: dayCount,
      points: points.length,
      metrics: [...perMetric.entries()].map(([metric, m]) => ({
        metric,
        label: (metricInfo as Record<string, { label: string }>)[metric]?.label ?? metric,
        days: m.days.size,
        total:
          metricInfo[metric as keyof typeof metricInfo]?.aggregation === 'mean' ? null : m.total })),
      sample: [...points]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.metric < b.metric ? -1 : 1))
        .slice(0, 10)
        .map((p) => ({
          date: p.date,
          metric: p.metric,
          value: p.value,
          ...(p.dimension
            ? { dimension: { type: p.dimension.type, value: p.dimension.value } }
            : {}) })),
      notes };
    return { ok: true, plan, points, confirmHash: hashOf(app.id, app.platform, source, points) };
  } catch (error) {
    if (error instanceof AnalyticsError) return failure(422, error.code, error.message);
    return failure(422, 'bad_format', analyticsErrorMessages.bad_format);
  }
}

export async function previewImport(
  db: Database,
  input: { workspaceId: string; appId: string; bytes: Uint8Array; fileName?: string },
): Promise<{ ok: true; plan: ImportPlan; confirmHash: string } | Failure> {
  const parsed = await parseImport(db, input);
  if (!parsed.ok) return parsed;
  return { ok: true, plan: parsed.plan, confirmHash: parsed.confirmHash };
}

export type ImportResult = {
  ok: true;
  source: AnalyticsSource;
  points: number;
  /** Rows inserted or changed. */
  written: number;
  /** Rows that already held this number, or a newer one from the API. */
  unchanged: number;
  dateFrom: string | null;
  dateTo: string | null;
};

export async function applyImport(
  db: Database,
  now: () => number,
  input: {
    workspaceId: string;
    appId: string;
    bytes: Uint8Array;
    fileName?: string;
    confirmHash: string;
  },
  actor: Actor,
): Promise<ImportResult | Failure> {
  const parsed = await parseImport(db, input);
  if (!parsed.ok) return parsed;
  if (parsed.confirmHash !== input.confirmHash) {
    return {
      ...failure(
        409,
        'confirm_mismatch',
        'The file is not the one that was previewed. Preview it again and confirm.',
      ),
      body: {
        error: 'confirm_mismatch',
        message: 'The file is not the one that was previewed. Preview it again and confirm.' } };
  }
  const app = await getApp(db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const startedAt = now();
  const startedBy = actor.type === 'user' || actor.type === 'token' ? actor.id : null;
  return db.transaction(async (tx): Promise<ImportResult | Failure> => {
    const written = await upsertPoints(
      tx,
      {
        workspaceId: input.workspaceId,
        appId: app.id,
        platform: app.platform,
        source: parsed.plan.source,
        processingDate: '',
        origin: 'import',
        now: startedAt },
      parsed.points,
    );
    const at = now();
    await recordRun(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      platform: app.platform,
      source: parsed.plan.source,
      trigger: 'import',
      startedBy,
      status: 'ok',
      pointsWritten: written.written,
      reportsRead: 1,
      dayFrom: parsed.plan.dateFrom,
      dayTo: parsed.plan.dateTo,
      startedAt,
      finishedAt: at });
    await saveSourceState(tx, {
      workspaceId: input.workspaceId,
      appId: app.id,
      platform: app.platform,
      source: parsed.plan.source,
      now: at,
      ok: true,
      dayFrom: parsed.plan.dateFrom,
      dayTo: parsed.plan.dateTo });
    // An app with no report request works from imported files.
    const config = await getAppConfig(tx, input.workspaceId, app.id);
    if (
      parsed.plan.source === 'apple_analytics' &&
      config.appleMode === 'off' &&
      (await listReportRequests(tx, input.workspaceId, app.id)).length === 0
    ) {
      await setAppleMode(tx, {
        workspaceId: input.workspaceId,
        appId: app.id,
        mode: 'import',
        by: actor.id,
        now: at });
    }
    await recordAudit(tx, {
      workspaceId: input.workspaceId,
      actor,
      action: 'analytics.import',
      target: { type: 'app', id: app.id },
      // Ids, the kind of report and counts: never a row, never the file name.
      detail: {
        source: parsed.plan.source,
        report: parsed.plan.report.kind,
        points: written.offered,
        written: written.written,
        dateFrom: parsed.plan.dateFrom,
        dateTo: parsed.plan.dateTo },
      at });
    if (written.written > 0) {
      await emitEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'analytics.synced',
        subject: { appId: app.id },
        payload: {
          appId: app.id,
          platform: app.platform,
          trigger: 'import',
          pointsWritten: written.written,
          sources: [{ source: parsed.plan.source, status: 'ok', points: written.written }] },
        at });
    }
    return {
      ok: true,
      source: parsed.plan.source,
      points: written.offered,
      written: written.written,
      unchanged: written.offered - written.written,
      dateFrom: parsed.plan.dateFrom,
      dateTo: parsed.plan.dateTo };
  });
}
