import { type ActorType, DEFAULT_RELEASE_PATTERNS, DEFAULT_TAG_PATTERNS, type Platform } from '@mrm/core';
import type {
  CiJob,
  CiJobList,
  CiRun,
  CiRunPage,
  CiWorkflow,
  CommitComparison,
  DispatchResult,
  ListWorkflowRunsOptions,
} from '@mrm/connectors';
import { type JobHandler, enqueue } from '../jobs.ts';
import { type ManagedApp, getApp, listAppReleases } from './apps.ts';
import { recordAudit } from './audit.ts';
import {
  type BuildConventions,
  type EffectiveConventions,
  type StoredConventions,
  effectiveConventions,
  listConventions,
  saveConventions,
} from './build-conventions.ts';
import {
  type ReadTagData,
  type ScanApp,
  type StoredScan,
  type TagClient,
  clearScanCaches,
  getScan,
  isTagClient,
  readTagData,
  scanBuildTags,
} from './build-scan.ts';
import {
  type BuildMatcher,
  type BuildView,
  buildKey,
  buildViews,
  buildsFromReleases,
  defaultMatchers,
  listBuildLinks,
  loadRunRefs,
  previousLinkedBuild,
  putBuildLink,
  relinkApp,
  removeBuildLink,
} from './build-links.ts';
import {
  REFRESH_PAGE_SIZE,
  type StoreResult,
  type WorkflowRunView,
  countActiveRuns,
  getRunView,
  firstLine,
  pruneRuns,
  recordDispatch,
  storeRuns,
} from './ci-runs.ts';
import { type TestLimiter, createTestLimiter } from './credential-tests.ts';
import {
  type Failure,
  type Outcome,
  type RepoClient,
  type RepoContext,
  type Repository,
  failure,
  getRepository,
  githubFailure,
  isTimeoutError,
  openConnector,
  withTimeout,
} from './repositories.ts';
import { timedCache } from './timed-cache.ts';
import { type WorkflowDispatchInfo, parseWorkflowDispatch } from './workflow-inputs.ts';

type Actor = { type: ActorType; id: string };

export const CI_POLL_QUEUE = 'ci.poll';
/** How long a workflow list or a workflow's inputs are kept before GitHub is asked again. */
export const WORKFLOW_CACHE_TTL_MS = 60_000;
/** Two reads of one repository's runs are at least this far apart, whoever asks. */
export const MIN_REFRESH_MS = 8_000;
/** A comparison of two commits never changes, so it is kept long. */
export const COMPARE_CACHE_TTL_MS = 10 * 60_000;
/** `ci.poll` stops after this long, even when a run is still going. GitHub runs end within 6 hours. */
export const DEFAULT_POLL_MAX_MS = 3 * 60 * 60_000;
/** Reads of the workspace-wide "running now" list per workspace per minute (cached answers count too). */
export const ACTIVE_LIMIT_PER_MINUTE = 60;
/** Dispatches per workspace per minute (a refused one counts too). Reads are cached and spaced instead. */
export const CI_LIMIT_PER_MINUTE = 10;
/** "Re-run matching" requests per workspace per minute. */
export const REMATCH_LIMIT_PER_MINUTE = 6;
const POLL_FIRST_DELAY_MS = 5_000;
const MAX_STALE_RUNS_FETCHED = 10;

/** What the CI services need: the repository context plus a rate limit and the build matchers. */
export type CiContext = RepoContext & {
  /** Dispatches per workspace per minute. Reads from the stored table are not counted. */
  limiter: TestLimiter;
  /** Re-run matching reads several things from GitHub: its own, smaller budget per workspace. */
  rematchLimiter: TestLimiter;
  /** Reads of `GET /ci/runs/active` per workspace. */
  activeLimiter: TestLimiter;
  matchers: BuildMatcher[];
  pollMaxMs: number;
};

export function createCiContext(
  base: RepoContext,
  options: Partial<Pick<CiContext, 'limiter' | 'rematchLimiter' | 'activeLimiter' | 'matchers' | 'pollMaxMs'>> = {},
): CiContext {
  return {
    ...base,
    limiter: options.limiter ?? createTestLimiter({ limit: CI_LIMIT_PER_MINUTE, now: base.now }),
    rematchLimiter: options.rematchLimiter ?? createTestLimiter({ limit: REMATCH_LIMIT_PER_MINUTE, now: base.now }),
    activeLimiter: options.activeLimiter ?? createTestLimiter({ limit: ACTIVE_LIMIT_PER_MINUTE, now: base.now }),
    matchers: options.matchers ?? defaultMatchers(),
    pollMaxMs: options.pollMaxMs ?? DEFAULT_POLL_MAX_MS,
  };
}

// ---------------------------------------------------------------------------------------------
// The connector

/**
 * The GitHub connector's CI reads. A fake in tests implements the same four methods. The tag,
 * release and commit reads (`TagClient`) are optional: without them a build can only be linked
 * through the run itself (dispatch input, title), and the scan says so.
 */
export type CiClient = RepoClient &
  Partial<TagClient> & {
    listWorkflows(signal?: AbortSignal): Promise<CiWorkflow[]>;
    listCiRuns(options?: ListWorkflowRunsOptions & { signal?: AbortSignal }): Promise<CiRun[]>;
    getCiRun(runId: string, signal?: AbortSignal): Promise<CiRun | undefined>;
    /** Conditional read of the runs (ETag). A client without it is read with `listCiRuns` every time. */
    listCiRunsPage?(
      options?: ListWorkflowRunsOptions & { signal?: AbortSignal; etag?: string | undefined },
    ): Promise<CiRunPage>;
    /** The jobs and steps of a run (no logs). A client without it cannot show job progress. */
    listRunJobs?(runId: string, options?: { signal?: AbortSignal; etag?: string | undefined }): Promise<CiJobList>;
    compareCommits(
      base: string,
      head: string,
      options?: { limit?: number; signal?: AbortSignal },
    ): Promise<CommitComparison>;
  };

const isCiClient = (c: RepoClient): c is CiClient => {
  const x = c as Partial<CiClient>;
  return (
    typeof x.listWorkflows === 'function' &&
    typeof x.listCiRuns === 'function' &&
    typeof x.getCiRun === 'function' &&
    typeof x.compareCommits === 'function'
  );
};

export type Opened = { client: CiClient; secret: string };

export async function openCi(
  ctx: CiContext,
  workspaceId: string,
  repository: Repository,
  actor: Actor,
  purpose: string,
): Promise<Outcome<Opened>> {
  const opened = await openConnector(
    ctx,
    {
      workspaceId,
      credentialId: repository.credentialId,
      owner: repository.owner,
      repo: repository.repo,
    },
    actor,
    purpose,
  );
  if (!opened.ok) return opened;
  if (!isCiClient(opened.connector)) {
    return failure(422, 'ci_unsupported', 'This repository connection cannot read CI runs.');
  }
  return { ok: true, client: opened.connector, secret: opened.secret };
}

/** Runs one GitHub read under the request time limit; a timeout also cancels the request. */
export async function guarded<T>(
  ctx: CiContext,
  secret: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | Failure> {
  const controller = new AbortController();
  try {
    const value = await withTimeout(work(controller.signal), ctx.timeoutMs, () => controller.abort());
    return { ok: true, value };
  } catch (error) {
    return githubFailure(error, secret);
  }
}

const rateLimited = (wait: number): Failure => ({
  ...failure(429, 'rate_limited', `Too many CI requests. Try again in ${wait} seconds.`, {
    retryAfterSeconds: wait,
  }),
  headers: { 'Retry-After': String(wait) },
});

// ---------------------------------------------------------------------------------------------
// Short-lived in-memory caches (per process, like repo-snapshot.ts)

type WorkflowInputs = WorkflowDispatchInfo & { workflow: CiWorkflow; ref: string };

const workflowCache = timedCache<CiWorkflow[]>(WORKFLOW_CACHE_TTL_MS, 100);
const inputsCache = timedCache<WorkflowInputs>(WORKFLOW_CACHE_TTL_MS, 200);
const compareCache = timedCache<CommitComparison>(COMPARE_CACHE_TTL_MS, 200);
const previewCache = timedCache<RepositoryTags>(WORKFLOW_CACHE_TTL_MS, 50);
/** When the runs of a repository were last asked for (success or not), and last read successfully. */
const lastAttempt = new Map<string, number>();
const lastSuccess = new Map<string, number>();
const refreshing = new Map<string, Promise<Outcome<{ refreshed: boolean; refreshedAt: number | null }>>>();
/** The ETag of the last read of a repository's runs (the first page), so the next read can be conditional. */
const runEtags = new Map<string, string>();
/** The run ids of that page, for a 304 (which carries no runs): an active run not among them is asked for one by one. */
const runPageIds = new Map<string, Set<string>>();
/** Who started a run on GitHub. The table has no column for it, so it is kept for a day in memory. */
const actorCache = timedCache<string>(24 * 60 * 60_000, 2_000);
const jobsStore = timedCache<JobsEntry>(30 * 60_000, 500);
const jobsInFlight = new Map<string, Promise<Outcome<{ jobs: RunJobs; cached: boolean }>>>();

/** For tests. */
export function clearCiCaches(): void {
  clearScanCaches();
  previewCache.clear();
  workflowCache.clear();
  inputsCache.clear();
  compareCache.clear();
  lastAttempt.clear();
  lastSuccess.clear();
  refreshing.clear();
  runEtags.clear();
  runPageIds.clear();
  jobsStore.clear();
  jobsInFlight.clear();
  actorCache.clear();
}

/** When the runs of a repository were last asked for (a try counts, as does a failure), or undefined. */
export const lastRefreshAttempt = (repositoryId: string): number | undefined => lastAttempt.get(repositoryId);
/** When the runs of a repository were last read from GitHub successfully, or undefined. */
export const lastRefreshSuccess = (repositoryId: string): number | undefined => lastSuccess.get(repositoryId);

/** The GitHub login that started a run, when a read since the last restart saw it. */
export const runActor = (repositoryId: string, runId: string, now: number): string | null =>
  actorCache.get(`${repositoryId}\u0000${runId}`, now) ?? null;

function rememberActors(repositoryId: string, runs: readonly CiRun[], now: number): void {
  for (const run of runs) if (run.actor) actorCache.set(`${repositoryId}\u0000${run.id}`, run.actor, now);
}

// ---------------------------------------------------------------------------------------------
// Workflows

const sameWorkflow = (w: CiWorkflow, wanted: string) =>
  w.id === wanted || w.path === wanted || w.path.split('/').pop() === wanted;

async function loadWorkflows(
  ctx: CiContext,
  workspaceId: string,
  repository: Repository,
  actor: Actor,
): Promise<Outcome<{ workflows: CiWorkflow[]; cached: boolean; opened?: Opened }>> {
  const hit = workflowCache.get(repository.id, ctx.now());
  if (hit) return { ok: true, workflows: hit, cached: true };
  const opened = await openCi(ctx, workspaceId, repository, actor, 'ci.workflows');
  if (!opened.ok) return opened;
  const read = await guarded(ctx, opened.secret, (signal) => opened.client.listWorkflows(signal));
  if (!read.ok) return read;
  workflowCache.set(repository.id, read.value, ctx.now());
  return { ok: true, workflows: read.value, cached: false, opened: { client: opened.client, secret: opened.secret } };
}

export async function listWorkflows(
  ctx: CiContext,
  input: { workspaceId: string; repositoryId: string },
  actor: Actor,
): Promise<Outcome<{ workflows: CiWorkflow[]; cached: boolean }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const done = await loadWorkflows(ctx, input.workspaceId, repository, actor);
  if (!done.ok) return done;
  return { ok: true, workflows: done.workflows, cached: done.cached };
}

/** One workflow with the inputs its `workflow_dispatch` trigger declares, read from its file. */
export async function getWorkflowInputs(
  ctx: CiContext,
  input: { workspaceId: string; repositoryId: string; workflow: string; ref?: string | undefined },
  actor: Actor,
): Promise<Outcome<WorkflowInputs & { cached: boolean }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const ref = input.ref ?? repository.defaultBranch;
  const key = `${repository.id}\u0000${input.workflow}\u0000${ref}`;
  const hit = inputsCache.get(key, ctx.now());
  if (hit) return { ok: true, ...hit, cached: true };

  const listed = await loadWorkflows(ctx, input.workspaceId, repository, actor);
  if (!listed.ok) return listed;
  const workflow = listed.workflows.find((w) => sameWorkflow(w, input.workflow));
  if (!workflow) {
    return failure(404, 'workflow_not_found', `${repository.owner}/${repository.repo} has no workflow ${input.workflow}.`);
  }
  const opened: Outcome<Opened> = listed.opened
    ? { ok: true, ...listed.opened }
    : await openCi(ctx, input.workspaceId, repository, actor, 'ci.workflow_inputs');
  if (!opened.ok) return opened;
  const read = await guarded(ctx, opened.secret, () => opened.client.readFile(workflow.path, ref));
  if (!read.ok) return read;
  const info: WorkflowDispatchInfo =
    read.value === undefined
      ? { dispatchable: null, parsed: false, inputs: [] }
      : parseWorkflowDispatch(read.value);
  const value: WorkflowInputs = { workflow, ref, ...info };
  inputsCache.set(key, value, ctx.now());
  return { ok: true, ...value, cached: false };
}

// ---------------------------------------------------------------------------------------------
// Dispatch

export type DispatchInput = {
  workspaceId: string;
  repositoryId: string;
  /** A workflow file name (`ios.yml`) or id. */
  workflow: string;
  /** A branch or tag. Default: the repository's default branch. */
  ref?: string | undefined;
  inputs?: Record<string, string> | undefined;
  /** The app this run builds, when it is for one. Lets the run be linked to that app's builds. Same as `appIds: [appId]`. */
  appId?: string | undefined;
  /**
   * The apps this run builds: one workflow can build one app or several that share the repository. Each must be an app of
   * the workspace linked to the repository. With `appId` as well, the two are joined.
   */
  appIds?: readonly string[] | undefined;
};

/**
 * Starts a workflow on GitHub. This is the one thing here that changes anything outside this
 * database: it runs the team's CI with the team's secrets. It is rate limited per workspace and
 * audited whether it works or not (`ci.dispatch`, with the names of the inputs, never their
 * values). The run is stored at once (a placeholder when GitHub does not name it) and `ci.poll`
 * follows it.
 */
export async function dispatchRun(
  ctx: CiContext,
  input: DispatchInput,
  actor: Actor,
): Promise<Outcome<{ run: WorkflowRunView; runKnown: boolean }>> {
  const { workspaceId } = input;
  const repository = await getRepository(ctx.db, workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const appIds: string[] = [];
  for (const id of [...(input.appId !== undefined ? [input.appId] : []), ...(input.appIds ?? [])]) {
    if (appIds.indexOf(id) === -1) appIds.push(id);
  }
  appIds.sort();
  for (const id of appIds) {
    const app = await getApp(ctx.db, workspaceId, id);
    if (!app) return failure(422, 'app_not_found', 'That app is not in this workspace.');
    if (app.repositoryId !== repository.id) {
      return failure(422, 'app_repository_mismatch', 'That app is not linked to this repository.');
    }
  }
  const wait = ctx.limiter.take(workspaceId);
  if (wait > 0) return rateLimited(wait);

  const opened = await openCi(ctx, workspaceId, repository, actor, 'ci.dispatch');
  if (!opened.ok) return opened;
  const ref = input.ref ?? repository.defaultBranch;
  const inputs = input.inputs ?? {};
  const audit = (detail: Record<string, unknown>) => ({
    workspaceId,
    actor,
    action: 'ci.dispatch',
    target: { type: 'repository', id: repository.id },
    detail: {
      workflow: input.workflow,
      ref,
      inputs: Object.keys(inputs).sort(),
      ...(appIds[0] ? { appId: appIds[0] } : {}),
      ...(appIds.length > 1 ? { appIds } : {}),
      ...detail,
    },
    at: ctx.now(),
  });

  let result: DispatchResult;
  try {
    result = await withTimeout(opened.client.dispatchWorkflow(input.workflow, ref, inputs), ctx.timeoutMs);
  } catch (error) {
    const failed = isTimeoutError(error)
      ? failure(
          504,
          'timeout',
          'GitHub did not answer in time. The workflow may still have started: look at the runs before trying again.',
        )
      : githubFailure(error, opened.secret);
    await recordAudit(ctx.db, audit({ ok: false, code: failed.body.error }));
    return failed;
  }

  const now = ctx.now();
  const run = await ctx.db.transaction(async (tx) => {
    const stored = await recordDispatch(tx, {
      workspaceId,
      repositoryId: repository.id,
      appId: appIds[0] ?? null,
      appIds,
      workflow: input.workflow,
      ref,
      inputs,
      dispatchedBy: actor.id,
      now,
      runId: result.runId,
      runUrl: result.runUrl,
    });
    await recordAudit(tx, audit({ ok: true, ...(result.runId ? { runId: result.runId } : {}) }));
    return stored;
  });
  await enqueueCiPoll(
    ctx,
    { workspaceId, repositoryId: repository.id, startedAt: now, attempt: 0, requestedBy: actor.id },
    POLL_FIRST_DELAY_MS,
  );
  return { ok: true, run, runKnown: result.runId !== undefined };
}

// ---------------------------------------------------------------------------------------------
// Runs: refresh

/**
 * Reads the repository's recent runs from GitHub into `workflow_runs`, settles stored runs that
 * dropped out of that page, links builds to the runs that name them, and prunes old rows. Reads
 * of one repository are at least `MIN_REFRESH_MS` apart whoever asks (the UI and `ci.poll` share
 * that), and two at once share one request. `force` skips the spacing.
 */
export async function refreshRuns(
  ctx: CiContext,
  input: { workspaceId: string; repository: Repository; force?: boolean; tags?: 'auto' | 'skip' },
  actor: Actor,
): Promise<Outcome<{ refreshed: boolean; refreshedAt: number | null }>> {
  const { repository } = input;
  const now = ctx.now();
  const last = lastAttempt.get(repository.id);
  if (!input.force && last !== undefined && now - last < MIN_REFRESH_MS) {
    return { ok: true, refreshed: false, refreshedAt: lastSuccess.get(repository.id) ?? null };
  }
  const running = refreshing.get(repository.id);
  if (running) return running;
  lastAttempt.set(repository.id, now);
  const work = readRuns(ctx, input.workspaceId, repository, actor, input.tags ?? 'auto').finally(() => {
    refreshing.delete(repository.id);
  });
  refreshing.set(repository.id, work);
  return work;
}

async function readRuns(
  ctx: CiContext,
  workspaceId: string,
  repository: Repository,
  actor: Actor,
  tags: 'auto' | 'skip',
): Promise<Outcome<{ refreshed: boolean; refreshedAt: number | null }>> {
  const opened = await openCi(ctx, workspaceId, repository, actor, CI_POLL_QUEUE);
  if (!opened.ok) return opened;
  const { client } = opened;
  const read = await guarded(ctx, opened.secret, async (signal) => {
    // A conditional read when the client can: GitHub answers 304 (free of the rate limit) while nothing changed.
    let runs: CiRun[];
    let notModified = false;
    let etag: string | undefined;
    if (client.listCiRunsPage) {
      const page = await client.listCiRunsPage({ limit: REFRESH_PAGE_SIZE, signal, etag: runEtags.get(repository.id) });
      runs = page.runs;
      notModified = page.notModified;
      etag = page.etag;
    } else {
      runs = await client.listCiRuns({ limit: REFRESH_PAGE_SIZE, signal });
    }
    // Active runs that fell off the page (a busy repository) are asked for one by one.
    const seen = notModified ? (runPageIds.get(repository.id) ?? new Set<string>()) : new Set(runs.map((r) => r.id));
    if (!notModified) runPageIds.set(repository.id, seen);
    const stale = await ctx.db.query(
      `SELECT run_id FROM workflow_runs
        WHERE workspace_id = ? AND repository_id = ? AND status IN ('queued', 'in_progress', 'waiting', 'requested')`,
      [workspaceId, repository.id],
    );
    const missing: string[] = [];
    for (const row of stale) {
      const id = String(row.run_id);
      if (!seen.has(id) && missing.length < MAX_STALE_RUNS_FETCHED) missing.push(id);
    }
    const settled: { id: string; run: CiRun | undefined }[] = [];
    for (const id of missing) settled.push({ id, run: await client.getCiRun(id, signal) });
    return { runs, settled, notModified, etag };
  });
  if (!read.ok) return read;
  if (read.value.etag) runEtags.set(repository.id, read.value.etag);
  else runEtags.delete(repository.id);

  const now = ctx.now();
  const fetched = [...read.value.runs, ...read.value.settled.flatMap((s) => (s.run ? [s.run] : []))];
  rememberActors(repository.id, fetched, now);
  await ctx.db.transaction(async (tx) => {
    await storeRuns(tx, { workspaceId, repositoryId: repository.id, runs: fetched, now });
    for (const gone of read.value.settled.filter((s) => s.run === undefined)) {
      // GitHub no longer has the run (deleted): stop waiting for it.
      await tx.execute(
        `UPDATE workflow_runs SET status = 'completed', conclusion = 'unknown', synced_at = ?
          WHERE repository_id = ? AND run_id = ?`,
        [now, repository.id, gone.id],
      );
    }
    // Nothing changed on GitHub (a 304) and nothing was settled by hand: there is nothing to prune or to link again.
    if (read.value.notModified && read.value.settled.length === 0) return;
    await pruneRuns(tx, { workspaceId, repositoryId: repository.id, now });
    const linked = await tx.query(
      'SELECT id FROM apps WHERE workspace_id = ? AND repository_id = ?',
      [workspaceId, repository.id],
    );
    for (const row of linked) {
      const app = await getApp(tx, workspaceId, String(row.id));
      if (app) await relinkApp(tx, { app, matchers: ctx.matchers, now });
    }
  });
  lastSuccess.set(repository.id, now);
  // Builds the runs themselves do not name are followed through their tags. A failure here is
  // kept with the scan and never fails the refresh of the runs.
  if (tags === 'auto') {
    await guarded(ctx, opened.secret, (signal) =>
      scanBuildTags({
        db: ctx.db,
        workspaceId,
        repositoryId: repository.id,
        client,
        matchers: ctx.matchers,
        now: ctx.now(),
        signal,
        describeError: (error) => describeGithubError(error, opened.secret),
      }),
    );
  }
  return { ok: true, refreshed: true, refreshedAt: now };
}

/** A GitHub error as text for a person (and for `build_scans.error`). */
function describeGithubError(error: unknown, secret: string): string {
  try {
    const failed = githubFailure(error, secret);
    return String(failed.body.message ?? failed.body.error).slice(0, 300);
  } catch {
    return 'Could not read the tags and releases.';
  }
}

/** One run read from GitHub and stored; for a run id the table does not have yet. */
export async function fetchRun(
  ctx: CiContext,
  input: { workspaceId: string; repository: Repository; runId: string },
  actor: Actor,
): Promise<Outcome<{ run: WorkflowRunView }>> {
  const opened = await openCi(ctx, input.workspaceId, input.repository, actor, 'ci.run');
  if (!opened.ok) return opened;
  const read = await guarded(ctx, opened.secret, (signal) =>
    opened.client.getCiRun(input.runId, signal),
  );
  if (!read.ok) return read;
  if (!read.value) return failure(404, 'not_found');
  const now = ctx.now();
  rememberActors(input.repository.id, [read.value as CiRun], now);
  await ctx.db.transaction((tx) =>
    storeRuns(tx, {
      workspaceId: input.workspaceId,
      repositoryId: input.repository.id,
      runs: [read.value as CiRun],
      now,
    }),
  );
  const run = await getRunView(ctx.db, input.workspaceId, input.repository.id, input.runId);
  return run ? { ok: true, run } : failure(404, 'not_found');
}

// ---------------------------------------------------------------------------------------------
// Jobs of a run (what a person following the run sees: names, states, times; never logs)

/** An active run's jobs are read again after this long; a finished run's after `JOBS_TTL_DONE_MS`. */
export const JOBS_TTL_ACTIVE_MS = 10_000;
export const JOBS_TTL_DONE_MS = 2 * 60_000;

export type RunJobs = { jobs: CiJob[]; truncated: boolean; readAt: number };
type JobsEntry = RunJobs & { etag?: string };

const jobsKey = (repositoryId: string, runId: string) => `${repositoryId}\u0000${runId}`;

/** The jobs as last read by anyone (up to 30 minutes ago), without asking GitHub: what a viewer may see. */
export const cachedRunJobs = (repositoryId: string, runId: string, now: number): RunJobs | null => {
  const hit = jobsStore.get(jobsKey(repositoryId, runId), now);
  return hit ? { jobs: hit.jobs, truncated: hit.truncated, readAt: hit.readAt } : null;
};

/**
 * Reads the jobs and steps of one run. Kept for 10 seconds while the run is active and 2 minutes
 * after it finished, two requests at once share one read, and the read is conditional (ETag) so an
 * unchanged answer is a free 304. Needs a connection that can read CI (`422 ci_unsupported`).
 */
export async function readRunJobs(
  ctx: CiContext,
  input: { workspaceId: string; repository: Repository; runId: string; active: boolean },
  actor: Actor,
): Promise<Outcome<{ jobs: RunJobs; cached: boolean }>> {
  const key = jobsKey(input.repository.id, input.runId);
  const ttl = input.active ? JOBS_TTL_ACTIVE_MS : JOBS_TTL_DONE_MS;
  const entry = jobsStore.get(key, ctx.now());
  if (entry && ctx.now() - entry.readAt < ttl) {
    return { ok: true, jobs: { jobs: entry.jobs, truncated: entry.truncated, readAt: entry.readAt }, cached: true };
  }
  const running = jobsInFlight.get(key);
  if (running) return running;
  const work = (async (): Promise<Outcome<{ jobs: RunJobs; cached: boolean }>> => {
    const opened = await openCi(ctx, input.workspaceId, input.repository, actor, 'ci.jobs');
    if (!opened.ok) return opened;
    const { client } = opened;
    if (!client.listRunJobs) return failure(422, 'ci_unsupported', 'This repository connection cannot read CI jobs.');
    const read = await guarded(ctx, opened.secret, (signal) =>
      (client.listRunJobs as NonNullable<CiClient['listRunJobs']>)(input.runId, { signal, etag: entry?.etag }),
    );
    if (!read.ok) return read;
    const now = ctx.now();
    const list = read.value;
    if (list.missing) return failure(404, 'not_found');
    const value: JobsEntry =
      list.notModified && entry
        ? { ...entry, readAt: now }
        : { jobs: list.jobs, truncated: list.truncated, readAt: now, ...(list.etag ? { etag: list.etag } : {}) };
    jobsStore.set(key, value, now);
    return { ok: true, jobs: { jobs: value.jobs, truncated: value.truncated, readAt: now }, cached: false };
  })().finally(() => {
    jobsInFlight.delete(key);
  });
  jobsInFlight.set(key, work);
  return work;
}

// ---------------------------------------------------------------------------------------------
// ci.poll

export type CiPollPayload = {
  workspaceId: string;
  repositoryId: string;
  /** When polling began; `pollMaxMs` counts from here. */
  startedAt: number;
  /** How many polls of this chain ran, for the backoff. */
  attempt: number;
  requestedBy: string;
};

/** 15 s, 22 s, 34 s, 51 s, then a minute. */
export const pollDelayMs = (attempt: number) => Math.min(Math.round(15_000 * 1.5 ** attempt), 60_000);

/**
 * Queues a poll of a repository's runs, unless one is already waiting for it. A poll that is
 * running right now does not count: it queues its own next one.
 */
export async function enqueueCiPoll(
  ctx: Pick<CiContext, 'db' | 'now'>,
  payload: CiPollPayload,
  delayMs = 0,
): Promise<string | undefined> {
  const waiting = await ctx.db.query(
    "SELECT id FROM jobs WHERE queue = ? AND status = 'queued' AND payload LIKE ?",
    [CI_POLL_QUEUE, `%"repositoryId":"${payload.repositoryId}"%`],
  );
  if (waiting.length > 0) return undefined;
  const now = ctx.now();
  return enqueue(ctx.db, CI_POLL_QUEUE, payload, { now, runAt: now + delayMs });
}

const isPollPayload = (v: unknown): v is CiPollPayload => {
  const p = v as Partial<CiPollPayload> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.workspaceId === 'string' &&
    typeof p.repositoryId === 'string' &&
    typeof p.startedAt === 'number' &&
    typeof p.attempt === 'number' &&
    typeof p.requestedBy === 'string'
  );
};

/**
 * The worker's handler for `ci.poll`: reads the repository's runs, and while any run is not
 * finished queues the next poll with a growing delay, until `pollMaxMs` after the first. A GitHub
 * rate limit waits for what GitHub asks; a temporary failure throws so the queue retries it with
 * backoff; a permanent one (bad credential, no access) is audited once and ends the chain.
 */
export function createCiPollHandler(ctx: CiContext): JobHandler {
  return async (payload) => {
    if (!isPollPayload(payload)) return;
    const { workspaceId, repositoryId } = payload;
    const repository = await getRepository(ctx.db, workspaceId, repositoryId);
    if (!repository) return;
    const actor: Actor = { type: 'system', id: CI_POLL_QUEUE };
    const target = { type: 'repository', id: repositoryId };
    const deadline = payload.startedAt + ctx.pollMaxMs;
    const next = (delayMs: number) =>
      enqueueCiPoll(ctx, { ...payload, attempt: payload.attempt + 1 }, delayMs);

    const done = await refreshRuns(ctx, { workspaceId, repository, force: true }, actor);
    const now = ctx.now();
    if (!done.ok) {
      if (done.status === 429) {
        const wait = Math.max(1, Number(done.body.retryAfterSeconds ?? 60)) * 1000;
        if (now + wait < deadline) await next(wait);
        return;
      }
      if (done.status === 502 || done.status === 504) {
        throw new Error(String(done.body.message ?? done.body.error));
      }
      await recordAudit(ctx.db, {
        workspaceId,
        actor,
        action: CI_POLL_QUEUE,
        target,
        detail: { ok: false, code: done.body.error },
        at: now,
      });
      return;
    }
    const active = await countActiveRuns(ctx.db, workspaceId, repositoryId);
    if (active === 0) return;
    if (now >= deadline) {
      await recordAudit(ctx.db, {
        workspaceId,
        actor,
        action: CI_POLL_QUEUE,
        target,
        detail: { ok: true, ended: 'max_duration', active },
        at: now,
      });
      return;
    }
    await next(Math.min(pollDelayMs(payload.attempt), deadline - now));
  };
}

// ---------------------------------------------------------------------------------------------
// Builds

/** What the last search for tags saw and which patterns were tried: why a build may be unlinked. */
export type BuildDiagnostics = {
  /** When tags were last searched for this repository; null when never. */
  scannedAt: number | null;
  scanOk: boolean | null;
  scanError: string | null;
  patterns: {
    tags: string[];
    releases: string[];
    prefix: string;
    workflow: string | null;
    usingDefaults: boolean;
    source: EffectiveConventions['source'];
  };
  tags: { seen: number; truncated: boolean; sample: string[]; targeted: string[] } | null;
  releases: { seen: number; truncated: boolean; error: string | null } | null;
  newestRelease: { name: string | null; tag: string; at: number | null } | null;
  /** Names that fit a pattern, and the one with the highest number for this app's platform. */
  fitting: number;
  newestFit: { name: string; buildNumber: string } | null;
  runs: { stored: number; newestAt: number | null };
  /** False when the connection cannot read tags (a connector without the reads). */
  canReadTags: boolean;
};

export type AppBuilds = {
  app: ManagedApp;
  repository: { id: string; owner: string; repo: string } | null;
  matchers: { id: string; description: string }[];
  builds: BuildView[];
  diagnostics: BuildDiagnostics | null;
};

function diagnosticsOf(input: {
  conventions: EffectiveConventions;
  scan: StoredScan | undefined;
  entry: ScanApp | undefined;
  runs: readonly WorkflowRunView[];
}): BuildDiagnostics {
  const { conventions: c, scan, entry } = input;
  return {
    scannedAt: scan?.scannedAt ?? null,
    scanOk: scan ? scan.ok : null,
    scanError: scan?.error ?? null,
    patterns: {
      tags: c.tagPatterns,
      releases: c.releasePatterns,
      prefix: c.prefix,
      workflow: c.workflow,
      usingDefaults: c.usingDefaultTags && c.usingDefaultReleases,
      source: c.source,
    },
    tags: scan ? { seen: scan.summary.tags.seen, truncated: scan.summary.tags.truncated, sample: scan.summary.sampleTags, targeted: scan.summary.tags.targeted } : null,
    releases: scan ? scan.summary.releases : null,
    newestRelease: scan?.summary.newestRelease ?? null,
    fitting: entry?.fitting ?? 0,
    newestFit: entry?.newestFit ?? null,
    runs: { stored: input.runs.length, newestAt: input.runs.reduce<number | null>((m, r) => (m === null || r.startedAt > m ? r.startedAt : m), null) },
    canReadTags: true,
  };
}

async function viewsFor(
  ctx: Pick<CiContext, 'db' | 'matchers'>,
  workspaceId: string,
  app: ManagedApp,
): Promise<AppBuilds> {
  const repository = app.repositoryId
    ? await getRepository(ctx.db, workspaceId, app.repositoryId)
    : undefined;
  const [releases, links, runs, conventions, scan] = await Promise.all([
    listAppReleases(ctx.db, workspaceId, app.id),
    listBuildLinks(ctx.db, workspaceId, app.id),
    repository ? loadRunRefs(ctx.db, workspaceId, repository.id, app.id) : Promise.resolve([]),
    repository ? listConventions(ctx.db, workspaceId, repository.id) : Promise.resolve([]),
    repository ? getScan(ctx.db, workspaceId, repository.id) : Promise.resolve(undefined),
  ]);
  const effective = effectiveConventions(conventions, app.id);
  const entry = scan?.summary.apps[app.id];
  const builds = buildViews({
    builds: buildsFromReleases(releases),
    runs,
    links,
    matchers: ctx.matchers,
    repository: repository ? { owner: repository.owner, repo: repository.repo } : null,
  }).map((build): BuildView => {
    if (build.linkState !== 'unlinked' || !repository) return build;
    const reason = entry?.reasons[buildKey(build)];
    return { ...build, diagnostic: reason ?? unsearched(scan) };
  });
  return {
    app,
    repository: repository ? { id: repository.id, owner: repository.owner, repo: repository.repo } : null,
    matchers: ctx.matchers.map((m) => ({ id: m.id, description: m.description })),
    builds,
    diagnostics: repository ? diagnosticsOf({ conventions: effective, scan, entry, runs }) : null,
  };
}

/** The builds of an app with their linked runs and commits, from stored data only. */
export async function listAppBuilds(
  ctx: Pick<CiContext, 'db' | 'matchers'>,
  input: { workspaceId: string; appId: string },
): Promise<AppBuilds | undefined> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  return app ? viewsFor(ctx, input.workspaceId, app) : undefined;
}

export type BuildRefInput = { workspaceId: string; appId: string; platform: Platform; buildNumber: string };

/**
 * Links a build to a run by hand. It beats any matcher, and stays until `unlinkBuild`. The run
 * must be one of this app's repository (stored, or read from GitHub now) and have a commit.
 */
export async function linkBuildToRun(
  ctx: CiContext,
  input: BuildRefInput & { runId: string },
  actor: Actor,
): Promise<Outcome<{ build: BuildView }>> {
  const { workspaceId } = input;
  const app = await getApp(ctx.db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const repository = app.repositoryId ? await getRepository(ctx.db, workspaceId, app.repositoryId) : undefined;
  if (!repository) {
    return failure(422, 'no_repository', 'Link a repository to this app before linking its builds to CI runs.');
  }
  const current = await viewsFor(ctx, workspaceId, app);
  const exists = current.builds.some(
    (b) => b.platform === input.platform && b.buildNumber === input.buildNumber,
  );
  if (!exists) {
    return failure(422, 'build_not_found', `This app has no ${input.platform} build ${input.buildNumber}. Sync the app first.`);
  }
  if (input.platform !== app.platform) {
    return failure(422, 'build_not_found', `This app is an ${app.platform} app, so it has no ${input.platform} builds.`);
  }

  let run = await getRunView(ctx.db, workspaceId, repository.id, input.runId);
  if (!run) {
    const fetched = await fetchRun(ctx, { workspaceId, repository, runId: input.runId }, actor);
    if (!fetched.ok) {
      return fetched.status === 404
        ? failure(422, 'run_not_found', `${repository.owner}/${repository.repo} has no workflow run ${input.runId}.`)
        : fetched;
    }
    run = fetched.run;
  }
  if (!run.headSha) {
    return failure(422, 'run_without_commit', 'That run has no commit, so it cannot explain a build.');
  }
  const linkedRun = run;
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await putBuildLink(tx, {
      workspaceId,
      appId: app.id,
      platform: input.platform,
      buildNumber: input.buildNumber,
      repositoryId: repository.id,
      run: linkedRun,
      source: 'manual',
      reason: 'Linked by a person.',
      linkedBy: actor.id,
      now,
    });
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'build.link',
      target: { type: 'app', id: app.id },
      detail: {
        platform: input.platform,
        buildNumber: input.buildNumber,
        runId: linkedRun.id,
        sha: linkedRun.headSha,
      },
      at: now,
    });
  });
  const after = await viewsFor(ctx, workspaceId, app);
  const build = after.builds.find((b) => b.platform === input.platform && b.buildNumber === input.buildNumber);
  return { ok: true, build: build as BuildView };
}

/** Removes the manual link of a build; what the matchers find (or nothing) applies again. */
export async function unlinkBuild(
  ctx: CiContext,
  input: BuildRefInput,
  actor: Actor,
): Promise<Outcome<{ build: BuildView | null }>> {
  const { workspaceId } = input;
  const app = await getApp(ctx.db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const now = ctx.now();
  const removed = await ctx.db.transaction(async (tx) => {
    const done = await removeBuildLink(tx, { ...input, onlyManual: true });
    if (done) {
      await recordAudit(tx, {
        workspaceId,
        actor,
        action: 'build.unlink',
        target: { type: 'app', id: app.id },
        detail: { platform: input.platform, buildNumber: input.buildNumber },
        at: now,
      });
    }
    return done;
  });
  if (!removed) return failure(404, 'not_found');
  const after = await viewsFor(ctx, workspaceId, app);
  return {
    ok: true,
    build: after.builds.find((b) => b.platform === input.platform && b.buildNumber === input.buildNumber) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// What changed between two builds

export type ChangedCommit = {
  sha: string;
  shortSha: string;
  /** The first line of the message. */
  title: string;
  message: string;
  author: string | null;
  date: number | null;
  url: string | null;
};

export type BuildChanges = {
  platform: Platform;
  base: { buildNumber: string; version: string; sha: string; shortSha: string };
  head: { buildNumber: string; version: string; sha: string; shortSha: string };
  /** GitHub's word for how head relates to base: `ahead`, `behind`, `identical`, `diverged`. */
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  /** More commits than `commits` holds: the oldest were left out. */
  truncated: boolean;
  /** The compare page on GitHub. */
  url: string | null;
  /** Newest first. */
  commits: ChangedCommit[];
};

/**
 * The commits in `head` that are not in `base`, for two linked builds of one app (`base` defaults
 * to the build before `head` that has a commit). Read from the GitHub compare API and kept for
 * ten minutes by commit pair.
 */
export async function buildChanges(
  ctx: CiContext,
  input: BuildRefInput & { base?: string | undefined },
  actor: Actor,
): Promise<Outcome<{ changes: BuildChanges }>> {
  const { workspaceId } = input;
  const app = await getApp(ctx.db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const repository = app.repositoryId ? await getRepository(ctx.db, workspaceId, app.repositoryId) : undefined;
  if (!repository) {
    return failure(422, 'no_repository', 'Link a repository to this app to see what changed.');
  }
  const { builds } = await viewsFor(ctx, workspaceId, app);
  const same = (b: BuildView, number: string) => b.platform === input.platform && b.buildNumber === number;
  const head = builds.find((b) => same(b, input.buildNumber));
  if (!head) return failure(404, 'build_not_found', `This app has no ${input.platform} build ${input.buildNumber}.`);
  if (!head.link?.commit) {
    return failure(422, 'build_not_linked', `Build ${head.buildNumber} is not linked to a CI run, so its commit is not known.`);
  }
  let base: BuildView | undefined;
  if (input.base !== undefined) {
    base = builds.find((b) => same(b, input.base as string));
    if (!base) return failure(404, 'build_not_found', `This app has no ${input.platform} build ${input.base}.`);
    if (!base.link?.commit) {
      return failure(422, 'build_not_linked', `Build ${base.buildNumber} is not linked to a CI run, so its commit is not known.`);
    }
  } else {
    base = previousLinkedBuild(builds, head);
    if (!base) {
      return failure(422, 'no_base_build', 'There is no earlier linked build to compare with.');
    }
  }
  const baseCommit = (base.link as NonNullable<BuildView['link']>).commit as { sha: string; shortSha: string };
  const headCommit = head.link.commit;
  const ends = {
    base: { buildNumber: base.buildNumber, version: base.version, sha: baseCommit.sha, shortSha: baseCommit.shortSha },
    head: { buildNumber: head.buildNumber, version: head.version, sha: headCommit.sha, shortSha: headCommit.shortSha },
  };

  if (baseCommit.sha === headCommit.sha) {
    return {
      ok: true,
      changes: {
        platform: input.platform,
        ...ends,
        status: 'identical',
        aheadBy: 0,
        behindBy: 0,
        totalCommits: 0,
        truncated: false,
        url: null,
        commits: [],
      },
    };
  }

  const key = `${repository.id}\u0000${baseCommit.sha}\u0000${headCommit.sha}`;
  let comparison = compareCache.get(key, ctx.now());
  if (!comparison) {
    const opened = await openCi(ctx, workspaceId, repository, actor, 'ci.compare');
    if (!opened.ok) return opened;
    const read = await guarded(ctx, opened.secret, (signal) =>
      opened.client.compareCommits(baseCommit.sha, headCommit.sha, { signal }),
    );
    if (!read.ok) return read;
    comparison = read.value;
    compareCache.set(key, comparison, ctx.now());
  }
  const commits = [...comparison.commits].reverse().map(
    (c): ChangedCommit => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      title: firstLine(c.message) ?? '',
      message: c.message,
      author: c.author ?? null,
      date: c.date ?? null,
      url: c.url ?? null,
    }),
  );
  return {
    ok: true,
    changes: {
      platform: input.platform,
      ...ends,
      status: comparison.status,
      aheadBy: comparison.aheadBy,
      behindBy: comparison.behindBy,
      totalCommits: comparison.totalCommits,
      truncated: comparison.truncated,
      url: comparison.url ?? null,
      commits,
    },
  };
}


// ---------------------------------------------------------------------------------------------
// Build number conventions

export type ConventionsView = {
  repositoryId: string;
  /** The app the view is for, or null for the repository. */
  appId: string | null;
  /** What is stored for this scope; null when nothing is (the defaults or the repository's apply). */
  stored: StoredConventions | null;
  /** The repository-wide convention that is stored, when the view is for an app. */
  repository: StoredConventions | null;
  /** What matching really uses: stored values with the defaults filled in. */
  effective: EffectiveConventions;
  defaults: { tagPatterns: string[]; releasePatterns: string[] };
};

async function scopeApp(
  ctx: Pick<CiContext, 'db'>,
  workspaceId: string,
  repository: Repository,
  appId: string | undefined,
): Promise<{ ok: true; app: ManagedApp | undefined } | Failure> {
  if (appId === undefined) return { ok: true, app: undefined };
  const app = await getApp(ctx.db, workspaceId, appId);
  if (!app) return failure(422, 'app_not_found', 'That app is not in this workspace.');
  if (app.repositoryId !== repository.id) {
    return failure(422, 'app_repository_mismatch', 'That app is not linked to this repository.');
  }
  return { ok: true, app };
}

/** The stored and effective build number conventions of a repository, or of one of its apps. */
export async function getConventions(
  ctx: Pick<CiContext, 'db'>,
  input: { workspaceId: string; repositoryId: string; appId?: string | undefined },
): Promise<Outcome<{ conventions: ConventionsView }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const scope = await scopeApp(ctx, input.workspaceId, repository, input.appId);
  if (!scope.ok) return scope;
  const rows = await listConventions(ctx.db, input.workspaceId, repository.id);
  const appId = scope.app?.id ?? null;
  return {
    ok: true,
    conventions: {
      repositoryId: repository.id,
      appId,
      stored: rows.find((r) => r.appId === appId) ?? null,
      repository: rows.find((r) => r.appId === null) ?? null,
      effective: effectiveConventions(rows, appId),
      defaults: { tagPatterns: [...DEFAULT_TAG_PATTERNS], releasePatterns: [...DEFAULT_RELEASE_PATTERNS] },
    },
  };
}

/** Stores the conventions (audited as `build.conventions`). The body was validated by the route. */
export async function setConventions(
  ctx: Pick<CiContext, 'db' | 'now'>,
  input: { workspaceId: string; repositoryId: string; appId?: string | undefined; conventions: BuildConventions },
  actor: Actor,
): Promise<Outcome<{ conventions: ConventionsView }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const scope = await scopeApp(ctx, input.workspaceId, repository, input.appId);
  if (!scope.ok) return scope;
  await saveConventions(ctx.db, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    appId: scope.app?.id ?? null,
    conventions: input.conventions,
    actor,
    now: ctx.now(),
  });
  return getConventions(ctx, { workspaceId: input.workspaceId, repositoryId: repository.id, appId: scope.app?.id });
}

// ---------------------------------------------------------------------------------------------
// Tags of the repository, for the conventions dialog's live preview

export type RepositoryTags = {
  tags: { name: string; sha: string }[];
  releases: { name: string | null; tagName: string; draft: boolean; publishedAt: number | null }[];
  tagsTruncated: boolean;
  releasesTruncated: boolean;
  releasesError: string | null;
  readAt: number;
};

/** At most this many names go to the page. */
const PREVIEW_TAGS = 500;
const PREVIEW_RELEASES = 200;

/** The tags and releases GitHub lists for the repository, kept for a minute. Needs a scan right. */
export async function listRepositoryTags(
  ctx: CiContext,
  input: { workspaceId: string; repositoryId: string },
  actor: Actor,
): Promise<Outcome<{ data: RepositoryTags; cached: boolean }>> {
  const repository = await getRepository(ctx.db, input.workspaceId, input.repositoryId);
  if (!repository) return failure(404, 'not_found');
  const hit = previewCache.get(repository.id, ctx.now());
  if (hit) return { ok: true, data: hit, cached: true };
  const opened = await openCi(ctx, input.workspaceId, repository, actor, 'ci.tags');
  if (!opened.ok) return opened;
  if (!isTagClient(opened.client)) {
    return failure(422, 'ci_unsupported', 'This repository connection cannot read tags.');
  }
  const client = opened.client;
  const read = await guarded(ctx, opened.secret, (signal) => readTagData(client, { signal, now: ctx.now() }));
  if (!read.ok) return read;
  const data: ReadTagData = read.value;
  const value: RepositoryTags = {
    tags: data.tags.slice(0, PREVIEW_TAGS).map((t) => ({ name: t.name, sha: t.sha })),
    releases: data.releases
      .slice(0, PREVIEW_RELEASES)
      .map((r) => ({ name: r.name, tagName: r.tagName, draft: r.draft, publishedAt: r.publishedAt ?? r.createdAt })),
    tagsTruncated: data.tagsTruncated || data.tags.length > PREVIEW_TAGS,
    releasesTruncated: data.releasesTruncated || data.releases.length > PREVIEW_RELEASES,
    releasesError: data.releasesError,
    readAt: data.readAt,
  };
  previewCache.set(repository.id, value, ctx.now());
  return { ok: true, data: value, cached: false };
}

// ---------------------------------------------------------------------------------------------
// Re-run matching

export type RematchResult = {
  /** Whether GitHub was asked for tags (false when nothing needed them). */
  scanned: boolean;
  /** Links written or changed by the tag search. */
  written: number;
  /** Why the tag search failed, when it did; the runs were still refreshed. */
  error: string | null;
};

/**
 * Reads the repository's runs again and searches tags and releases for the builds of one app that
 * are not linked, ignoring the spacing and the kept tag lists. Needs the right of a scan. Audited
 * as `build.rematch` (and the credential use).
 */
export async function rematchBuilds(
  ctx: CiContext,
  input: { workspaceId: string; appId: string },
  actor: Actor,
): Promise<Outcome<{ builds: AppBuilds; rematch: RematchResult }>> {
  const { workspaceId } = input;
  const app = await getApp(ctx.db, workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const repository = app.repositoryId ? await getRepository(ctx.db, workspaceId, app.repositoryId) : undefined;
  if (!repository) {
    return failure(422, 'no_repository', 'Link a repository to this app before matching its builds to CI runs.');
  }
  const refreshed = await refreshRuns(ctx, { workspaceId, repository, force: true, tags: 'skip' }, actor);
  if (!refreshed.ok) return refreshed;
  const opened = await openCi(ctx, workspaceId, repository, actor, 'ci.rematch');
  if (!opened.ok) return opened;
  const { client } = opened;
  const done = await guarded(ctx, opened.secret, (signal) =>
    scanBuildTags({
      db: ctx.db,
      workspaceId,
      repositoryId: repository.id,
      client,
      matchers: ctx.matchers,
      now: ctx.now(),
      force: true,
      signal,
      onlyAppId: app.id,
      describeError: (error) => describeGithubError(error, opened.secret),
    }),
  );
  const rematch: RematchResult = done.ok
    ? { scanned: done.value.scanned, written: done.value.written, error: done.value.error }
    : { scanned: true, written: 0, error: String(done.body.message ?? done.body.error) };
  await recordAudit(ctx.db, {
    workspaceId,
    actor,
    action: 'build.rematch',
    target: { type: 'app', id: app.id },
    detail: { scanned: rematch.scanned, written: rematch.written, ok: rematch.error === null },
    at: ctx.now(),
  });
  return { ok: true, builds: await viewsFor(ctx, workspaceId, app), rematch };
}

/** Why a build the scan did not mention has no link: the search failed, is older than the build, or never ran. */
function unsearched(scan: StoredScan | undefined): { code: string; message: string } {
  if (scan && !scan.ok) {
    return {
      code: 'scan_failed',
      message: `The last search of tags and releases failed${scan.error ? `: ${scan.error}` : ''}. Use "Re-run matching".`,
    };
  }
  if (scan) return { code: 'not_searched', message: 'Tags were searched before this build was synced. Use "Re-run matching".' };
  return { code: 'not_searched', message: 'Tags and releases have not been searched yet. Use "Re-run matching".' };
}
