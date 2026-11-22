import { formatDuration, formatList } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
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


/** "45 sec", "3 min 5 sec", "1 hr 5 min" (in the active language). */
export function elapsedText(ms: number): string {
  return formatDuration(Math.max(0, ms));
}

/** How long a run has gone (ticking against `now`) or went (a finished run). */
export function runElapsedMs(
  run: Pick<WorkflowRun, 'active' | 'startedAt' | 'updatedAt'>,
  now: number,
): number {
  return Math.max(0, (run.active ? now : run.updatedAt) - run.startedAt);
}

/** Runs in progress first, then queued ones, each newest first. Does not change its argument. */
export function sortActive<T extends Pick<WorkflowRun, 'status' | 'startedAt' | 'id'>>(
  runs: readonly T[],
): T[] {
  const rank = (r: Pick<WorkflowRun, 'status'>) => (r.status === 'in_progress' ? 0 : 1);
  return [...runs].sort(
    (a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
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
      return { percent: null, label: t('builds:running.starting') };
    case 'waiting':
      return { percent: null, label: t('builds:running.waitingApproval') };
    case 'queued':
    case 'requested':
      return { percent: null, label: t('builds:running.waitingRunner') };
    case 'in_progress': {
      const p = run.progress;
      if (!p) return { percent: null, label: t('builds:running.inProgress') };
      const where = [p.job, p.step]
        .filter((x): x is string => typeof x === 'string' && x !== '')
        .join(' · ');
      const jobs =
        p.jobsTotal > 1
          ? t('builds:running.jobOf', { n: Math.min(p.jobsDone + 1, p.jobsTotal), total: p.jobsTotal })
          : '';
      const label = [where, jobs].filter((x) => x !== '').join(' · ');
      return {
        percent: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100),
        label: label || t('builds:running.inProgress'),
      };
    }
    default:
      return { percent: null, label: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// One app

/** The apps a run was started for. `appIds` when the server sends it, else the one `appId`; empty for none. */
export function runAppIds(
  run: Pick<WorkflowRun, 'appId'> & { appIds?: readonly string[] },
): string[] {
  if (run.appIds !== undefined) return [...run.appIds];
  return run.appId === null ? [] : [run.appId];
}

/** The names of the apps a run was started for, in the order of `apps`. Empty when it was started for none. */
export function runAppNames(
  run: Pick<WorkflowRun, 'appId'> & { appIds?: readonly string[] },
  apps: readonly { id: string; name: string }[],
): string[] {
  const ids = runAppIds(run);
  return apps.filter((a) => ids.indexOf(a.id) >= 0).map((a) => a.name);
}

const workflowMatches = (run: Pick<WorkflowRun, 'workflow' | 'workflowPath'>, wanted: string) =>
  run.workflowPath === wanted ||
  run.workflowPath?.split('/').pop() === wanted ||
  run.workflow === wanted;

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
export function scopeRunsToApps(
  runs: readonly ActiveRun[],
  targets: readonly AppRunTarget[],
): ScopedRuns {
  const repos = new Set<string>();
  for (const target of targets) if (target.repositoryId) repos.add(target.repositoryId);
  const inRepos = runs.filter((r) => repos.has(r.repositoryId));
  const tied = inRepos.filter((r) =>
    targets.some(
      (target) =>
        target.repositoryId === r.repositoryId &&
        (runAppIds(r).indexOf(target.id) >= 0 ||
          (runAppIds(r).length === 0 &&
            target.workflow !== null &&
            workflowMatches(r, target.workflow))),
    ),
  );
  return tied.length > 0 ? { runs: tied, linked: true } : { runs: inRepos, linked: false };
}

// ---------------------------------------------------------------------------------------------
// Finished, and what could not be read

const FAILED = ['failure', 'timed_out', 'startup_failure'];
export const isFailedRun = (run: Pick<WorkflowRun, 'conclusion'>): boolean =>
  FAILED.indexOf(run.conclusion ?? '') >= 0;

/** Failed runs first, then the others, each newest first. Does not change its argument. */
export function failedFirst<T extends Pick<WorkflowRun, 'conclusion' | 'updatedAt' | 'id'>>(
  runs: readonly T[],
): T[] {
  return [...runs].sort(
    (a, b) =>
      Number(isFailedRun(b)) - Number(isFailedRun(a)) ||
      b.updatedAt - a.updatedAt ||
      b.id.localeCompare(a.id),
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
  if (failed) parts.push(t('builds:running.count.failed', { count: failed }));
  if (succeeded) parts.push(t('builds:running.count.succeeded', { count: succeeded }));
  if (cancelled) parts.push(t('builds:running.count.cancelled', { count: cancelled }));
  if (other) parts.push(t('builds:running.count.other', { count: other }));
  return formatList(parts);
}

export type ProblemPill = { tone: 'warn' | 'info'; label: string; lines: string[] };

const reasonKeys: Record<ActiveRunsProblem['reason'], string> = {
  no_access: k('builds:running.problem.noAccess'),
  unsupported: k('builds:running.problem.unsupported'),
  rate_limited: k('builds:running.problem.rateLimited'),
  unavailable: k('builds:running.problem.unavailable'),
};

/** One quiet pill for repositories whose runs could not be read; null when there is nothing to say. */
export function problemPill(
  problems: readonly ActiveRunsProblem[],
  repositories: readonly { id: string; owner: string; repo: string }[],
): ProblemPill | null {
  if (problems.length === 0) return null;
  const name = (id: string) => {
    const r = repositories.find((x) => x.id === id);
    return r ? `${r.owner}/${r.repo}` : t('builds:running.problem.aRepository');
  };
  const lines = problems.map((p) => t(reasonKeys[p.reason], { name: name(p.repositoryId) }));
  const hard = problems.some((p) => p.reason === 'no_access' || p.reason === 'unsupported');
  const label =
    problems.length === 1
      ? t('builds:running.problem.labelOne', {
          name: name((problems[0] as ActiveRunsProblem).repositoryId),
        })
      : t('builds:running.problem.labelMany', { count: problems.length });
  return { tone: hard ? 'warn' : 'info', label, lines };
}

/** The status codes that end the polling: the person may not read runs, or the workspace is gone. */
export const endsFeed = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404 || status === 401;
};

// ---------------------------------------------------------------------------------------------
// Jobs and steps (the run drawer)

export type StateVisual = {
  icon: 'check-circle' | 'x-circle' | 'refresh' | 'clock' | 'minus' | 'alert-triangle';
  tone: 'ok' | 'bad' | 'info' | 'warn' | 'neutral';
  label: string;
};

/** The icon, tone and words for a job or a step. The words always say the state. */
export function stateVisual(status: string, conclusion: string | null): StateVisual {
  if (status === 'completed') {
    if (conclusion === 'success')
      return { icon: 'check-circle', tone: 'ok', label: t('builds:ci.run.succeeded') };
    if (conclusion === 'skipped')
      return { icon: 'minus', tone: 'neutral', label: t('builds:ci.run.skipped') };
    if (conclusion === 'cancelled')
      return { icon: 'minus', tone: 'neutral', label: t('builds:ci.run.cancelled') };
    if (conclusion === 'action_required')
      return { icon: 'alert-triangle', tone: 'warn', label: t('builds:ci.run.needsApproval') };
    if (conclusion === 'neutral')
      return { icon: 'check-circle', tone: 'neutral', label: t('builds:ci.run.finished') };
    return { icon: 'x-circle', tone: 'bad', label: t('builds:ci.run.failed') };
  }
  if (status === 'in_progress')
    return { icon: 'refresh', tone: 'info', label: t('builds:ci.run.running') };
  return { icon: 'clock', tone: 'neutral', label: t('builds:ci.run.queued') };
}

/** Milliseconds a job or step has taken (against `now` while it goes); null when it has not started. */
export function spanMs(
  item: { startedAt: number | null; completedAt: number | null },
  now: number,
): number | null {
  if (item.startedAt === null) return null;
  return Math.max(0, (item.completedAt ?? now) - item.startedAt);
}

/** A job that went well and is over is folded away; one that runs, waits or failed shows its steps. */
export const showsSteps = (job: { status: string; conclusion: string | null }): boolean =>
  job.status !== 'completed' || (job.conclusion !== 'success' && job.conclusion !== 'skipped');
