/**
 * The top of the Workflows page of an app (docs/design/readability.md, "Second pass: forms and dialogs"): one headline that says where
 * the workflows stand ("Last run failed 2 hours ago on main"), one line of counts ("3 workflows, 1 failing"), and ONE primary action
 * (open the run that failed or is going, or start the release workflow). Also the order of the run list: the workflows that are failing
 * come first. Pure; the component only draws.
 */
import { isPending, runBadge } from './ci.ts';
import { timeAgo } from './format.ts';
import type { LeadTone } from './page-lead.ts';
import { isFailedRun } from './running.ts';
import type { WorkflowRun } from './types.ts';
import { runBlockedReason, type WorkflowRow } from './workflows.ts';

export type WorkflowsPrimary =
  | { kind: 'open'; runId: string; label: string }
  | { kind: 'start'; workflowId: string; repositoryId: string; label: string }
  | null;

export type WorkflowsLead = {
  headline: string;
  hint: string;
  tone: LeadTone;
  primary: WorkflowsPrimary;
};

const workflowOf = (run: Pick<WorkflowRun, 'workflow' | 'workflowPath'>): string =>
  run.workflowPath ?? run.workflow;

const newestFinished = <T extends WorkflowRun>(runs: readonly T[]): Map<string, T> => {
  const newest = new Map<string, T>();
  for (const r of runs) {
    if (r.active) continue;
    const key = workflowOf(r);
    const seen = newest.get(key);
    if (!seen || r.startedAt > seen.startedAt) newest.set(key, r);
  }
  return newest;
};

/** The ids of the failing runs: the newest finished run of a workflow, when it failed. An old failure of a workflow that ran well since is not. */
export function failingRunIds(runs: readonly WorkflowRun[]): Set<string> {
  const ids = new Set<string>();
  for (const r of newestFinished(runs).values()) if (isFailedRun(r)) ids.add(r.id);
  return ids;
}

/**
 * The runs in the order of the list: the failing runs first (see `failingRunIds`), then the runs going now, then the rest, newest
 * first. Does not change its argument.
 */
export function orderRuns<T extends WorkflowRun>(runs: readonly T[]): T[] {
  const failing = failingRunIds(runs);
  const rank = (r: T): number => (failing.has(r.id) ? 0 : r.active ? 1 : 2);
  return [...runs].sort(
    (a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}

const where = (run: Pick<WorkflowRun, 'branch'>): string => (run.branch ? ` on ${run.branch}` : '');

const countsLine = (rows: readonly WorkflowRow[]): string => {
  const n = rows.length;
  if (n === 0) return 'No workflows are listed for this app yet.';
  const failing = rows.filter((r) => r.last !== null && isFailedRun(r.last)).length;
  const noun = `${n} ${n === 1 ? 'workflow' : 'workflows'}`;
  return failing === 0 ? `${noun}, none failing.` : `${noun}, ${failing} failing.`;
};

/** The workflow the primary button would start: a release or build workflow the app uses, that can be run now. */
function startCandidate(rows: readonly WorkflowRow[], canDispatch: boolean): WorkflowsPrimary {
  if (!canDispatch) return null;
  const row = rows.find(
    (r) =>
      (r.entry.relevance === 'configured' ||
        r.entry.relevance === 'release' ||
        r.entry.relevance === 'used') &&
      runBlockedReason(r.entry.workflow, canDispatch) === null,
  );
  if (!row) return null;
  const release = row.entry.relevance === 'configured' || row.entry.relevance === 'release';
  return {
    kind: 'start',
    workflowId: row.entry.workflow.id,
    repositoryId: row.repository.id,
    label: release ? 'Start release' : `Run ${row.entry.workflow.name}`,
  };
}

const pastTense = (run: Pick<WorkflowRun, 'status' | 'conclusion'>): string => {
  if (run.conclusion === 'success') return 'succeeded';
  if (run.conclusion === 'cancelled') return 'was cancelled';
  if (isFailedRun(run)) return 'failed';
  return `finished (${runBadge(run).label.toLowerCase()})`;
};

export function workflowsLead(input: {
  rows: readonly WorkflowRow[];
  runs: readonly WorkflowRun[];
  now: number;
  canDispatch: boolean;
}): WorkflowsLead {
  const hint = countsLine(input.rows);
  const named = input.runs.filter((r) => !isPending(r));
  const active = named.filter((r) => r.active).sort((a, b) => b.startedAt - a.startedAt);
  const start = startCandidate(input.rows, input.canDispatch);
  const going = input.runs.filter((r) => r.active).length;
  if (going > 0) {
    const first = active[0];
    return {
      headline: going === 1 ? '1 run is going now' : `${going} runs are going now`,
      hint,
      tone: 'info',
      primary: first ? { kind: 'open', runId: first.id, label: 'Follow the run' } : start,
    };
  }
  const finished = named
    .filter((r) => !r.active)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  const last = finished[0];
  if (!last) {
    return {
      headline: input.rows.length === 0 ? 'No workflows to run yet' : 'No run has been read yet',
      hint,
      tone: 'neutral',
      primary: start,
    };
  }
  const ago = timeAgo(last.startedAt, input.now);
  const headline = `Last run ${pastTense(last)} ${ago}${where(last)}`;
  if (isFailedRun(last))
    return {
      headline,
      hint,
      tone: 'bad',
      primary: { kind: 'open', runId: last.id, label: 'Open the run' },
    };
  return {
    headline,
    hint,
    tone: last.conclusion === 'success' ? 'ok' : 'neutral',
    primary: start ?? { kind: 'open', runId: last.id, label: 'Open the run' },
  };
}
