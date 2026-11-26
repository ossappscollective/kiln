import { randomUUID } from 'node:crypto';
import type { Platform } from '@kiln/core';
import type { Sql } from '@kiln/db';
import type { ErrorParams } from '../../i18n/problem.ts';
import type { PublishStep } from './pending.ts';
import type { StoreFacts } from './store-failure.ts';

/**
 * What the last batch publishes of an app did, kept on the server (migration 72, `store_publish_runs`; docs/api/pending.md "Why a publish
 * failed"). The answer of `POST .../publish` used to live only in the browser that sent it, so a failure was gone after a reload and
 * invisible from another browser. A run holds ids, step names, error codes, HTTP statuses, times and the SANITISED sentence the store
 * gave (`store-failure.ts`): never a token, a key, a request body or an upload. The newest five runs of an app are kept; the rows go
 * with the app.
 *
 * `lastPublish` (pending view, summary lines, `GET /pending/publishing`) is the LATEST run of an app when it did not complete, so a
 * later run that went through clears it; `dismissed` says a person hid it (a newer run is never hidden by an older dismissal).
 */

export const MAX_RUNS_PER_APP = 5;

export type RunOutcome = 'completed' | 'partial' | 'failed';

/** One step of a run, as kept: enough to say what happened and why, small enough to keep. */
export type RunStep = {
  type: PublishStep;
  status: 'applied' | 'skipped' | 'failed';
  startedAt: number;
  finishedAt: number;
  /** Failed: the error code (`store_rejected`, `state_changed`, `step_timeout`, ...). */
  error?: string;
  httpStatus?: number;
  /** Failed: `refused`, `not_applied`, `unknown` or `partial`. */
  outcome?: 'refused' | 'not_applied' | 'unknown' | 'partial';
  /** Skipped: `previous_step_not_applied`, `plan_drifted`, `blocked`, `preview_failed`. */
  reason?: string;
  /** The sentence of this server, sanitised. */
  message?: string;
  /** The catalogue code of that sentence or of the store's cause (`store.google.draftApp`), with its parameters. */
  code?: string;
  params?: ErrorParams;
  /** What the store said (its kind of error, HTTP status, its own words), sanitised. */
  store?: StoreFacts;
};

export type LastPublish = {
  id: string;
  platform: Platform;
  startedAt: number;
  finishedAt: number;
  outcome: RunOutcome;
  completed: boolean;
  steps: PublishStep[];
  results: RunStep[];
  by: { id: string; name: string | null } | null;
  /** A person hid this failure; stays true for this run only. */
  dismissed: boolean;
};

const parse = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const nameMap = async (sql: Sql, ids: string[]): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  for (const u of await sql.query(
    `SELECT id, display_name FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  ))
    names.set(String(u.id), String(u.display_name));
  return names;
};

const runOf = (row: Record<string, unknown>, names: Map<string, string>): LastPublish => {
  const by = row.by_user === null || row.by_user === undefined ? '' : String(row.by_user);
  const outcome = String(row.outcome) as RunOutcome;
  return {
    id: String(row.id),
    platform: String(row.platform) as Platform,
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    outcome,
    completed: outcome === 'completed',
    steps: parse<PublishStep[]>(row.steps, []),
    results: parse<RunStep[]>(row.results, []),
    by: by === '' ? null : { id: by, name: names.get(by) ?? null },
    dismissed: row.dismissed_at !== null && row.dismissed_at !== undefined,
  };
};

const COLUMNS =
  'id, platform, started_at, finished_at, outcome, steps, results, by_user, dismissed_at';

/**
 * Keeps one finished run and drops the older ones beyond the newest `MAX_RUNS_PER_APP` of the app. Returns the run as the screens read
 * it. A failure to write is the caller's to swallow: a publish never changes its answer because its history could not be kept.
 */
export async function recordRun(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    platform: Platform;
    startedAt: number;
    finishedAt: number;
    outcome: RunOutcome;
    steps: readonly PublishStep[];
    results: readonly RunStep[];
    byUser: string | null;
    id?: string;
  },
): Promise<LastPublish> {
  const id = input.id ?? randomUUID();
  await sql.execute(
    `INSERT INTO store_publish_runs
       (id, workspace_id, app_id, platform, started_at, finished_at, outcome, steps, results, by_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.appId,
      input.platform,
      input.startedAt,
      input.finishedAt,
      input.outcome,
      JSON.stringify(input.steps),
      JSON.stringify(input.results),
      input.byUser,
    ],
  );
  await sql.execute(
    `DELETE FROM store_publish_runs WHERE app_id = ? AND workspace_id = ? AND id NOT IN (
       SELECT id FROM store_publish_runs WHERE app_id = ? AND workspace_id = ?
        ORDER BY finished_at DESC, id DESC LIMIT ${MAX_RUNS_PER_APP}
     )`,
    [input.appId, input.workspaceId, input.appId, input.workspaceId],
  );
  const names = await nameMap(sql, input.byUser === null ? [] : [input.byUser]);
  return {
    id,
    platform: input.platform,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    completed: input.outcome === 'completed',
    steps: [...input.steps],
    results: [...input.results],
    by: input.byUser === null ? null : { id: input.byUser, name: names.get(input.byUser) ?? null },
    dismissed: false,
  };
}

/** The runs of an app, newest first (at most `MAX_RUNS_PER_APP`). */
export async function listRuns(
  sql: Sql,
  input: { workspaceId: string; appId: string },
): Promise<LastPublish[]> {
  const rows = await sql.query(
    `SELECT ${COLUMNS} FROM store_publish_runs WHERE workspace_id = ? AND app_id = ?
      ORDER BY finished_at DESC, id DESC LIMIT ${MAX_RUNS_PER_APP}`,
    [input.workspaceId, input.appId],
  );
  const names = await nameMap(sql, [
    ...new Set(rows.flatMap((r) => (r.by_user ? [String(r.by_user)] : []))),
  ]);
  return rows.map((r) => runOf(r, names));
}

/**
 * The latest run of each app (of `appIds`, or of the workspace) that did NOT complete, by app id. An app whose latest run completed has
 * none: a later publish that went through clears the failure. Dismissed runs are returned with `dismissed: true`.
 */
export async function readLastPublish(
  sql: Sql,
  input: { workspaceId: string; appIds?: readonly string[] | undefined },
): Promise<Map<string, LastPublish>> {
  const out = new Map<string, LastPublish>();
  if (input.appIds !== undefined && input.appIds.length === 0) return out;
  const wanted = input.appIds === undefined ? null : new Set(input.appIds);
  // Newest first: the first row seen of an app is its latest run.
  const rows = await sql.query(
    `SELECT app_id, ${COLUMNS} FROM store_publish_runs WHERE workspace_id = ?
      ORDER BY finished_at DESC, id DESC`,
    [input.workspaceId],
  );
  const seen = new Set<string>();
  const latest: Record<string, unknown>[] = [];
  for (const r of rows) {
    const appId = String(r.app_id);
    if (seen.has(appId)) continue;
    seen.add(appId);
    if (wanted !== null && !wanted.has(appId)) continue;
    if (String(r.outcome) === 'completed') continue;
    latest.push(r);
  }
  const names = await nameMap(sql, [
    ...new Set(latest.flatMap((r) => (r.by_user ? [String(r.by_user)] : []))),
  ]);
  for (const r of latest) out.set(String(r.app_id), runOf(r, names));
  return out;
}

/** Hides the failure of one run. False when there is no such run for the app. A newer run is not hidden by it. */
export async function dismissRun(
  sql: Sql,
  input: { workspaceId: string; appId: string; runId: string; by: string | null; now: number },
): Promise<boolean> {
  const rows = await sql.query(
    'SELECT id FROM store_publish_runs WHERE id = ? AND workspace_id = ? AND app_id = ?',
    [input.runId, input.workspaceId, input.appId],
  );
  if (rows.length === 0) return false;
  await sql.execute(
    'UPDATE store_publish_runs SET dismissed_at = ?, dismissed_by = ? WHERE id = ? AND dismissed_at IS NULL',
    [input.now, input.by, input.runId],
  );
  return true;
}

/** The rows of a deleted app (inside `deleteApp`'s transaction). */
export const deleteAppRuns = (sql: Sql, workspaceId: string, appId: string) =>
  sql.execute('DELETE FROM store_publish_runs WHERE app_id = ? AND workspace_id = ?', [
    appId,
    workspaceId,
  ]);

/**
 * Google Play: whether Google refused to keep a draft for this app, as the runs say. Newest run first: a run whose push_draft step
 * failed with `draft_not_allowed` says yes; a run whose draft push went through says no (Google kept a draft since); a run that did
 * neither (a release, a combined push and submit that went through) says nothing, so the older runs decide. Only the runs of this
 * platform count. The five newest runs are kept, so the answer fades with them.
 */
export async function draftRefusedBefore(
  sql: Sql,
  input: { workspaceId: string; appId: string; platform: Platform },
): Promise<boolean> {
  for (const run of await listRuns(sql, input)) {
    if (run.platform !== input.platform) continue;
    const push = run.results.find((r) => r.type === 'push_draft');
    if (push?.status === 'failed' && push.error === 'draft_not_allowed') return true;
    if (push?.status === 'applied') return false;
  }
  return false;
}

/**
 * Google Play: whether the last run of this app was refused because changes were already in review (`changes_in_review`), as the runs
 * say. Newest run first: a run with a step that failed that way says yes; a run that completed says no (a later review is not known
 * to be the old one); anything else says nothing, so the older runs decide. It is only a hint for the recommended plan, never a read
 * of Google Play: the Edits API shows no review state, so nothing here can know whether the review is still in progress.
 */
export async function changesInReviewBefore(
  sql: Sql,
  input: { workspaceId: string; appId: string; platform: Platform },
): Promise<boolean> {
  for (const run of await listRuns(sql, input)) {
    if (run.platform !== input.platform) continue;
    if (run.results.some((r) => r.status === 'failed' && r.error === 'changes_in_review'))
      return true;
    if (run.outcome === 'completed') return false;
  }
  return false;
}
