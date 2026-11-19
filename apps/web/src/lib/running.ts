import { createPoller, type Poller, type Timers, type Visibility } from './poll.ts';
import type { ActiveRun, ActiveRuns, ActiveRunsProblem, WorkflowRun } from './types.ts';

/**
 * Pure helpers and the polling loop behind "Running now" (components/ci/RunningNow.svelte). No DOM:
 * the clock, the timers and the page visibility are injected, so tests drive them by hand.
 */

// ---------------------------------------------------------------------------------------------
// Cadence

/** While a run is going. */
export const RUNNING_POLL_MS = 15_000;
/** With nothing going: the only way a run started on GitHub itself is noticed. */
export const IDLE_POLL_MS = 60_000;
/** After failures the wait doubles up to this. */
export const MAX_POLL_MS = 5 * 60_000;

export type RunsFeedOptions = {
  load: () => Promise<ActiveRuns>;
  onData: (data: ActiveRuns) => void;
  onError: (error: unknown) => void;
  /** An error that ends the loop (the person may not read runs): reported once, then no more polls. */
  fatal?: (error: unknown) => boolean;
  visibility?: Visibility;
  timers?: Timers;
};

/**
 * Follows the list of runs: every 15 seconds while any run is going, every minute when none is,
 * slower after a failure, and not at all while the page is hidden (it ticks at once when the page
 * is shown again). Call `start(true)` to read at once.
 */
export function createRunsFeed(options: RunsFeedOptions): Poller {
  let busy = false;
  return createPoller({
    intervalMs: RUNNING_POLL_MS,
    delayMs: () => (busy ? RUNNING_POLL_MS : IDLE_POLL_MS),
    maxIntervalMs: MAX_POLL_MS,
    onError: options.onError,
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
    tick: async () => {
      let data: ActiveRuns;
      try {
        data = await options.load();
      } catch (error) {
        if (options.fatal?.(error)) {
          options.onError(error);
          return false;
        }
        throw error;
      }
      busy = data.runs.length > 0;
      options.onData(data);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Rows

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "45 s", "3 min 05 s", "1 h 05 min". */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${pad(total % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** How long a run has gone (ticking against `now`) or went (a finished run). */
export function runElapsedMs(run: Pick<WorkflowRun, 'active' | 'startedAt' | 'updatedAt'>, now: number): number {
  return Math.max(0, (run.active ? now : run.updatedAt) - run.startedAt);
}

/** Runs in progress first, then queued ones, each newest first. Does not change its argument. */
export function sortActive<T extends Pick<WorkflowRun, 'status' | 'startedAt' | 'id'>>(runs: readonly T[]): T[] {
  const rank = (r: Pick<WorkflowRun, 'status'>) => (r.status === 'in_progress' ? 0 : 1);
  return [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}

export type ProgressInfo = {
  /** 0 to 100, or null when there is nothing to measure (not started, or the jobs are not known). */
  percent: number | null;
  /** What the run is doing now, in words. */
  label: string;
};

/** The progress bar and the line beside it. A run that has not started says what it waits for. */
export function progressInfo(run: Pick<ActiveRun, 'status' | 'progress'>): ProgressInfo {
  switch (run.status) {
    case 'pending':
      return { percent: null, label: 'Starting' };
    case 'waiting':
      return { percent: null, label: 'Waiting for approval' };
    case 'queued':
    case 'requested':
      return { percent: null, label: 'Waiting for a runner' };
    case 'in_progress': {
      const p = run.progress;
      if (!p) return { percent: null, label: 'In progress' };
      const where = [p.job, p.step].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
      const jobs = p.jobsTotal > 1 ? `job ${Math.min(p.jobsDone + 1, p.jobsTotal)} of ${p.jobsTotal}` : '';
      const label = [where, jobs].filter((x) => x !== '').join(' · ');
      return { percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100), label: label || 'In progress' };
    }
    default:
      return { percent: null, label: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// One app

const workflowMatches = (run: Pick<WorkflowRun, 'workflow' | 'workflowPath'>, wanted: string) =>
  run.workflowPath === wanted || run.workflowPath?.split('/').pop() === wanted || run.workflow === wanted;

export type AppRunTarget = {
  id: string;
  repositoryId: string | null;
  /** The release workflow of the app's build conventions (a file name, path or name), when one is set. */
  workflow: string | null;
};

export type ScopedRuns = {
  runs: ActiveRun[];
  /** True when every run shown is tied to the app (it was started for it, or it is its release workflow). False: these are the repository's runs. */
  linked: boolean;
};

/**
 * The runs an app's dashboard shows. A run is tied to an app when it was started for it from here
 * (`appId`), or when it is the release workflow of the app's build conventions. Runs that are tied
 * to one of the apps are shown alone; when none is, all the runs of the apps' repositories are shown
 * and `linked` is false, so the screen can say they are the repository's. Never guessed from names.
 */
export function scopeRunsToApps(runs: readonly ActiveRun[], targets: readonly AppRunTarget[]): ScopedRuns {
  const repos = new Set<string>();
  for (const t of targets) if (t.repositoryId) repos.add(t.repositoryId);
  const inRepos = runs.filter((r) => repos.has(r.repositoryId));
  const tied = inRepos.filter((r) =>
    targets.some(
      (t) =>
        t.repositoryId === r.repositoryId &&
        (r.appId === t.id || (r.appId === null && t.workflow !== null && workflowMatches(r, t.workflow))),
    ),
  );
  return tied.length > 0 ? { runs: tied, linked: true } : { runs: inRepos, linked: false };
}

// ---------------------------------------------------------------------------------------------
// Finished, and what could not be read

const FAILED = ['failure', 'timed_out', 'startup_failure'];
export const isFailedRun = (run: Pick<WorkflowRun, 'conclusion'>): boolean => FAILED.indexOf(run.conclusion ?? '') >= 0;

/** Failed runs first, then the others, each newest first. Does not change its argument. */
export function failedFirst<T extends Pick<WorkflowRun, 'conclusion' | 'updatedAt' | 'id'>>(runs: readonly T[]): T[] {
  return [...runs].sort(
    (a, b) => Number(isFailedRun(b)) - Number(isFailedRun(a)) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
  );
}

/** "2 failed, 5 succeeded, 1 cancelled"; empty for no runs. */
export function finishedCounts(runs: readonly Pick<WorkflowRun, 'conclusion'>[]): string {
  let failed = 0;
  let succeeded = 0;
  let cancelled = 0;
  let other = 0;
  for (const r of runs) {
    if (isFailedRun(r)) failed++;
    else if (r.conclusion === 'success') succeeded++;
    else if (r.conclusion === 'cancelled') cancelled++;
    else other++;
  }
  const parts: string[] = [];
  if (failed) parts.push(`${failed} failed`);
  if (succeeded) parts.push(`${succeeded} succeeded`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  if (other) parts.push(`${other} other`);
  return parts.join(', ');
}

export type ProblemPill = { tone: 'warn' | 'info'; label: string; lines: string[] };

const reasonText: Record<ActiveRunsProblem['reason'], string> = {
  no_access: 'the GitHub connection cannot read Actions runs (check the token or app permission "Actions: read")',
  unsupported: 'this connection cannot read workflow runs',
  rate_limited: 'GitHub asked for a pause; it is tried again by itself',
  unavailable: 'GitHub did not answer; it is tried again by itself',
};

/** One quiet pill for repositories whose runs could not be read; null when there is nothing to say. */
export function problemPill(
  problems: readonly ActiveRunsProblem[],
  repositories: readonly { id: string; owner: string; repo: string }[],
): ProblemPill | null {
  if (problems.length === 0) return null;
  const name = (id: string) => {
    const r = repositories.find((x) => x.id === id);
    return r ? `${r.owner}/${r.repo}` : 'a repository';
  };
  const lines = problems.map((p) => `${name(p.repositoryId)}: ${reasonText[p.reason]}.`);
  const hard = problems.some((p) => p.reason === 'no_access' || p.reason === 'unsupported');
  const label =
    problems.length === 1
      ? `Runs of ${name((problems[0] as ActiveRunsProblem).repositoryId)} cannot be read`
      : `Runs of ${problems.length} repositories cannot be read`;
  return { tone: hard ? 'warn' : 'info', label, lines };
}

/** The status codes that end the polling: the person may not read runs, or the workspace is gone. */
export const endsFeed = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404 || status === 401;
};

// ---------------------------------------------------------------------------------------------
// Jobs and steps (the run drawer)

export type StateVisual = { icon: 'check-circle' | 'x-circle' | 'refresh' | 'clock' | 'minus' | 'alert-triangle'; tone: 'ok' | 'bad' | 'info' | 'warn' | 'neutral'; label: string };

/** The icon, tone and words for a job or a step. The words always say the state. */
export function stateVisual(status: string, conclusion: string | null): StateVisual {
  if (status === 'completed') {
    if (conclusion === 'success') return { icon: 'check-circle', tone: 'ok', label: 'Succeeded' };
    if (conclusion === 'skipped') return { icon: 'minus', tone: 'neutral', label: 'Skipped' };
    if (conclusion === 'cancelled') return { icon: 'minus', tone: 'neutral', label: 'Cancelled' };
    if (conclusion === 'action_required') return { icon: 'alert-triangle', tone: 'warn', label: 'Needs approval' };
    if (conclusion === 'neutral') return { icon: 'check-circle', tone: 'neutral', label: 'Finished' };
    return { icon: 'x-circle', tone: 'bad', label: 'Failed' };
  }
  if (status === 'in_progress') return { icon: 'refresh', tone: 'info', label: 'Running' };
  return { icon: 'clock', tone: 'neutral', label: 'Queued' };
}

/** Milliseconds a job or step has taken (against `now` while it goes); null when it has not started. */
export function spanMs(item: { startedAt: number | null; completedAt: number | null }, now: number): number | null {
  if (item.startedAt === null) return null;
  return Math.max(0, (item.completedAt ?? now) - item.startedAt);
}

/** A job that went well and is over is folded away; one that runs, waits or failed shows its steps. */
export const showsSteps = (job: { status: string; conclusion: string | null }): boolean =>
  job.status !== 'completed' || (job.conclusion !== 'success' && job.conclusion !== 'skipped');
