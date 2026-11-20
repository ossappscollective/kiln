import type { CiJob } from '@mrm/connectors';
import type { ActorType } from '@mrm/core';
import {
  type CiContext,
  cachedRunJobs,
  lastRefreshAttempt,
  lastRefreshSuccess,
  MIN_REFRESH_MS,
  readRunJobs,
  refreshRuns,
  runActor,
} from './service.ts';
import { ACTIVE_STATUSES, listWorkspaceRuns, type WorkflowRunView } from './runs.ts';
import { type Failure, listRepositories, type Repository } from '../../services/repositories.ts';

type Actor = { type: ActorType; id: string };

/**
 * The workspace-wide "running now" list: the runs of the connected repositories that have not
 * finished, and those that finished in the last 24 hours. It is read from `workflow_runs`; for a
 * caller who may ask GitHub (the right of a scan) the repositories are first refreshed through the
 * same run sync that `ci.poll` and `?refresh=true` use (conditional ETag reads, at least
 * `MIN_REFRESH_MS` apart, shared with those callers), and the jobs of runs in progress are read for
 * the progress bar. Nothing here writes to GitHub.
 *
 * Budget: an answer is kept `ACTIVE_CACHE_TTL_MS` and concurrent identical requests share one
 * computation; a repository with a run going is refreshed at most every `MIN_REFRESH_MS`, one
 * without every `IDLE_REFRESH_MS` (that is how a run started on GitHub itself is noticed); at most
 * `MAX_REPOS_PER_ROUND` repositories and `MAX_JOB_READS` jobs lists per computation. A repository
 * GitHub will not let us read is left alone for a while and reported as a problem, not an error.
 */

export const ACTIVE_CACHE_TTL_MS = 5_000;
/** A repository with no run going is looked at this rarely (a 304 is free of the rate limit, but it is still a request). */
export const IDLE_REFRESH_MS = 60_000;
export const RECENT_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_RECENT_RUNS = 20;
export const MAX_REPOS_PER_ROUND = 25;
export const MAX_JOB_READS = 12;
const READ_PARALLEL = 4;
/** No access, no Actions, a connection that cannot read CI: not tried again for this long. */
export const PROBLEM_BACKOFF_MS = 10 * 60_000;
export const TRANSIENT_BACKOFF_MS = 30_000;

export type ProgressView = {
  jobsTotal: number;
  jobsDone: number;
  /** The first job in progress, and its first step in progress. */
  job: string | null;
  step: string | null;
  /** Steps of that job: done of total. */
  stepsDone: number;
  stepsTotal: number;
  /** 0 to 1 over all the jobs (a job in progress counts by its finished steps). */
  fraction: number;
  readAt: number;
};

export type ActiveRun = WorkflowRunView & {
  repository: { id: string; owner: string; repo: string };
  /** The GitHub login that started the run, when a read since the last restart saw it. */
  actor: string | null;
  /** Null for a run that has not started, when the jobs were not read, or for a viewer before anyone read them. */
  progress: ProgressView | null;
};

/**
 * `no_access`: the credential cannot read runs; `rate_limited`: GitHub asked us to wait;
 * `unavailable`: GitHub did not answer; `unsupported`: this connection cannot read CI.
 */
export type ProblemReason = 'no_access' | 'rate_limited' | 'unavailable' | 'unsupported';
export type ActiveProblem = { repositoryId: string; reason: ProblemReason };

export type ActiveRuns = {
  runs: ActiveRun[];
  /** Finished in the last 24 hours: runs that failed first, then the newest. At most 20. */
  recent: ActiveRun[];
  /** The repositories this answer covers. */
  repositories: { id: string; owner: string; repo: string }[];
  /** Repositories GitHub could not be read for, with a reason from a short fixed list (never GitHub's text). */
  problems: ActiveProblem[];
  /** Newest successful read of GitHub among the repositories, or null. */
  refreshedAt: number | null;
  /** True when GitHub was asked (the caller may scan); false when this is only what is stored. */
  live: boolean;
  cached: boolean;
};

// ---------------------------------------------------------------------------------------------
// Progress, from the jobs

/** What a person following a run wants to see in one line: how many jobs are done, and where it is now. */
export function summarizeJobs(jobs: readonly CiJob[], readAt: number): ProgressView | null {
  if (jobs.length === 0) return null;
  const done = jobs.filter((j) => j.status === 'completed').length;
  const current = jobs.find((j) => j.status === 'in_progress');
  const step = current?.steps.find((s) => s.status === 'in_progress');
  const stepsOf = (job: CiJob) => ({
    total: job.steps.length,
    done: job.steps.filter((s) => s.status === 'completed').length,
  });
  let sum = 0;
  for (const job of jobs) {
    if (job.status === 'completed') sum += 1;
    else if (job.status === 'in_progress') {
      const { total, done: finished } = stepsOf(job);
      sum += total > 0 ? finished / total : 0;
    }
  }
  const here = current ? stepsOf(current) : { total: 0, done: 0 };
  return {
    jobsTotal: jobs.length,
    jobsDone: done,
    job: current?.name ?? null,
    step: step?.name ?? null,
    stepsDone: here.done,
    stepsTotal: here.total,
    fraction: Math.min(1, Math.max(0, sum / jobs.length)),
    readAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Caches: answers, work in flight, and repositories to leave alone for a while

type Computed = Omit<ActiveRuns, 'cached'>;
const answers = new Map<string, { at: number; value: Computed }>();
const inFlight = new Map<string, Promise<Computed>>();
const trouble = new Map<string, { reason: ProblemReason; until: number }>();
const MAX_ANSWERS = 200;

/** For tests. */
export function clearActiveCaches(): void {
  answers.clear();
  inFlight.clear();
  trouble.clear();
}

const PERMANENT = new Set([
  'github_auth',
  'github_forbidden',
  'github_not_found',
  'credential_not_found',
  'credential_kind',
  'credential_unreadable',
  'local_only',
]);

function troubleOf(failure: Failure, now: number): { reason: ProblemReason; until: number } {
  const code = String(failure.body.error);
  if (failure.status === 429) {
    const wait = Math.max(1, Number(failure.body.retryAfterSeconds ?? 60));
    return { reason: 'rate_limited', until: now + wait * 1000 };
  }
  if (code === 'ci_unsupported') return { reason: 'unsupported', until: now + PROBLEM_BACKOFF_MS };
  if (PERMANENT.has(code)) return { reason: 'no_access', until: now + PROBLEM_BACKOFF_MS };
  return { reason: 'unavailable', until: now + TRANSIENT_BACKOFF_MS };
}

// ---------------------------------------------------------------------------------------------

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** Failed runs first, then the others, each newest first. */
export const recentOrder = (a: WorkflowRunView, b: WorkflowRunView): number =>
  Number(FAILED.has(b.conclusion ?? '')) - Number(FAILED.has(a.conclusion ?? '')) ||
  b.updatedAt - a.updatedAt ||
  b.id.localeCompare(a.id);

export type ActiveInput = {
  workspaceId: string;
  /** The caller may ask GitHub (`repositories.scan`). Otherwise only the stored runs are listed. */
  canScan: boolean;
  /** Only these repositories (those that exist in the workspace). */
  repositoryIds?: readonly string[] | undefined;
  /** An API token limited to these apps: only their repositories, and runs that belong to no app or to one of them. */
  appIds?: readonly string[] | null | undefined;
};

async function appRepositories(
  ctx: CiContext,
  workspaceId: string,
  appIds: readonly string[],
): Promise<Set<string>> {
  if (appIds.length === 0) return new Set();
  const rows = await ctx.db.query(
    `SELECT repository_id FROM apps WHERE workspace_id = ? AND repository_id IS NOT NULL AND id IN (${appIds.map(() => '?').join(', ')})`,
    [workspaceId, ...appIds],
  );
  return new Set(rows.map((r) => String(r.repository_id)));
}

export async function listActiveRuns(
  ctx: CiContext,
  input: ActiveInput,
  actor: Actor,
): Promise<ActiveRuns> {
  const { workspaceId } = input;
  const all = (await listRepositories(ctx.db, workspaceId)).filter((r) => !r.localOnly);
  const allowedRepos = input.appIds
    ? await appRepositories(ctx, workspaceId, input.appIds)
    : undefined;
  const wanted = input.repositoryIds ? new Set(input.repositoryIds) : undefined;
  const repositories = all
    .filter(
      (r) =>
        (wanted === undefined || wanted.has(r.id)) &&
        (allowedRepos === undefined || allowedRepos.has(r.id)),
    )
    .slice(0, 100);

  const key = [
    workspaceId,
    input.canScan ? 'scan' : 'read',
    input.appIds ? [...input.appIds].sort().join(',') : '*',
    repositories
      .map((r) => r.id)
      .sort()
      .join(','),
  ].join('|');
  const hit = answers.get(key);
  if (hit && ctx.now() - hit.at < ACTIVE_CACHE_TTL_MS) return { ...hit.value, cached: true };
  const running = inFlight.get(key);
  if (running) return { ...(await running), cached: true };

  const work = compute(ctx, input, repositories, actor).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  const value = await work;
  answers.set(key, { at: ctx.now(), value });
  while (answers.size > MAX_ANSWERS) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
  return { ...value, cached: false };
}

async function inBatches<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size)
    await Promise.all(items.slice(i, i + size).map(work));
}

async function compute(
  ctx: CiContext,
  input: ActiveInput,
  repositories: Repository[],
  actor: Actor,
): Promise<Computed> {
  const { workspaceId } = input;
  const byId = new Map(repositories.map((r) => [r.id, r]));
  const ids = repositories.map((r) => r.id);

  // 1. Ask GitHub, for who may, about the repositories that are due.
  if (input.canScan && ids.length > 0) {
    const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
    const goingRows = await ctx.db.query(
      `SELECT DISTINCT repository_id FROM workflow_runs
        WHERE workspace_id = ? AND repository_id IN (${ids.map(() => '?').join(', ')}) AND status IN (${marks})`,
      [workspaceId, ...ids, ...ACTIVE_STATUSES],
    );
    const going = new Set(goingRows.map((r) => String(r.repository_id)));
    const at = ctx.now();
    const due = repositories
      .filter((r) => {
        if ((trouble.get(r.id)?.until ?? 0) > at) return false;
        const last = lastRefreshAttempt(r.id);
        return (
          last === undefined || at - last >= (going.has(r.id) ? MIN_REFRESH_MS : IDLE_REFRESH_MS)
        );
      })
      .sort((a, b) => (lastRefreshAttempt(a.id) ?? 0) - (lastRefreshAttempt(b.id) ?? 0))
      .slice(0, MAX_REPOS_PER_ROUND);
    await inBatches(due, READ_PARALLEL, async (repository) => {
      const done = await refreshRuns(ctx, { workspaceId, repository, tags: 'skip' }, actor);
      if (done.ok) trouble.delete(repository.id);
      else trouble.set(repository.id, troubleOf(done, ctx.now()));
    });
  }

  // 2. Read what is stored.
  const now = ctx.now();
  const rows = await listWorkspaceRuns(ctx.db, workspaceId, ids, {
    finishedSince: now - RECENT_WINDOW_MS,
  });
  const visible = (r: WorkflowRunView) =>
    input.appIds === undefined ||
    input.appIds === null ||
    r.appIds.length === 0 ||
    r.appIds.some((id) => (input.appIds as readonly string[]).includes(id));
  const active = rows.active.filter(visible);
  const finished = rows.finished.filter(visible).sort(recentOrder).slice(0, MAX_RECENT_RUNS);

  // 3. Progress of the runs in progress: read for who may scan, else what anyone read lately.
  const progress = new Map<string, ProgressView | null>();
  let limited = false;
  const inProgress = active.filter((r) => r.status === 'in_progress').slice(0, MAX_JOB_READS);
  await inBatches(inProgress, READ_PARALLEL, async (run) => {
    const repository = byId.get(run.repositoryId);
    if (!repository) return;
    const mine = `${run.repositoryId}/${run.id}`;
    if (!input.canScan || limited) {
      const cached = cachedRunJobs(run.repositoryId, run.id, ctx.now());
      progress.set(mine, cached ? summarizeJobs(cached.jobs, cached.readAt) : null);
      return;
    }
    const read = await readRunJobs(
      ctx,
      { workspaceId, repository, runId: run.id, active: true },
      actor,
    );
    if (read.ok) progress.set(mine, summarizeJobs(read.jobs.jobs, read.jobs.readAt));
    else if (read.status === 429) limited = true;
  });

  const decorate = (run: WorkflowRunView): ActiveRun => {
    const repository = byId.get(run.repositoryId) as Repository;
    return {
      ...run,
      repository: { id: repository.id, owner: repository.owner, repo: repository.repo },
      actor: runActor(run.repositoryId, run.id, now),
      progress: progress.get(`${run.repositoryId}/${run.id}`) ?? null,
    };
  };

  const problems: ActiveProblem[] = [];
  for (const repository of repositories) {
    const t = trouble.get(repository.id);
    if (t && t.until > now) problems.push({ repositoryId: repository.id, reason: t.reason });
  }
  const refreshedAt = repositories.reduce<number | null>((m, r) => {
    const at = lastRefreshSuccess(r.id);
    return at !== undefined && (m === null || at > m) ? at : m;
  }, null);

  return {
    runs: active.map(decorate),
    recent: finished.map(decorate),
    repositories: repositories.map((r) => ({ id: r.id, owner: r.owner, repo: r.repo })),
    problems,
    refreshedAt,
    live: input.canScan,
  };
}
