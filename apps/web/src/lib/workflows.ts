import type { Platform } from '@mrm/core';
import { canDispatchWorkflow } from './ci.ts';
import { isFailedRun, runAppIds } from './running.ts';
import type { CiWorkflow, WorkflowRun } from './types.ts';

/**
 * Pure helpers for the Workflows pages (an app's and the workspace's): which workflows look like
 * this app's build or release workflows, which platform a workflow or run is for, the last run of
 * each workflow, and the filters. No fetching, no DOM. Hints come from names and file names only,
 * so they are shown as hints and never hide everything (see `filterByPlatform`).
 */

// ---------------------------------------------------------------------------------------------
// Names

/** Lower-case words of a name or path: `.github/workflows/iOS-Release.yml` is github, workflows, ios, release, yml. */
export const nameTokens = (text: string): string[] =>
  text
    .replace(/iOS/g, 'ios')
    .replace(/macOS/g, 'macos')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');

const IOS_WORDS = ['ios', 'iphone', 'ipados', 'testflight', 'xcode', 'appstore'];
const ANDROID_WORDS = ['android', 'gradle', 'apk', 'aab', 'playstore'];
const MACOS_WORDS = ['macos', 'osx', 'mac'];
const RELEASE_WORDS = ['release', 'releases', 'publish', 'deploy', 'ship', 'distribute', 'testflight', 'fastlane', 'production', 'submit', 'store', 'appstore', 'playstore'];
const BUILD_WORDS = ['build', 'builds', 'archive', 'beta', 'nightly', 'assemble', 'bundle', 'package'];

const has = (tokens: readonly string[], words: readonly string[]) => words.some((w) => tokens.indexOf(w) >= 0);

/** The file part of a workflow path: `.github/workflows/ios.yml` is `ios.yml`. */
export const fileOf = (path: string): string => path.split('/').pop() ?? path;

type Named = { name: string; path: string };

const wordsOf = (item: Named) => nameTokens(`${item.name} ${fileOf(item.path)}`);

/**
 * The platforms a workflow name or file speaks of. Naming both (or none) says nothing, so the result
 * is empty: the workflow is for any platform.
 */
export function platformHints(item: Named): Platform[] {
  const words = wordsOf(item);
  const out: Platform[] = [];
  if (has(words, IOS_WORDS)) out.push('ios');
  if (has(words, MACOS_WORDS)) out.push('macos');
  if (has(words, ANDROID_WORDS)) out.push('android');
  return out.length === 3 || out.length === 0 ? [] : out;
}

/** A run is judged by the name and file of its workflow. */
export const runHints = (run: Pick<WorkflowRun, 'workflow' | 'workflowPath'>): Platform[] =>
  platformHints({ name: run.workflow, path: run.workflowPath ?? '' });

// ---------------------------------------------------------------------------------------------
// Ranking

export type WorkflowRelevance = 'configured' | 'used' | 'release' | 'build' | 'other';

export type WorkflowEntry = {
  workflow: CiWorkflow;
  relevance: WorkflowRelevance;
  /** Why it is marked, for a tooltip or a line of text; empty for `other`. */
  reason: string;
  platforms: Platform[];
};

const RANK: Record<WorkflowRelevance, number> = { configured: 0, used: 1, release: 2, build: 3, other: 4 };

/** The text people read beside the mark. */
export const relevanceLabel = (relevance: WorkflowRelevance): string => {
  switch (relevance) {
    case 'configured':
      return 'Release workflow';
    case 'used':
      return 'Used for this app';
    case 'release':
      return 'Release';
    case 'build':
      return 'Build';
    default:
      return '';
  }
};

/** Whether a name, file or path from the build conventions (`release.yml`) points at this workflow. */
export const isConfiguredWorkflow = (workflow: Pick<CiWorkflow, 'name' | 'path'>, wanted: string): boolean => {
  const w = wanted.trim();
  return w !== '' && (workflow.path === w || fileOf(workflow.path) === fileOf(w) || workflow.name === w);
};

/** Whether a stored run belongs to this workflow (same file, else same name). */
export function runIsOf(run: Pick<WorkflowRun, 'workflow' | 'workflowPath'>, workflow: Pick<CiWorkflow, 'name' | 'path'>): boolean {
  if (run.workflowPath) return fileOf(run.workflowPath) === fileOf(workflow.path);
  return run.workflow === workflow.name;
}

export type RankContext = {
  /** The release workflow of each app's build conventions (a file, path or name). */
  configured?: readonly string[];
  /** The ids of the apps in scope: a workflow that was started for one of them is "used for this app". */
  appIds?: readonly string[];
  /** Stored runs, to find the workflows that were started for one of the apps. */
  runs?: readonly (Pick<WorkflowRun, 'workflow' | 'workflowPath' | 'appId'> & { appIds?: readonly string[] })[];
};

/**
 * Marks and sorts the workflows of a repository: the release workflow of the build conventions first,
 * then a workflow started for the app from here, then names that say release or build, then the rest
 * by name. A workflow GitHub has disabled goes after those that can run.
 */
export function rankWorkflows(workflows: readonly CiWorkflow[], context: RankContext = {}): WorkflowEntry[] {
  const configured = (context.configured ?? []).filter((c) => c.trim() !== '');
  const appIds = context.appIds ?? [];
  const runs = context.runs ?? [];
  const entries = workflows.map((workflow): WorkflowEntry => {
    const platforms = platformHints(workflow);
    const words = wordsOf(workflow);
    if (configured.some((c) => isConfiguredWorkflow(workflow, c))) {
      return { workflow, relevance: 'configured', reason: "The release workflow set in this app's build conventions.", platforms };
    }
    if (runs.some((r) => runAppIds(r).some((id) => appIds.indexOf(id) >= 0) && runIsOf(r, workflow))) {
      return { workflow, relevance: 'used', reason: 'A run of it was started from here for this app.', platforms };
    }
    if (has(words, RELEASE_WORDS)) return { workflow, relevance: 'release', reason: 'Its name says release, publish or deploy.', platforms };
    if (has(words, BUILD_WORDS)) return { workflow, relevance: 'build', reason: 'Its name says build.', platforms };
    return { workflow, relevance: 'other', reason: '', platforms };
  });
  return entries.sort(
    (a, b) =>
      Number(!canDispatchWorkflow(a.workflow)) - Number(!canDispatchWorkflow(b.workflow)) ||
      RANK[a.relevance] - RANK[b.relevance] ||
      a.workflow.name.localeCompare(b.workflow.name),
  );
}

/**
 * When there are many workflows, the marked ones are shown and the rest wait behind a toggle. Few
 * workflows, or none marked, show everything.
 */
export function splitRelevant(entries: readonly WorkflowEntry[], limit = 8): { shown: WorkflowEntry[]; rest: WorkflowEntry[] } {
  const marked = entries.filter((e) => e.relevance !== 'other');
  if (entries.length <= limit || marked.length === 0) return { shown: [...entries], rest: [] };
  return { shown: marked, rest: entries.filter((e) => e.relevance === 'other') };
}

// ---------------------------------------------------------------------------------------------
// Platform scope

export type Filtered<T> = {
  shown: T[];
  /** What the platform scope left out. */
  hidden: T[];
  /** Nothing matched the scope, so everything is shown: the screen says so instead of going empty. */
  fellBack: boolean;
};

/**
 * Keeps the items that are for the platforms in scope, or for no platform in particular. It never
 * leaves nothing: when the scope matches no item, all of them are shown and `fellBack` is true.
 * A scope that holds every platform of the app filters nothing.
 */
export function filterByPlatform<T>(
  items: readonly T[],
  hintsOf: (item: T) => readonly Platform[],
  wanted: readonly Platform[],
  appPlatforms: readonly Platform[],
): Filtered<T> {
  const everything = appPlatforms.length === 0 || appPlatforms.every((p) => wanted.indexOf(p) >= 0);
  if (everything || wanted.length === 0) return { shown: [...items], hidden: [], fellBack: false };
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const item of items) {
    const hints = hintsOf(item);
    if (hints.length === 0 || hints.some((h) => wanted.indexOf(h) >= 0)) shown.push(item);
    else hidden.push(item);
  }
  if (shown.length === 0 && hidden.length > 0) return { shown: [...hidden], hidden: [], fellBack: true };
  return { shown, hidden, fellBack: false };
}

/** The sentence under the toolbar when the scope left something out; empty when it left nothing. */
export function scopeNote(input: { noun: string; scopeLabel: string; hidden: number; fellBack: boolean }): string {
  if (input.fellBack) return `No ${input.noun}s are named for ${input.scopeLabel}, so all of them are shown.`;
  if (input.hidden === 0) return '';
  return `${input.hidden} ${input.noun}${input.hidden === 1 ? '' : 's'} for other platforms ${input.hidden === 1 ? 'is' : 'are'} hidden.`;
}

// ---------------------------------------------------------------------------------------------
// Runs of a workflow

/** The newest run of each workflow, by workflow id. A workflow with no stored run has no entry. */
export function lastRuns(workflows: readonly CiWorkflow[], runs: readonly WorkflowRun[]): Record<string, WorkflowRun> {
  const out: Record<string, WorkflowRun> = {};
  for (const w of workflows) {
    let best: WorkflowRun | undefined;
    for (const r of runs) {
      if (!runIsOf(r, w)) continue;
      if (!best || r.startedAt > best.startedAt) best = r;
    }
    if (best) out[w.id] = best;
  }
  return out;
}

/** Workflows known only from their runs, for a role that cannot ask GitHub for the list. They cannot be started. */
export function workflowsFromRuns(runs: readonly Pick<WorkflowRun, 'workflow' | 'workflowPath'>[]): CiWorkflow[] {
  const seen: Record<string, CiWorkflow> = {};
  for (const r of runs) {
    const path = r.workflowPath ?? r.workflow;
    const key = fileOf(path);
    if (!(key in seen)) seen[key] = { id: `run:${key}`, name: r.workflow, path, state: 'unknown' };
  }
  return Object.keys(seen).map((k) => seen[k] as CiWorkflow);
}

/** Why a workflow cannot be run now; null when it can. */
export function runBlockedReason(workflow: Pick<CiWorkflow, 'state'>, canDispatch: boolean): string | null {
  if (!canDispatch) return 'Starting a workflow needs the member or admin role.';
  if (!canDispatchWorkflow(workflow)) return `This workflow is ${workflow.state.replace(/_/g, ' ')} on GitHub.`;
  return null;
}

/**
 * The app to tie a run to in the dispatch form: the record of the platform the workflow is named for,
 * else the only record of the repository. Nothing when it would be a guess.
 */
export function suggestAppId(
  apps: readonly { id: string; platform: Platform; repositoryId: string | null }[],
  repositoryId: string,
  hints: readonly Platform[],
): string {
  const own = apps.filter((a) => a.repositoryId === repositoryId);
  if (hints.length === 1) {
    const match = own.filter((a) => a.platform === hints[0]);
    if (match.length === 1) return (match[0] as { id: string }).id;
  }
  return own.length === 1 ? (own[0] as { id: string }).id : '';
}

// ---------------------------------------------------------------------------------------------
// The workspace list

export type RepoRef = { id: string; owner: string | null; repo: string | null; name: string; defaultBranch: string };
export type WorkflowRow = { repository: RepoRef; entry: WorkflowEntry; last: WorkflowRun | null };

export type StatusFilter = 'all' | 'running' | 'failed' | 'succeeded' | 'never';

export const statusFilters: readonly { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Any status' },
  { id: 'running', label: 'Running now' },
  { id: 'failed', label: 'Last run failed' },
  { id: 'succeeded', label: 'Last run succeeded' },
  { id: 'never', label: 'Never run' },
];

export const isStatusFilter = (value: string): value is StatusFilter => statusFilters.some((f) => f.id === value);

export function matchesStatus(last: WorkflowRun | null, filter: StatusFilter): boolean {
  switch (filter) {
    case 'running':
      return last !== null && last.active;
    case 'failed':
      return last !== null && isFailedRun(last);
    case 'succeeded':
      return last !== null && !last.active && last.conclusion === 'success';
    case 'never':
      return last === null;
    default:
      return true;
  }
}

/** The rows of one repository: its ranked workflows with their last runs. */
export function rowsOf(repository: RepoRef, entries: readonly WorkflowEntry[], runs: readonly WorkflowRun[]): WorkflowRow[] {
  const last = lastRuns(
    entries.map((e) => e.workflow),
    runs,
  );
  return entries.map((entry) => ({ repository, entry, last: last[entry.workflow.id] ?? null }));
}

/** Running ones first, then by repository, then the ranking inside the repository. Does not change its argument. */
export function sortRows(rows: readonly WorkflowRow[]): WorkflowRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.last?.active === true) - Number(a.last?.active === true) ||
      a.repository.name.localeCompare(b.repository.name) ||
      Number(!canDispatchWorkflow(a.entry.workflow)) - Number(!canDispatchWorkflow(b.entry.workflow)) ||
      RANK[a.entry.relevance] - RANK[b.entry.relevance] ||
      a.entry.workflow.name.localeCompare(b.entry.workflow.name),
  );
}

export function filterRows(rows: readonly WorkflowRow[], filter: { repositoryId: string; status: StatusFilter }): WorkflowRow[] {
  return rows.filter(
    (r) => (filter.repositoryId === '' || r.repository.id === filter.repositoryId) && matchesStatus(r.last, filter.status),
  );
}

// ---------------------------------------------------------------------------------------------
// Reading problems

/**
 * The one line of a StatusPill when GitHub could not be read for a repository. The details (the
 * server's message) go inside the pill.
 */
export function readProblemLabel(code: string | undefined, status?: number): string {
  switch (code) {
    case 'github_auth':
    case 'github_forbidden':
    case 'github_not_found':
    case 'ci_unsupported':
      return 'The GitHub connection cannot read Actions';
    case 'rate_limited':
      return 'GitHub asked for a pause';
    case 'github_unavailable':
    case 'timeout':
      return 'GitHub did not answer';
    default:
      return status === 403 ? 'You cannot read workflows here' : 'Workflows could not be read';
  }
}
