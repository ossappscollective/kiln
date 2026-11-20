import { randomUUID } from 'node:crypto';
import type { AnalyticsPoint } from '@mrm/connectors';
import {
  type AnalyticsDimension,
  type AnalyticsMetric,
  type AnalyticsSource,
  addDays,
  dateToDay,
  normalizeBucketId,
  type PlayBucketSource,
  toMicro,
} from '@mrm/core';
import type { Database, Param, Sql } from '@mrm/db';
import type { ManagedApp } from '../../services/apps.ts';

/**
 * Storage of analytics (docs/adr/0017-analytics-foundation.md): the normalised daily facts, the sync runs, the Apple report
 * requests and instances, the per-app switches and the last result per source. Only numbers, ids and fixed codes are stored here:
 * never a URL, a token, a report row or store text.
 */

export type DailyKey = { appId: string; platform: string; source: AnalyticsSource };

export type UpsertInput = DailyKey & {
  workspaceId: string;
  /** The day the store produced the numbers (YYYY-MM-DD), or '' when unknown (an imported file). A later one replaces an earlier one. */
  processingDate: string;
  origin: 'sync' | 'import';
  now: number;
};

export type UpsertResult = {
  /** Points offered, after joining duplicates. */
  offered: number;
  /** Rows inserted or changed. Reading the same data again gives 0 (idempotent). */
  written: number;
};

const CHUNK = 100;

const dimOf = (p: AnalyticsPoint) => ({
  type: p.dimension?.type ?? '',
  value: p.dimension?.value ?? '',
});

/**
 * Writes points by key (app, platform, source, metric, day, dimension). A row is replaced only by a point of a LATER processing
 * date (the store restated the day), or of the same date with another value (a corrected file); an older one never replaces a
 * newer one. So syncing and importing again changes nothing, and a late file cannot undo a newer number.
 */
export async function upsertPoints(
  sql: Sql,
  input: UpsertInput,
  points: AnalyticsPoint[],
): Promise<UpsertResult> {
  const unique = new Map<string, AnalyticsPoint>();
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    const d = dimOf(point);
    unique.set(`${point.metric}\u0000${point.date}\u0000${d.type}\u0000${d.value}`, point);
  }
  const list = [...unique.values()];
  let written = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const params: Param[] = [];
    for (const point of chunk) {
      const d = dimOf(point);
      params.push(
        input.appId,
        input.platform,
        input.source,
        point.metric,
        point.date,
        d.type,
        d.value,
        input.workspaceId,
        toMicro(point.value),
        input.processingDate,
        input.origin,
        input.now,
      );
    }
    written += await sql.execute(
      `INSERT INTO analytics_daily
         (app_id, platform, source, metric, day, dim_type, dim_value, workspace_id, value_micro, processing_date, origin, updated_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (app_id, platform, source, metric, day, dim_type, dim_value) DO UPDATE SET
         value_micro = excluded.value_micro, processing_date = excluded.processing_date, origin = excluded.origin,
         updated_at = excluded.updated_at
       WHERE excluded.processing_date > analytics_daily.processing_date
          OR (excluded.processing_date = analytics_daily.processing_date AND excluded.value_micro <> analytics_daily.value_micro)`,
      params,
    );
  }
  return { offered: list.length, written };
}

export type DailyRow = {
  metric: AnalyticsMetric;
  day: string;
  dimType: '' | AnalyticsDimension;
  dimValue: string;
  /** In units (the stored micro value divided back). */
  value: number;
  processingDate: string;
  origin: string;
};

/** The stored facts of an app in a range of days (inclusive), totals only unless `dimension` names one. */
export async function readDaily(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    platform: string;
    from: string;
    to: string;
    dimension?: AnalyticsDimension;
  },
): Promise<DailyRow[]> {
  const rows = await sql.query(
    `SELECT metric, day, dim_type, dim_value, value_micro, processing_date, origin
       FROM analytics_daily
      WHERE workspace_id = ? AND app_id = ? AND platform = ? AND day >= ? AND day <= ?
        AND dim_type = ?
      ORDER BY day, metric, dim_value`,
    [input.workspaceId, input.appId, input.platform, input.from, input.to, input.dimension ?? ''],
  );
  return rows.map((r) => ({
    metric: String(r.metric) as AnalyticsMetric,
    day: String(r.day),
    dimType: String(r.dim_type) as DailyRow['dimType'],
    dimValue: String(r.dim_value),
    value: Number(r.value_micro) / 1_000_000,
    processingDate: String(r.processing_date),
    origin: String(r.origin),
  }));
}

/** The first and last day stored for each source of an app, or none. */
export async function dayBounds(
  sql: Sql,
  input: { workspaceId: string; appId: string; platform: string },
): Promise<Map<AnalyticsSource, { first: string; last: string }>> {
  const rows = await sql.query(
    `SELECT source, MIN(day) AS first_day, MAX(day) AS last_day
       FROM analytics_daily WHERE workspace_id = ? AND app_id = ? AND platform = ? AND dim_type = '' GROUP BY source`,
    [input.workspaceId, input.appId, input.platform],
  );
  return new Map(
    rows.map((r) => [
      String(r.source) as AnalyticsSource,
      { first: String(r.first_day), last: String(r.last_day) },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Runs

export type RunTrigger = 'schedule' | 'manual' | 'enable' | 'import';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

export type SyncRun = {
  id: string;
  appId: string;
  platform: string;
  source: AnalyticsSource;
  trigger: RunTrigger;
  status: RunStatus;
  errorCode: string | null;
  pointsWritten: number;
  reportsRead: number;
  dayFrom: string | null;
  dayTo: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/** Records one finished run of one source. Counts and a fixed error code only. */
export async function recordRun(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    platform: string;
    source: AnalyticsSource;
    trigger: RunTrigger;
    startedBy: string | null;
    status: Exclude<RunStatus, 'running'>;
    errorCode?: string | null;
    pointsWritten?: number;
    reportsRead?: number;
    dayFrom?: string | null;
    dayTo?: string | null;
    startedAt: number;
    finishedAt: number;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO analytics_sync_runs
       (id, workspace_id, app_id, platform, source, trigger_kind, status, error_code, points_written, reports_read, day_from, day_to,
        started_by, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.appId,
      input.platform,
      input.source,
      input.trigger,
      input.status,
      input.errorCode ?? null,
      input.pointsWritten ?? 0,
      input.reportsRead ?? 0,
      input.dayFrom ?? null,
      input.dayTo ?? null,
      input.startedBy,
      input.startedAt,
      input.finishedAt,
    ],
  );
  return id;
}

const toRun = (r: Record<string, unknown>): SyncRun => ({
  id: String(r.id),
  appId: String(r.app_id),
  platform: String(r.platform),
  source: String(r.source) as AnalyticsSource,
  trigger: String(r.trigger_kind) as RunTrigger,
  status: String(r.status) as RunStatus,
  errorCode: r.error_code === null || r.error_code === undefined ? null : String(r.error_code),
  pointsWritten: Number(r.points_written),
  reportsRead: Number(r.reports_read),
  dayFrom: r.day_from === null || r.day_from === undefined ? null : String(r.day_from),
  dayTo: r.day_to === null || r.day_to === undefined ? null : String(r.day_to),
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
});

export async function recentRuns(
  sql: Sql,
  workspaceId: string,
  appId: string,
  limit = 10,
): Promise<SyncRun[]> {
  const rows = await sql.query(
    `SELECT id, app_id, platform, source, trigger_kind, status, error_code, points_written, reports_read, day_from, day_to,
            started_at, finished_at
       FROM analytics_sync_runs WHERE workspace_id = ? AND app_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  return rows.map(toRun);
}

// ---------------------------------------------------------------------------------------------
// Source state

export type SourceState = {
  source: AnalyticsSource;
  setupCode: string | null;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastErrorCode: string | null;
  oldestDay: string | null;
  newestDay: string | null;
};

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export async function getSourceStates(
  sql: Sql,
  workspaceId: string,
  appId: string,
  platform: string,
): Promise<Map<AnalyticsSource, SourceState>> {
  const rows = await sql.query(
    `SELECT source, setup_code, last_attempt_at, last_ok_at, last_error_code, oldest_day, newest_day
       FROM analytics_source_state WHERE workspace_id = ? AND app_id = ? AND platform = ?`,
    [workspaceId, appId, platform],
  );
  return new Map(
    rows.map((r) => [
      String(r.source) as AnalyticsSource,
      {
        source: String(r.source) as AnalyticsSource,
        setupCode: s(r.setup_code),
        lastAttemptAt: n(r.last_attempt_at),
        lastOkAt: n(r.last_ok_at),
        lastErrorCode: s(r.last_error_code),
        oldestDay: s(r.oldest_day),
        newestDay: s(r.newest_day),
      },
    ]),
  );
}

/**
 * Records the outcome of an attempt. `ok` keeps the previous error out and moves `last_ok_at`; a failure keeps the previous
 * `last_ok_at` and the days. The covered days only ever widen.
 */
export async function saveSourceState(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    platform: string;
    source: AnalyticsSource;
    now: number;
    ok: boolean;
    errorCode?: string | null;
    setupCode?: string | null;
    dayFrom?: string | null;
    dayTo?: string | null;
    /** Records a setup need without an attempt (nothing was asked of the store). */
    attempted?: boolean;
  },
): Promise<void> {
  const attempted = input.attempted ?? true;
  await sql.execute(
    `INSERT INTO analytics_source_state
       (app_id, platform, source, workspace_id, setup_code, last_attempt_at, last_ok_at, last_error_code, oldest_day, newest_day, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, platform, source) DO UPDATE SET
       setup_code = excluded.setup_code,
       last_attempt_at = COALESCE(excluded.last_attempt_at, analytics_source_state.last_attempt_at),
       last_ok_at = COALESCE(excluded.last_ok_at, analytics_source_state.last_ok_at),
       last_error_code = CASE WHEN excluded.last_attempt_at IS NULL THEN analytics_source_state.last_error_code ELSE excluded.last_error_code END,
       oldest_day = CASE WHEN excluded.oldest_day IS NULL THEN analytics_source_state.oldest_day
                         WHEN analytics_source_state.oldest_day IS NULL OR excluded.oldest_day < analytics_source_state.oldest_day THEN excluded.oldest_day
                         ELSE analytics_source_state.oldest_day END,
       newest_day = CASE WHEN excluded.newest_day IS NULL THEN analytics_source_state.newest_day
                         WHEN analytics_source_state.newest_day IS NULL OR excluded.newest_day > analytics_source_state.newest_day THEN excluded.newest_day
                         ELSE analytics_source_state.newest_day END,
       updated_at = excluded.updated_at`,
    [
      input.appId,
      input.platform,
      input.source,
      input.workspaceId,
      input.setupCode ?? null,
      attempted ? input.now : null,
      attempted && input.ok ? input.now : null,
      attempted && !input.ok ? (input.errorCode ?? 'sync_failed') : null,
      input.dayFrom ?? null,
      input.dayTo ?? null,
      input.now,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Per-app switches

export type AppleMode = 'off' | 'ongoing' | 'import';
export type AppAnalyticsConfig = { appleMode: AppleMode; playBucketId: string | null };

export async function getAppConfig(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<AppAnalyticsConfig> {
  const [row] = await sql.query(
    'SELECT apple_mode, play_bucket_id FROM analytics_app_config WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  return {
    appleMode: (row ? String(row.apple_mode) : 'off') as AppleMode,
    playBucketId: row ? s(row.play_bucket_id) : null,
  };
}

export async function setAppleMode(
  sql: Sql,
  input: { workspaceId: string; appId: string; mode: AppleMode; by: string; now: number },
): Promise<void> {
  await sql.execute(
    `INSERT INTO analytics_app_config (app_id, workspace_id, apple_mode, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET apple_mode = excluded.apple_mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [input.appId, input.workspaceId, input.mode, input.by, input.now],
  );
}

// ---------------------------------------------------------------------------------------------
// The Google Play reports bucket (see analytics-bucket.ts)

const clean = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : (normalizeBucketId(text) ?? null);
};

export async function getAccountBucket(
  sql: Sql,
  workspaceId: string,
  credentialId: string,
): Promise<string | null> {
  const [row] = await sql.query(
    'SELECT play_bucket_id FROM analytics_credential_config WHERE credential_id = ? AND workspace_id = ?',
    [credentialId, workspaceId],
  );
  return row ? clean(row.play_bucket_id) : null;
}

/** The bucket an Android app reads: its own override, else its developer account's, else the workspace setting. */
export async function resolvePlayBucket(
  sql: Sql,
  input: {
    workspaceId: string;
    app: Pick<ManagedApp, 'id' | 'credentialId'>;
    settings: Record<string, unknown>;
  },
): Promise<{
  bucketId: string | null;
  source: PlayBucketSource | null;
  app: string | null;
  account: string | null;
  workspace: string | null;
  inherited: { bucketId: string | null; source: PlayBucketSource | null };
}> {
  const app = clean((await getAppConfig(sql, input.workspaceId, input.app.id)).playBucketId);
  const account = await getAccountBucket(sql, input.workspaceId, input.app.credentialId);
  const workspace = clean(input.settings['analytics.playBucketId']);
  const [bucketId, source] = app
    ? [app, 'app' as const]
    : account
      ? [account, 'account' as const]
      : workspace
        ? [workspace, 'workspace' as const]
        : [null, null];
  // What the app would read without its own override: the Play credential's bucket, else the workspace default.
  const inherited = account
    ? { bucketId: account, source: 'account' as const }
    : workspace
      ? { bucketId: workspace, source: 'workspace' as const }
      : { bucketId: null, source: null };
  return { bucketId, source, app, account, workspace, inherited };
}

// ---------------------------------------------------------------------------------------------
// Apple report requests and instances

export type StoredRequest = {
  id: string;
  appleRequestId: string;
  accessType: 'ONGOING' | 'ONE_TIME_SNAPSHOT';
  status: 'active' | 'stopped' | 'missing';
  createdAt: number;
  lastCheckedAt: number | null;
  lastErrorCode: string | null;
};

const toRequest = (r: Record<string, unknown>): StoredRequest => ({
  id: String(r.id),
  appleRequestId: String(r.apple_request_id),
  accessType: String(r.access_type) as StoredRequest['accessType'],
  status: String(r.status) as StoredRequest['status'],
  createdAt: Number(r.created_at),
  lastCheckedAt: n(r.last_checked_at),
  lastErrorCode: s(r.last_error_code),
});

export async function listReportRequests(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<StoredRequest[]> {
  const rows = await sql.query(
    `SELECT id, apple_request_id, access_type, status, created_at, last_checked_at, last_error_code
       FROM analytics_report_requests WHERE workspace_id = ? AND app_id = ? ORDER BY created_at, id`,
    [workspaceId, appId],
  );
  return rows.map(toRequest);
}

export async function saveReportRequest(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    appleRequestId: string;
    accessType: StoredRequest['accessType'];
    createdBy: string;
    now: number;
  },
): Promise<string> {
  const id = randomUUID();
  await sql.execute(
    `INSERT INTO analytics_report_requests (id, workspace_id, app_id, apple_request_id, access_type, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (app_id, access_type) DO UPDATE SET
       apple_request_id = excluded.apple_request_id, status = 'active', last_error_code = NULL`,
    [
      id,
      input.workspaceId,
      input.appId,
      input.appleRequestId,
      input.accessType,
      input.createdBy,
      input.now,
    ],
  );
  return id;
}

export async function markReportRequest(
  sql: Sql,
  id: string,
  input: { status: StoredRequest['status']; errorCode?: string | null; now: number },
): Promise<void> {
  await sql.execute(
    'UPDATE analytics_report_requests SET status = ?, last_checked_at = ?, last_error_code = ? WHERE id = ?',
    [input.status, input.now, input.errorCode ?? null, id],
  );
}

/** Instances that need no second look: read (even with no point) or failed for a reason that will not go away. */
export async function settledInstances(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<Set<string>> {
  const rows = await sql.query(
    `SELECT apple_instance_id, status, error_code FROM analytics_instances WHERE workspace_id = ? AND app_id = ?`,
    [workspaceId, appId],
  );
  const retry = new Set([
    'segment_expired',
    'rate_limited',
    'store_unavailable',
    'timeout',
    'store_auth',
    'store_forbidden',
    'sync_failed',
  ]);
  const settled = new Set<string>();
  for (const r of rows) {
    if (String(r.status) === 'read') settled.add(String(r.apple_instance_id));
    else if (!retry.has(String(r.error_code))) settled.add(String(r.apple_instance_id));
  }
  return settled;
}

export async function saveInstance(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    appleInstanceId: string;
    appleReportId: string;
    reportKind: string;
    processingDate: string;
    status: 'read' | 'failed';
    errorCode?: string | null;
    segments?: number;
    points?: number;
    now: number;
  },
): Promise<void> {
  await sql.execute(
    `INSERT INTO analytics_instances
       (app_id, apple_instance_id, workspace_id, apple_report_id, report_kind, processing_date, status, error_code, segments, points, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, apple_instance_id) DO UPDATE SET
       status = excluded.status, error_code = excluded.error_code, segments = excluded.segments, points = excluded.points,
       read_at = excluded.read_at`,
    [
      input.appId,
      input.appleInstanceId,
      input.workspaceId,
      input.appleReportId,
      input.reportKind,
      input.processingDate,
      input.status,
      input.errorCode ?? null,
      input.segments ?? 0,
      input.points ?? 0,
      input.now,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Removal and upkeep

const TABLES = [
  'analytics_daily',
  'analytics_sync_runs',
  'analytics_report_requests',
  'analytics_instances',
  'analytics_app_config',
  'analytics_source_state',
  // Google Play search terms (migration 32): imported from a file, deleted with the app like the rest of analytics.
  'play_search_terms',
  'play_search_term_imports',
] as const;

/** Everything analytics holds for an app (used when the app is deleted). */
export async function deleteAnalyticsData(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<void> {
  for (const table of TABLES) {
    await sql.execute(`DELETE FROM ${table} WHERE app_id = ? AND workspace_id = ?`, [
      appId,
      workspaceId,
    ]);
  }
}

export const ANALYTICS_RUN_RETENTION_DAYS = 90;
export const ANALYTICS_INSTANCE_RETENTION_DAYS = 120;
const DAY_MS = 86_400_000;

export type AnalyticsUpkeepSummary = { runs: number; instances: number; orphans: number };

/**
 * Upkeep: old run rows (counts only) and instance bookkeeping go; rows of apps that no longer exist go too. The DAILY FACTS are
 * kept: they are small, and Apple deletes its instances after 35 days, so they are the only copy.
 */
export async function analyticsUpkeep(
  db: Database,
  options: { now: number },
): Promise<AnalyticsUpkeepSummary> {
  const runs = await db.execute('DELETE FROM analytics_sync_runs WHERE started_at < ?', [
    options.now - ANALYTICS_RUN_RETENTION_DAYS * DAY_MS,
  ]);
  const instances = await db.execute('DELETE FROM analytics_instances WHERE read_at < ?', [
    options.now - ANALYTICS_INSTANCE_RETENTION_DAYS * DAY_MS,
  ]);
  let orphans = 0;
  for (const table of TABLES) {
    orphans += await db.execute(`DELETE FROM ${table} WHERE app_id NOT IN (SELECT id FROM apps)`);
  }
  return { runs, instances, orphans };
}

/** The UTC day of a clock reading, and the day `n` days before it. */
export const today = (now: number): string => dateToDay(now);
export const daysAgo = (now: number, n: number): string => addDays(dateToDay(now), -n);
