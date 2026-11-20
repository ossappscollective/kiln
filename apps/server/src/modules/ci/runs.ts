import { randomUUID } from 'node:crypto';
import type { CiRun } from '@mrm/connectors';
import { type CiProviderId, ciProviderOf } from '@mrm/core';
import { mapOrNull, type Row, type Sql } from '@mrm/db';
import { emitEvent } from '../../services/events.ts';
import { purgeConventionOrphans } from './conventions.ts';

/**
 * The stored side of CI tracking: `workflow_runs` rows, one per GitHub Actions run of a connected
 * repository, plus a placeholder row (`status = 'pending'`) for a dispatch whose run GitHub has
 * not named yet. Nothing here talks to GitHub; services/ci.ts fills the table.
 *
 * `repository_id` has no foreign key on purpose (like `apps.repository_id`): disconnecting a
 * repository must stay possible. Rows of a disconnected repository are never read (every read
 * starts from the repository) and `purgeOrphans` deletes them.
 */

/** GitHub's own run statuses that mean the run is not finished. Anything else is not polled. */
export const ACTIVE_STATUSES = [
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
] as const;
export const isActiveStatus = (status: string): boolean =>
  (ACTIVE_STATUSES as readonly string[]).includes(status);

/** A dispatch that no run was found for within this long is dropped. */
export const PENDING_DISPATCH_TTL_MS = 10 * 60_000;
/** Finished runs older than this are deleted, unless a build link names them. */
export const RUN_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** A run that finished and was first seen finished within this long is still announced (`ci.run_finished`). */
export const RECENT_FINISH_EVENT_MS = 15 * 60_000;
/** Runs read from GitHub per refresh (one page). */
export const REFRESH_PAGE_SIZE = 50;

export type WorkflowRunView = {
  /** GitHub's run id; `pending-…` for a dispatch whose run is not known yet. */
  id: string;
  repositoryId: string;
  /** The first app of `appIds`, or null: kept for clients that know one app per run. */
  appId: string | null;
  /**
   * The apps this run builds (a workflow can build one app or several that share a repository). Empty: the run was not
   * started for an app, and it counts for every app of its repository.
   */
  appIds: string[];
  /** The workflow's name; the file name or id that was dispatched while still pending. */
  workflow: string;
  workflowPath: string | null;
  /** The run title: the `run-name`, or GitHub's default (the commit or pull request title). */
  title: string | null;
  /** GitHub's own status kept verbatim (`queued`, `in_progress`, `completed`, ...) or `pending`; another provider's is put into these words. */
  status: string;
  conclusion: string | null;
  /** Which CI provider the run lives in (`github`, `eas-workflows`; packages/core/src/ci-providers.ts). */
  provider: CiProviderId;
  /** True while the run is not finished (what the poller and the UI wait for). */
  active: boolean;
  headSha: string | null;
  /** First line of the commit message. */
  commitMessage: string | null;
  branch: string | null;
  event: string | null;
  runNumber: number | null;
  url: string | null;
  /** The inputs this tool dispatched with, when it started the run. */
  inputs: Record<string, string> | null;
  dispatchedBy: string | null;
  startedAt: number;
  updatedAt: number;
  syncedAt: number;
};

export const RUN_COLUMNS = `id, repository_id, app_id, run_id, workflow, workflow_path, title, status, provider,
  conclusion, head_sha, commit_message, branch, event, run_number, url, inputs_json, dispatched_by,
  started_at, run_updated_at, synced_at`;

function parseInputs(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
  } catch {
    return null;
  }
}

/**
 * The app set of a run row: the rows of `ci_run_apps` (the apps of the dispatch), else the legacy `app_id` column
 * (rows written before migration 28 are migrated, so this only matters for a row a test inserted by hand).
 */
const appIdsOf = (r: Row, linked: readonly string[] | undefined): string[] =>
  linked !== undefined && linked.length > 0
    ? [...linked]
    : r.app_id === null || r.app_id === undefined
      ? []
      : [String(r.app_id)];

export const toRunView = (r: Row, linked?: readonly string[]): WorkflowRunView => {
  const appIds = appIdsOf(r, linked);
  return {
    id: String(r.run_id),
    repositoryId: String(r.repository_id),
    appId: appIds[0] ?? null,
    appIds,
    workflow: String(r.workflow),
    workflowPath: mapOrNull(r.workflow_path, String),
    title: mapOrNull(r.title, String),
    status: String(r.status),
    conclusion: mapOrNull(r.conclusion, String),
    provider: ciProviderOf(r.provider),
    active: isActiveStatus(String(r.status)),
    headSha: mapOrNull(r.head_sha, String),
    commitMessage: mapOrNull(r.commit_message, String),
    branch: mapOrNull(r.branch, String),
    event: mapOrNull(r.event, String),
    runNumber: mapOrNull(r.run_number, Number),
    url: mapOrNull(r.url, String),
    inputs: parseInputs(r.inputs_json),
    dispatchedBy: mapOrNull(r.dispatched_by, String),
    startedAt: Number(r.started_at),
    updatedAt: Number(r.run_updated_at),
    syncedAt: Number(r.synced_at),
  };
};

const IN_CHUNK = 400;

/** The apps of each run row (by the row's own id), from `ci_run_apps`. */
export async function loadRunApps(
  sql: Sql,
  rowIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < rowIds.length; i += IN_CHUNK) {
    const chunk = rowIds.slice(i, i + IN_CHUNK);
    const rows = await sql.query(
      `SELECT run_ref, app_id FROM ci_run_apps WHERE run_ref IN (${chunk.map(() => '?').join(', ')}) ORDER BY app_id`,
      [...chunk],
    );
    for (const r of rows) {
      const key = String(r.run_ref);
      out.set(key, [...(out.get(key) ?? []), String(r.app_id)]);
    }
  }
  return out;
}

/** Run rows (selected with RUN_COLUMNS) as views, with their apps. */
export async function runViews(sql: Sql, rows: readonly Row[]): Promise<WorkflowRunView[]> {
  const apps = await loadRunApps(
    sql,
    rows.map((r) => String(r.id)),
  );
  return rows.map((r) => toRunView(r, apps.get(String(r.id))));
}

/** Does a run count for this app? A run with no app counts for every app of its repository. */
export const runCountsForApp = (run: Pick<WorkflowRunView, 'appIds'>, appId: string): boolean =>
  run.appIds.length === 0 || run.appIds.indexOf(appId) !== -1;

/** Replaces the apps of a run row. The first one is also kept in the legacy `workflow_runs.app_id` column. */
export async function setRunApps(
  sql: Sql,
  input: { workspaceId: string; runRef: string; appIds: readonly string[]; now: number },
): Promise<void> {
  // Sorted, so the first app (the legacy column, `appId` of the view) is the same however the request listed them.
  const unique = input.appIds.filter((id, i) => input.appIds.indexOf(id) === i).sort();
  await sql.execute('DELETE FROM ci_run_apps WHERE run_ref = ? AND workspace_id = ?', [
    input.runRef,
    input.workspaceId,
  ]);
  for (const appId of unique) {
    await sql.execute(
      'INSERT INTO ci_run_apps (run_ref, app_id, workspace_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [input.runRef, appId, input.workspaceId, input.now],
    );
  }
  await sql.execute('UPDATE workflow_runs SET app_id = ? WHERE id = ? AND workspace_id = ?', [
    unique[0] ?? null,
    input.runRef,
    input.workspaceId,
  ]);
}

/** The first line of a commit message, at most 200 characters. */
export const firstLine = (message: string | undefined): string | null => {
  const line = message?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line.slice(0, 200) : null;
};

/**
 * `ci.run_started` and `ci.run_finished`: ids only (the run, its repository, its app), plus the
 * conclusion word on a finish. Never a title, a branch, an input or a person. A run that is
 * first seen already finished (history read for the first time) is not announced, unless it
 * finished within `RECENT_FINISH_EVENT_MS`, which means it ran between two reads.
 */
export async function announce(
  sql: Sql,
  run: {
    workspaceId: string;
    repositoryId: string;
    appIds: readonly string[];
    runId: string;
    at: number;
  },
  kind: 'started' | 'finished',
  conclusion?: string | null,
): Promise<void> {
  // One event per app of the run (an API token limited to some apps hears about its own apps), or one without an app.
  const subjects: (string | null)[] = run.appIds.length > 0 ? [...run.appIds] : [null];
  for (const appId of subjects) {
    await emitEvent(sql, {
      workspaceId: run.workspaceId,
      type: kind === 'started' ? 'ci.run_started' : 'ci.run_finished',
      subject: { repositoryId: run.repositoryId, ...(appId ? { appId } : {}) },
      payload: {
        runId: run.runId,
        repositoryId: run.repositoryId,
        appId,
        // Only when the run builds several apps; one event is sent for each of them (its `appId`).
        ...(run.appIds.length > 1 ? { appIds: [...run.appIds] } : {}),
        ...(kind === 'finished' ? { conclusion: conclusion ?? null } : {}),
      },
      at: run.at,
    });
  }
}

export type RunFilter = {
  /** A workflow path, its file name, or its name. */
  workflow?: string | undefined;
  branch?: string | undefined;
  /** Only runs that are not finished. */
  activeOnly?: boolean | undefined;
  appId?: string | undefined;
  limit?: number | undefined;
};

const matchesWorkflow = (run: WorkflowRunView, wanted: string) =>
  run.workflowPath === wanted ||
  run.workflowPath?.split('/').pop() === wanted ||
  run.workflow === wanted;

/** Newest first. Pending dispatches are included, so a person sees the click was received. */
export async function listRuns(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  filter: RunFilter = {},
): Promise<WorkflowRunView[]> {
  const rows = await sql.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE workspace_id = ? AND repository_id = ?
      ORDER BY started_at DESC, id DESC LIMIT 500`,
    [workspaceId, repositoryId],
  );
  const wanted = filter.workflow;
  return (await runViews(sql, rows))
    .filter(
      (r) =>
        (filter.activeOnly !== true || r.active) &&
        (filter.branch === undefined || r.branch === filter.branch) &&
        (filter.appId === undefined || runCountsForApp(r, filter.appId)) &&
        (wanted === undefined || matchesWorkflow(r, wanted)),
    )
    .slice(0, Math.min(Math.max(Math.trunc(filter.limit ?? 30), 1), 100));
}

export async function getRunView(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  runId: string,
): Promise<WorkflowRunView | undefined> {
  const [row] = await sql.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND run_id = ?`,
    [workspaceId, repositoryId, runId],
  );
  return row ? (await runViews(sql, [row]))[0] : undefined;
}

/**
 * The runs of several repositories at once, for the "running now" list: every run that has not
 * finished (newest first, at most `activeLimit`), and every run that finished at or after
 * `finishedSince` (newest first, at most `finishedLimit`). Reads only our own table.
 */
export async function listWorkspaceRuns(
  sql: Sql,
  workspaceId: string,
  repositoryIds: readonly string[],
  options: { finishedSince: number; activeLimit?: number; finishedLimit?: number },
): Promise<{ active: WorkflowRunView[]; finished: WorkflowRunView[] }> {
  if (repositoryIds.length === 0) return { active: [], finished: [] };
  const repos = repositoryIds.map(() => '?').join(', ');
  const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
  const active = await sql.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
      WHERE workspace_id = ? AND repository_id IN (${repos}) AND status IN (${marks})
      ORDER BY started_at DESC, id DESC LIMIT ?`,
    [workspaceId, ...repositoryIds, ...ACTIVE_STATUSES, options.activeLimit ?? 100],
  );
  const finished = await sql.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
      WHERE workspace_id = ? AND repository_id IN (${repos}) AND status = 'completed' AND run_updated_at >= ?
      ORDER BY run_updated_at DESC, id DESC LIMIT ?`,
    [workspaceId, ...repositoryIds, options.finishedSince, options.finishedLimit ?? 200],
  );
  const views = await runViews(sql, [...active, ...finished]);
  return { active: views.slice(0, active.length), finished: views.slice(active.length) };
}

/** How many runs of the repository are not finished (pending dispatches included). */
export async function countActiveRuns(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  /** Only the runs of this provider (the GitHub poll waits for GitHub's runs only). Default: every provider's. */
  provider?: CiProviderId,
): Promise<number> {
  const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
  const [row] = await sql.query(
    `SELECT COUNT(*) AS n FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status IN (${marks})${provider ? ' AND provider = ?' : ''}`,
    [workspaceId, repositoryId, ...ACTIVE_STATUSES, ...(provider ? [provider] : [])],
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Writes

export type PendingDispatch = {
  workspaceId: string;
  repositoryId: string;
  /** The first app of `appIds` (kept for callers that pass one app). */
  appId: string | null;
  /** The apps the run builds. When absent, `appId` is the only one. */
  appIds?: readonly string[] | undefined;
  /** The workflow file name or id that was dispatched. */
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
  dispatchedBy: string;
  now: number;
  /** Set when GitHub named the run in its answer: the row is then a real run, not a placeholder. */
  runId?: string | undefined;
  runUrl?: string | undefined;
  /** The CI provider that ran it. Default `github`. */
  provider?: CiProviderId | undefined;
  /** Where the workflow file is, when it is not the name that was dispatched (`.eas/workflows/build.yml`). */
  workflowPath?: string | undefined;
};

/** Records a dispatch the moment it was sent. Returns the stored row. */
export async function recordDispatch(sql: Sql, d: PendingDispatch): Promise<WorkflowRunView> {
  const runId = d.runId ?? `pending-${randomUUID()}`;
  const inputsJson = JSON.stringify(d.inputs);
  const appIds = d.appIds !== undefined ? [...d.appIds] : d.appId !== null ? [d.appId] : [];
  const [existing] = await sql.query(
    'SELECT id FROM workflow_runs WHERE repository_id = ? AND run_id = ?',
    [d.repositoryId, runId],
  );
  if (existing) {
    // A refresh stored the run before the dispatch answer was recorded: add what only we know.
    await sql.execute(
      `UPDATE workflow_runs SET inputs_json = ?, dispatched_by = ?
        WHERE id = ? AND workspace_id = ?`,
      [inputsJson, d.dispatchedBy, String(existing.id), d.workspaceId],
    );
    await setRunApps(sql, {
      workspaceId: d.workspaceId,
      runRef: String(existing.id),
      appIds,
      now: d.now,
    });
  } else {
    if (d.runId) {
      await announce(
        sql,
        { workspaceId: d.workspaceId, repositoryId: d.repositoryId, appIds, runId, at: d.now },
        'started',
      );
    }
    const rowId = randomUUID();
    await sql.execute(
      `INSERT INTO workflow_runs
         (id, workspace_id, repository_id, app_id, run_id, workflow, workflow_path, status, branch,
          event, url, inputs_json, dispatched_by, started_at, run_updated_at, synced_at, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_dispatch', ?, ?, ?, ?, ?, ?, ?)`,
      [
        rowId,
        d.workspaceId,
        d.repositoryId,
        appIds[0] ?? null,
        runId,
        d.workflow,
        d.workflowPath ?? d.workflow,
        d.runId ? 'queued' : 'pending',
        d.ref,
        d.runUrl ?? null,
        inputsJson,
        d.dispatchedBy,
        d.now,
        d.now,
        d.now,
        d.provider ?? 'github',
      ],
    );
    await setRunApps(sql, { workspaceId: d.workspaceId, runRef: rowId, appIds, now: d.now });
  }
  const view = await getRunView(sql, d.workspaceId, d.repositoryId, runId);
  return view as WorkflowRunView;
}

type PendingRow = {
  id: string;
  appIds: string[];
  workflow: string;
  branch: string | null;
  startedAt: number;
};

/** Does this run look like the one a pending dispatch of `workflow` on `ref` started? */
function fitsPending(run: CiRun, pending: PendingRow): boolean {
  if (run.event !== 'workflow_dispatch') return false;
  if (pending.branch !== null && run.branch !== undefined && run.branch !== pending.branch)
    return false;
  // Allow a minute of clock difference between GitHub and this server.
  if ((run.createdAt ?? run.startedAt ?? 0) < pending.startedAt - 60_000) return false;
  const wanted = pending.workflow;
  const file = run.path?.split('/').pop();
  return (
    wanted === run.workflowId ||
    wanted === file ||
    wanted === run.path ||
    wanted === run.name ||
    // The dispatch named a workflow GitHub reports nothing to compare with: accept it.
    (run.path === undefined && run.workflowId === undefined && run.name === undefined)
  );
}

export type StoreResult = { added: number; updated: number; adopted: number; expired: number };

/**
 * Stores runs read from GitHub: a run that is already stored is updated (its dispatch inputs and
 * app are kept), a new one takes over the oldest pending dispatch it fits, else it is inserted.
 * Pending dispatches nobody claimed within `PENDING_DISPATCH_TTL_MS` are deleted.
 */
export async function storeRuns(
  sql: Sql,
  input: { workspaceId: string; repositoryId: string; runs: CiRun[]; now: number },
): Promise<StoreResult> {
  const { workspaceId, repositoryId, now } = input;
  const result: StoreResult = { added: 0, updated: 0, adopted: 0, expired: 0 };

  result.expired = await sql.execute(
    `DELETE FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status = 'pending' AND started_at < ?`,
    [workspaceId, repositoryId, now - PENDING_DISPATCH_TTL_MS],
  );
  const pendingRows = await sql.query(
    `SELECT id, app_id, workflow, branch, started_at FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status = 'pending'
      ORDER BY started_at, id`,
    [workspaceId, repositoryId],
  );
  const pendingApps = await loadRunApps(
    sql,
    pendingRows.map((p) => String(p.id)),
  );
  const pending: PendingRow[] = pendingRows.map((p) => ({
    id: String(p.id),
    appIds: appIdsOf(p, pendingApps.get(String(p.id))),
    workflow: String(p.workflow),
    branch: mapOrNull(p.branch, String),
    startedAt: Number(p.started_at),
  }));

  // Oldest runs first, so the oldest pending dispatch is matched with the oldest fitting run.
  const ordered = [...input.runs].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id),
  );
  for (const run of ordered) {
    const startedAt = run.startedAt ?? run.createdAt ?? now;
    const values = [
      run.name ?? run.path ?? 'workflow',
      run.path ?? null,
      run.displayTitle ?? null,
      run.status,
      run.conclusion ?? null,
      run.headSha ?? null,
      firstLine(run.commitMessage),
      run.branch ?? null,
      run.event ?? null,
      run.runNumber ?? null,
      run.url,
      startedAt,
      run.updatedAt ?? startedAt,
      now,
    ];
    const set = `workflow = ?, workflow_path = ?, title = ?, status = ?, conclusion = ?, head_sha = ?,
      commit_message = ?, branch = ?, event = ?, run_number = ?, url = ?, started_at = ?,
      run_updated_at = ?, synced_at = ?`;
    const [existing] = await sql.query(
      'SELECT id, status, app_id FROM workflow_runs WHERE repository_id = ? AND run_id = ?',
      [repositoryId, run.id],
    );
    const about = (appIds: readonly string[]) => ({
      workspaceId,
      repositoryId,
      appIds,
      runId: run.id,
      at: now,
    });
    const finishedNow = run.status === 'completed';
    if (existing) {
      await sql.execute(`UPDATE workflow_runs SET ${set} WHERE id = ?`, [
        ...values,
        String(existing.id),
      ]);
      result.updated++;
      if (finishedNow && isActiveStatus(String(existing.status))) {
        const linked = (await loadRunApps(sql, [String(existing.id)])).get(String(existing.id));
        await announce(sql, about(appIdsOf(existing, linked)), 'finished', run.conclusion ?? null);
      }
      continue;
    }
    const claimed = pending.findIndex((p) => fitsPending(run, p));
    if (claimed >= 0) {
      const [taken] = pending.splice(claimed, 1) as [PendingRow];
      await sql.execute(`UPDATE workflow_runs SET run_id = ?, ${set} WHERE id = ?`, [
        run.id,
        ...values,
        taken.id,
      ]);
      result.adopted++;
      await announce(sql, about(taken.appIds), 'started');
      if (finishedNow) await announce(sql, about(taken.appIds), 'finished', run.conclusion ?? null);
      continue;
    }
    await sql.execute(
      `INSERT INTO workflow_runs
         (id, workspace_id, repository_id, run_id, workflow, workflow_path, title, status, conclusion,
          head_sha, commit_message, branch, event, run_number, url, started_at, run_updated_at,
          synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), workspaceId, repositoryId, run.id, ...values],
    );
    result.added++;
    if (!finishedNow) await announce(sql, about([]), 'started');
    else if (now - (run.updatedAt ?? startedAt) <= RECENT_FINISH_EVENT_MS) {
      await announce(sql, about([]), 'started');
      await announce(sql, about([]), 'finished', run.conclusion ?? null);
    }
  }
  return result;
}

/**
 * Deletes finished runs not touched for `RUN_RETENTION_MS`, unless a build link names them (the
 * link keeps its own copy of the commit, but the run row still explains it).
 */
export async function pruneRuns(
  sql: Sql,
  input: { workspaceId: string; repositoryId: string; now: number },
): Promise<number> {
  return sql.execute(
    `DELETE FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND synced_at < ? AND status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM build_links l
           WHERE l.repository_id = workflow_runs.repository_id AND l.run_id = workflow_runs.run_id)`,
    [input.workspaceId, input.repositoryId, input.now - RUN_RETENTION_MS],
  );
}

/** Deletes the rows of repositories that were disconnected (runs, conventions, scans) and of apps that were deleted. */
export async function purgeOrphans(sql: Sql): Promise<number> {
  const runs = await sql.execute(
    'DELETE FROM workflow_runs WHERE repository_id NOT IN (SELECT id FROM repositories)',
  );
  const links = await sql.execute(
    'DELETE FROM build_links WHERE app_id NOT IN (SELECT id FROM apps)',
  );
  const conventions = await purgeConventionOrphans(sql);
  // The apps of a run go with the run (a cascade), and an app that was deleted leaves its links.
  const runApps =
    (await sql.execute(
      'DELETE FROM ci_run_apps WHERE run_ref NOT IN (SELECT id FROM workflow_runs)',
    )) + (await sql.execute('DELETE FROM ci_run_apps WHERE app_id NOT IN (SELECT id FROM apps)'));
  return runs + links + conventions + runApps;
}
