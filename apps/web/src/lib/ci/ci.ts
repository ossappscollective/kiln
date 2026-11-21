import {
  DEFAULT_RELEASE_PATTERNS,
  DEFAULT_TAG_PATTERNS,
  MAX_PATTERNS,
  type PatternKind,
  type Platform,
  type PreviewRow,
  ciProviderMeta,
  patternListProblems,
  platformLabel,
  platformMeta,
  prefixProblem,
  previewPatterns,
  proposePattern,
} from '@kiln/core';
import type { Tone } from '../repositories.ts';
import type {
  AppBuild,
  BuildChanges,
  BuildConventionsView,
  BuildConventionValues,
  BuildDiagnostics,
  CiWorkflow,
  LinkConfidence,
  RepositoryTags,
  WorkflowInputSpec,
  WorkflowRun,
} from '../types.ts';

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
      return (
        (run.conclusion ? finished[run.conclusion] : undefined) ?? {
          label: 'Finished',
          tone: 'neutral',
          dot: false,
        }
      );
    default:
      return { label: 'Unknown', tone: 'neutral', dot: false };
  }
}

/** True while any run is not finished: the cue to keep polling. */
export const hasActiveRun = (runs: readonly Pick<WorkflowRun, 'active'>[]): boolean =>
  runs.some((r) => r.active);

/** The words and abilities of the CI provider a run lives in (an older server sends none: GitHub). */
export const runProvider = (run: Pick<WorkflowRun, 'provider'>) => ciProviderMeta(run.provider);

/** Where the provider lists the run, when it is known. A pending run has no page yet. */
export const runHref = (run: Pick<WorkflowRun, 'url'>): string | null => run.url;

export const isPending = (run: Pick<WorkflowRun, 'id'>): boolean => run.id.startsWith('pending-');

/** "iOS release #12", or the title when the workflow set one. */
export function runTitle(run: Pick<WorkflowRun, 'title' | 'workflow' | 'runNumber'>): string {
  const title = run.title?.trim();
  if (title) return title;
  return run.runNumber === null ? run.workflow : `${run.workflow} #${run.runNumber}`;
}

/** Runs that are still going first, then the newest. Does not change the array it is given. */
export function sortRuns<T extends Pick<WorkflowRun, 'active' | 'startedAt' | 'id'>>(
  runs: readonly T[],
): T[] {
  return [...runs].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}

/** How long a finished run took, as "3 min 20 s"; null while it is going or when times are odd. */
export function runDuration(
  run: Pick<WorkflowRun, 'active' | 'startedAt' | 'updatedAt'>,
): string | null {
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
export const canDispatchWorkflow = (workflow: Pick<CiWorkflow, 'state'>): boolean =>
  workflow.state === 'active';

// ---------------------------------------------------------------------------------------------
// Polling cadence

export const POLL_MS = 15_000;
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
    else if (spec.type === 'choice' && spec.required && spec.options?.[0] !== undefined)
      values[spec.name] = spec.options[0];
    else values[spec.name] = '';
  }
  return values;
}

/** One message per input that cannot be sent as it is. Empty means the form is fine. */
export function inputProblems(
  specs: readonly WorkflowInputSpec[],
  values: Readonly<InputValues>,
): Record<string, string> {
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
export function dispatchInputs(
  specs: readonly WorkflowInputSpec[],
  values: Readonly<InputValues>,
): InputValues {
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
      problems.push(
        `Line ${lineNo}: "${name}" is not a valid input name (letters, digits, - and _).`,
      );
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
  const withInputs =
    names.length === 0
      ? 'with no inputs'
      : `with ${names.length} input${names.length === 1 ? '' : 's'}`;
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
    case 'tag':
      return 'Found through the tag';
    case 'release':
      return 'Found through the GitHub release';
    default:
      return `Matched by ${source}`;
  }
}

/** The state of a build in a few words for the table: Linked, Tag found or Unlinked. */
export const buildLinkLabel = (build: Pick<AppBuild, 'linkState'>): string =>
  build.linkState === 'linked' ? 'Linked' : build.linkState === 'tag' ? 'Tag found' : 'Unlinked';

/** The words and tone for how sure a link is. The text always says it, so colour is never alone. */
export function confidenceBadge(confidence: LinkConfidence): { label: string; tone: Tone } {
  switch (confidence) {
    case 'high':
      return { label: 'High confidence', tone: 'ok' };
    case 'medium':
      return { label: 'Medium confidence', tone: 'info' };
    default:
      return { label: 'Low confidence', tone: 'warn' };
  }
}

/** Whether a link is worth a second look: a guess from times, or several runs that fit. */
export const isUncertain = (
  link: { confidence: LinkConfidence; manual: boolean } | null,
): boolean => link !== null && !link.manual && link.confidence === 'low';

/** What a "Tag found" build says in the table: which tag, and what is missing. */
export function tagFoundText(link: {
  evidence: { tag: string; kind: 'tag' | 'release'; noRunReason: string | null } | null;
}): string {
  const e = link.evidence;
  if (!e) return 'A tag carries this build number, but no run was found for its commit.';
  const what = e.kind === 'release' ? 'GitHub release' : 'tag';
  return `The ${what} ${e.tag} carries this build number. ${e.noRunReason ?? 'No run was found for its commit.'}`;
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The platform's word for the number: Apple platforms have builds, Android has version codes. */
export const buildNumberLabel = (platform: Platform): string =>
  platformMeta(platform).buildLabelSingular;

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

// ---------------------------------------------------------------------------------------------
// Why a build is unlinked

/** Plain sentences about what the last search did, for the diagnostics under the table. */
export function diagnosticsLines(d: BuildDiagnostics): string[] {
  const lines: string[] = [];
  if (d.scannedAt === null) {
    lines.push('Tags and releases have not been searched yet.');
  } else if (d.scanOk === false) {
    lines.push(`The last search failed${d.scanError ? `: ${d.scanError}` : '.'}`);
  } else {
    if (d.tags) {
      const more = d.tags.truncated ? ' (more exist than were read)' : '';
      lines.push(`${d.tags.seen} tag${d.tags.seen === 1 ? '' : 's'} read${more}.`);
    }
    if (d.releases) {
      if (d.releases.error) lines.push(`Releases could not be read: ${d.releases.error}`);
      else lines.push(`${d.releases.seen} GitHub release${d.releases.seen === 1 ? '' : 's'} read.`);
    }
    if (d.fitting > 0 && d.newestFit) {
      lines.push(
        `${d.fitting} name${d.fitting === 1 ? '' : 's'} fit a pattern; the newest build number among them is ${d.newestFit.buildNumber} (${d.newestFit.name}).`,
      );
    } else if ((d.tags?.seen ?? 0) > 0) {
      lines.push('No tag or release name fits a pattern.');
    }
  }
  lines.push(`${d.runs.stored} CI run${d.runs.stored === 1 ? ' is' : 's are'} stored.`);
  return lines;
}

/** Where the patterns in use come from, in a few words. */
export function conventionSourceLabel(
  patterns: Pick<BuildDiagnostics['patterns'], 'source'>,
): string {
  if (patterns.source === 'app') return "this app's own patterns";
  if (patterns.source === 'repository') return "the repository's patterns";
  return 'the built-in patterns';
}

/**
 * Whether the page should ask for a search by itself: only when the repository's tags were never
 * searched, something is unlinked, and the person may ask GitHub. It is tried once per app.
 */
export function shouldAutoRematch(input: {
  hasRepository: boolean;
  canScan: boolean;
  diagnostics: Pick<BuildDiagnostics, 'scannedAt' | 'canReadTags'> | null;
  unlinked: number;
  alreadyTried: boolean;
}): boolean {
  return (
    input.hasRepository &&
    input.canScan &&
    !input.alreadyTried &&
    input.unlinked > 0 &&
    input.diagnostics !== null &&
    input.diagnostics.scannedAt === null &&
    input.diagnostics.canReadTags
  );
}

// ---------------------------------------------------------------------------------------------
// The "Build number conventions" dialog

/** What the dialog edits: one pattern per line. */
export type ConventionDraft = {
  tagText: string;
  releaseText: string;
  prefix: string;
  workflow: string;
};

/** One pattern per line; blank lines are dropped, the rest is kept as typed (apart from outer spaces). */
export const parsePatternLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

export const patternLines = (patterns: readonly string[]): string => patterns.join('\n');

/** The starting values: what is stored for the scope, else empty (which means "use the defaults"). */
export function draftOf(view: Pick<BuildConventionsView, 'stored'>): ConventionDraft {
  const s = view.stored;
  return {
    tagText: patternLines(s?.tagPatterns ?? []),
    releaseText: patternLines(s?.releasePatterns ?? []),
    prefix: s?.prefix ?? '',
    workflow: s?.workflow ?? '',
  };
}

export const draftValues = (draft: ConventionDraft): BuildConventionValues => ({
  tagPatterns: parsePatternLines(draft.tagText),
  releasePatterns: parsePatternLines(draft.releaseText),
  prefix: draft.prefix.trim(),
  workflow: draft.workflow.trim() === '' ? null : draft.workflow.trim(),
});

/** Whether two drafts mean the same thing once saved. */
export const sameDraft = (a: ConventionDraft, b: ConventionDraft): boolean =>
  JSON.stringify(draftValues(a)) === JSON.stringify(draftValues(b));

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,199}$/;

export type DraftProblems = {
  tags: string[];
  releases: string[];
  prefix: string | undefined;
  workflow: string | undefined;
};

/** The messages the server would refuse the draft with, so the person sees them before saving. */
export function draftProblems(draft: ConventionDraft): DraftProblems {
  const values = draftValues(draft);
  const prefix = prefixProblem(values.prefix);
  const options = { prefix: prefix ? '' : values.prefix };
  return {
    tags: patternListProblems(values.tagPatterns, { ...options, kind: 'tag' }),
    releases: patternListProblems(values.releasePatterns, { ...options, kind: 'release' }),
    prefix,
    workflow:
      values.workflow !== null && !WORKFLOW_NAME.test(values.workflow)
        ? 'A workflow file name such as release.yml.'
        : undefined,
  };
}

export const hasDraftProblems = (p: DraftProblems): boolean =>
  p.tags.length > 0 || p.releases.length > 0 || p.prefix !== undefined || p.workflow !== undefined;

export type ConventionPreview = {
  tags: PreviewRow[];
  releases: PreviewRow[];
  /** Names that fit a pattern, of all that were read. */
  tagFits: number;
  releaseFits: number;
  /** The patterns in use: the draft's, or the defaults for an empty list. */
  usedTagPatterns: string[];
  usedReleasePatterns: string[];
};

/** The name of a release for matching: its title, else its tag. Drafts are skipped by the caller. */
export const releaseName = (r: { name: string | null; tagName: string }): string =>
  r.name && r.name.trim() !== '' ? r.name : r.tagName;

/**
 * What the draft's patterns read from the repository's tags and releases. An empty list means the
 * defaults, as on the server. A name that says the other platform is marked, so a monorepo's
 * Android tags do not look like a fit for an iOS app.
 */
export function previewConventions(
  names: Pick<RepositoryTags, 'tags' | 'releases'>,
  draft: ConventionDraft,
  platform: Platform,
): ConventionPreview {
  const values = draftValues(draft);
  const prefix = prefixProblem(values.prefix) ? '' : values.prefix;
  const usedTagPatterns =
    values.tagPatterns.length > 0 ? values.tagPatterns : [...DEFAULT_TAG_PATTERNS];
  const usedReleasePatterns =
    values.releasePatterns.length > 0 ? values.releasePatterns : [...DEFAULT_RELEASE_PATTERNS];
  const tags = previewPatterns(
    names.tags.map((t) => t.name),
    usedTagPatterns,
    { kind: 'tag', prefix, platform },
  );
  const releases = previewPatterns(
    names.releases.filter((r) => !r.draft).map(releaseName),
    usedReleasePatterns,
    { kind: 'release', prefix, platform },
  );
  const fits = (rows: PreviewRow[]) =>
    rows.filter((r) => r.matched && r.platformOk !== false).length;
  return {
    tags,
    releases,
    tagFits: fits(tags),
    releaseFits: fits(releases),
    usedTagPatterns,
    usedReleasePatterns,
  };
}

const sameNumber = (a: string, b: string) =>
  /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b);

/** The preview rows that carry this build's number (and are not for the other platform). */
export const rowsForBuild = (rows: readonly PreviewRow[], buildNumber: string): PreviewRow[] =>
  rows.filter(
    (r) =>
      r.matched &&
      r.platformOk !== false &&
      r.fields !== undefined &&
      sameNumber(r.fields.buildNumber, buildNumber),
  );

/** Short text for a preview row: what was read from the name. */
export function previewReading(row: PreviewRow): string {
  if (!row.matched || !row.fields) return 'Fits no pattern';
  const f = row.fields;
  const parts = [`build ${f.buildNumber}`];
  if (f.version) parts.push(`version ${f.version}`);
  if (f.platform)
    parts.push(
      f.platform === 'other'
        ? `platform ${f.platformWord ?? '?'} (not used)`
        : platformLabel(f.platform),
    );
  if (f.flavor) parts.push(f.flavor);
  if (row.platformOk === false) parts.push('other platform: not used for this app');
  return parts.join(' · ');
}

export type Proposal = { ok: true; pattern: string } | { ok: false; message: string };

/**
 * The "add pattern" helper: from one name the person pastes or picks (a tag, or a release name),
 * a pattern with the build number, version and platform turned into placeholders. The build's own
 * number and version are the hints, so the right digits are chosen.
 */
export function proposeFromExample(
  example: string,
  build: Pick<AppBuild, 'buildNumber' | 'version'>,
  kind: PatternKind,
): Proposal {
  const text = example.trim();
  if (text === '') return { ok: false, message: 'Paste or pick a tag or release name.' };
  const proposal = proposePattern(text, {
    buildNumber: build.buildNumber,
    version: build.version,
    kind,
  });
  if (!proposal) return { ok: false, message: 'No build number was found in that name.' };
  return { ok: true, pattern: proposal.pattern };
}

/**
 * Adds a pattern to the lines of a list: not twice, and never past the limit. An empty list means
 * "the defaults", so the new pattern is put first and the defaults are kept behind it; otherwise
 * saving it would silently drop them.
 */
export function appendPattern(
  text: string,
  pattern: string,
  defaults: readonly string[] = [],
): { text: string; added: boolean; reason?: string } {
  const lines = parsePatternLines(text);
  if (lines.includes(pattern))
    return { text, added: false, reason: 'That pattern is already in the list.' };
  if (lines.length === 0) {
    const next = [pattern, ...defaults.filter((d) => d !== pattern)].slice(0, MAX_PATTERNS);
    return { text: patternLines(next), added: true };
  }
  if (lines.length >= MAX_PATTERNS)
    return { text, added: false, reason: `A list holds ${MAX_PATTERNS} patterns at most.` };
  return { text: patternLines([...lines, pattern]), added: true };
}
