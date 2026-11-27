import { createHash, randomUUID } from 'node:crypto';
import { crashSignature, type StoreBetaFeedback } from '@kiln/connectors';
import { TESTFLIGHT_NOTE_MAX_CHARS as MAX_NOTE_CHARS } from '@kiln/core';
import type { Sql } from '@kiln/db';

export { MAX_NOTE_CHARS };

/**
 * The stored copy of an app's TestFlight feedback and crashes (migration 54) and its triage: what the syncs read, how the last sync went, and
 * the views the routes answer with. Nothing here talks to Apple. A sync only ever ADDS or refreshes rows (Apple gives no deletion signal and
 * keeps feedback for a limited time, so Kiln keeps what it has read until its own retention); the triage fields are never overwritten by a sync.
 */

export const TRIAGE_STATUSES = ['new', 'seen', 'in_progress', 'resolved', 'ignored'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
export const isTriageStatus = (v: unknown): v is TriageStatus =>
  typeof v === 'string' && (TRIAGE_STATUSES as readonly string[]).includes(v);

/** The largest crash log kept, in characters. A bigger log is cut and says so (`crashLogTruncated`). */
export const MAX_CRASH_LOG_CHARS = 64 * 1024;

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * A stable pseudonym of a tester: the first six hex digits of a hash of the workspace and the lowercased email. It lets a person filter and
 * group by tester without being shown the email, and it is not reversible by anyone who does not already have the email. Null without an email.
 */
export function testerKey(workspaceId: string, email: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  if (e === '') return null;
  return createHash('sha256')
    .update(`${workspaceId}\u0000${e}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
}

export type FeedbackKind = 'feedback' | 'crash';

export type FeedbackItem = {
  id: string;
  kind: FeedbackKind;
  createdAt: number;
  buildNumber: string | null;
  version: string | null;
  platform: string | null;
  bundleId: string | null;
  /** The pseudonym ("3FA9C1"), or null for an anonymous (public link) tester. */
  tester: string | null;
  /** The email: set only for a person who may see it (administrators), null otherwise. */
  testerEmail: string | null;
  deviceModel: string | null;
  deviceFamily: string | null;
  osVersion: string | null;
  locale: string | null;
  timeZone: string | null;
  architecture: string | null;
  connectionType: string | null;
  pairedWatch: string | null;
  appUptimeMs: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  batteryPercent: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  comment: string;
  screenshots: { width: number | null; height: number | null }[];
  crashLogState: 'none' | 'stored' | 'missing';
  crashLogTruncated: boolean;
  signature: string | null;
  symbolicated: boolean | null;
  status: TriageStatus;
  assigneeUserId: string | null;
  internalNote: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  firstSeenAt: number;
};

export type FeedbackListItem = Omit<FeedbackItem, 'comment' | 'internalNote' | 'screenshots'> & {
  /** The start of the comment (300 characters at most). */
  comment: string;
  commentTruncated: boolean;
  screenshotCount: number;
  hasNote: boolean;
};

const LIST_COLUMNS = `id, kind, created_at, build_number, version, platform, bundle_id, tester_key, tester_email, device_model, device_family,
  os_version, locale, time_zone, architecture, connection_type, paired_watch, app_uptime_ms, disk_free_bytes, disk_total_bytes, battery_percent,
  screen_width, screen_height, comment, screenshots_json, crash_log_state, crash_log_truncated, signature, symbolicated, status,
  assignee_user_id, internal_note, status_changed_at, status_changed_by, first_seen_at`;

function parseSizes(value: unknown): FeedbackItem['screenshots'] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => {
      const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return {
        width: typeof r.width === 'number' ? r.width : null,
        height: typeof r.height === 'number' ? r.height : null,
      };
    });
  } catch {
    return [];
  }
}

const logState = (v: unknown): FeedbackItem['crashLogState'] =>
  v === 'stored' || v === 'missing' ? v : 'none';

function toItem(r: Record<string, unknown>, mayViewEmail: boolean): FeedbackItem {
  const status = String(r.status);
  return {
    id: String(r.id),
    kind: r.kind === 'crash' ? 'crash' : 'feedback',
    createdAt: Number(r.created_at),
    buildNumber: text(r.build_number),
    version: text(r.version),
    platform: text(r.platform),
    bundleId: text(r.bundle_id),
    tester: text(r.tester_key),
    testerEmail: mayViewEmail ? text(r.tester_email) : null,
    deviceModel: text(r.device_model),
    deviceFamily: text(r.device_family),
    osVersion: text(r.os_version),
    locale: text(r.locale),
    timeZone: text(r.time_zone),
    architecture: text(r.architecture),
    connectionType: text(r.connection_type),
    pairedWatch: text(r.paired_watch),
    appUptimeMs: num(r.app_uptime_ms),
    diskFreeBytes: num(r.disk_free_bytes),
    diskTotalBytes: num(r.disk_total_bytes),
    batteryPercent: num(r.battery_percent),
    screenWidth: num(r.screen_width),
    screenHeight: num(r.screen_height),
    comment: String(r.comment ?? ''),
    screenshots: parseSizes(r.screenshots_json),
    crashLogState: logState(r.crash_log_state),
    crashLogTruncated: Number(r.crash_log_truncated) === 1,
    signature: text(r.signature),
    symbolicated:
      r.symbolicated === null || r.symbolicated === undefined ? null : Number(r.symbolicated) === 1,
    status: isTriageStatus(status) ? status : 'new',
    assigneeUserId: text(r.assignee_user_id),
    internalNote: text(r.internal_note),
    statusChangedAt: num(r.status_changed_at),
    statusChangedBy: text(r.status_changed_by),
    firstSeenAt: Number(r.first_seen_at),
  };
}

const LIST_COMMENT_CHARS = 300;
function toListItem(r: Record<string, unknown>, mayViewEmail: boolean): FeedbackListItem {
  const { comment, internalNote, screenshots, ...rest } = toItem(r, mayViewEmail);
  return {
    ...rest,
    comment: comment.slice(0, LIST_COMMENT_CHARS),
    commentTruncated: comment.length > LIST_COMMENT_CHARS,
    screenshotCount: screenshots.length,
    hasNote: (internalNote ?? '') !== '',
  };
}

export type ListFilter = {
  kind: FeedbackKind;
  build?: string | undefined;
  version?: string | undefined;
  statuses?: TriageStatus[] | undefined;
  tester?: string | undefined;
  signature?: string | undefined;
  /** Keyset cursor: items strictly older than (createdAt, id). */
  before?: { createdAt: number; id: string } | undefined;
  limit: number;
};

export type BuildFacet = {
  buildNumber: string | null;
  version: string | null;
  feedback: number;
  crashes: number;
  lastAt: number;
};

export type Counts = {
  feedback: number;
  crashes: number;
  /** The open ones (status new, seen or in progress) of each kind. */
  openFeedback: number;
  openCrashes: number;
  byStatus: Record<TriageStatus, number>;
};

export async function listFeedback(
  sql: Sql,
  input: { workspaceId: string; appId: string; filter: ListFilter; mayViewEmail: boolean },
): Promise<{ items: FeedbackListItem[]; next: { createdAt: number; id: string } | null }> {
  const f = input.filter;
  const where = ['workspace_id = ?', 'app_id = ?', 'kind = ?'];
  const params: (string | number)[] = [input.workspaceId, input.appId, f.kind];
  if (f.build !== undefined) {
    where.push('build_number = ?');
    params.push(f.build);
  }
  if (f.version !== undefined) {
    where.push('version = ?');
    params.push(f.version);
  }
  if (f.statuses && f.statuses.length > 0) {
    where.push(`status IN (${f.statuses.map(() => '?').join(', ')})`);
    params.push(...f.statuses);
  }
  if (f.tester !== undefined) {
    where.push('tester_key = ?');
    params.push(f.tester);
  }
  if (f.signature !== undefined) {
    where.push('signature = ?');
    params.push(f.signature);
  }
  if (f.before) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(f.before.createdAt, f.before.createdAt, f.before.id);
  }
  const rows = await sql.query(
    `SELECT ${LIST_COLUMNS} FROM testflight_feedback WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  const items = page.map((r) => toListItem(r, input.mayViewEmail));
  const last = items.length === f.limit && rows.length > f.limit ? items.at(-1) : undefined;
  return { items, next: last ? { createdAt: last.createdAt, id: last.id } : null };
}

export async function getFeedback(
  sql: Sql,
  input: { workspaceId: string; appId: string; id: string; mayViewEmail: boolean },
): Promise<(FeedbackItem & { crashLog: string | null }) | undefined> {
  const [row] = await sql.query(
    `SELECT ${LIST_COLUMNS}, crash_log FROM testflight_feedback WHERE id = ? AND app_id = ? AND workspace_id = ?`,
    [input.id, input.appId, input.workspaceId],
  );
  if (!row) return undefined;
  return { ...toItem(row, input.mayViewEmail), crashLog: text(row.crash_log) };
}

/** Apple's id of a stored submission (for the on-demand screenshot read), with its kind and the number of screenshots. */
export async function appleRefOf(
  sql: Sql,
  input: { workspaceId: string; appId: string; id: string },
): Promise<{ appleId: string; kind: FeedbackKind; screenshots: number } | undefined> {
  const [row] = await sql.query(
    'SELECT apple_id, kind, screenshots_json FROM testflight_feedback WHERE id = ? AND app_id = ? AND workspace_id = ?',
    [input.id, input.appId, input.workspaceId],
  );
  if (!row) return undefined;
  return {
    appleId: String(row.apple_id),
    kind: row.kind === 'crash' ? 'crash' : 'feedback',
    screenshots: parseSizes(row.screenshots_json).length,
  };
}

export async function readCounts(sql: Sql, workspaceId: string, appId: string): Promise<Counts> {
  const rows = await sql.query(
    'SELECT kind, status, COUNT(*) AS n FROM testflight_feedback WHERE workspace_id = ? AND app_id = ? GROUP BY kind, status',
    [workspaceId, appId],
  );
  const counts: Counts = {
    feedback: 0,
    crashes: 0,
    openFeedback: 0,
    openCrashes: 0,
    byStatus: { new: 0, seen: 0, in_progress: 0, resolved: 0, ignored: 0 },
  };
  for (const r of rows) {
    const n = Number(r.n);
    const crash = r.kind === 'crash';
    const status = String(r.status);
    const open = status === 'new' || status === 'seen' || status === 'in_progress';
    if (crash) {
      counts.crashes += n;
      if (open) counts.openCrashes += n;
    } else {
      counts.feedback += n;
      if (open) counts.openFeedback += n;
    }
    if (isTriageStatus(status)) counts.byStatus[status] += n;
  }
  return counts;
}

/** The builds an app has feedback for, newest first, with the count of each kind. At most `limit`. */
export async function readBuilds(
  sql: Sql,
  workspaceId: string,
  appId: string,
  limit = 50,
): Promise<BuildFacet[]> {
  const rows = await sql.query(
    `SELECT build_number, version,
            SUM(CASE WHEN kind = 'feedback' THEN 1 ELSE 0 END) AS feedback,
            SUM(CASE WHEN kind = 'crash' THEN 1 ELSE 0 END) AS crashes,
            MAX(created_at) AS last_at
       FROM testflight_feedback WHERE workspace_id = ? AND app_id = ?
      GROUP BY build_number, version ORDER BY MAX(created_at) DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  return rows.map((r) => ({
    buildNumber: text(r.build_number),
    version: text(r.version),
    feedback: Number(r.feedback),
    crashes: Number(r.crashes),
    lastAt: Number(r.last_at),
  }));
}

export type CrashGroups = {
  byBuild: { buildNumber: string | null; version: string | null; count: number; lastAt: number }[];
  bySignature: {
    signature: string | null;
    count: number;
    builds: (string | null)[];
    symbolicated: boolean | null;
    lastAt: number;
    open: number;
  }[];
};

/** Crashes grouped by build and by signature (documented rule in connectors/testflight-crash.ts). A crash with no signature is one group (null). */
export async function readCrashGroups(
  sql: Sql,
  workspaceId: string,
  appId: string,
  limit = 50,
): Promise<CrashGroups> {
  const byBuild = await sql.query(
    `SELECT build_number, version, COUNT(*) AS n, MAX(created_at) AS last_at FROM testflight_feedback
      WHERE workspace_id = ? AND app_id = ? AND kind = 'crash' GROUP BY build_number, version ORDER BY MAX(created_at) DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  const bySig = await sql.query(
    `SELECT signature, COUNT(*) AS n, MAX(created_at) AS last_at, MIN(symbolicated) AS sym,
            SUM(CASE WHEN status IN ('new', 'seen', 'in_progress') THEN 1 ELSE 0 END) AS open
       FROM testflight_feedback WHERE workspace_id = ? AND app_id = ? AND kind = 'crash'
      GROUP BY signature ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  const groups: CrashGroups['bySignature'] = [];
  for (const r of bySig) {
    const signature = text(r.signature);
    const builds = await sql.query(
      `SELECT DISTINCT build_number FROM testflight_feedback WHERE workspace_id = ? AND app_id = ? AND kind = 'crash' AND ${
        signature === null ? 'signature IS NULL' : 'signature = ?'
      } ORDER BY build_number LIMIT 6`,
      signature === null ? [workspaceId, appId] : [workspaceId, appId, signature],
    );
    groups.push({
      signature,
      count: Number(r.n),
      builds: builds.map((b) => text(b.build_number)),
      symbolicated: r.sym === null || r.sym === undefined ? null : Number(r.sym) === 1,
      lastAt: Number(r.last_at),
      open: Number(r.open),
    });
  }
  return {
    byBuild: byBuild.map((r) => ({
      buildNumber: text(r.build_number),
      version: text(r.version),
      count: Number(r.n),
      lastAt: Number(r.last_at),
    })),
    bySignature: groups,
  };
}

// ---------------------------------------------------------------------------------------------
// Sync

export type SyncStatus = {
  lastAttemptAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  failures: number;
  complete: boolean;
  warnings: string[];
};

export async function readSyncStatus(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<SyncStatus | null> {
  const [row] = await sql.query(
    `SELECT last_attempt_at, last_synced_at, last_error, failures, complete, warnings_json
       FROM testflight_sync WHERE app_id = ? AND workspace_id = ?`,
    [appId, workspaceId],
  );
  if (!row) return null;
  let warnings: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.warnings_json ?? '[]'));
    if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === 'string');
  } catch {
    warnings = [];
  }
  return {
    lastAttemptAt: num(row.last_attempt_at),
    lastSyncedAt: num(row.last_synced_at),
    lastError: text(row.last_error),
    failures: Number(row.failures ?? 0),
    complete: Number(row.complete ?? 1) === 1,
    warnings,
  };
}

/** A failed sync keeps what was stored and says what went wrong. */
export async function recordSyncFailure(
  sql: Sql,
  input: { workspaceId: string; appId: string; message: string; at: number },
): Promise<void> {
  await sql.execute(
    `INSERT INTO testflight_sync (app_id, workspace_id, last_attempt_at, last_error, failures)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       failures = testflight_sync.failures + 1`,
    [input.appId, input.workspaceId, input.at, input.message.slice(0, 500)],
  );
}

export async function hasSynced(sql: Sql, workspaceId: string, appId: string): Promise<boolean> {
  const [row] = await sql.query(
    'SELECT last_synced_at FROM testflight_sync WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  return row !== undefined && row.last_synced_at !== null && row.last_synced_at !== undefined;
}

/** Of Apple's ids, the ones already stored (a map to the stored row id and whether a crash log is still to read). */
export async function existingIds(
  sql: Sql,
  workspaceId: string,
  appId: string,
  appleIds: readonly string[],
): Promise<Map<string, { id: string; crashLogState: string }>> {
  const out = new Map<string, { id: string; crashLogState: string }>();
  for (let at = 0; at < appleIds.length; at += 400) {
    const chunk = appleIds.slice(at, at + 400);
    const rows = await sql.query(
      `SELECT id, apple_id, crash_log_state FROM testflight_feedback WHERE workspace_id = ? AND app_id = ? AND apple_id IN (${chunk.map(() => '?').join(', ')})`,
      [workspaceId, appId, ...chunk],
    );
    for (const r of rows)
      out.set(String(r.apple_id), { id: String(r.id), crashLogState: String(r.crash_log_state) });
  }
  return out;
}

/** Stored crashes whose log was never read (the cap of an earlier sync), newest first, as Apple ids. */
export async function crashesWithoutLog(
  sql: Sql,
  workspaceId: string,
  appId: string,
  limit: number,
): Promise<string[]> {
  const rows = await sql.query(
    `SELECT apple_id FROM testflight_feedback WHERE workspace_id = ? AND app_id = ? AND kind = 'crash' AND crash_log_state = 'none'
      ORDER BY created_at DESC LIMIT ?`,
    [workspaceId, appId, limit],
  );
  return rows.map((r) => String(r.apple_id));
}

export type CrashLogRead = { text: string | null };

/** The log as it is kept: cut at the size limit. */
export function capCrashLog(logText: string): { text: string; truncated: boolean } {
  return logText.length > MAX_CRASH_LOG_CHARS
    ? { text: logText.slice(0, MAX_CRASH_LOG_CHARS), truncated: true }
    : { text: logText, truncated: false };
}

export type UpsertResult = { inserted: { id: string; item: StoreBetaFeedback }[]; updated: number };

/**
 * Adds the submissions that are new and refreshes the Apple-given fields of the ones stored; triage fields and crash logs are never touched
 * here (`storeCrashLog` keeps the logs).
 */
export async function upsertSubmissions(
  tx: Sql,
  input: {
    workspaceId: string;
    appId: string;
    items: readonly StoreBetaFeedback[];
    existing: ReadonlyMap<string, { id: string; crashLogState: string }>;
    at: number;
  },
): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: [], updated: 0 };
  for (const item of input.items) {
    const known = input.existing.get(item.id);
    const key = testerKey(input.workspaceId, item.email);
    const created = item.createdAt ?? input.at;
    const sizes = JSON.stringify(item.screenshots.slice(0, 20));
    if (!known) {
      const id = randomUUID();
      await tx.execute(
        `INSERT INTO testflight_feedback (id, workspace_id, app_id, apple_id, kind, created_at, build_id, build_number, version, platform, bundle_id,
           tester_key, tester_email, device_model, device_family, os_version, locale, time_zone, architecture, connection_type, paired_watch,
           app_uptime_ms, disk_free_bytes, disk_total_bytes, battery_percent, screen_width, screen_height, comment, screenshots_json,
           first_seen_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.workspaceId,
          input.appId,
          item.id,
          item.kind,
          created,
          item.buildId,
          item.buildNumber,
          item.version,
          item.platform,
          item.bundleId,
          key,
          item.email,
          item.deviceModel,
          item.deviceFamily,
          item.osVersion,
          item.locale,
          item.timeZone,
          item.architecture,
          item.connectionType,
          item.pairedWatch,
          item.appUptimeMs,
          item.diskFreeBytes,
          item.diskTotalBytes,
          item.batteryPercent,
          item.screenWidth,
          item.screenHeight,
          item.comment,
          sizes,
          input.at,
          input.at,
        ],
      );
      result.inserted.push({ id, item });
      continue;
    }
    // A refresh: what Apple gives may fill a gap (a version that could not be read before) but a known value is not blanked by a missing one.
    await tx.execute(
      `UPDATE testflight_feedback SET build_id = COALESCE(?, build_id), build_number = COALESCE(?, build_number), version = COALESCE(?, version),
         tester_key = COALESCE(?, tester_key), tester_email = COALESCE(?, tester_email), comment = ?, screenshots_json = ?, fetched_at = ?
       WHERE id = ? AND app_id = ? AND workspace_id = ?`,
      [
        item.buildId,
        item.buildNumber,
        item.version,
        key,
        item.email,
        item.comment,
        sizes,
        input.at,
        known.id,
        input.appId,
        input.workspaceId,
      ],
    );
    result.updated++;
  }
  return result;
}

/**
 * Keeps what a crash log read gave for a stored crash (by Apple's id): the text, capped, with its signature; or, when Apple had none, the state
 * `missing`. Never changes a row that is not a crash.
 */
export async function storeCrashLog(
  tx: Sql,
  input: { workspaceId: string; appId: string; appleId: string; logText: string | null },
): Promise<void> {
  if (input.logText === null) {
    await tx.execute(
      `UPDATE testflight_feedback SET crash_log = NULL, crash_log_truncated = 0, crash_log_state = 'missing', signature = NULL, symbolicated = NULL
        WHERE apple_id = ? AND app_id = ? AND workspace_id = ? AND kind = 'crash'`,
      [input.appleId, input.appId, input.workspaceId],
    );
    return;
  }
  const sig = crashSignature(input.logText);
  const capped = capCrashLog(input.logText);
  await tx.execute(
    `UPDATE testflight_feedback SET crash_log = ?, crash_log_truncated = ?, crash_log_state = 'stored', signature = ?, symbolicated = ?
      WHERE apple_id = ? AND app_id = ? AND workspace_id = ? AND kind = 'crash'`,
    [
      capped.text,
      capped.truncated ? 1 : 0,
      sig?.key ?? null,
      sig?.symbolicated === null || sig === null ? null : sig.symbolicated ? 1 : 0,
      input.appleId,
      input.appId,
      input.workspaceId,
    ],
  );
}

/** Counts, completeness and warnings of a sync, as the state of the last sync. */
export async function recordSyncSuccess(
  tx: Sql,
  input: {
    workspaceId: string;
    appId: string;
    at: number;
    complete: boolean;
    warnings: readonly string[];
  },
): Promise<void> {
  const count = async (kind: FeedbackKind) => {
    const [row] = await tx.query(
      'SELECT COUNT(*) AS n FROM testflight_feedback WHERE app_id = ? AND workspace_id = ? AND kind = ?',
      [input.appId, input.workspaceId, kind],
    );
    return Number(row?.n ?? 0);
  };
  await tx.execute(
    `INSERT INTO testflight_sync (app_id, workspace_id, last_attempt_at, last_synced_at, last_error, failures, feedback_count, crash_count, complete, warnings_json)
     VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET workspace_id = excluded.workspace_id, last_attempt_at = excluded.last_attempt_at,
       last_synced_at = excluded.last_synced_at, last_error = NULL, failures = 0, feedback_count = excluded.feedback_count,
       crash_count = excluded.crash_count, complete = excluded.complete, warnings_json = excluded.warnings_json`,
    [
      input.appId,
      input.workspaceId,
      input.at,
      input.at,
      await count('feedback'),
      await count('crash'),
      input.complete ? 1 : 0,
      JSON.stringify(input.warnings.slice(0, 50).map((w) => w.slice(0, 300))),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Triage

export type TriageInput = {
  status?: TriageStatus | undefined;
  assigneeUserId?: string | null | undefined;
  internalNote?: string | null | undefined;
};

export type TriageResult =
  | {
      ok: true;
      item: FeedbackItem;
      changed: string[];
      from: { status: TriageStatus; assigneeUserId: string | null };
    }
  | { ok: false; error: 'not_found' | 'assignee_not_member' };

export async function triage(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    id: string;
    actorId: string;
    at: number;
    mayViewEmail: boolean;
  } & TriageInput,
): Promise<TriageResult> {
  const current = await getFeedback(sql, input);
  if (!current) return { ok: false, error: 'not_found' };
  if (input.assigneeUserId) {
    const [member] = await sql.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [input.workspaceId, input.assigneeUserId],
    );
    if (!member) return { ok: false, error: 'assignee_not_member' };
  }
  const changed: string[] = [];
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.status !== undefined && input.status !== current.status) {
    sets.push('status = ?', 'status_changed_at = ?', 'status_changed_by = ?');
    params.push(input.status, input.at, input.actorId);
    changed.push('status');
  }
  if (input.assigneeUserId !== undefined && input.assigneeUserId !== current.assigneeUserId) {
    sets.push('assignee_user_id = ?');
    params.push(input.assigneeUserId);
    changed.push('assignee');
  }
  if (input.internalNote !== undefined) {
    const note =
      input.internalNote === null || input.internalNote.trim() === '' ? null : input.internalNote;
    if (note !== current.internalNote) {
      sets.push('internal_note = ?');
      params.push(note);
      changed.push('note');
    }
  }
  if (sets.length > 0) {
    await sql.execute(
      `UPDATE testflight_feedback SET ${sets.join(', ')} WHERE id = ? AND app_id = ? AND workspace_id = ?`,
      [...params, input.id, input.appId, input.workspaceId],
    );
  }
  const item = (await getFeedback(sql, input)) as FeedbackItem & { crashLog: string | null };
  const { crashLog: _log, ...view } = item;
  return {
    ok: true,
    item: view,
    changed,
    from: { status: current.status, assigneeUserId: current.assigneeUserId },
  };
}

// ---------------------------------------------------------------------------------------------
// Retention and removal

/** Data protection: deletes submissions older than `olderThan` (Apple's date), a bounded number per run. */
export async function pruneTestflight(
  sql: Sql,
  olderThan: number,
  maxRows = 1000,
): Promise<number> {
  const limit = Math.max(1, Math.trunc(maxRows));
  return sql.execute(
    `DELETE FROM testflight_feedback WHERE id IN (SELECT id FROM testflight_feedback WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
    [olderThan, limit],
  );
}
