import type { Tone } from './repositories.ts';
import type { AppBuild, BuildChanges, CiWorkflow, WorkflowInputSpec, WorkflowRun } from './types.ts';

/** Pure helpers for the CI panel and the builds panel. No fetching, no DOM. */

// ---------------------------------------------------------------------------------------------
// Run status

export type RunBadge = { label: string; tone: Tone; dot: boolean };

const finished: Record<string, RunBadge> = {
  success: { label: 'Succeeded', tone: 'ok', dot: false },
  failure: { label: 'Failed', tone: 'bad', dot: false },
  timed_out: { label: 'Timed out', tone: 'bad', dot: false },
  startup_failure: { label: 'Failed to start', tone: 'bad', dot: false },
  cancelled: { label: 'Cancelled', tone: 'neutral', dot: false },
  skipped: { label: 'Skipped', tone: 'neutral', dot: false },
  stale: { label: 'Stale', tone: 'neutral', dot: false },
  neutral: { label: 'Finished', tone: 'neutral', dot: false },
  action_required: { label: 'Needs approval', tone: 'warn', dot: false },
};

/** The words and tone for a run. The text always says the state, so colour is never alone. */
export function runBadge(run: Pick<WorkflowRun, 'status' | 'conclusion'>): RunBadge {
  switch (run.status) {
    case 'pending':
      return { label: 'Starting', tone: 'info', dot: true };
    case 'queued':
    case 'requested':
    case 'waiting':
      return { label: 'Queued', tone: 'neutral', dot: true };
    case 'in_progress':
      return { label: 'Running', tone: 'info', dot: true };
    case 'completed':
      return (run.conclusion ? finished[run.conclusion] : undefined) ?? { label: 'Finished', tone: 'neutral', dot: false };
    default:
      return { label: 'Unknown', tone: 'neutral', dot: false };
  }
}

/** True while any run is not finished: the cue to keep polling. */
export const hasActiveRun = (runs: readonly Pick<WorkflowRun, 'active'>[]): boolean => runs.some((r) => r.active);

/** Where GitHub lists the run, when it is known. A pending run has no page yet. */
export const runHref = (run: Pick<WorkflowRun, 'url'>): string | null => run.url;

export const isPending = (run: Pick<WorkflowRun, 'id'>): boolean => run.id.startsWith('pending-');

/** "iOS release #12", or the title when the workflow set one. */
export function runTitle(run: Pick<WorkflowRun, 'title' | 'workflow' | 'runNumber'>): string {
  const title = run.title?.trim();
  if (title) return title;
  return run.runNumber === null ? run.workflow : `${run.workflow} #${run.runNumber}`;
}

/** Runs that are still going first, then the newest. Does not change the array it is given. */
export function sortRuns<T extends Pick<WorkflowRun, 'active' | 'startedAt' | 'id'>>(runs: readonly T[]): T[] {
  return [...runs].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}

/** How long a finished run took, as "3 min 20 s"; null while it is going or when times are odd. */
export function runDuration(run: Pick<WorkflowRun, 'active' | 'startedAt' | 'updatedAt'>): string | null {
  if (run.active || run.updatedAt < run.startedAt) return null;
  const seconds = Math.round((run.updatedAt - run.startedAt) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** What the API takes for a workflow: its file name (`ios.yml`), else its id. */
export const workflowKey = (workflow: Pick<CiWorkflow, 'id' | 'path'>): string =>
  workflow.path.split('/').pop() || workflow.id;

/** Only an active workflow can be started; GitHub lists disabled ones too. */
export const canDispatchWorkflow = (workflow: Pick<CiWorkflow, 'state'>): boolean => workflow.state === 'active';

// ---------------------------------------------------------------------------------------------
// Polling cadence

export const POLL_MS = 5_000;
export const POLL_MAX_MS = 60_000;

/** Milliseconds between polls: steady while all goes well, doubling after each failure up to a minute. */
export const pollDelay = (failures: number, base = POLL_MS, max = POLL_MAX_MS): number =>
  Math.min(max, base * 2 ** Math.max(0, Math.min(failures, 10)));

// ---------------------------------------------------------------------------------------------
// The dispatch form

export type InputValues = Record<string, string>;

/** The starting values of the form: each input's default, `false` for a boolean without one. */
export function initialInputValues(specs: readonly WorkflowInputSpec[]): InputValues {
  const values: InputValues = {};
  for (const spec of specs) {
    if (spec.default !== undefined) values[spec.name] = spec.default;
    else if (spec.type === 'boolean') values[spec.name] = 'false';
    else if (spec.type === 'choice' && spec.required && spec.options?.[0] !== undefined) values[spec.name] = spec.options[0];
    else values[spec.name] = '';
  }
  return values;
}

/** One message per input that cannot be sent as it is. Empty means the form is fine. */
export function inputProblems(specs: readonly WorkflowInputSpec[], values: Readonly<InputValues>): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const spec of specs) {
    const value = (values[spec.name] ?? '').trim();
    if (value === '') {
      if (spec.required) problems[spec.name] = `${spec.name} is required.`;
      continue;
    }
    if (spec.type === 'number' && !Number.isFinite(Number(value))) {
      problems[spec.name] = `${spec.name} must be a number.`;
    } else if (spec.type === 'boolean' && value !== 'true' && value !== 'false') {
      problems[spec.name] = `${spec.name} must be true or false.`;
    } else if (spec.type === 'choice' && spec.options && !spec.options.includes(value)) {
      problems[spec.name] = `${spec.name} must be one of: ${spec.options.join(', ')}.`;
    } else if (value.length > 4096) {
      problems[spec.name] = `${spec.name} is too long (4096 characters at most).`;
    }
  }
  return problems;
}

/**
 * The inputs to send: every field that has a value. An empty optional field is left out, so the
 * workflow's own default applies. Values go as text, as GitHub takes them.
 */
export function dispatchInputs(specs: readonly WorkflowInputSpec[], values: Readonly<InputValues>): InputValues {
  const out: InputValues = {};
  for (const spec of specs) {
    const value = (values[spec.name] ?? '').trim();
    if (value !== '') out[spec.name] = value;
  }
  return out;
}

const INPUT_NAME = /^[A-Za-z0-9_-]{1,100}$/;
export const MAX_DISPATCH_INPUTS = 25;

export type FreeFormInputs = { inputs: InputValues; problems: string[] };

/**
 * For a workflow whose inputs could not be read from its file: `name=value` lines. Blank lines and
 * lines that start with # are skipped. The first `=` splits, so a value may hold more of them.
 */
export function parseFreeFormInputs(text: string): FreeFormInputs {
  const inputs: InputValues = {};
  const problems: string[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) {
      problems.push(`Line ${lineNo}: write name=value.`);
      continue;
    }
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!INPUT_NAME.test(name)) {
      problems.push(`Line ${lineNo}: "${name}" is not a valid input name (letters, digits, - and _).`);
      continue;
    }
    if (name in inputs) {
      problems.push(`Line ${lineNo}: ${name} is given twice.`);
      continue;
    }
    if (value.length > 4096) {
      problems.push(`Line ${lineNo}: the value of ${name} is too long.`);
      continue;
    }
    inputs[name] = value;
  }
  if (Object.keys(inputs).length > MAX_DISPATCH_INPUTS) {
    problems.push(`GitHub accepts at most ${MAX_DISPATCH_INPUTS} inputs.`);
  }
  return { inputs, problems };
}

/** The confirmation text: what is about to run, where, with which inputs (names and values). */
export function dispatchSummary(input: {
  workflow: string;
  ref: string;
  repository: string;
  inputs: Readonly<InputValues>;
}): string {
  const names = Object.keys(input.inputs);
  const withInputs = names.length === 0 ? 'with no inputs' : `with ${names.length} input${names.length === 1 ? '' : 's'}`;
  return `Run ${input.workflow} on ${input.ref} in ${input.repository} ${withInputs}.`;
}

// ---------------------------------------------------------------------------------------------
// Builds

/** What the person reads for how a link was made. */
export function linkSourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return 'Linked by hand';
    case 'dispatch_input':
      return 'Matched by the dispatch input';
    case 'run_title':
      return 'Matched by the run title';
    case 'run_number':
      return 'Matched by the run number';
    default:
      return `Matched by ${source}`;
  }
}

/** The state of a build in one word for the table: Linked or Unlinked. */
export const buildLinkLabel = (build: Pick<AppBuild, 'linkState'>): string =>
  build.linkState === 'linked' ? 'Linked' : 'Unlinked';

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The platform's word for the number: iOS has builds, Android has version codes. */
export const buildNumberLabel = (platform: 'ios' | 'android'): string =>
  platform === 'ios' ? 'Build' : 'Version code';

/** "2.4.0 (240)" */
export const buildName = (build: Pick<AppBuild, 'version' | 'buildNumber'>): string =>
  `${build.version} (${build.buildNumber})`;

/** The earlier linked build of the same platform that "what changed" compares with by default. */
export function previousLinkedBuild(
  builds: readonly AppBuild[],
  build: Pick<AppBuild, 'platform' | 'buildNumber'>,
): AppBuild | undefined {
  const own = builds.filter((b) => b.platform === build.platform);
  const at = own.findIndex((b) => b.buildNumber === build.buildNumber);
  if (at < 0) return undefined;
  return own.slice(at + 1).find((b) => b.link?.commit);
}

/** A sentence about how the two builds relate, from GitHub's word. */
export function changesHeadline(
  changes: Pick<BuildChanges, 'status' | 'totalCommits' | 'behindBy' | 'base' | 'head'>,
): string {
  const from = changes.base.buildNumber;
  const to = changes.head.buildNumber;
  switch (changes.status) {
    case 'identical':
      return `Build ${to} and build ${from} were made from the same commit.`;
    case 'behind':
      return `Build ${to} is older than build ${from}: it is behind it by ${changes.behindBy} commit${changes.behindBy === 1 ? '' : 's'}.`;
    case 'diverged':
      return `Build ${to} and build ${from} come from branches that split. The commits below are only in build ${to}.`;
    default:
      return `${changes.totalCommits} commit${changes.totalCommits === 1 ? '' : 's'} in build ${to} since build ${from}.`;
  }
}
