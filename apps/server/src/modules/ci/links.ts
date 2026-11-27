import { randomUUID } from 'node:crypto';
import {
  compareBuildNumbers,
  PLATFORMS,
  type Platform,
  RELEASE_STATES,
  type ReleaseState,
  supports,
} from '@kiln/core';
import { oneOf, type Row, type Sql } from '@kiln/db';
import { type AppRelease, listAppReleases, type ManagedApp } from '../../services/apps.ts';
import { emitCacheEvent } from '../../services/cache-registry.ts';
import { RUN_COLUMNS, runCountsForApp, runViews, type WorkflowRunView } from './runs.ts';
import type { Confidence, LinkEvidence } from './tags.ts';

/**
 * Links the builds a store reports to the CI run (and so the commit) that made them, through the
 * build number. The tool never builds; the team's own workflow does, and something in that run has
 * to carry the number. What counts as "carries the number" is a list of matchers, so a team's own
 * convention is one more entry (see docs/api/ci.md for the conventions that ship).
 *
 * A build is `linked` (a manual link, or the best run a matcher found) or `unlinked`. A person can
 * always link a build to a run by hand; that wins over any matcher.
 */

// ---------------------------------------------------------------------------------------------
// Matchers

/** The part of a run a matcher may look at. */
export type RunRef = Pick<
  WorkflowRunView,
  | 'id'
  | 'workflow'
  | 'workflowPath'
  | 'title'
  | 'headSha'
  | 'commitMessage'
  | 'event'
  | 'runNumber'
  | 'status'
  | 'conclusion'
  | 'inputs'
  | 'startedAt'
>;

/** A build as the store reports it. */
export type BuildRef = { platform: Platform; buildNumber: string; version: string };

export type BuildMatcher = {
  /** Stored with the link and shown as its source, for example `dispatch_input`. */
  id: string;
  description: string;
  /** Why the run carries this build's number, or undefined when it does not. */
  match(build: BuildRef, run: RunRef): string | undefined;
};

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const ANY_KEYS = new Set(['buildnumber', 'build', 'buildno']);
const IOS_KEYS = new Set(['iosbuildnumber', 'iosbuild', 'cfbundleversion', 'bundleversion']);
const MACOS_KEYS = new Set([
  'macosbuildnumber',
  'macosbuild',
  'osxbuildnumber',
  'osxbuild',
  'cfbundleversion',
  'bundleversion',
]);
const ANDROID_KEYS = new Set([
  'versioncode',
  'androidversioncode',
  'androidbuildnumber',
  'androidbuild',
]);

const BUILD_KEYS: Readonly<Record<Platform, Set<string>>> = {
  ios: IOS_KEYS,
  macos: MACOS_KEYS,
  android: ANDROID_KEYS,
};

const ownKeys = (platform: Platform): Set<string> => BUILD_KEYS[platform];

/**
 * The run was started from this tool (or any dispatch we recorded) with an input that names the
 * build number: `build_number` or `build` for either platform, `ios_build_number` for iOS,
 * `version_code` or `android_version_code` for Android. Names compare without case, dashes or
 * underscores. This is the most reliable convention: the number is a fact of the dispatch.
 */
export const dispatchInputMatcher: BuildMatcher = {
  id: 'dispatch_input',
  description:
    'The run was dispatched with a build_number / version_code input equal to the build number.',
  match(build, run) {
    for (const [key, value] of Object.entries(run.inputs ?? {})) {
      const k = normalizeKey(key);
      const own = ownKeys(build.platform);
      if ((ANY_KEYS.has(k) || own.has(k)) && value.trim() === build.buildNumber) {
        return `input ${key} = ${value.trim()}`;
      }
    }
    return undefined;
  },
};

const NOT_A_VERSION = '(?!\\.\\d)';
const AFTER_PLATFORM = '(?<!\\b(?:ios|macos|osx|android)[\\s_-]*)';

const TITLE_PATTERNS: { platform: Platform | 'any'; label: string; re: RegExp }[] = [
  {
    platform: 'any',
    label: 'build N',
    re: new RegExp(
      `${AFTER_PLATFORM}\\bbuild[\\s_-]?(?:number|no\\.?)?\\s*[:=#]?\\s*(\\d{1,10})\\b${NOT_A_VERSION}`,
      'gi',
    ),
  },
  {
    platform: 'ios',
    label: 'ios build N',
    re: new RegExp(
      `\\bios[\\s_-]*build(?:[\\s_-]*number)?\\s*[:=#]?\\s*(\\d{1,10})\\b${NOT_A_VERSION}`,
      'gi',
    ),
  },
  {
    platform: 'macos',
    label: 'macos build N',
    re: new RegExp(
      `\\b(?:macos|osx)[\\s_-]*build(?:[\\s_-]*number)?\\s*[:=#]?\\s*(\\d{1,10})\\b${NOT_A_VERSION}`,
      'gi',
    ),
  },
  {
    platform: 'android',
    label: 'android build N / version code N',
    re: new RegExp(
      `\\bandroid[\\s_-]*(?:build|version[\\s_-]*code)(?:[\\s_-]*number)?\\s*[:=#]?\\s*(\\d{1,10})\\b${NOT_A_VERSION}`,
      'gi',
    ),
  },
  {
    platform: 'android',
    label: 'version code N',
    re: new RegExp(
      `${AFTER_PLATFORM}\\bversion[\\s_-]*code\\s*[:=#]?\\s*(\\d{1,10})\\b${NOT_A_VERSION}`,
      'gi',
    ),
  },
  { platform: 'any', label: 'x.y.z (N)', re: /\b\d+\.\d+(?:\.\d+)*\s*\((\d{1,10})\)/g },
  { platform: 'any', label: 'x.y.z+N', re: /\b\d+\.\d+\.\d+\+(\d{1,10})\b/g },
];

/**
 * A custom `run-name` of the workflow names the build: `Release 2.4.0 (build 240)`,
 * `iOS build 240`, `Android versionCode 241`, `2.4.0 (240)`, `2.4.0+240`. A run-name is evaluated
 * when the run is created, so it can only hold what is known then (a dispatch input, the run
 * number, a counter the team keeps), not a number the store assigns later. Titles that are just
 * the commit message are ignored, because "fix build 3 failures" is not a build number.
 */
export const runTitleMatcher: BuildMatcher = {
  id: 'run_title',
  description:
    'The run title (run-name) says "build N", "versionCode N", "x.y.z (N)" or "x.y.z+N".',
  match(build, run) {
    const title = run.title?.trim();
    if (!title) return undefined;
    const message = run.commitMessage?.trim();
    if (message && title === message) return undefined;
    for (const pattern of TITLE_PATTERNS) {
      if (pattern.platform !== 'any' && pattern.platform !== build.platform) continue;
      for (const m of title.matchAll(pattern.re)) {
        if (m[1] === build.buildNumber) return `title "${title.slice(0, 80)}" (${pattern.label})`;
      }
    }
    return undefined;
  },
};

/**
 * Opt-in: the build number is the workflow's run number plus an offset, as with fastlane's
 * `increment_build_number(build_number: ENV["GITHUB_RUN_NUMBER"])`. It is not on by default,
 * because run numbers are per workflow and collide easily; name the workflows it applies to.
 */
export function runNumberMatcher(options: {
  /** Workflow file names, paths or names. Required: without them it would link anything. */
  workflows: string[];
  offset?: number;
}): BuildMatcher {
  const offset = options.offset ?? 0;
  return {
    id: 'run_number',
    description: `The run number${offset ? ` + ${offset}` : ''} of ${options.workflows.join(', ')} equals the build number.`,
    match(build, run) {
      if (run.runNumber === null || options.workflows.length === 0) return undefined;
      const here = [run.workflowPath, run.workflowPath?.split('/').pop(), run.workflow];
      if (!options.workflows.some((w) => here.includes(w))) return undefined;
      return String(run.runNumber + offset) === build.buildNumber
        ? `run number ${run.runNumber}${offset ? ` + ${offset}` : ''}`
        : undefined;
    },
  };
}

export const defaultMatchers = (): BuildMatcher[] => [dispatchInputMatcher, runTitleMatcher];

// ---------------------------------------------------------------------------------------------
// Resolution (pure)

export type Match = { run: RunRef; matcher: string; reason: string; candidates: number };

export const buildKey = (b: { platform: string; buildNumber: string }) =>
  `${b.platform}\u0000${b.buildNumber}`;

const isSuccess = (r: RunRef) => r.status === 'completed' && r.conclusion === 'success';

/** Newest first; a finished successful run before any other, so a re-run that failed never wins. */
const better = (a: RunRef, b: RunRef) =>
  Number(isSuccess(b)) - Number(isSuccess(a)) ||
  b.startedAt - a.startedAt ||
  b.id.localeCompare(a.id, 'en', { numeric: true });

/**
 * For each build, the run its number points to: the first matcher that finds any run wins, and
 * among that matcher's runs the best one (a successful run first, then the newest). Runs without a
 * commit are ignored: a link without a commit explains nothing.
 */
export function matchBuilds(
  builds: readonly BuildRef[],
  runs: readonly RunRef[],
  matchers: readonly BuildMatcher[],
): Map<string, Match> {
  const out = new Map<string, Match>();
  const usable = runs.filter((r) => r.headSha);
  for (const build of builds) {
    for (const matcher of matchers) {
      const hits: { run: RunRef; reason: string }[] = [];
      for (const run of usable) {
        const reason = matcher.match(build, run);
        if (reason !== undefined) hits.push({ run, reason });
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => better(a.run, b.run));
      const [first] = hits as [{ run: RunRef; reason: string }];
      out.set(buildKey(build), {
        run: first.run,
        matcher: matcher.id,
        reason: first.reason,
        candidates: hits.length,
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The builds of an app

export type StoredBuild = {
  platform: Platform;
  buildNumber: string;
  /** The version of the release that carries the build (on Android, of the most advanced one). */
  version: string;
  /** Play tracks carrying it, sorted; empty on iOS. */
  tracks: string[];
  status: ReleaseState | null;
  rawState: string;
  /** Upload time when the store sent it (iOS), else null. */
  uploadedAt: number | null;
  syncedAt: number;
};

const rank = (status: ReleaseState | null) =>
  status === null ? -1 : RELEASE_STATES.indexOf(status);

const buildOrder = (a: StoredBuild, b: StoredBuild) =>
  a.platform.localeCompare(b.platform) || compareBuildNumbers(b.buildNumber, a.buildNumber);

/**
 * The builds a sync stored. The sync keeps the build attached to each version (iOS: the newest
 * processed build of that version string; Android: the version codes of each track's release), not
 * every build the store holds, so a build that no version points to is not listed.
 */
export function buildsFromReleases(releases: readonly AppRelease[]): StoredBuild[] {
  const byKey = new Map<string, StoredBuild>();
  for (const release of releases) {
    const numbers = supports(release.platform, 'releaseTracks')
      ? (release.versionCodes ?? release.build?.split(',') ?? [])
      : release.build
        ? [release.build]
        : [];
    for (const raw of numbers) {
      const buildNumber = raw.trim();
      if (!buildNumber) continue;
      const key = buildKey({ platform: release.platform, buildNumber });
      const known = byKey.get(key);
      if (!known) {
        byKey.set(key, {
          platform: release.platform,
          buildNumber,
          version: release.version,
          tracks: release.track ? [release.track] : [],
          status: release.status,
          rawState: release.rawState,
          uploadedAt: release.storeUpdatedAt,
          syncedAt: release.syncedAt,
        });
        continue;
      }
      if (release.track && !known.tracks.includes(release.track)) known.tracks.push(release.track);
      if (rank(release.status) > rank(known.status)) {
        known.version = release.version;
        known.status = release.status;
        known.rawState = release.rawState;
      }
      known.uploadedAt ??= release.storeUpdatedAt;
      known.syncedAt = Math.max(known.syncedAt, release.syncedAt);
    }
  }
  for (const b of byKey.values()) b.tracks.sort();
  return [...byKey.values()].sort(buildOrder);
}

// ---------------------------------------------------------------------------------------------
// Stored links

export type StoredLink = {
  id: string;
  appId: string;
  platform: Platform;
  buildNumber: string;
  repositoryId: string;
  runId: string;
  headSha: string;
  runUrl: string | null;
  workflow: string | null;
  /** `manual`, the id of the matcher that found it, or `tag` / `release` (found through a tag). */
  source: string;
  reason: string;
  linkedBy: string | null;
  linkedAt: number;
  /** Why a tag-based link was made; null for a manual or matcher link. */
  evidence: LinkEvidence | null;
};

function parseEvidence(raw: unknown): LinkEvidence | null {
  if (typeof raw !== 'string') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as LinkEvidence).tag === 'string'
      ? (v as LinkEvidence)
      : null;
  } catch {
    return null;
  }
}

const toLink = (r: Row): StoredLink => ({
  id: String(r.id),
  appId: String(r.app_id),
  platform: oneOf(r.platform, PLATFORMS, 'platform'),
  buildNumber: String(r.build_number),
  repositoryId: String(r.repository_id),
  runId: String(r.run_id),
  headSha: String(r.head_sha),
  runUrl: r.run_url === null || r.run_url === undefined ? null : String(r.run_url),
  workflow: r.workflow === null || r.workflow === undefined ? null : String(r.workflow),
  source: String(r.source),
  reason: String(r.reason ?? ''),
  linkedBy: r.linked_by === null || r.linked_by === undefined ? null : String(r.linked_by),
  linkedAt: Number(r.linked_at),
  evidence: parseEvidence(r.evidence_json),
});

const LINK_COLUMNS = `id, app_id, platform, build_number, repository_id, run_id, head_sha, run_url,
  workflow, source, reason, linked_by, linked_at, evidence_json`;

export async function listBuildLinks(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<StoredLink[]> {
  const rows = await sql.query(
    `SELECT ${LINK_COLUMNS} FROM build_links WHERE workspace_id = ? AND app_id = ?`,
    [workspaceId, appId],
  );
  return rows.map(toLink);
}

export type NewLink = {
  workspaceId: string;
  appId: string;
  platform: Platform;
  buildNumber: string;
  repositoryId: string;
  /** The run, or null for a tag whose run is not known (a "tag found" link: `sha` is then needed). */
  run: Pick<WorkflowRunView, 'id' | 'headSha' | 'url' | 'workflow'> | null;
  /** The commit the link names. Default: the run's commit. A tag-based link names the tag's commit. */
  sha?: string | undefined;
  source: string;
  reason: string;
  linkedBy: string | null;
  now: number;
  evidence?: LinkEvidence | null;
};

/** Writes the link of a build, replacing the one it had. */
export async function putBuildLink(sql: Sql, link: NewLink): Promise<void> {
  const values = [
    link.repositoryId,
    link.run?.id ?? '',
    link.sha ?? link.run?.headSha ?? '',
    link.run?.url ?? null,
    link.run?.workflow ?? null,
    link.source,
    link.reason.slice(0, 600),
    link.linkedBy,
    link.now,
    link.evidence ? JSON.stringify(link.evidence) : null,
  ];
  const changed = await sql.execute(
    `UPDATE build_links SET repository_id = ?, run_id = ?, head_sha = ?, run_url = ?, workflow = ?,
            source = ?, reason = ?, linked_by = ?, linked_at = ?, evidence_json = ?
      WHERE workspace_id = ? AND app_id = ? AND platform = ? AND build_number = ?`,
    [...values, link.workspaceId, link.appId, link.platform, link.buildNumber],
  );
  if (changed > 0) {
    emitCacheEvent('build_changed', { workspaceId: link.workspaceId, appId: link.appId });
    return;
  }
  await sql.execute(
    `INSERT INTO build_links
       (id, workspace_id, app_id, platform, build_number, repository_id, run_id, head_sha, run_url,
        workflow, source, reason, linked_by, linked_at, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), link.workspaceId, link.appId, link.platform, link.buildNumber, ...values],
  );
  emitCacheEvent('build_changed', { workspaceId: link.workspaceId, appId: link.appId });
}

/** Removes a link. With `onlyManual`, an automatic one is left alone. Returns whether one existed. */
export async function removeBuildLink(
  sql: Sql,
  input: {
    workspaceId: string;
    appId: string;
    platform: Platform;
    buildNumber: string;
    onlyManual?: boolean;
  },
): Promise<boolean> {
  const changed = await sql.execute(
    `DELETE FROM build_links
      WHERE workspace_id = ? AND app_id = ? AND platform = ? AND build_number = ?
        ${input.onlyManual ? "AND source = 'manual'" : ''}`,
    [input.workspaceId, input.appId, input.platform, input.buildNumber],
  );
  if (changed > 0)
    emitCacheEvent('build_changed', { workspaceId: input.workspaceId, appId: input.appId });
  return changed > 0;
}

/**
 * The runs of a repository a build can be linked to (stored runs, no placeholders). With `appId`, only the runs that count
 * for that app: those dispatched for it (alone or with other apps) and those that were not started for an app at all. A run
 * that was dispatched only for another app of the repository never links this app's builds.
 */
export async function loadRunRefs(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
  appId?: string,
): Promise<WorkflowRunView[]> {
  const rows = await sql.query(
    `SELECT ${RUN_COLUMNS} FROM workflow_runs
      WHERE workspace_id = ? AND repository_id = ? AND status <> 'pending'
      ORDER BY started_at DESC, id DESC LIMIT 1000`,
    [workspaceId, repositoryId],
  );
  const views = await runViews(sql, rows);
  return appId === undefined ? views : views.filter((r) => runCountsForApp(r, appId));
}

/**
 * Stores the links the matchers find for an app, so they outlive the run rows' retention. A manual
 * link is never replaced. A build no matcher finds keeps the link it has. Returns how many links
 * were written or changed.
 */
export async function relinkApp(
  sql: Sql,
  input: { app: ManagedApp; matchers: readonly BuildMatcher[]; now: number },
): Promise<number> {
  const { app } = input;
  if (!app.repositoryId) return 0;
  const workspaceId = await workspaceOf(sql, app.id);
  if (!workspaceId) return 0;
  const [releases, runs, links] = await Promise.all([
    listAppReleases(sql, workspaceId, app.id),
    loadRunRefs(sql, workspaceId, app.repositoryId, app.id),
    listBuildLinks(sql, workspaceId, app.id),
  ]);
  const builds = buildsFromReleases(releases);
  const found = matchBuilds(builds, runs, input.matchers);
  const existing = new Map(links.map((l) => [buildKey(l), l]));
  let written = 0;
  for (const build of builds) {
    const key = buildKey(build);
    const had = existing.get(key);
    const match = found.get(key);
    if (!match || had?.source === 'manual') continue;
    if (
      had &&
      had.runId === match.run.id &&
      had.source === match.matcher &&
      had.headSha === match.run.headSha
    ) {
      continue;
    }
    await putBuildLink(sql, {
      workspaceId,
      appId: app.id,
      platform: build.platform,
      buildNumber: build.buildNumber,
      repositoryId: app.repositoryId,
      run: {
        id: match.run.id,
        headSha: match.run.headSha,
        url: runUrlOf(runs, match.run.id),
        workflow: match.run.workflow,
      },
      source: match.matcher,
      reason: match.reason,
      linkedBy: null,
      now: input.now,
    });
    written++;
  }
  return written;
}

async function workspaceOf(sql: Sql, appId: string): Promise<string | undefined> {
  const [row] = await sql.query('SELECT workspace_id FROM apps WHERE id = ?', [appId]);
  return row ? String(row.workspace_id) : undefined;
}

const runUrlOf = (runs: readonly WorkflowRunView[], id: string) =>
  runs.find((r) => r.id === id)?.url ?? null;

// ---------------------------------------------------------------------------------------------
// The response

export type BuildLinkView = {
  /** `linked`: a run is known (or was). `tag`: a tag or release carries the number, no run was found. */
  state: 'linked' | 'tag';
  /** `manual`, the id of the matcher (`dispatch_input`, `run_title`, ...), or `tag` / `release`. */
  source: string;
  /** How sure the link is. A manual link and an exact matcher are `high`; tag links say why. */
  confidence: Confidence;
  /** The tag, pattern, commit and reasoning of a tag-based link; null for the others. */
  evidence: LinkEvidence | null;
  manual: boolean;
  /** Why this run: what the matcher saw, or who linked it. */
  reason: string;
  /** How many runs the matcher found; more than 1 means the newest successful one was taken. */
  candidates: number;
  linkedAt: number | null;
  linkedBy: string | null;
  /** The run, when it is still stored. */
  run: {
    id: string;
    workflow: string;
    title: string | null;
    status: string;
    conclusion: string | null;
    active: boolean;
    url: string | null;
    branch: string | null;
    startedAt: number;
    updatedAt: number;
  } | null;
  commit: { sha: string; shortSha: string; message: string | null; url: string | null } | null;
};

export type BuildView = StoredBuild & {
  linkState: 'linked' | 'tag' | 'unlinked';
  link: BuildLinkView | null;
  /** For an unlinked build: why the last search found nothing, when a search has run. */
  diagnostic: { code: string; message: string } | null;
};

/** `https://github.com/acme/app/actions/runs/1` and `acme/app` give `https://github.com/acme/app/commit/<sha>`. */
export function commitUrl(
  runUrl: string | null,
  owner: string,
  repo: string,
  sha: string,
): string | null {
  if (!runUrl) return null;
  try {
    return `${new URL(runUrl).origin}/${owner}/${repo}/commit/${sha}`;
  } catch {
    return null;
  }
}

/**
 * Joins the builds of an app with their links: a manual link first, then what the matchers find
 * now in the stored runs, then a stored automatic link whose run has left the table.
 */
export function buildViews(input: {
  builds: readonly StoredBuild[];
  runs: readonly WorkflowRunView[];
  links: readonly StoredLink[];
  matchers: readonly BuildMatcher[];
  repository: { owner: string; repo: string } | null;
}): BuildView[] {
  const { runs, repository } = input;
  const byRun = new Map(runs.map((r) => [r.id, r]));
  /** Any stored run's address tells where this GitHub lives, for a commit link without a run. */
  const anyRunUrl = runs.find((r) => r.url)?.url ?? null;
  const stored = new Map(input.links.map((l) => [buildKey(l), l]));
  const found = repository
    ? matchBuilds(input.builds, runs, input.matchers)
    : new Map<string, Match>();

  return input.builds.map((build): BuildView => {
    const key = buildKey(build);
    const saved = stored.get(key);
    const match = found.get(key);

    let source: string | undefined;
    let runId: string | undefined;
    let sha: string | undefined;
    let reason = '';
    let candidates = 1;
    let linkedAt: number | null = null;
    let linkedBy: string | null = null;
    let fallbackUrl: string | null = null;
    let fallbackWorkflow: string | null = null;
    let evidence: LinkEvidence | null = null;
    let confidence: Confidence = 'high';
    if (saved?.source === 'manual') {
      source = saved.source;
      runId = saved.runId;
      sha = saved.headSha;
      reason = saved.reason || 'Linked by a person.';
      linkedAt = saved.linkedAt;
      linkedBy = saved.linkedBy;
      fallbackUrl = saved.runUrl;
      fallbackWorkflow = saved.workflow;
    } else if (match) {
      source = match.matcher;
      runId = match.run.id;
      sha = match.run.headSha ?? undefined;
      reason = match.reason;
      candidates = match.candidates;
    } else if (saved) {
      source = saved.source;
      runId = saved.runId;
      sha = saved.headSha;
      reason = saved.reason;
      linkedAt = saved.linkedAt;
      fallbackUrl = saved.runUrl;
      fallbackWorkflow = saved.workflow;
      evidence = saved.evidence;
      confidence = saved.evidence?.confidence ?? 'high';
    }
    if (!source || runId === undefined || !sha) {
      return { ...build, linkState: 'unlinked', link: null, diagnostic: null };
    }

    const run = byRun.get(runId);
    const url = run?.url ?? fallbackUrl ?? anyRunUrl;
    const tagOnly = runId === '';
    const link: BuildLinkView = {
      state: tagOnly ? 'tag' : 'linked',
      source,
      confidence,
      evidence,
      manual: source === 'manual',
      reason,
      candidates,
      linkedAt,
      linkedBy,
      run: run
        ? {
            id: run.id,
            workflow: run.workflow,
            title: run.title,
            status: run.status,
            conclusion: run.conclusion,
            active: run.active,
            url: run.url,
            branch: run.branch,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
          }
        : fallbackUrl || fallbackWorkflow
          ? {
              id: runId,
              workflow: fallbackWorkflow ?? '',
              title: null,
              status: 'unknown',
              conclusion: null,
              active: false,
              url: fallbackUrl,
              branch: null,
              startedAt: linkedAt ?? 0,
              updatedAt: linkedAt ?? 0,
            }
          : null,
      commit: {
        sha,
        shortSha: sha.slice(0, 7),
        message:
          (run && run.headSha === sha ? run.commitMessage : null) ?? evidence?.message ?? null,
        url: repository ? commitUrl(url, repository.owner, repository.repo, sha) : null,
      },
    };
    return { ...build, linkState: tagOnly ? 'tag' : 'linked', link, diagnostic: null };
  });
}

/** The build before `buildNumber` on the same platform that has a commit, newest first. */
export function previousLinkedBuild(
  views: readonly BuildView[],
  build: { platform: Platform; buildNumber: string },
): BuildView | undefined {
  const own = views.filter((v) => v.platform === build.platform);
  const index = own.findIndex((v) => v.buildNumber === build.buildNumber);
  if (index < 0) return undefined;
  return own.slice(index + 1).find((v) => v.link?.commit);
}
