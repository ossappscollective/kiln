import { randomUUID } from 'node:crypto';
import type { CommitDetail, GitRelease, ReleaseList, TagList } from '@mrm/connectors';
import type { Platform } from '@mrm/core';
import type { Sql } from '@mrm/db';
import { getApp, listAppReleases, type ManagedApp } from '../../services/apps.ts';
import { timedCache } from '../../services/timed-cache.ts';
import { type EffectiveConventions, effectiveConventions, listConventions } from './conventions.ts';
import {
  type BuildMatcher,
  buildKey,
  buildsFromReleases,
  listBuildLinks,
  loadRunRefs,
  matchBuilds,
  putBuildLink,
  type StoredBuild,
  type StoredLink,
} from './links.ts';
import type { WorkflowRunView } from './runs.ts';
import { firstLine, runCountsForApp } from './runs.ts';
import {
  type CommitFacts,
  type CompiledConventions,
  compileConventions,
  explainNoCandidate,
  findCandidates,
  type ReleaseRef,
  resolveTagLink,
  type TagCandidate,
  type TagData,
  type TagRef,
} from './tags.ts';

/**
 * The part of build linking that reads tags, releases and commits from GitHub and writes what it
 * finds as links (`build_links` with evidence). The matching itself is pure and lives in
 * build-tags.ts; the pattern language is in `@mrm/core`. See docs/api/ci.md.
 *
 * One scan reads, for a repository: its tags (a bounded number of pages), its releases (a few
 * pages), and the commits of the tags that carry a build number that is not linked yet (a few
 * dozen). Tags and releases are kept for a minute and commits for a day (a commit never changes),
 * so repeated refreshes ask GitHub for little, and nothing is read when every build is settled.
 */

/** Pages of 100 tags read per scan, and of releases. GitHub's order is not documented, so this is a bound, not "the newest". */
export const TAG_PAGES = 5;
export const RELEASE_PAGES = 2;
/** At most this many commits are read per scan; the rest wait for the next one. */
export const MAX_COMMIT_FETCHES = 30;
/** Tags and releases are re-read at most this often (a rematch on request ignores it). */
export const TAG_DATA_TTL_MS = 60_000;
const COMMIT_TTL_MS = 24 * 60 * 60_000;
const MAX_TARGETED_PREFIXES = 4;

/** The GitHub reads a scan needs. The connector has them; a fake in tests implements the same four. */
export type TagClient = {
  listTags(options?: { maxPages?: number; signal?: AbortSignal }): Promise<TagList>;
  listMatchingTags(
    prefix: string,
    options?: { limit?: number; resolveLimit?: number; signal?: AbortSignal },
  ): Promise<TagList & { unresolved: number }>;
  getCommit(ref: string, signal?: AbortSignal): Promise<CommitDetail | undefined>;
  listReleases(options?: { maxPages?: number; signal?: AbortSignal }): Promise<ReleaseList>;
};

export const isTagClient = (c: unknown): c is TagClient => {
  const x = c as Partial<TagClient>;
  return (
    typeof x.listTags === 'function' &&
    typeof x.listMatchingTags === 'function' &&
    typeof x.getCommit === 'function' &&
    typeof x.listReleases === 'function'
  );
};

// ---------------------------------------------------------------------------------------------
// Caches

export type ReadTagData = TagData & {
  readAt: number;
  tagsTruncated: boolean;
  tagPages: number;
  releasesTruncated: boolean;
  /** Prefixes read with the matching-refs call because the tag list was cut short. */
  targeted: string[];
  releasesError: string | null;
};

const tagDataCache = timedCache<ReadTagData>(TAG_DATA_TTL_MS, 50);
const commitCache = timedCache<CommitFacts | null>(COMMIT_TTL_MS, 2000);

/** For tests. */
export function clearScanCaches(): void {
  tagDataCache.clear();
  commitCache.clear();
}

// ---------------------------------------------------------------------------------------------
// Reading

const toReleaseRef = (r: GitRelease): ReleaseRef => ({
  name: r.name ?? null,
  tagName: r.tagName,
  targetCommitish: r.targetCommitish ?? null,
  draft: r.draft,
  createdAt: r.createdAt ?? null,
  publishedAt: r.publishedAt ?? null,
  url: r.url ?? null,
});

/**
 * The text before the first placeholder that is not known in advance, with `{prefix}` and
 * `{platform}` filled in: what a tag of this convention starts with. Used to ask GitHub for the
 * tags under that prefix when the tag list was cut short. Empty when nothing is known.
 */
export function literalPrefixes(
  patterns: readonly string[],
  prefix: string,
  platforms: readonly Platform[],
): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const lead = (platformWord: string) => {
      let text = '';
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern.charAt(i);
        if (ch === '*') break;
        if (ch === '{') {
          const end = pattern.indexOf('}', i);
          const name = end < 0 ? '' : pattern.slice(i + 1, end);
          if (name === 'prefix') text += prefix;
          else if (name === 'platform') text += platformWord;
          else break;
          i = end;
          continue;
        }
        text += ch;
      }
      return text;
    };
    for (const platform of platforms) {
      const text = lead(platform);
      if (text.length >= 2 && text.length <= 100) out.add(text);
    }
  }
  return [...out].sort().slice(0, MAX_TARGETED_PREFIXES);
}

/** Reads tags and releases. A failure of the releases alone is kept as a note, not thrown. */
export async function readTagData(
  client: TagClient,
  options: { signal?: AbortSignal | undefined; prefixes?: readonly string[]; now: number },
): Promise<ReadTagData> {
  const { signal } = options;
  const listed = await client.listTags({ maxPages: TAG_PAGES, ...(signal ? { signal } : {}) });
  const byName = new Map<string, TagRef>(
    listed.tags.map((t) => [t.name, { name: t.name, sha: t.sha }]),
  );
  const targeted: string[] = [];
  if (listed.truncated) {
    for (const prefix of (options.prefixes ?? []).slice(0, MAX_TARGETED_PREFIXES)) {
      const more = await client.listMatchingTags(prefix, {
        limit: 1000,
        resolveLimit: 30,
        ...(signal ? { signal } : {}),
      });
      targeted.push(prefix);
      for (const t of more.tags)
        if (!byName.has(t.name)) byName.set(t.name, { name: t.name, sha: t.sha });
    }
  }
  let releases: ReleaseRef[] = [];
  let releasesTruncated = false;
  let releasesError: string | null = null;
  try {
    const read = await client.listReleases({
      maxPages: RELEASE_PAGES,
      ...(signal ? { signal } : {}),
    });
    releases = read.releases.map(toReleaseRef);
    releasesTruncated = read.truncated;
  } catch (error) {
    if (signal?.aborted) throw error;
    releasesError = (error instanceof Error ? error.message : 'Could not read the releases.').slice(
      0,
      200,
    );
  }
  return {
    tags: [...byName.values()],
    releases,
    readAt: options.now,
    tagsTruncated: listed.truncated,
    tagPages: listed.pages,
    releasesTruncated,
    targeted,
    releasesError,
  };
}

const factsOfDetail = (c: CommitDetail): CommitFacts => ({
  sha: c.sha.toLowerCase(),
  parents: c.parents,
  committedAt: c.committedAt ?? c.date ?? null,
  message: firstLine(c.message),
  author: c.author ?? null,
  url: c.url ?? null,
});

// ---------------------------------------------------------------------------------------------
// Stored scan summary (build_scans)

export type ScanApp = {
  /** Names (tags and releases) that fit a pattern of this app, whatever their number. */
  fitting: number;
  newestFit: { name: string; buildNumber: string } | null;
  /** Per build (`platform\u0000number`): why nothing was found. */
  reasons: Record<string, { code: string; message: string }>;
};

export type ScanSummary = {
  tags: { seen: number; truncated: boolean; pages: number; targeted: string[] };
  releases: { seen: number; truncated: boolean; error: string | null };
  newestRelease: { name: string | null; tag: string; at: number | null } | null;
  /** Stored runs looked at. */
  runsSeen: number;
  /** The first tag names as GitHub listed them, to show what the repository's tags look like. */
  sampleTags: string[];
  apps: Record<string, ScanApp>;
};

export type StoredScan = {
  scannedAt: number;
  ok: boolean;
  error: string | null;
  summary: ScanSummary;
};

const emptySummary = (): ScanSummary => ({
  tags: { seen: 0, truncated: false, pages: 0, targeted: [] },
  releases: { seen: 0, truncated: false, error: null },
  newestRelease: null,
  runsSeen: 0,
  sampleTags: [],
  apps: {},
});

export async function getScan(
  sql: Sql,
  workspaceId: string,
  repositoryId: string,
): Promise<StoredScan | undefined> {
  const [row] = await sql.query(
    'SELECT scanned_at, ok, error, summary_json FROM build_scans WHERE workspace_id = ? AND repository_id = ?',
    [workspaceId, repositoryId],
  );
  if (!row) return undefined;
  let summary = emptySummary();
  try {
    const v: unknown = JSON.parse(String(row.summary_json));
    if (v && typeof v === 'object' && !Array.isArray(v))
      summary = { ...summary, ...(v as Partial<ScanSummary>) };
  } catch {
    // keep the empty summary
  }
  return {
    scannedAt: Number(row.scanned_at),
    ok: Number(row.ok) === 1,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    summary,
  };
}

async function putScan(
  sql: Sql,
  input: {
    workspaceId: string;
    repositoryId: string;
    ok: boolean;
    error: string | null;
    summary: ScanSummary;
    now: number;
  },
): Promise<void> {
  const values = [input.now, input.ok ? 1 : 0, input.error, JSON.stringify(input.summary)];
  const changed = await sql.execute(
    'UPDATE build_scans SET scanned_at = ?, ok = ?, error = ?, summary_json = ? WHERE workspace_id = ? AND repository_id = ?',
    [...values, input.workspaceId, input.repositoryId],
  );
  if (changed > 0) return;
  await sql.execute(
    `INSERT INTO build_scans (id, workspace_id, repository_id, scanned_at, ok, error, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), input.workspaceId, input.repositoryId, ...values],
  );
}

// ---------------------------------------------------------------------------------------------
// Planning: which builds still need a tag

type AppPlan = {
  app: ManagedApp;
  builds: StoredBuild[];
  conventions: EffectiveConventions;
  compiled: CompiledConventions;
  links: Map<string, StoredLink>;
  /** Builds a matcher or a person already settled. */
  settled: Set<string>;
};

/** A build the tags can still help: not linked by hand, not found by a matcher, no run-based tag link yet. */
function wantsTags(plan: AppPlan, build: StoredBuild): boolean {
  const key = buildKey(build);
  if (plan.settled.has(key)) return false;
  const had = plan.links.get(key);
  if (!had) return true;
  if (had.source === 'manual') return false;
  if (had.source !== 'tag' && had.source !== 'release') return false;
  return had.runId === '' || had.evidence?.confidence === 'low';
}

async function loadPlans(
  sql: Sql,
  input: {
    workspaceId: string;
    repositoryId: string;
    runs: readonly WorkflowRunView[];
    matchers: readonly BuildMatcher[];
  },
): Promise<AppPlan[]> {
  const apps = await sql.query(
    'SELECT id FROM apps WHERE workspace_id = ? AND repository_id = ? ORDER BY id',
    [input.workspaceId, input.repositoryId],
  );
  const conventions = await listConventions(sql, input.workspaceId, input.repositoryId);
  const plans: AppPlan[] = [];
  for (const row of apps) {
    const app = await getApp(sql, input.workspaceId, String(row.id));
    if (!app) continue;
    const builds = buildsFromReleases(await listAppReleases(sql, input.workspaceId, app.id)).filter(
      (b) => b.platform === app.platform,
    );
    const links = new Map(
      (await listBuildLinks(sql, input.workspaceId, app.id)).map((l) => [buildKey(l), l]),
    );
    const effective = effectiveConventions(conventions, app.id);
    plans.push({
      app,
      builds,
      conventions: effective,
      compiled: compileConventions(effective),
      links,
      settled: new Set(
        matchBuilds(
          builds,
          input.runs.filter((r) => runCountsForApp(r, app.id)),
          input.matchers,
        ).keys(),
      ),
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------------------------
// The scan

export type ScanResult = {
  /** Whether GitHub was asked (false when nothing needed tags, or the connection cannot). */
  scanned: boolean;
  /** How many links were written or changed. */
  written: number;
  error: string | null;
};

/**
 * Looks for the tags of the builds of every app of a repository that are not linked yet, and links
 * them: build number -> tag -> commit -> run. Never throws for a GitHub failure: the failure is
 * stored with the scan (`build_scans.error`) and returned, so the refresh of the runs that called
 * it still counts as done. `force` ignores the re-read spacing and the kept tag lists.
 */
export async function scanBuildTags(input: {
  db: Sql & { transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> };
  workspaceId: string;
  repositoryId: string;
  client: unknown;
  matchers: readonly BuildMatcher[];
  now: number;
  force?: boolean;
  signal?: AbortSignal | undefined;
  /** Turns a thrown GitHub error into text for a person. */
  describeError: (error: unknown) => string;
  /** Limit the scan to one app (a rematch of one app's builds). */
  onlyAppId?: string | undefined;
}): Promise<ScanResult> {
  const { db, workspaceId, repositoryId, now } = input;
  if (!isTagClient(input.client)) return { scanned: false, written: 0, error: null };
  const client = input.client;

  const runs = await loadRunRefs(db, workspaceId, repositoryId);
  const plans = (
    await loadPlans(db, { workspaceId, repositoryId, runs, matchers: input.matchers })
  ).filter((p) => input.onlyAppId === undefined || p.app.id === input.onlyAppId);
  const wanted = plans.flatMap((p) =>
    p.builds.filter((b) => wantsTags(p, b)).map((b) => ({ plan: p, build: b })),
  );
  if (wanted.length === 0) return { scanned: false, written: 0, error: null };

  const previous = await getScan(db, workspaceId, repositoryId);
  const summary: ScanSummary = previous
    ? { ...previous.summary, apps: { ...previous.summary.apps } }
    : emptySummary();
  const cached = tagDataCache.get(repositoryId, now);
  let error: string | null = null;

  try {
    let data: ReadTagData;
    if (cached && input.force !== true) data = cached;
    else {
      const prefixes = [
        ...new Set(
          plans.flatMap((p) =>
            literalPrefixes(p.conventions.tagPatterns, p.conventions.prefix, [p.app.platform]),
          ),
        ),
      ].slice(0, MAX_TARGETED_PREFIXES);
      data = await readTagData(client, { signal: input.signal, prefixes, now });
      tagDataCache.set(repositoryId, data, now);
    }
    const tagData = data;

    // Candidates for every wanted build, and the commits that are not known yet.
    const needed: { sha: string; buildNumber: number }[] = [];
    const known = new Map<string, CommitFacts | null>();
    for (const plan of plans) {
      for (const link of plan.links.values()) {
        const e = link.evidence;
        if (e)
          known.set(e.sha, {
            sha: e.sha,
            parents: e.parents,
            committedAt: e.committedAt,
            message: e.message,
            author: null,
            url: null,
          });
      }
    }
    const candidatesOf = new Map<string, TagCandidate[]>();
    for (const { plan, build } of wanted) {
      const candidates = findCandidates(build, tagData, plan.compiled);
      candidatesOf.set(`${plan.app.id}\u0000${buildKey(build)}`, candidates);
      for (const c of candidates.slice(0, 2)) {
        if (!c.sha || known.has(c.sha)) continue;
        const cached = commitCache.get(c.sha, now);
        if (cached !== undefined) {
          known.set(c.sha, cached);
          continue;
        }
        needed.push({ sha: c.sha, buildNumber: Number(build.buildNumber) || 0 });
      }
    }
    const seen = new Set<string>();
    const order = needed
      .sort((a, b) => b.buildNumber - a.buildNumber)
      .filter((n) => (seen.has(n.sha) ? false : (seen.add(n.sha), true)));
    for (const { sha } of order.slice(0, MAX_COMMIT_FETCHES)) {
      const detail = await client.getCommit(sha, input.signal);
      const facts = detail ? factsOfDetail(detail) : null;
      commitCache.set(sha, facts, now);
      known.set(sha, facts);
    }

    // Link what leads somewhere, and say why the rest does not.
    let written = 0;
    await db.transaction(async (tx) => {
      for (const plan of plans) {
        const entry: ScanApp = { fitting: 0, newestFit: null, reasons: {} };
        for (const build of plan.builds) {
          if (!wanted.some((w) => w.plan === plan && w.build === build)) continue;
          const key = buildKey(build);
          const candidates = candidatesOf.get(`${plan.app.id}\u0000${key}`) ?? [];
          if (candidates.length === 0) {
            const why = explainNoCandidate(build, tagData, plan.compiled);
            entry.reasons[key] = { code: why.code, message: why.message };
            entry.fitting = Math.max(entry.fitting, why.fitting);
            if (
              why.newestFit &&
              (!entry.newestFit ||
                Number(why.newestFit.buildNumber) > Number(entry.newestFit.buildNumber))
            ) {
              entry.newestFit = why.newestFit;
            }
            continue;
          }
          const link = resolveTagLink({
            candidates,
            factsOf: (sha) => known.get(sha) ?? undefined,
            runs: runs.filter((r) => runCountsForApp(r, plan.app.id)),
            workflow: plan.conventions.workflow,
          });
          if (!link) {
            entry.reasons[key] = {
              code: 'tag_without_commit',
              message: 'A tag carries the number, but its commit could not be read.',
            };
            continue;
          }
          const had = plan.links.get(key);
          const runId = link.run?.run.id ?? '';
          if (had?.source === 'tag' || had?.source === 'release') {
            if (had.runId !== '' && runId === '') continue;
            const e = had.evidence;
            if (
              had.runId === runId &&
              had.headSha === link.evidence.sha &&
              e?.tag === link.evidence.tag &&
              e?.confidence === link.evidence.confidence &&
              e?.reason === link.evidence.reason
            ) {
              continue;
            }
          } else if (had) {
            continue;
          }
          await putBuildLink(tx, {
            workspaceId,
            appId: plan.app.id,
            platform: build.platform,
            buildNumber: build.buildNumber,
            repositoryId,
            run: link.run
              ? {
                  id: link.run.run.id,
                  headSha: link.run.run.headSha,
                  url: runs.find((r) => r.id === link.run?.run.id)?.url ?? null,
                  workflow: link.run.run.workflow,
                }
              : null,
            sha: link.evidence.sha,
            source: link.candidate.kind,
            reason: link.evidence.reason,
            linkedBy: null,
            now,
            evidence: link.evidence,
          });
          written++;
          if (!link.run)
            entry.reasons[key] = {
              code: 'tag_without_run',
              message: link.evidence.noRunReason ?? 'No run found.',
            };
        }
        summary.apps[plan.app.id] = entry;
      }
      const newest = [...tagData.releases]
        .filter((r) => !r.draft)
        .sort(
          (a, b) => (b.publishedAt ?? b.createdAt ?? 0) - (a.publishedAt ?? a.createdAt ?? 0),
        )[0];
      summary.tags = {
        seen: tagData.tags.length,
        truncated: tagData.tagsTruncated,
        pages: tagData.tagPages,
        targeted: tagData.targeted,
      };
      summary.releases = {
        seen: tagData.releases.length,
        truncated: tagData.releasesTruncated,
        error: tagData.releasesError,
      };
      summary.newestRelease = newest
        ? { name: newest.name, tag: newest.tagName, at: newest.publishedAt ?? newest.createdAt }
        : null;
      summary.runsSeen = runs.length;
      summary.sampleTags = tagData.tags.slice(0, 8).map((t) => t.name);
      await putScan(tx, { workspaceId, repositoryId, ok: true, error: null, summary, now });
    });
    return { scanned: true, written, error: null };
  } catch (e) {
    error = input.describeError(e);
    await putScan(db, { workspaceId, repositoryId, ok: false, error, summary, now }).catch(
      () => undefined,
    );
    return { scanned: true, written: 0, error };
  }
}
