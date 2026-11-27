import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  type CiArtifact,
  type InternalSharingConnector,
  PlayInternalSharingConnector,
  StoreError,
  type TestFlightGroup,
  type TestFlightLinksConnector,
} from '@kiln/connectors';
import {
  BUILD_BUSY_RETRY_AFTER_SECONDS,
  BUILD_LIST_TTL_MS,
  BUILD_PROBLEM_TTL_MS,
  BUILD_RUNS_READ_LIMIT,
  can,
  compareBuildNumbers,
  BUILD_LINK_TTL_MS as LINK_TTL_MS,
  type Platform,
  supports,
} from '@kiln/core';
import { coded } from '../../i18n/problem.ts';
import { memberRole } from '../../services/accounts.ts';
import {
  defaultStoreConnectorFactory,
  getApp,
  type ManagedApp,
  type StoreConnectorFactory,
} from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { registerMapCache } from '../../services/cache-registry.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { type Failure, getRepository, withTimeout } from '../../services/repositories.ts';
import { timedCache } from '../../services/timed-cache.ts';
import { listConventions } from '../ci/conventions.ts';
import { listRuns, runCountsForApp, type WorkflowRunView } from '../ci/runs.ts';
import { type CiContext, guarded, openCi } from '../ci/service.ts';
import {
  type ArtifactBuild,
  type ArtifactMeta,
  type ArtifactOrigin,
  loadArtifactMeta,
} from './artifact-meta-store.ts';

export { LINK_TTL_MS };

/**
 * Builds you can test before publishing (docs/api/builds.md, docs/research/test-builds.md): the zips that CI runs
 * uploaded as workflow artifacts, and the builds the last store sync saw. Listing asks GitHub for artifact names and
 * sizes; downloading streams the zip THROUGH this server, so the GitHub credential and the short-lived storage address
 * never reach the browser. Both are read-only towards GitHub and the stores.
 */

type Actor = { type: 'user' | 'token' | 'assistant' | 'system'; id: string };

export const DEFAULT_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** `BUILD_LIST_TTL_MS` / `BUILD_PROBLEM_TTL_MS` of `@kiln/core`'s timings (the browser's build read derives its own from them). */
export const LIST_CACHE_TTL_MS = BUILD_LIST_TTL_MS;
export const PROBLEM_CACHE_TTL_MS = BUILD_PROBLEM_TTL_MS;
export const DOWNLOADS_PER_MINUTE = 20;
export const LISTS_PER_MINUTE = 60;
export const MAX_PARALLEL_DOWNLOADS = 3;
/** TestFlight builds stop being installable 90 days after upload (Apple's TestFlight help); the build's `expired` flag is the truth. */
export const TESTFLIGHT_LIFETIME_MS = 90 * 24 * 60 * 60_000;
const ARTIFACT_PAGES = 2;

export type BuildsSettings = {
  /** KILN_BUILDS_DOWNLOAD_ENABLED. Off: the lists work, downloads and links answer `409 builds_download_disabled`. */
  downloadEnabled: boolean;
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  linkTtlMs: number;
  /** Tests only: let the fake storage be an http address. */
  allowHttpRedirects: boolean;
  /** A folder for the temporary file of an artifact being read (its build number). Default: the system temp folder. */
  scratchDir: string;
  /** Builds the read-only App Store Connect connector for the TestFlight public links. Replaced by a fake in tests. */
  storeConnectorFactory: StoreConnectorFactory;
  /** KILN_PLAY_INTERNAL_SHARING_ENABLED (default false): uploading a build to Google Play internal app sharing (docs/api/internal-sharing.md). */
  internalSharingEnabled: boolean;
  /** Builds the connector that uploads to internal app sharing. Replaced by a fake in tests. */
  internalSharingConnectorFactory: InternalSharingConnectorFactory;
  /** The whole upload (download from GitHub is separate) is abandoned after this. Tests shorten it. */
  internalSharingTimeoutMs?: number | undefined;
  /** An upload in flight is not trusted as one after this long. Tests shorten it. */
  internalSharingClaimTtlMs?: number | undefined;
};

export type InternalSharingConnectorInput = {
  /** The decrypted service account of the app. Never log it or put it in a message. */
  secret: string;
  packageName: string;
  /** Aborted when the upload times out. Pass it to the connector as its `fetch`. */
  fetch: typeof fetch;
};
export type InternalSharingConnectorFactory = (
  input: InternalSharingConnectorInput,
) => InternalSharingConnector;
export const defaultInternalSharingConnectorFactory: InternalSharingConnectorFactory = (input) =>
  new PlayInternalSharingConnector({
    serviceAccount: input.secret,
    packageName: input.packageName,
    fetch: input.fetch,
  });

export type BuildsContext = CiContext & {
  builds: BuildsSettings;
  listLimiter: TestLimiter;
  downloadLimiter: TestLimiter;
  /** The links handed out and not yet expired, by their id. Per process: a restart forgets them. */
  links: Map<string, { w: string; a: string; i: string; u: string; e: number; used: boolean }>;
  downloading: Map<string, number>;
  /** The reads of build numbers in flight or waiting, by app: one at a time per app. */
  inspecting: Map<string, Promise<unknown>>;
  /** When the last background batch of build reads started, by app (`facts.ts`): one batch per app every `BUILD_AUTO_READ_PAUSE_MS`. */
  autoReadAt: Map<string, number>;
};

export function createBuildsContext(
  ci: CiContext,
  options: Partial<BuildsSettings> & {
    listLimiter?: TestLimiter;
    downloadLimiter?: TestLimiter;
  } = {},
): BuildsContext {
  return {
    ...ci,
    builds: {
      downloadEnabled: options.downloadEnabled ?? false,
      maxDownloadBytes: options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
      downloadTimeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
      linkTtlMs: options.linkTtlMs ?? LINK_TTL_MS,
      allowHttpRedirects: options.allowHttpRedirects ?? false,
      scratchDir: options.scratchDir ?? tmpdir(),
      storeConnectorFactory: options.storeConnectorFactory ?? defaultStoreConnectorFactory,
      internalSharingEnabled: options.internalSharingEnabled ?? false,
      internalSharingConnectorFactory:
        options.internalSharingConnectorFactory ?? defaultInternalSharingConnectorFactory,
      internalSharingTimeoutMs: options.internalSharingTimeoutMs,
      internalSharingClaimTtlMs: options.internalSharingClaimTtlMs,
    },
    listLimiter: options.listLimiter ?? createTestLimiter({ limit: LISTS_PER_MINUTE, now: ci.now }),
    downloadLimiter:
      options.downloadLimiter ?? createTestLimiter({ limit: DOWNLOADS_PER_MINUTE, now: ci.now }),
    links: new Map(),
    downloading: new Map(),
    inspecting: new Map(),
    autoReadAt: new Map(),
  };
}

type BuildsFailure = {
  ok: false;
  status: number;
  body: Record<string, unknown> & { error: string };
  headers?: Record<string, string>;
};
export const fail = (
  status: number,
  error: string,
  message?: string,
  extra: Record<string, unknown> = {},
): BuildsFailure => ({
  ok: false,
  status,
  body: { error, ...(message ? { message } : {}), ...extra },
});
export type { BuildsFailure };

// ---------------------------------------------------------------------------------------------
// What an artifact is, from its name

export type ArtifactKind = 'ipa' | 'apk' | 'aab' | 'app' | 'dmg' | 'pkg' | 'zip' | 'other';

const NOT_A_BUILD =
  /(^|[^a-z])(tests?|reports?|coverage|logs?|junit|results?|screenshots?|symbols?|dsyms?|mapping|lint|sbom|docs?|cache)([^a-z]|$)/;
const BUILDISH =
  /(^|[^a-z])(ipa|apk|aab|app|build|builds|release|bundle|binary|archive|artifact|dmg|pkg|ios|android|macos|debug|adhoc|ad-hoc|testflight|nightly)([^a-z]|$)/;

/**
 * A guess from the artifact's name (an artifact is always a zip; the name is the team's own, so this can be wrong).
 * `platform` falls back to the platform of the app for something that looks like a build, and is null for `other`.
 */
export function guessArtifact(
  name: string,
  appPlatform: Platform,
): { kind: ArtifactKind; platform: Platform | null } {
  const n = name.toLowerCase();
  const ext = /\.(ipa|apk|aab|dmg|pkg)(\.zip)?$/.exec(n)?.[1] as
    | 'ipa'
    | 'apk'
    | 'aab'
    | 'dmg'
    | 'pkg'
    | undefined;
  let kind: ArtifactKind;
  if (ext) kind = ext;
  else if (/\.app(\.zip)?$/.test(n)) kind = 'app';
  else if (NOT_A_BUILD.test(n)) kind = 'other';
  else {
    const word = /(^|[^a-z])(ipa|apk|aab|dmg|pkg)([^a-z]|$)/.exec(n)?.[2] as
      | ArtifactKind
      | undefined;
    kind = word ?? (BUILDISH.test(n) ? 'zip' : 'other');
  }
  const byKind: Partial<Record<ArtifactKind, Platform>> = {
    ipa: 'ios',
    apk: 'android',
    aab: 'android',
    app: 'macos',
    dmg: 'macos',
    pkg: 'macos',
  };
  const byWord = /(^|[^a-z])(ios|iphone|ipad)([^a-z]|$)/.test(n)
    ? 'ios'
    : /(^|[^a-z])(android)([^a-z]|$)/.test(n)
      ? 'android'
      : /(^|[^a-z])(macos|osx|mac)([^a-z]|$)/.test(n)
        ? 'macos'
        : undefined;
  const platform = byKind[kind] ?? byWord ?? (kind === 'zip' ? appPlatform : null);
  return { kind, platform };
}

// ---------------------------------------------------------------------------------------------
// The list

export type ArtifactItem = {
  id: string;
  name: string;
  kind: ArtifactKind;
  /** True: `kind` and `platform` come from the name only. */
  guessed: boolean;
  platform: Platform | null;
  sizeBytes: number;
  expired: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  /** Not expired and within the size limit. Whether downloads are on at all is `downloadEnabled`. */
  downloadable: boolean;
  tooLarge: boolean;
  /**
   * The real build number read from inside the file (the Android versionCode, the iOS CFBundleVersion), when it was read; null before
   * that and when the file held none. `buildRead` says which: read, unreadable (looked at, nothing found) or null (not looked at yet).
   */
  build: ArtifactBuild | null;
  buildRead: 'read' | 'unreadable' | null;
  /**
   * Names of the apps a multi-app run is shared by, when the name of the artifact does not tell which of them it belongs to
   * (so it is shown under each of them); null when the run is for one app or the owner is known.
   */
  sharedWith: string[] | null;
  run: {
    id: string;
    number: number | null;
    workflow: string;
    title: string | null;
    branch: string | null;
    shortSha: string | null;
    status: string;
    conclusion: string | null;
    url: string | null;
  };
};

export type StoreBuildItem = {
  platform: Platform;
  buildNumber: string;
  version: string | null;
  state: 'processing' | 'processed' | 'invalid' | 'unknown';
  rawState: string | null;
  expired: boolean | null;
  uploadedAt: number | null;
  /** TestFlight: upload plus 90 days, an estimate (`expiresAtEstimated`) unless the store says expired. */
  expiresAt: number | null;
  expiresAtEstimated: boolean;
  /** `testflight` (App Store Connect builds) or `play` (version codes on tracks). */
  channel: 'testflight' | 'play';
  tracks: string[];
  releaseStatus: string | null;
  /** Play: where a tester who was invited opts in (not for the internal track: the API does not give that link). */
  optInUrl: string | null;
  runId: string | null;
  /**
   * TestFlight (iOS and macOS): the ids of the public-link groups (`BuildsList.testflight.groups`) this build is in.
   * Null when the groups were not read (no read, an error, or not an Apple build): then nothing is claimed.
   */
  testflightGroupIds: string[] | null;
};

export type ArtifactProblemReason =
  | 'no_access'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported'
  | 'no_repository';

/** Why the TestFlight groups could not be read, in a fixed vocabulary (never Apple's text). */
export type TestFlightProblemReason = 'no_access' | 'rate_limited' | 'unavailable' | 'not_synced';

/** An external TestFlight group that has a public link, as read. This app never creates, enables or changes one. */
export type TestFlightLinkItem = {
  id: string;
  name: string;
  /** The address a tester opens; null when the store did not give one. */
  publicLink: string | null;
  /** False while the link is switched off: testers cannot join with it. */
  enabled: boolean;
  /** The tester limit of the link; null means no limit. */
  limit: number | null;
};

export type TestFlightInfo = {
  groups: TestFlightLinkItem[];
  /** External groups that have no public link (not listed). */
  withoutLink: number;
  problem: { reason: TestFlightProblemReason; needs: string | null } | null;
  readAt: number | null;
  cached: boolean;
};

export type BuildsList = {
  app: { id: string; name: string; platform: Platform; identifier: string };
  repository: { id: string; owner: string; repo: string } | null;
  artifacts: ArtifactItem[];
  /** Artifacts of runs this app does not own or that are not stored here (not shown). */
  hiddenArtifacts: number;
  /** More artifacts exist than were read. */
  truncated: boolean;
  store: StoreBuildItem[];
  /** TestFlight public links (App Store Connect, read only); null for an Android app. */
  testflight: TestFlightInfo | null;
  /** Why CI artifacts could not be listed, in a fixed vocabulary (never GitHub's text). */
  problem: { reason: ArtifactProblemReason; needs: string | null } | null;
  downloadEnabled: boolean;
  maxDownloadBytes: number;
  readAt: number | null;
  cached: boolean;
};

type RepoArtifacts = { at: number; artifacts: CiArtifact[]; truncated: boolean; etag?: string };
const BUILD_EVENTS = ['sync', 'build_changed'] as const;
const repoCache = timedCache<RepoArtifacts>(LIST_CACHE_TTL_MS, 100, {
  name: 'builds.repo_artifacts',
  owner: 'modules/builds/service.ts',
  invalidatedBy: BUILD_EVENTS,
  keys: 'workspace', // `workspace|repository`
});
const stale = new Map<string, RepoArtifacts>();
registerMapCache(stale, {
  name: 'builds.repo_artifacts_etag',
  owner: 'modules/builds/service.ts',
  ttlMs: null,
  invalidatedBy: [],
  why: 'The last list with its ETag, kept only to ask the host conditionally: a 304 revalidates it, it is never served without asking (the 30 second list above is what is served).',
  keys: 'workspace',
});
const troubleCache = timedCache<ArtifactProblemReason>(PROBLEM_CACHE_TTL_MS, 100, {
  name: 'builds.artifact_trouble',
  owner: 'modules/builds/service.ts',
  invalidatedBy: BUILD_EVENTS,
  keys: 'workspace',
});
const inFlight = new Map<
  string,
  Promise<{ ok: true; value: RepoArtifacts; cached: boolean } | Failure>
>();
/** The TestFlight groups of an app (30 seconds), and why a read failed (60 seconds, so a missing role is not asked again every click). */
const flightCache = timedCache<{ at: number; groups: TestFlightGroup[] }>(LIST_CACHE_TTL_MS, 100, {
  name: 'builds.testflight_groups',
  owner: 'modules/builds/service.ts',
  invalidatedBy: BUILD_EVENTS,
  keys: 'workspace_app',
});
const flightTrouble = timedCache<TestFlightProblemReason>(PROBLEM_CACHE_TTL_MS, 100, {
  name: 'builds.testflight_trouble',
  owner: 'modules/builds/service.ts',
  invalidatedBy: BUILD_EVENTS,
  keys: 'workspace_app',
});

/** For tests. */
export function clearBuildCaches(): void {
  repoCache.clear();
  stale.clear();
  troubleCache.clear();
  flightCache.clear();
  flightTrouble.clear();
  inFlight.clear();
}

const reasonOf = (f: Failure): ArtifactProblemReason => {
  const code = String(f.body.error);
  if (f.status === 429) return 'rate_limited';
  if (code === 'ci_unsupported') return 'unsupported';
  if (
    [
      'github_auth',
      'github_forbidden',
      'github_not_found',
      'credential_not_found',
      'credential_kind',
      'credential_unreadable',
    ].includes(code)
  )
    return 'no_access';
  return 'unavailable';
};

/** One read of a repository's artifacts, kept 30 seconds, conditional (ETag) after that, shared by callers that arrive together. */
async function readRepoArtifacts(
  ctx: BuildsContext,
  workspaceId: string,
  repository: NonNullable<Awaited<ReturnType<typeof getRepository>>>,
  actor: Actor,
): Promise<{ ok: true; value: RepoArtifacts; cached: boolean } | Failure> {
  const key = `${workspaceId}|${repository.id}`;
  const hit = repoCache.get(key, ctx.now());
  if (hit) return { ok: true, value: hit, cached: true };
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    const opened = await openCi(ctx, workspaceId, repository, actor, 'builds.list');
    if (!opened.ok) return opened;
    const { client } = opened;
    if (!client.listArtifacts)
      return {
        ok: false,
        status: 422,
        body: {
          error: 'ci_unsupported',
          message: 'This repository connection cannot list artifacts.',
          ...coded('ci.cannotListArtifacts'),
        },
      } as Failure;
    const before = stale.get(key);
    const read = await guarded(ctx, opened.secret, (signal) =>
      (client.listArtifacts as NonNullable<typeof client.listArtifacts>)({
        maxPages: ARTIFACT_PAGES,
        signal,
        etag: before?.etag,
      }),
    );
    if (!read.ok) return read;
    const list = read.value;
    const value: RepoArtifacts =
      list.notModified && before
        ? { ...before, at: ctx.now() }
        : {
            at: ctx.now(),
            artifacts: list.artifacts,
            truncated: list.truncated,
            ...(list.etag ? { etag: list.etag } : {}),
          };
    stale.set(key, value);
    repoCache.set(key, value, ctx.now());
    return { ok: true as const, value, cached: false };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

export type OwnerCandidate = {
  id: string;
  name: string;
  identifier: string;
  prefix?: string | undefined;
};

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What in an artifact name can point at an app: its name, its bundle id or package name (whole and last part), its own tag prefix. */
function ownerKeys(c: OwnerCandidate): string[] {
  const last = c.identifier.split('.').pop() ?? '';
  return [c.name, c.identifier, last, c.prefix ?? '']
    .map(squash)
    .filter((k, i, all) => k.length >= 3 && all.indexOf(k) === i);
}

/**
 * Which of the apps a multi-app run is for does an artifact belong to? By its name only: the one app whose name, bundle id or
 * package name (or tag prefix) the name contains; when several match, the one with the longest match if that is unique
 * ("Notes Pro" over "Notes"). Null: the name does not say.
 */
export function artifactOwner(
  artifactName: string,
  candidates: readonly OwnerCandidate[],
): string | null {
  const n = squash(artifactName);
  const hits = candidates
    .map((c) => ({
      id: c.id,
      score: ownerKeys(c).reduce(
        (best, k) => (n.indexOf(k) !== -1 && k.length > best ? k.length : best),
        0,
      ),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  if (hits.length === 0) return null;
  const first = hits[0]!;
  return hits.length === 1 || hits[0]!.score > hits[1]!.score ? first.id : null;
}

const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

export function artifactItem(
  a: CiArtifact,
  run: WorkflowRunView,
  app: ManagedApp,
  maxBytes: number,
  meta?: ArtifactMeta | undefined,
): ArtifactItem {
  const guess = guessArtifact(a.name, app.platform);
  const tooLarge = a.sizeInBytes > maxBytes;
  return {
    id: a.id,
    name: a.name,
    kind: guess.kind,
    guessed: true,
    platform: guess.platform,
    sizeBytes: a.sizeInBytes,
    expired: a.expired,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    downloadable: !a.expired && !tooLarge,
    tooLarge,
    build: meta?.build ?? null,
    buildRead: meta?.status ?? null,
    sharedWith: null,
    run: {
      id: run.id,
      number: run.runNumber,
      workflow: run.workflow,
      title: run.title,
      branch: run.branch ?? a.headBranch,
      shortSha: shortSha(run.headSha ?? a.headSha),
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
    },
  };
}

/** What the artifact list says about when an artifact was made and its run, in the shape `ci_artifact_meta` keeps (migration 73). */
export function artifactOriginOf(a: CiArtifact, run: WorkflowRunView | undefined): ArtifactOrigin {
  return {
    name: a.name,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    runId: a.runId,
    runNumber: run?.runNumber ?? null,
    branch: run?.branch ?? a.headBranch,
    headSha: shortSha(run?.headSha ?? a.headSha),
    runUrl: run?.url ?? null,
  };
}

/**
 * Every artifact GitHub lists for the repository of an app (the same read as the list, kept 30 seconds), each with its run when the
 * last hundred runs hold it. Unlike the list this does not drop an artifact whose run is not known or that belongs to another platform: it
 * is for the date and the run of a build whose file was read. `reason` is the fixed vocabulary of a list that could not be read.
 */
export async function listRawArtifacts(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string },
  actor: Actor,
): Promise<
  | { ok: true; artifacts: CiArtifact[]; runs: Map<string, WorkflowRunView>; truncated: boolean }
  | { ok: false; reason: ArtifactProblemReason }
> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app?.repositoryId) return { ok: false, reason: 'no_repository' };
  const repository = await getRepository(ctx.db, input.workspaceId, app.repositoryId);
  if (!repository || repository.localOnly) return { ok: false, reason: 'no_repository' };
  const read = await readRepoArtifacts(ctx, input.workspaceId, repository, actor);
  if (!read.ok) return { ok: false, reason: reasonOf(read) };
  const runs = await listRuns(ctx.db, input.workspaceId, repository.id, {
    limit: BUILD_RUNS_READ_LIMIT,
  });
  return {
    ok: true,
    artifacts: read.value.artifacts,
    runs: new Map(runs.map((r) => [r.id, r])),
    truncated: read.value.truncated,
  };
}

export async function storeBuilds(
  ctx: BuildsContext,
  workspaceId: string,
  app: ManagedApp,
): Promise<StoreBuildItem[]> {
  const rows = await ctx.db.query(
    `SELECT build_number, version, processing_state, raw_state, expired, uploaded_at FROM app_builds
      WHERE workspace_id = ? AND app_id = ? AND platform = ?`,
    [workspaceId, app.id, app.platform],
  );
  const releases = await ctx.db.query(
    'SELECT version, track, build, status, details_json FROM app_releases WHERE workspace_id = ? AND app_id = ?',
    [workspaceId, app.id],
  );
  const tracksOf = new Map<string, { tracks: Set<string>; status: string | null }>();
  for (const r of releases) {
    let codes: string[] = [];
    try {
      const d = JSON.parse(String(r.details_json ?? '{}')) as { versionCodes?: unknown };
      if (Array.isArray(d.versionCodes)) codes = d.versionCodes.map((c) => String(c));
    } catch {
      // not JSON: only the build column counts
    }
    for (const code of supports(app.platform, 'releaseTracks')
      ? codes.length
        ? codes
        : String(r.build ?? '').split(',')
      : [String(r.build ?? '')]) {
      const k = code.trim();
      if (!k) continue;
      const e = tracksOf.get(k) ?? { tracks: new Set<string>(), status: null };
      if (r.track) e.tracks.add(String(r.track));
      e.status ??= r.status ? String(r.status) : null;
      tracksOf.set(k, e);
    }
  }
  const play = supports(app.platform, 'releaseTracks');
  const items = rows.map((r): StoreBuildItem => {
    const number = String(r.build_number);
    const uploadedAt =
      r.uploaded_at === null || r.uploaded_at === undefined ? null : Number(r.uploaded_at);
    const expired = r.expired === null || r.expired === undefined ? null : Number(r.expired) === 1;
    const state = String(r.processing_state);
    const extra = tracksOf.get(number);
    const tracks = [...(extra?.tracks ?? [])].sort();
    const estimated = !play && uploadedAt !== null && expired !== true;
    return {
      platform: app.platform,
      buildNumber: number,
      version: r.version ? String(r.version) : null,
      state:
        state === 'processing' || state === 'processed' || state === 'invalid' ? state : 'unknown',
      rawState: r.raw_state ? String(r.raw_state) : null,
      expired,
      uploadedAt,
      expiresAt: estimated ? (uploadedAt as number) + TESTFLIGHT_LIFETIME_MS : null,
      expiresAtEstimated: estimated,
      channel: play ? 'play' : 'testflight',
      tracks,
      releaseStatus: extra?.status ?? null,
      optInUrl:
        play && tracks.some((t) => t !== 'internal' && t !== 'production')
          ? `https://play.google.com/apps/testing/${encodeURIComponent(app.identifier)}`
          : null,
      runId: null,
      testflightGroupIds: null,
    };
  });
  return items.sort(
    (a, b) =>
      (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0) ||
      compareBuildNumbers(b.buildNumber, a.buildNumber),
  );
}

const isFlightReader = (c: unknown): c is TestFlightLinksConnector =>
  typeof (c as Partial<TestFlightLinksConnector>)?.listTestFlightGroups === 'function';

/** Store errors in the fixed vocabulary. Apple's own text never leaves this function. */
const flightReason = (error: unknown): TestFlightProblemReason => {
  if (error instanceof StoreError) {
    if (error.kind === 'auth' || error.kind === 'forbidden' || error.status === 403)
      return 'no_access';
    if (error.kind === 'rate_limited') return 'rate_limited';
  }
  return 'unavailable';
};

const flightProblem = (reason: TestFlightProblemReason, cached = false): TestFlightInfo => ({
  groups: [],
  withoutLink: 0,
  // UNVERIFIED: which App Store Connect role is the least that may read beta groups; App Manager is what the connector tells the user to use.
  problem: {
    reason,
    needs: reason === 'no_access' ? 'App Store Connect API key with the App Manager role' : null,
  },
  readAt: null,
  cached,
});

/**
 * The TestFlight public links of an iOS or macOS app: a READ of its external beta groups (App Store Connect, GET only).
 * Kept 30 seconds like the artifact list; a failure is kept 60 seconds. Nothing is created, enabled or changed.
 */
async function readTestFlight(
  ctx: BuildsContext,
  workspaceId: string,
  app: ManagedApp,
  actor: Actor,
): Promise<{ info: TestFlightInfo; groups: TestFlightGroup[] }> {
  const fail_ = (reason: TestFlightProblemReason, cached = false) => ({
    info: flightProblem(reason, cached),
    groups: [] as TestFlightGroup[],
  });
  if (!app.storeAppId) return fail_('not_synced');
  const key = `${workspaceId}|${app.id}|${app.storeAppId}|${app.credentialId}`;
  const trouble = flightTrouble.get(key, ctx.now());
  if (trouble) return fail_(trouble, true);
  const hit = flightCache.get(key, ctx.now());
  if (hit) return { info: flightInfo(hit.groups, hit.at, true), groups: hit.groups };
  const stop = (reason: TestFlightProblemReason) => {
    flightTrouble.set(key, reason, ctx.now());
    return fail_(reason);
  };
  const [credential] = await ctx.db.query(
    'SELECT kind FROM credentials WHERE id = ? AND workspace_id = ?',
    [app.credentialId, workspaceId],
  );
  if (!credential || String(credential.kind) !== 'app_store_connect') return stop('no_access');
  let secret: string | undefined;
  try {
    secret = await useCredentialSecret(
      ctx.db,
      ctx.masterKey,
      { workspaceId, id: app.credentialId, purpose: 'builds.testflight' },
      actor,
      ctx.now(),
    );
  } catch {
    return stop('no_access');
  }
  if (secret === undefined) return stop('no_access');
  const controller = new AbortController();
  const guardedFetch: typeof fetch = (input, init) =>
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  try {
    const connector = ctx.builds.storeConnectorFactory({
      kind: 'app_store_connect',
      secret,
      identifier: app.identifier,
      platform: app.platform,
      fetch: guardedFetch,
    });
    if (!isFlightReader(connector)) return fail_('unavailable');
    const groups = await withTimeout(
      connector.listTestFlightGroups(app.storeAppId),
      ctx.timeoutMs,
      () => controller.abort(),
    );
    const at = ctx.now();
    flightCache.set(key, { at, groups }, at);
    return { info: flightInfo(groups, at, false), groups };
  } catch (error) {
    return stop(flightReason(error));
  }
}

function flightInfo(groups: TestFlightGroup[], at: number, cached: boolean): TestFlightInfo {
  const withLink = groups.filter((g) => g.publicLink !== null || g.publicLinkEnabled);
  return {
    groups: withLink
      .map((g) => ({
        id: g.id,
        name: g.name,
        publicLink: g.publicLink,
        enabled: g.publicLinkEnabled,
        limit: g.publicLinkLimit,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    withoutLink: groups.length - withLink.length,
    problem: null,
    readAt: at,
    cached,
  };
}

export async function listBuildArtifacts(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string },
  actor: Actor,
): Promise<{ ok: true; list: BuildsList } | BuildsFailure | Failure> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return fail(404, 'not_found');
  const repository = app.repositoryId
    ? await getRepository(ctx.db, input.workspaceId, app.repositoryId)
    : undefined;
  let store = await storeBuilds(ctx, input.workspaceId, app);
  // TestFlight links: only for an Apple app that has builds from a sync. A failure is a fixed reason, never an error of the list.
  let testflight: TestFlightInfo | null = null;
  if (supports(app.platform, 'betaTesting') && store.length > 0) {
    const flight = await readTestFlight(ctx, input.workspaceId, app, actor);
    testflight = flight.info;
    if (!flight.info.problem) {
      const wanted = flight.groups.filter((g) => g.publicLink !== null || g.publicLinkEnabled);
      store = store.map((b) => ({
        ...b,
        testflightGroupIds: wanted
          .filter((g) => g.allBuilds || g.buildNumbers.includes(b.buildNumber))
          .map((g) => g.id),
      }));
    }
  }
  const base = {
    testflight,
    app: { id: app.id, name: app.name, platform: app.platform, identifier: app.identifier },
    repository:
      repository && !repository.localOnly
        ? { id: repository.id, owner: repository.owner, repo: repository.repo }
        : null,
    store,
    downloadEnabled: ctx.builds.downloadEnabled,
    maxDownloadBytes: ctx.builds.maxDownloadBytes,
  };
  if (!repository || repository.localOnly) {
    return {
      ok: true,
      list: {
        ...base,
        artifacts: [],
        hiddenArtifacts: 0,
        truncated: false,
        problem: { reason: 'no_repository', needs: null },
        readAt: null,
        cached: false,
      },
    };
  }
  const key = `${input.workspaceId}|${repository.id}`;
  const trouble = troubleCache.get(key, ctx.now());
  if (trouble) {
    return {
      ok: true,
      list: {
        ...base,
        artifacts: [],
        hiddenArtifacts: 0,
        truncated: false,
        problem: { reason: trouble, needs: trouble === 'no_access' ? 'actions: read' : null },
        readAt: null,
        cached: true,
      },
    };
  }
  const read = await readRepoArtifacts(ctx, input.workspaceId, repository, actor);
  if (!read.ok) {
    const reason = reasonOf(read);
    troubleCache.set(key, reason, ctx.now());
    return {
      ok: true,
      list: {
        ...base,
        artifacts: [],
        hiddenArtifacts: 0,
        truncated: false,
        problem: { reason, needs: reason === 'no_access' ? 'actions: read' : null },
        readAt: null,
        cached: false,
      },
    };
  }
  const runs = await listRuns(ctx.db, input.workspaceId, repository.id, {
    limit: BUILD_RUNS_READ_LIMIT,
  });
  const byRun = new Map(runs.filter((r) => runCountsForApp(r, app.id)).map((r) => [r.id, r]));
  const artifacts: ArtifactItem[] = [];
  const metas = await loadArtifactMeta(ctx.db, input.workspaceId, app.id);
  let hidden = 0;
  // A run linked to several apps (a monorepo): who each artifact belongs to is read from its name.
  const conventions = await listConventions(ctx.db, input.workspaceId, repository.id);
  const linked = new Map<string, OwnerCandidate | null>();
  const candidatesOf = async (run: WorkflowRunView): Promise<OwnerCandidate[]> => {
    const out: OwnerCandidate[] = [];
    for (const id of run.appIds) {
      if (!linked.has(id)) {
        const other = id === app.id ? app : await getApp(ctx.db, input.workspaceId, id);
        linked.set(
          id,
          other
            ? {
                id,
                name: other.name,
                identifier: other.identifier,
                prefix: conventions.find((r) => r.appId === id)?.prefix,
              }
            : null,
        );
      }
      const c = linked.get(id);
      if (c) out.push(c);
    }
    return out;
  };
  for (const a of read.value.artifacts) {
    const run = a.runId ? byRun.get(a.runId) : undefined;
    if (!run) {
      hidden++;
      continue;
    }
    const item = artifactItem(a, run, app, ctx.builds.maxDownloadBytes, metas.get(a.id));
    if (run.appIds.length > 1) {
      const candidates = await candidatesOf(run);
      const owner = artifactOwner(a.name, candidates);
      if (owner !== null && owner !== app.id) {
        hidden++;
        continue;
      }
      if (owner === null) item.sharedWith = candidates.map((c) => c.name).sort();
    }
    // A run can build several platforms: an APK is not a build of the iOS app of the same repository.
    if (item.platform !== null && item.platform !== app.platform) hidden++;
    else artifacts.push(item);
  }
  artifacts.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id));
  return {
    ok: true,
    list: {
      ...base,
      artifacts,
      hiddenArtifacts: hidden,
      truncated: read.value.truncated,
      problem: null,
      readAt: read.value.at,
      cached: read.cached,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Download

export type OpenedDownload = {
  ok: true;
  body: ReadableStream<Uint8Array>;
  /** Only when GitHub said so and it is within the limit. */
  contentLength: number | null;
  filename: string;
  artifact: CiArtifact;
};

/** `ios build #12 (main).zip` becomes `ios_build_12_main.zip`: letters, digits, dot, dash, underscore; never a path. */
export function safeFilename(name: string, fallback = 'build'): string {
  const cleaned = name
    .replace(/\.zip$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/_{2 }/g, '_')
    .slice(0, 100);
  return `${cleaned || fallback}.zip`;
}

/** The zip as a stream that stops at the limit, at the time limit, and when the reader goes away. */
function guardStream(
  body: ReadableStream<Uint8Array>,
  limits: { maxBytes: number; timeoutMs: number; onDone: () => void },
  abort: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sent = 0;
  let done = false;
  const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
  // A download that nobody reads must not keep the process alive for the whole time limit.
  timer.unref?.();
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    limits.onDone();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        sent += next.value.byteLength;
        if (sent > limits.maxBytes) {
          finish();
          abort.abort();
          await reader.cancel().catch(() => undefined);
          controller.error(new Error('The artifact is larger than the download limit.'));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error instanceof Error ? error : new Error('The download failed.'));
      }
    },
    async cancel(reason) {
      finish();
      abort.abort();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export type FoundArtifact = {
  ok: true;
  app: ManagedApp;
  repository: NonNullable<Awaited<ReturnType<typeof getRepository>>>;
  artifact: CiArtifact;
  run: WorkflowRunView;
};

/** The artifact of a run of this app, that can still be downloaded: the listing decides, never the id alone. */
export async function findArtifact(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string; artifactId: string },
  actor: Actor,
): Promise<FoundArtifact | BuildsFailure | Failure> {
  if (!/^[0-9]{1,20}$/.test(input.artifactId))
    return fail(400, 'invalid_request', 'An artifact id is a number.');
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app?.repositoryId) return fail(404, 'not_found');
  const repository = await getRepository(ctx.db, input.workspaceId, app.repositoryId);
  if (!repository || repository.localOnly) return fail(404, 'not_found');
  const read = await readRepoArtifacts(ctx, input.workspaceId, repository, actor);
  if (!read.ok) return read;
  const artifact = read.value.artifacts.find((a) => a.id === input.artifactId);
  const runs = artifact?.runId
    ? await listRuns(ctx.db, input.workspaceId, repository.id, { limit: BUILD_RUNS_READ_LIMIT })
    : [];
  const run = runs.find((r) => r.id === artifact?.runId && runCountsForApp(r, app.id));
  if (!artifact || !run) return fail(404, 'not_found');
  if (artifact.expired || (artifact.expiresAt !== null && artifact.expiresAt <= ctx.now())) {
    return fail(
      410,
      'artifact_expired',
      'GitHub no longer keeps this artifact. Run the workflow again to make a new one.',
      coded('builds.artifactGone'),
    );
  }
  if (artifact.sizeInBytes > ctx.builds.maxDownloadBytes) {
    return fail(
      413,
      'artifact_too_large',
      `This artifact is larger than the download limit (${Math.floor(ctx.builds.maxDownloadBytes / 1024 / 1024)} MB).`,
      {
        sizeBytes: artifact.sizeInBytes,
        maxBytes: ctx.builds.maxDownloadBytes,
        ...coded('builds.artifactTooLargeMb', {
          mb: Math.floor(ctx.builds.maxDownloadBytes / 1024 / 1024),
        }),
      },
    );
  }
  return { ok: true, app, repository, artifact, run };
}

export async function openArtifactDownload(
  ctx: BuildsContext,
  input: {
    workspaceId: string;
    appId: string;
    artifactId: string;
    via: 'session' | 'link' | 'share' | 'inspect';
  },
  actor: Actor,
): Promise<OpenedDownload | BuildsFailure | Failure> {
  // `share`: the internal sharing service reads the artifact to upload it to Google; it has its own switch and gates.
  if (!ctx.builds.downloadEnabled && input.via !== 'share') {
    return fail(
      409,
      'builds_download_disabled',
      'Downloading builds is switched off on this server (KILN_BUILDS_DOWNLOAD_ENABLED).',
    );
  }
  if (!/^[0-9]{1,20}$/.test(input.artifactId))
    return fail(400, 'invalid_request', 'An artifact id is a number.');
  const wait = ctx.downloadLimiter.take(input.workspaceId);
  if (wait > 0) {
    return {
      ...fail(429, 'rate_limited', `Too many downloads. Try again in ${wait} seconds.`, {
        retryAfterSeconds: wait,
        ...coded('rate.downloads', { count: wait }),
      }),
      headers: { 'Retry-After': String(wait) },
    };
  }
  const found = await findArtifact(ctx, input, actor);
  if (!found.ok) return found;
  const { app, repository, artifact, run } = found;
  const busy = ctx.downloading.get(input.workspaceId) ?? 0;
  if (busy >= MAX_PARALLEL_DOWNLOADS) {
    return {
      ...fail(429, 'rate_limited', 'Other downloads are still running. Try again in a moment.', {
        retryAfterSeconds: BUILD_BUSY_RETRY_AFTER_SECONDS,
        ...coded('builds.downloadsBusy'),
      }),
      headers: { 'Retry-After': '10' },
    };
  }

  const opened = await openCi(ctx, input.workspaceId, repository, actor, 'builds.download');
  if (!opened.ok) return opened;
  const { client } = opened;
  if (!client.openArtifactDownload)
    return fail(
      422,
      'ci_unsupported',
      'This repository connection cannot download artifacts.',
      coded('ci.cannotDownloadArtifacts'),
    );
  const abort = new AbortController();
  ctx.downloading.set(input.workspaceId, busy + 1);
  const release = () => {
    const n = (ctx.downloading.get(input.workspaceId) ?? 1) - 1;
    if (n <= 0) ctx.downloading.delete(input.workspaceId);
    else ctx.downloading.set(input.workspaceId, n);
  };
  let started = false;
  try {
    const got = await guarded(ctx, opened.secret, (signal) =>
      (client.openArtifactDownload as NonNullable<typeof client.openArtifactDownload>)(
        artifact.id,
        {
          signal: AbortSignal.any([signal, abort.signal]),
          allowHttp: ctx.builds.allowHttpRedirects,
        },
      ),
    );
    if (!got.ok) return got;
    if (got.value.status === 'gone')
      return fail(
        410,
        'artifact_expired',
        'GitHub no longer keeps this artifact. Run the workflow again to make a new one.',
        coded('builds.artifactGone'),
      );
    if (got.value.status === 'missing') return fail(404, 'not_found');
    const { body, contentLength } = got.value;
    if (contentLength !== null && contentLength > ctx.builds.maxDownloadBytes) {
      await body.cancel().catch(() => undefined);
      return fail(413, 'artifact_too_large', 'This artifact is larger than the download limit.', {
        sizeBytes: contentLength,
        maxBytes: ctx.builds.maxDownloadBytes,
        ...coded('builds.artifactTooLarge'),
      });
    }
    // Ids and a size only: no name, no address. The server reading a file for itself (`inspect`: a build number, nothing leaves
    // this machine) is not a download by a person and writes no row.
    if (input.via !== 'inspect')
      await recordAudit(ctx.db, {
        workspaceId: input.workspaceId,
        actor,
        action: 'build.download',
        target: { type: 'app', id: app.id },
        detail: {
          artifactId: artifact.id,
          runId: run.id,
          repositoryId: repository.id,
          sizeBytes: artifact.sizeInBytes,
          via: input.via,
        },
        at: ctx.now(),
      });
    started = true;
    return {
      ok: true,
      body: guardStream(
        body,
        {
          maxBytes: ctx.builds.maxDownloadBytes,
          timeoutMs: ctx.builds.downloadTimeoutMs,
          onDone: release,
        },
        abort,
      ),
      contentLength,
      filename: safeFilename(artifact.name, `build-${artifact.id}`),
      artifact,
    };
  } finally {
    if (!started) release();
  }
}

// ---------------------------------------------------------------------------------------------
// A link for a phone: signed, ten minutes, once. The token is short enough for a small QR code: a random id and the expiry,
// signed. What it opens (workspace, app, artifact, the person) is kept here in memory under that id, never in the token and
// never a GitHub address. A restart forgets the links, which is fine for something that lives ten minutes.

export type LinkPayload = { w: string; a: string; i: string; u: string; e: number; n: string };
const MAX_LINKS = 1_000;

const b64 = (b: Buffer) => b.toString('base64url');
const signingKey = (ctx: Pick<BuildsContext, 'masterKey'>) =>
  createHmac('sha256', ctx.masterKey).update('mrm-builds-link-v1').digest();
const macOf = (ctx: BuildsContext, body: string) =>
  createHmac('sha256', signingKey(ctx)).update(body).digest().subarray(0, 16);

export function signDownloadLink(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string; artifactId: string; userId: string },
): { token: string; expiresAt: number } {
  const now = ctx.now();
  const expiresAt = now + ctx.builds.linkTtlMs;
  for (const [n, c] of ctx.links) if (c.e <= now) ctx.links.delete(n);
  while (ctx.links.size >= MAX_LINKS) {
    const oldest = ctx.links.keys().next().value;
    if (oldest === undefined) break;
    ctx.links.delete(oldest);
  }
  const nonce = randomBytes(12);
  const expiry = Buffer.alloc(6);
  expiry.writeUIntBE(expiresAt, 0, 6);
  const body = b64(Buffer.concat([nonce, expiry]));
  ctx.links.set(body, {
    w: input.workspaceId,
    a: input.appId,
    i: input.artifactId,
    u: input.userId,
    e: expiresAt,
    used: false,
  });
  return { token: `${body}.${b64(macOf(ctx, body))}`, expiresAt };
}

export function readDownloadLink(
  ctx: BuildsContext,
  token: string,
): { ok: true; payload: LinkPayload } | { ok: false; reason: 'invalid' | 'expired' | 'used' } {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined || token.length > 200)
    return { ok: false, reason: 'invalid' };
  const expected = macOf(ctx, body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'invalid' };
  const claim = ctx.links.get(body);
  if (!claim) return { ok: false, reason: 'invalid' };
  if (claim.e <= ctx.now()) return { ok: false, reason: 'expired' };
  if (claim.used) return { ok: false, reason: 'used' };
  return {
    ok: true,
    payload: { w: claim.w, a: claim.a, i: claim.i, u: claim.u, e: claim.e, n: body },
  };
}

/** Marks a link used (before any await, so two requests at once cannot both pass). */
export function reserveLink(ctx: BuildsContext, payload: LinkPayload): boolean {
  const claim = ctx.links.get(payload.n);
  if (!claim || claim.used) return false;
  claim.used = true;
  return true;
}

export const releaseLink = (ctx: BuildsContext, payload: LinkPayload) => {
  const claim = ctx.links.get(payload.n);
  if (claim) claim.used = false;
};

/** Does the person who made the link still have the right (a member who left in the meantime does not)? */
export async function linkStillAllowed(ctx: BuildsContext, payload: LinkPayload): Promise<boolean> {
  const role = await memberRole(ctx.db, payload.w, payload.u);
  return role !== undefined && role !== null && can(role, 'builds.download');
}

/** A link for a phone, for an artifact that can be downloaded now. Audited with ids only. */
export async function createDownloadLink(
  ctx: BuildsContext,
  input: { workspaceId: string; appId: string; artifactId: string; userId: string },
  actor: Actor,
): Promise<
  { ok: true; token: string; expiresAt: number; filename: string } | BuildsFailure | Failure
> {
  if (!ctx.builds.downloadEnabled) {
    return fail(
      409,
      'builds_download_disabled',
      'Downloading builds is switched off on this server (KILN_BUILDS_DOWNLOAD_ENABLED).',
    );
  }
  const wait = ctx.downloadLimiter.take(input.workspaceId);
  if (wait > 0) {
    return {
      ...fail(429, 'rate_limited', `Too many downloads. Try again in ${wait} seconds.`, {
        retryAfterSeconds: wait,
        ...coded('rate.downloads', { count: wait }),
      }),
      headers: { 'Retry-After': String(wait) },
    };
  }
  const found = await findArtifact(ctx, input, actor);
  if (!found.ok) return found;
  const link = signDownloadLink(ctx, input);
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor,
    action: 'build.link_created',
    target: { type: 'app', id: found.app.id },
    detail: { artifactId: found.artifact.id, runId: found.run.id, expiresAt: link.expiresAt },
    at: ctx.now(),
  });
  return {
    ok: true,
    ...link,
    filename: safeFilename(found.artifact.name, `build-${found.artifact.id}`),
  };
}
