import {
  compareBuildNumbers,
  type CompiledPattern,
  compilePatterns,
  matchName,
  type NameFields,
  type Platform,
} from '@kiln/core';
import type { BuildConventions } from './conventions.ts';
import type { WorkflowRunView } from './runs.ts';

/**
 * Follows a build number to the run that made it through the tag a release lane creates:
 *
 *   build number -> tag (or release) -> the tag's commit -> the run.
 *
 * This is for workflows that decide the number while they run (read the version code, bump it,
 * commit the bump, tag it, upload), so the number is not an input of the dispatch and not in the
 * run title, and the run's `head_sha` is the commit before the bump. The bump commit and the tag
 * are made during the run: the tag's commit has the run's head as its parent, and its time falls
 * inside the run's start-to-end window.
 *
 * Everything here is pure (no GitHub, no database): the services read the tags, the releases and
 * the commits, and call these functions with what they read.
 */

export type Confidence = 'high' | 'medium' | 'low';

/**
 * How far outside a run's `started_at`..`updated_at` window a commit may fall and still count as
 * made during the run. Before the start only a little (clock difference between the runner and
 * GitHub), so the run a push of the bump commit triggers a moment later is not taken for the
 * release run; after the end a minute (a run's last update can precede its last commit by a bit).
 */
export const RUN_WINDOW_SLACK = { beforeMs: 10_000, afterMs: 60_000 } as const;

/** At most this many candidate commits are looked at per build. */
export const MAX_CANDIDATES_PER_BUILD = 4;

export type TagRef = { name: string; sha: string };

export type ReleaseRef = {
  name: string | null;
  tagName: string;
  /** A branch name or a commit sha, as the release was created. */
  targetCommitish: string | null;
  draft: boolean;
  createdAt: number | null;
  publishedAt: number | null;
  url: string | null;
};

export type TagData = { tags: readonly TagRef[]; releases: readonly ReleaseRef[] };

/** The build being looked for. */
export type BuildKey = { platform: Platform; buildNumber: string; version: string };

/** The conventions with the defaults filled in. */
export type ConventionPatterns = Pick<
  BuildConventions,
  'tagPatterns' | 'releasePatterns' | 'prefix' | 'workflow'
>;

export type CompiledConventions = { tags: CompiledPattern[]; releases: CompiledPattern[] };

export function compileConventions(c: ConventionPatterns): CompiledConventions {
  return {
    tags: compilePatterns(c.tagPatterns, { kind: 'tag', prefix: c.prefix }),
    releases: compilePatterns(c.releasePatterns, { kind: 'release', prefix: c.prefix }),
  };
}

const SHA = /^[0-9a-f]{40}$/i;
const stripZeros = (n: string) => n.replace(/^0+(?=\d)/, '');

/** A name that carries this build's number, for this build's platform (when the name says one). */
function fitsBuild(fields: NameFields, build: BuildKey): boolean {
  if (stripZeros(fields.buildNumber) !== stripZeros(build.buildNumber)) return false;
  return fields.platform === undefined || fields.platform === build.platform;
}

// ---------------------------------------------------------------------------------------------
// Build number -> tag

export type TagCandidate = {
  kind: 'tag' | 'release';
  /** The git tag name (for a release, the tag it belongs to). */
  tag: string;
  releaseName: string | null;
  /** The pattern that read the name. */
  pattern: string;
  /** The commit the tag points at; null when it is not known (a release whose tag was not read). */
  sha: string | null;
  /** When the release was published (or created): a time to put against run windows. */
  releaseAt: number | null;
  /** Whether the name's version is the build's version; null when the name has none. */
  versionMatch: boolean | null;
  fields: NameFields;
};

const versionRank = (c: TagCandidate) =>
  c.versionMatch === true ? 0 : c.versionMatch === null ? 1 : 2;

/**
 * The tags and releases whose names carry this build's number (and do not name the other
 * platform), best first: names whose version agrees with the build's, tags before releases.
 */
export function findCandidates(
  build: BuildKey,
  data: TagData,
  compiled: CompiledConventions,
): TagCandidate[] {
  const byTag = new Map<string, TagCandidate>();
  const tagSha = new Map(data.tags.map((t) => [t.name, t.sha]));
  const version = (fields: NameFields) =>
    fields.version === undefined ? null : fields.version === build.version;

  for (const tag of data.tags) {
    const hit = matchName(tag.name, compiled.tags);
    if (!hit || !fitsBuild(hit.fields, build)) continue;
    byTag.set(tag.name, {
      kind: 'tag',
      tag: tag.name,
      releaseName: null,
      pattern: hit.pattern,
      sha: tag.sha,
      releaseAt: null,
      versionMatch: version(hit.fields),
      fields: hit.fields,
    });
  }
  for (const release of data.releases) {
    if (release.draft) continue;
    const at = release.publishedAt ?? release.createdAt;
    const known = byTag.get(release.tagName);
    if (known) {
      // The release of a tag already found: add what the release knows.
      known.releaseName = release.name;
      known.releaseAt = at;
      continue;
    }
    const sha =
      tagSha.get(release.tagName) ??
      (release.targetCommitish && SHA.test(release.targetCommitish)
        ? release.targetCommitish.toLowerCase()
        : null);
    // The release's tag may fit a tag pattern even if the tag list did not reach it.
    const tagHit = tagSha.has(release.tagName)
      ? undefined
      : matchName(release.tagName, compiled.tags);
    if (tagHit && fitsBuild(tagHit.fields, build)) {
      byTag.set(release.tagName, {
        kind: 'tag',
        tag: release.tagName,
        releaseName: release.name,
        pattern: tagHit.pattern,
        sha,
        releaseAt: at,
        versionMatch: version(tagHit.fields),
        fields: tagHit.fields,
      });
      continue;
    }
    const nameHit = release.name ? matchName(release.name, compiled.releases) : undefined;
    if (!nameHit || !fitsBuild(nameHit.fields, build)) continue;
    byTag.set(release.tagName, {
      kind: 'release',
      tag: release.tagName,
      releaseName: release.name,
      pattern: nameHit.pattern,
      sha,
      releaseAt: at,
      versionMatch: version(nameHit.fields),
      fields: nameHit.fields,
    });
  }
  return [...byTag.values()].sort(
    (a, b) =>
      versionRank(a) - versionRank(b) ||
      Number(b.kind === 'tag') - Number(a.kind === 'tag') ||
      a.tag.localeCompare(b.tag),
  );
}

export type NoCandidate = {
  code: 'no_tags' | 'no_pattern_fit' | 'number_not_found' | 'other_platform';
  message: string;
  /** Names (tags and releases) that fit a pattern, whatever their number. */
  fitting: number;
  /** The name with the highest number among those that fit this build's platform. */
  newestFit: { name: string; buildNumber: string } | null;
};

/** Why no tag or release carries the build: the first thing that is missing. */
export function explainNoCandidate(
  build: BuildKey,
  data: TagData,
  compiled: CompiledConventions,
): NoCandidate {
  const total = data.tags.length + data.releases.filter((r) => !r.draft).length;
  if (total === 0) {
    return {
      code: 'no_tags',
      message:
        'The repository has no tags or releases that could be read, so there is nothing to find the number in.',
      fitting: 0,
      newestFit: null,
    };
  }
  const fits: { name: string; fields: NameFields }[] = [];
  for (const tag of data.tags) {
    const hit = matchName(tag.name, compiled.tags);
    if (hit) fits.push({ name: tag.name, fields: hit.fields });
  }
  for (const release of data.releases) {
    if (release.draft || !release.name) continue;
    const hit = matchName(release.name, compiled.releases);
    if (hit) fits.push({ name: release.name, fields: hit.fields });
  }
  const own = fits.filter(
    (f) => f.fields.platform === undefined || f.fields.platform === build.platform,
  );
  let newestFit: NoCandidate['newestFit'] = null;
  for (const f of own) {
    if (newestFit === null || compareBuildNumbers(f.fields.buildNumber, newestFit.buildNumber) > 0) {
      newestFit = { name: f.name, buildNumber: f.fields.buildNumber };
    }
  }
  const sample = data.tags[0]?.name ?? data.releases[0]?.tagName ?? '';
  if (fits.length === 0) {
    return {
      code: 'no_pattern_fit',
      message: `None of the ${data.tags.length} tags and ${data.releases.length} releases read fits a pattern${sample ? ` (for example "${sample.slice(0, 80)}")` : ''}. The tag names may follow another convention.`,
      fitting: 0,
      newestFit: null,
    };
  }
  const numbered = fits.filter(
    (f) => stripZeros(f.fields.buildNumber) === stripZeros(build.buildNumber),
  );
  if (
    numbered.length > 0 &&
    own.every((f) => stripZeros(f.fields.buildNumber) !== stripZeros(build.buildNumber))
  ) {
    const names = numbered
      .slice(0, 3)
      .map((f) => `"${f.name.slice(0, 80)}"`)
      .join(', ');
    return {
      code: 'other_platform',
      message: `Number ${build.buildNumber} was found only for another platform (${names}), not for ${build.platform}.`,
      fitting: fits.length,
      newestFit,
    };
  }
  return {
    code: 'number_not_found',
    message: `${fits.length} tag or release names fit a pattern, but none has number ${build.buildNumber}${
      newestFit
        ? ` (the highest for ${build.platform} is ${newestFit.buildNumber}, "${newestFit.name.slice(0, 80)}")`
        : ''
    }.`,
    fitting: fits.length,
    newestFit,
  };
}

// ---------------------------------------------------------------------------------------------
// Commit -> run

/** What is known of a commit, read from GitHub (or kept from an earlier read). */
export type CommitFacts = {
  sha: string;
  parents: string[];
  /** When it was made (committer date, else author date), epoch ms. */
  committedAt: number | null;
  /** First line of the message. */
  message: string | null;
  author: string | null;
  url: string | null;
};

export type RunFacts = Pick<
  WorkflowRunView,
  | 'id'
  | 'workflow'
  | 'workflowPath'
  | 'headSha'
  | 'event'
  | 'status'
  | 'conclusion'
  | 'active'
  | 'startedAt'
  | 'updatedAt'
>;

export type RunMatch = {
  run: RunFacts;
  confidence: Confidence;
  reason: string;
  /** How many runs qualified. */
  candidates: number;
};

/** Names of workflows that ship builds; used when no release workflow is configured. */
export const RELEASE_WORKFLOW = /release|publish|deploy|ship|distribut|store|testflight|fastlane/i;

const workflowMatches = (run: RunFacts, wanted: string) => {
  const w = wanted.toLowerCase();
  return [run.workflow, run.workflowPath, run.workflowPath?.split('/').pop()].some(
    (v) => v?.toLowerCase() === w,
  );
};

const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/**
 * Finds the run that made a tag's commit. A run qualifies when
 *  (a) the commit is a child of the run's commit, or is the run's commit (the lane tags what it
 *      built), and/or
 *  (b) the commit's time falls inside the run's window (with a little slack),
 * and the run's workflow is the repository's release workflow: the configured one, else any whose
 * name says release, publish, deploy, ... (a run of another workflow is only offered, at `low`
 * confidence, when nothing else qualifies).
 *
 * Confidence: `high` when exactly one release run is both related to the commit and contains its
 * time; `medium` when exactly one run qualifies by one of the two, or when several qualify and
 * one alone contains the time; `low` otherwise.
 */
export function matchCommitToRun(input: {
  commit: {
    sha: string;
    parents: readonly string[];
    at: number | null;
    atSource: 'commit' | 'release' | null;
  };
  runs: readonly RunFacts[];
  /** The configured release workflow (file name, path or name), or null to detect it. */
  workflow: string | null;
  slack?: { beforeMs: number; afterMs: number };
}): RunMatch | { reason: string } {
  const slack = input.slack ?? RUN_WINDOW_SLACK;
  const { commit } = input;
  const parents = new Set(commit.parents);
  const usable = input.runs.filter((r) => r.headSha && r.status !== 'pending');
  const flags = usable.map((run) => {
    const related = parents.has(run.headSha as string) || run.headSha === commit.sha;
    const inWindow =
      commit.at !== null &&
      commit.at >= run.startedAt - slack.beforeMs &&
      commit.at <= (run.active ? Number.POSITIVE_INFINITY : run.updatedAt + slack.afterMs);
    return { run, related, inWindow, parent: parents.has(run.headSha as string) };
  });
  const qualified = flags.filter((f) => f.related || f.inWindow);
  if (qualified.length === 0) {
    return {
      reason:
        usable.length === 0
          ? 'No CI run is stored for this repository.'
          : commit.at === null
            ? `No stored run has ${commit.sha.slice(0, 7)} or its parent as its commit, and the commit time is not known.`
            : `No stored run has ${commit.sha.slice(0, 7)} or its parent as its commit, or was running at ${hhmm(commit.at)}.`,
    };
  }

  let pool = qualified;
  let generic = false;
  if (input.workflow) {
    const wanted = input.workflow;
    pool = qualified.filter((f) => workflowMatches(f.run, wanted));
    if (pool.length === 0) {
      return {
        reason: `A run qualified by commit or time, but none belongs to the workflow "${wanted}".`,
      };
    }
  } else {
    const hinted = qualified.filter((f) =>
      RELEASE_WORKFLOW.test(`${f.run.workflow} ${f.run.workflowPath ?? ''}`),
    );
    if (hinted.length > 0) pool = hinted;
    else generic = true;
  }

  const both = pool.filter((f) => f.related && f.inWindow);
  const containing = pool.filter((f) => f.inWindow);
  const newestStart = (a: (typeof pool)[number], b: (typeof pool)[number]) =>
    b.run.startedAt - a.run.startedAt;

  let chosen: (typeof pool)[number];
  let confidence: Confidence;
  if (pool.length === 1) {
    chosen = pool[0] as (typeof pool)[number];
    confidence = chosen.related && chosen.inWindow ? 'high' : 'medium';
  } else if (both.length === 1) {
    chosen = both[0] as (typeof pool)[number];
    confidence = 'medium';
  } else if (containing.length === 1) {
    chosen = containing[0] as (typeof pool)[number];
    confidence = 'medium';
  } else if (containing.length > 1) {
    chosen = [...containing].sort(
      (a, b) => Number(b.related) - Number(a.related) || newestStart(a, b),
    )[0] as (typeof pool)[number];
    confidence = 'low';
  } else {
    chosen = [...pool].sort(
      (a, b) => Number(b.parent) - Number(a.parent) || newestStart(a, b),
    )[0] as (typeof pool)[number];
    confidence = 'low';
  }
  if (generic) confidence = 'low';

  const parts: string[] = [];
  if (chosen.run.headSha === commit.sha)
    parts.push(`the tag's commit is the run's commit ${commit.sha.slice(0, 7)}`);
  else if (chosen.parent)
    parts.push(
      `the run's commit ${(chosen.run.headSha as string).slice(0, 7)} is the parent of the tag's commit ${commit.sha.slice(0, 7)}`,
    );
  if (chosen.inWindow && commit.at !== null) {
    const source = commit.atSource === 'release' ? 'the release was made' : 'the commit was made';
    parts.push(
      `${source} at ${hhmm(commit.at)}, while the run ran (${hhmm(chosen.run.startedAt)} to ${chosen.run.active ? 'now' : hhmm(chosen.run.updatedAt)})`,
    );
  }
  if (generic) parts.push('the workflow is not recognised as a release workflow');
  if (pool.length > 1) parts.push(`${pool.length} runs qualified`);
  return { run: chosen.run, confidence, reason: parts.join('; '), candidates: pool.length };
}

// ---------------------------------------------------------------------------------------------
// The whole chain

/** Why a link was made; stored with it (`build_links.evidence_json`) and shown by the web page. */
export type LinkEvidence = {
  kind: 'tag' | 'release';
  tag: string;
  releaseName: string | null;
  pattern: string;
  /** The tag's commit. */
  sha: string;
  parents: string[];
  committedAt: number | null;
  message: string | null;
  /** Whether the version in the name is the build's version; null when the name has no version. */
  versionMatch: boolean | null;
  /** The run found for the commit, or null with `noRunReason` saying why none. */
  runId: string | null;
  noRunReason: string | null;
  reason: string;
  confidence: Confidence;
};

export type TagLink = {
  candidate: TagCandidate;
  facts: CommitFacts | null;
  run: RunMatch | null;
  evidence: LinkEvidence;
};

/**
 * The link for one build from its candidates: the first candidate (best first) whose commit
 * leads to a run, else the first candidate with a commit ("tag found", no run). `facts` gives
 * what is known of a commit; a candidate whose commit is not known is judged by its release time.
 * Undefined when there is no candidate with a commit and no release time to judge by.
 */
export function resolveTagLink(input: {
  candidates: readonly TagCandidate[];
  factsOf: (sha: string) => CommitFacts | undefined;
  runs: readonly RunFacts[];
  workflow: string | null;
}): TagLink | undefined {
  let firstWithCommit: TagLink | undefined;
  for (const candidate of input.candidates.slice(0, MAX_CANDIDATES_PER_BUILD)) {
    const facts = candidate.sha ? (input.factsOf(candidate.sha) ?? null) : null;
    const at = facts?.committedAt ?? candidate.releaseAt ?? null;
    const atSource = facts?.committedAt ? 'commit' : candidate.releaseAt ? 'release' : null;
    const sha = facts?.sha ?? candidate.sha;
    if (!sha) continue;
    const found = matchCommitToRun({
      commit: { sha, parents: facts?.parents ?? [], at, atSource },
      runs: input.runs,
      workflow: input.workflow,
    });
    const run = 'run' in found ? found : null;
    const via =
      candidate.kind === 'tag'
        ? `tag "${candidate.tag}"`
        : `release "${candidate.releaseName ?? candidate.tag}" (tag "${candidate.tag}")`;
    const versionNote =
      candidate.versionMatch === false
        ? ` The name's version ${candidate.fields.version} differs from the store's.`
        : '';
    const reason = run
      ? `${via} has the number; ${run.reason}.${versionNote}`
      : `${via} has the number, on commit ${sha.slice(0, 7)}. No run found: ${(found as { reason: string }).reason}${versionNote}`;
    const commitConfidence: Confidence = candidate.versionMatch === false ? 'medium' : 'high';
    const confidence: Confidence = run
      ? rankOf(run.confidence) <= rankOf(commitConfidence)
        ? run.confidence
        : commitConfidence
      : commitConfidence;
    const link: TagLink = {
      candidate,
      facts,
      run,
      evidence: {
        kind: candidate.kind,
        tag: candidate.tag,
        releaseName: candidate.releaseName,
        pattern: candidate.pattern,
        sha,
        parents: facts?.parents ?? [],
        committedAt: facts?.committedAt ?? null,
        message: facts?.message ?? null,
        versionMatch: candidate.versionMatch,
        runId: run?.run.id ?? null,
        noRunReason: run ? null : (found as { reason: string }).reason,
        reason,
        confidence,
      },
    };
    if (run) return link;
    firstWithCommit ??= link;
  }
  return firstWithCommit;
}

/** `low` < `medium` < `high`, as a number to compare. */
export const rankOf = (c: Confidence): number => (c === 'high' ? 2 : c === 'medium' ? 1 : 0);
