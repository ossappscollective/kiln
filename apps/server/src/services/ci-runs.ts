import { randomUUID } from 'node:crypto';
import type { CiRun } from '@mrm/connectors';
import type { Sql } from '@mrm/db';
import { purgeConventionOrphans } from './build-conventions.ts';

/**
 * The stored side of CI tracking: `workflow_runs` rows, one per GitHub Actions run of a connected
 * repository, plus a placeholder row (`status = 'pending'`) for a dispatch whose run GitHub has
 * not named yet. Nothing here talks to GitHub; services/ci.ts fills the table.
 *
 * `repository_id` has no foreign key on purpose (like `apps.repository_id`): disconnecting a
 * repository must stay possible. Rows of a disconnected repository are never read (every read
 * starts from the repository) and `purgeOrphans` deletes them.
 */

type Row = Record<string, unknown>;

/** GitHub's own run statuses that mean the run is not finished. Anything else is not polled. */
export const ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'] as const;
export const isActiveStatus = (status: string): boolean =>
  (ACTIVE_STATUSES as readonly string[]).includes(status);

/** A dispatch that no run was found for within this long is dropped. */
export const PENDING_DISPATCH_TTL_MS = 10 * 60_000;
/** Finished runs older than this are deleted, unless a build link names them. */
export const RUN_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Runs read from GitHub per refresh (one page). */
export const REFRESH_PAGE_SIZE = 50;

export type WorkflowRunView = {
  /** GitHub's run id; `pending-…` for a dispatch whose run is not known yet. */
  id: string;
  repositoryId: string;
  appId: string | null;
  /** The workflow's name; the file name or id that was dispatched while still pending. */
  workflow: string;
  workflowPath: string | null;
  /** The run title: the `run-name`, or GitHub's default (the commit or pull request title). */
  title: string | null;
  /** GitHub's own status kept verbatim (`queued`, `in_progress`, `completed`, ...) or `pending`. */
  status: string;
  conclusion: string | null;
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

export const RUN_COLUMNS = `id, repository_id, app_id, run_id, workflow, workflow_path, title, status,
  conclusion, head_sha, commit_message, branch, event, run_number, url, inputs_json, dispatched_by,
  started_at, run_updated_at, synced_at`;

const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null =>
  v === null || v === undefined ? null : f(v);

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

export const toRunView = (r: Row): WorkflowRunView => ({
  id: String(r.run_id),
  repositoryId: String(r.repository_id),
  appId: orNull(r.app_id, String),
  workflow: String(r.workflow),
  workflowPath: orNull(r.workflow_path, String),
  title: orNull(r.title, String),
  status: String(r.status),
  conclusion: orNull(r.conclusion, String),
  active: isActiveStatus(String(r.status)),
  headSha: orNull(r.head_sha, String),
  commitMessage: orNull(r.commit_message, String),
  branch: orNull(r.branch, String),
  event: orNull(r.event, String),
  runNumber: orNull(r.run_number, Number),
  url: orNull(r.url, String),
  inputs: parseInputs(r.inputs_json),
  dispatchedBy: orNull(r.dispatched_by, String),
  startedAt: Number(r.started_at),
  updatedAt: Number(r.run_updated_at),
  syncedAt: Number(r.synced_at),
});

/** The first line of a commit message, at most 200 characters. */
export const firstLine = (message: string | undefined): string | null => {
  const line = message?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line.slice(0, 200) : null;
};

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
  return rows
    .map(toRunView)
    .filter(
      (r) =>
        (filter.activeOnly !== true || r.active) &&
        (filter.branch === undefined || r.branch === filter.branch) &&
        (filter.appId === undefined || r.appId === filter.appId) &&
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
  return row ? toRunView(row) : undefined;
}

/** How many runs of the repository are not finished (pending dispatches included). */
export async function countActiveRuns(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
): Promise<number> {
  const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
  const [row] = await sql.query(
    `SELECT COUNT(*) AS n FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status IN (${marks})`,
    [workspaceId, repositoryId, ...ACTIVE_STATUSES],
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Writes

export type PendingDispatch = {
  workspaceId: string;
  repositoryId: string;
  appId: string | null;
  /** The workflow file name or id that was dispatched. */
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
  dispatchedBy: string;
  now: number;
  /** Set when GitHub named the run in its answer: the row is then a real run, not a placeholder. */
  runId?: string | undefined;
  runUrl?: string | undefined;
};

/** Records a dispatch the moment it was sent. Returns the stored row. */
export async function recordDispatch(sql: Sql, d: PendingDispatch): Promise<WorkflowRunView> {
  const runId = d.runId ?? `pending-${randomUUID()}`;
  const inputsJson = JSON.stringify(d.inputs);
  const [existing] = await sql.query(
    'SELECT id FROM workflow_runs WHERE repository_id = ? AND run_id = ?',
    [d.repositoryId, runId],
  );
  if (existing) {
    // A refresh stored the run before the dispatch answer was recorded: add what only we know.
    await sql.execute(
      `UPDATE workflow_runs SET app_id = ?, inputs_json = ?, dispatched_by = ?
        WHERE id = ? AND workspace_id = ?`,
      [d.appId, inputsJson, d.dispatchedBy, String(existing.id), d.workspaceId],
    );
  } else {
    await sql.execute(
      `INSERT INTO workflow_runs
         (id, workspace_id, repository_id, app_id, run_id, workflow, workflow_path, status, branch,
          event, url, inputs_json, dispatched_by, started_at, run_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_dispatch', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        d.workspaceId,
        d.repositoryId,
        d.appId,
        runId,
        d.workflow,
        d.workflow,
        d.runId ? 'queued' : 'pending',
        d.ref,
        d.runUrl ?? null,
        inputsJson,
        d.dispatchedBy,
        d.now,
        d.now,
        d.now,
      ],
    );
  }
  const view = await getRunView(sql, d.workspaceId, d.repositoryId, runId);
  return view as WorkflowRunView;
}

type PendingRow = { id: string; workflow: string; branch: string | null; startedAt: number };

/** Does this run look like the one a pending dispatch of `workflow` on `ref` started? */
function fitsPending(run: CiRun, pending: PendingRow): boolean {
  if (run.event !== 'workflow_dispatch') return false;
  if (pending.branch !== null && run.branch !== undefined && run.branch !== pending.branch) return false;
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
    `SELECT id, workflow, branch, started_at FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status = 'pending'
      ORDER BY started_at, id`,
    [workspaceId, repositoryId],
  );
  const pending: PendingRow[] = pendingRows.map((p) => ({
    id: String(p.id),
    workflow: String(p.workflow),
    branch: orNull(p.branch, String),
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
      'SELECT id FROM workflow_runs WHERE repository_id = ? AND run_id = ?',
      [repositoryId, run.id],
    );
    if (existing) {
      await sql.execute(`UPDATE workflow_runs SET ${set} WHERE id = ?`, [...values, String(existing.id)]);
      result.updated++;
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
  const links = await sql.execute('DELETE FROM build_links WHERE app_id NOT IN (SELECT id FROM apps)');
  const conventions = await purgeConventionOrphans(sql);
  return runs + links + conventions;
}
