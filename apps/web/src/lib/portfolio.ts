import {
  byFamily,
  PLATFORMS,
  type Platform,
  platformMeta,
  type ReleaseEvent,
  type ReleaseState,
  supports,
  transition,
} from '@kiln/core';
import { type Api, ApiError } from './api.ts';
import { timeAgo } from './format.ts';
import { formatList, formatPercent } from './i18n/format.ts';
import { k, t } from './i18n/t.ts';
import type {
  AppSummary,
  DiscoverCandidate,
  DiscoverFailure,
  DiscoverResult,
  ImportItem,
  ImportItemResult,
  ImportResult,
  ImportSummary,
  NewApp,
  ReleaseSummary,
  SyncSummary,
} from './types.ts';

export type BadgeTone = 'neutral' | 'ok' | 'bad' | 'warn' | 'info' | 'accent';

// ---------------------------------------------------------------------------------------------
// Routing: the screen is the `portfolio` view; an open app is `#/portfolio/<id>`.

export type Route = { name: 'list' } | { name: 'app'; id: string };

export const portfolioHref = '#/portfolio';

export const appHref = (id: string) => `#/portfolio/${encodeURIComponent(id)}`;

/** Reads a location hash such as `#/portfolio/6f1c` into the screen to show. Anything else is the list. */
export function parseRoute(hash: string): Route {
  const match = /^#?\/?portfolio\/([^/?#]+)\/?(?:[?#].*)?$/.exec(hash);
  if (!match) return { name: 'list' };
  try {
    const id = decodeURIComponent(match[1] ?? '');
    return id ? { name: 'app', id } : { name: 'list' };
  } catch {
    return { name: 'list' };
  }
}

// ---------------------------------------------------------------------------------------------
// Labels

export const platformLabel = (platform: Platform) => platformMeta(platform).label;

export const storeName = (platform: Platform) => platformMeta(platform).storeName;

/** Platforms in display order: iOS, macOS, Android. */
export const platformRank = (platform: Platform): number => platformMeta(platform).order;

/**
 * A name that tells two apps apart when they share it (and often their identifier): the same
 * product on iOS and Android is two apps, so lists that show only a name add the platform.
 */
export const appLabel = (app: { name: string; platform: Platform }): string =>
  `${app.name} (${platformLabel(app.platform)})`;

const TRACKS: Record<string, string> = {
  production: k('portfolio:track.production'),
  beta: k('portfolio:track.beta'),
  alpha: k('portfolio:track.alpha'),
  internal: k('portfolio:track.internal'),
};

/** The Play track as a person reads it. `null` (iOS) is the App Store. */
export function trackLabel(track: string | null): string {
  if (track === null) return 'App Store';
  const key = TRACKS[track];
  return key === undefined ? track : t(key);
}

export type StatusInfo = { label: string; tone: BadgeTone; description: string };

type StatusKeys = { label: string; tone: BadgeTone; description: string };

const STATUS: Record<ReleaseState, StatusKeys> = {
  draft: {
    label: k('portfolio:status.draft.label'),
    tone: 'neutral',
    description: k('portfolio:status.draft.description'),
  },
  build_chosen: {
    label: k('portfolio:status.buildChosen.label'),
    tone: 'neutral',
    description: k('portfolio:status.buildChosen.description'),
  },
  ready: {
    label: k('portfolio:status.ready.label'),
    tone: 'info',
    description: k('portfolio:status.ready.description'),
  },
  in_review: {
    label: k('portfolio:status.inReview.label'),
    tone: 'info',
    description: k('portfolio:status.inReview.description'),
  },
  rejected: {
    label: k('portfolio:status.rejected.label'),
    tone: 'bad',
    description: k('portfolio:status.rejected.description'),
  },
  approved: {
    label: k('portfolio:status.approved.label'),
    tone: 'accent',
    description: k('portfolio:status.approved.description'),
  },
  propagating: {
    label: k('portfolio:status.propagating.label'),
    tone: 'info',
    description: k('portfolio:status.propagating.description'),
  },
  rolling_out: {
    label: k('portfolio:status.rollingOut.label'),
    tone: 'info',
    description: k('portfolio:status.rollingOut.description'),
  },
  live: {
    label: k('portfolio:status.live.label'),
    tone: 'ok',
    description: k('portfolio:status.live.description'),
  },
  halted: {
    label: k('portfolio:status.halted.label'),
    tone: 'warn',
    description: k('portfolio:status.halted.description'),
  },
};

/** The label, tone and a sentence for a normalized status. `null` means the store state has no mapping. */
export function statusInfo(
  status: ReleaseState | null | undefined,
  rawState?: string | null,
): StatusInfo {
  if (status) {
    const keys = STATUS[status];
    return { label: t(keys.label), tone: keys.tone, description: t(keys.description) };
  }
  return {
    label: t('portfolio:status.unmapped.label'),
    tone: 'neutral',
    description: rawState
      ? t('portfolio:status.unmapped.descriptionRaw', { state: rawState })
      : t('portfolio:status.unmapped.description'),
  };
}

/** "20%", "0.5%", or null when the store reports no staged rollout. */
export function formatRollout(fraction: number | null | undefined): string | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null;
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
  return formatPercent(percent / 100, { minimumFractionDigits: Number.isInteger(percent) ? 0 : 1, maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------------------------
// Sorting and grouping releases

const tokens = (version: string) => version.match(/\d+|[A-Za-z]+/g) ?? [];
const isNumber = (token: string) => /^\d/.test(token);

/**
 * Orders version strings: 2.10.0 is after 2.9.0, 1.0 equals 1.0.0, and a pre-release such as
 * 1.0.0-beta is before 1.0.0. Anything it cannot read as numbers and words compares as text.
 */
export function compareVersions(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined || y === undefined) {
      const extra = (x ?? y) as string;
      // The longer one is a pre-release (a word follows) or a later part (a number follows).
      if (isNumber(extra) && Number(extra) === 0) continue;
      const longerIsGreater = isNumber(extra);
      return (x === undefined ? -1 : 1) * (longerIsGreater ? 1 : -1);
    }
    if (isNumber(x) && isNumber(y)) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (isNumber(x) !== isNumber(y)) {
      return isNumber(x) ? 1 : -1;
    } else if (x.toLowerCase() !== y.toLowerCase()) {
      return x.toLowerCase() < y.toLowerCase() ? -1 : 1;
    }
  }
  return 0;
}

const TRACK_ORDER = ['production', 'beta', 'alpha', 'internal'];

/** Production first, then beta, alpha, internal, then custom tracks by name. iOS (no track) first of all. */
function trackRank(track: string | null): number {
  if (track === null) return -1;
  const i = TRACK_ORDER.indexOf(track);
  return i === -1 ? TRACK_ORDER.length : i;
}

function compareTracks(a: string | null, b: string | null): number {
  const diff = trackRank(a) - trackRank(b);
  if (diff !== 0) return diff;
  return (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
}

/** Newest version first. A tie goes to the more public track, then the higher build. */
export function compareReleases(a: ReleaseSummary, b: ReleaseSummary): number {
  const byVersion = compareVersions(b.version, a.version);
  if (byVersion !== 0) return byVersion;
  const byTrack = compareTracks(a.track, b.track);
  if (byTrack !== 0) return byTrack;
  if (a.build !== null && b.build !== null) {
    const byBuild = compareVersions(b.build, a.build);
    if (byBuild !== 0) return byBuild;
  } else if (a.build !== b.build) {
    return a.build === null ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const sortReleases = (releases: readonly ReleaseSummary[]): ReleaseSummary[] =>
  [...releases].sort(compareReleases);

/** The newest release, optionally of one platform. `null` when there is none. */
export function latestRelease(
  releases: readonly ReleaseSummary[],
  platform?: Platform,
): ReleaseSummary | null {
  const pool = platform ? releases.filter((r) => r.platform === platform) : releases;
  return sortReleases(pool)[0] ?? null;
}

/** The newest release of each platform that has one. */
export function latestByPlatform(
  releases: readonly ReleaseSummary[],
): Partial<Record<Platform, ReleaseSummary>> {
  const result: Partial<Record<Platform, ReleaseSummary>> = {};
  for (const platform of PLATFORMS) {
    const release = latestRelease(releases, platform);
    if (release) result[platform] = release;
  }
  return result;
}

/** The newest release that is fully live. Used to show what users have while a newer one is in progress. */
export function liveRelease(
  releases: readonly ReleaseSummary[],
  platform?: Platform,
): ReleaseSummary | null {
  const pool = platform ? releases.filter((r) => r.platform === platform) : releases;
  return sortReleases(pool).find((r) => r.status === 'live') ?? null;
}

export type ReleaseGroup = {
  key: string;
  platform: Platform;
  track: string | null;
  title: string;
  /** Newest first. */
  releases: ReleaseSummary[];
  latest: ReleaseSummary;
};

/** One group per platform and track, iOS before Android, the more public tracks first. */
export function groupReleases(releases: readonly ReleaseSummary[]): ReleaseGroup[] {
  const groups = new Map<string, ReleaseSummary[]>();
  for (const release of sortReleases(releases)) {
    const key = `${release.platform}:${release.track ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(release);
    else groups.set(key, [release]);
  }
  const result: ReleaseGroup[] = [];
  for (const [key, list] of groups) {
    const latest = list[0] as ReleaseSummary;
    result.push({
      key,
      platform: latest.platform,
      track: latest.track,
      title:
        latest.track === null
          ? `${platformLabel(latest.platform)} · ${storeName(latest.platform)}`
          : `${platformLabel(latest.platform)} · ${trackLabel(latest.track)}`,
      releases: list,
      latest,
    });
  }
  return result.sort(
    (a, b) =>
      platformRank(a.platform) - platformRank(b.platform) || compareTracks(a.track, b.track),
  );
}

// ---------------------------------------------------------------------------------------------
// The lifecycle timeline, walked from the state machine in @kiln/core

const FORWARD: readonly ReleaseEvent[] = [
  'choose_build',
  'mark_ready',
  'submit',
  'approve',
  'release',
  'propagated',
  'complete',
];

/** The happy path for a platform, from draft to live. Android passes through `propagating`. */
export function lifecyclePath(platform: Platform): ReleaseState[] {
  const path: ReleaseState[] = ['draft'];
  let state: ReleaseState = 'draft';
  for (const event of FORWARD) {
    const result = transition(platform, state, event);
    if (!result.ok) continue;
    state = result.state;
    path.push(state);
  }
  return path;
}

export type TimelineStep = {
  state: ReleaseState;
  label: string;
  position: 'done' | 'current' | 'upcoming';
  tone: BadgeTone;
};

/**
 * The steps of the lifecycle with the release's place marked. A rejected release sits on the review
 * step and a halted one on the rollout step, with their own label. Without a mapped status there
 * is no place to mark, so the result is empty.
 */
export function timeline(platform: Platform, status: ReleaseState | null): TimelineStep[] {
  if (!status) return [];
  const anchor: ReleaseState =
    status === 'rejected' ? 'in_review' : status === 'halted' ? 'rolling_out' : status;
  const path = lifecyclePath(platform);
  const at = path.indexOf(anchor);
  if (at === -1) return [];
  return path.map((state, i) => {
    const current = i === at;
    const info = statusInfo(current ? status : state);
    return {
      state,
      label: info.label,
      position: i < at ? 'done' : current ? 'current' : 'upcoming',
      tone: current ? info.tone : 'neutral',
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Apps

export function sortApps(apps: readonly AppSummary[]): AppSummary[] {
  return [...apps].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    if (a.platform !== b.platform) return platformRank(a.platform) - platformRank(b.platform);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type SyncInfo = {
  kind: 'never' | 'ok' | 'failed';
  /** "Synced 5 minutes ago" or "Never synced". */
  label: string;
  /** The message from the last failed attempt, or null. */
  error: string | null;
  /** "Last attempt 2 minutes ago", only when the last attempt failed. */
  attempt: string | null;
};

/** What the sync column says for an app. A failed attempt keeps the time of the last good sync. */
export function syncInfo(
  app: Pick<AppSummary, 'lastSyncedAt' | 'lastSyncAttemptAt' | 'lastSyncError'>,
  now: number = Date.now(),
): SyncInfo {
  const label =
    app.lastSyncedAt === null
      ? t('portfolio:sync.never')
      : t('portfolio:sync.synced', { when: timeAgo(app.lastSyncedAt, now) });
  const error = app.lastSyncError?.trim() ? app.lastSyncError.trim() : null;
  if (error) {
    const attempt =
      app.lastSyncAttemptAt === null
        ? null
        : t('portfolio:sync.lastAttempt', { when: timeAgo(app.lastSyncAttemptAt, now) });
    return { kind: 'failed', label, error, attempt };
  }
  return { kind: app.lastSyncedAt === null ? 'never' : 'ok', label, error: null, attempt: null };
}

/** What a successful sync found: "3 releases, 1 added, 1 updated." */
export function syncDetail(sync: SyncSummary): string {
  if (sync.found === 0) return t('portfolio:sync.noReleases');
  const parts = [
    sync.added > 0 ? t('portfolio:sync.added', { count: sync.added }) : '',
    sync.updated > 0 ? t('portfolio:sync.updated', { count: sync.updated }) : '',
    sync.removed > 0 ? t('portfolio:sync.removed', { count: sync.removed }) : '',
  ].filter(Boolean);
  const changes = parts.length > 0 ? formatList(parts, { type: 'unit' }) : t('portfolio:sync.noChanges');
  return sync.unmapped > 0
    ? t('portfolio:sync.detailUnmapped', { count: sync.found, changes, unmapped: sync.unmapped })
    : t('portfolio:sync.detail', { count: sync.found, changes });
}

/** A sentence for a screen reader and a toast: what a successful sync found. */
export function syncSummaryText(name: string, sync: SyncSummary): string {
  return sync.found === 0
    ? t('portfolio:sync.summaryEmpty', { name, detail: syncDetail(sync) })
    : t('portfolio:sync.summary', { name, detail: syncDetail(sync) });
}

// ---------------------------------------------------------------------------------------------
// Errors

/** "30 seconds", "1 minute", "10 minutes", rounded up. */
function waitPhrase(seconds: number): string {
  if (seconds < 60) return t('portfolio:wait.seconds', { count: Math.max(1, Math.ceil(seconds)) });
  return t('portfolio:wait.minutes', { count: Math.ceil(seconds / 60) });
}

export type AppErrorContext = 'load' | 'add' | 'sync' | 'delete' | 'discover' | 'import';

type ErrorLike = Pick<ApiError, 'status' | 'code' | 'message'> &
  Partial<Pick<ApiError, 'retryAfter' | 'body'>>;

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** How long to wait before trying again, from the Retry-After header or the body, in seconds. */
export function retrySeconds(error: ErrorLike): number | null {
  const fromBody = error.body?.retryAfterSeconds;
  const seconds = error.retryAfter ?? (typeof fromBody === 'number' ? fromBody : undefined);
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The app the server sent along with a failed sync (it carries the new `lastSyncError`), if any. */
export function appFromError(error: Pick<ApiError, 'body'>): AppSummary | null {
  const app = error.body?.app;
  if (!app || typeof app !== 'object') return null;
  const candidate = app as Partial<AppSummary>;
  return typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.platform === 'string'
    ? (app as AppSummary)
    : null;
}

/**
 * A sentence a person can act on for each thing the apps API can say. It does not reuse
 * `error.message`, which words some codes (rate limit, timeout) for GitHub.
 */
export function appErrorMessage(error: ErrorLike, context: AppErrorContext = 'load'): string {
  const wait = retrySeconds(error);
  switch (error.code) {
    case 'not_found':
      return t('portfolio:error.notFound');
    case 'already_exists':
      return t('portfolio:error.alreadyExists');
    case 'credential_not_found':
      return context === 'add' || context === 'discover' || context === 'import'
        ? t('portfolio:error.credentialGonePick')
        : t('portfolio:error.credentialGone');
    case 'credential_kind':
      return asText(error.body?.message) || t('portfolio:error.credentialKind');
    case 'repository_not_found':
      return t('portfolio:error.repositoryNotFound');
    case 'sync_in_progress':
      return t('portfolio:error.syncInProgress');
    case 'credential_unreadable':
      return t('portfolio:error.credentialUnreadable');
    case 'store_auth':
      return t('portfolio:error.storeAuth');
    case 'store_forbidden':
      return t('portfolio:error.storeForbidden');
    case 'store_not_found':
      return t('portfolio:error.storeNotFound');
    case 'rate_limited': {
      const when = wait === null ? t('portfolio:wait.aMinute') : waitPhrase(wait);
      if (context === 'discover' && !error.body?.app) {
        return t('portfolio:error.rateLimitedDiscover', { when });
      }
      // The workspace limit answers without an app; the store's own limit comes with one.
      return error.body?.app
        ? t('portfolio:error.rateLimitedStore', { when })
        : t('portfolio:error.rateLimitedWorkspace', { when });
    }
    case 'store_unavailable':
      return t('portfolio:error.storeUnavailable');
    case 'timeout':
      return t('portfolio:error.timeout');
    case 'packages_required':
      return t('portfolio:error.packagesRequired');
    case 'discover_failed':
      return t('portfolio:error.discoverFailed');
    case 'sync_failed':
      return t('portfolio:error.syncFailed');
    default:
      return (
        error.message ||
        (context === 'sync' ? t('portfolio:error.syncDefault') : t('common:error.genericRetry'))
      );
  }
}

export type SyncFailureKind =
  /** This app could not be synced; others can still be tried. */
  | 'failed'
  /** Another sync of this app is already running. */
  | 'busy'
  /** The workspace sync limit is reached; every further sync would be refused too. */
  | 'limited'
  /** The server cannot be reached or the session ended; stop. */
  | 'abort';

export type SyncFailure = {
  kind: SyncFailureKind;
  code: string;
  message: string;
  retryAfterSeconds: number | null;
};

export function classifySyncError(error: unknown): SyncFailure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'failed',
      code: 'error',
      message: t('common:error.genericRetry'),
      retryAfterSeconds: null,
    };
  }
  const message = appErrorMessage(error, 'sync');
  const retryAfterSeconds = retrySeconds(error);
  let kind: SyncFailureKind = 'failed';
  if (error.code === 'sync_in_progress') kind = 'busy';
  else if (error.code === 'rate_limited' && !error.body.app) kind = 'limited';
  else if (error.status === 0 || error.status === 401) kind = 'abort';
  return { kind, code: error.code, message, retryAfterSeconds };
}

export type SyncOutcome =
  | { ok: true; app: AppSummary; releases: ReleaseSummary[]; sync: SyncSummary }
  | { ok: false; failure: SyncFailure; app: AppSummary | null };

/** Syncs one app and turns every way it can fail into a value, so a loop over apps never throws. */
export async function syncApp(
  api: Pick<Api, 'syncApp'>,
  workspaceId: string,
  id: string,
): Promise<SyncOutcome> {
  try {
    const result = await api.syncApp(workspaceId, id);
    return { ok: true, app: result.app, releases: result.releases, sync: result.sync };
  } catch (error) {
    return {
      ok: false,
      failure: classifySyncError(error),
      app: error instanceof ApiError ? appFromError(error) : null,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Adding an app

export type CredentialKind = 'app_store_connect' | 'google_play';

export const credentialKindFor = (platform: Platform): CredentialKind =>
  platformMeta(platform).credentialKind;

/** The credentials that can read this platform's store. */
export function credentialsFor<T extends { kind: string }>(
  platform: Platform,
  credentials: readonly T[],
): T[] {
  const kind = credentialKindFor(platform);
  return credentials.filter((c) => c.kind === kind);
}

export const identifierLabel = (platform: Platform): string =>
  t(
    byFamily(platform, {
      apple: k('portfolio:identifier.bundleId'),
      google: k('portfolio:identifier.packageName'),
    }),
  );

/** The header of the column that holds the builds of a release: "Build" on Apple, "Version codes" on Google Play. */
export const buildColumnLabel = (platform: Platform): string =>
  t(
    byFamily(platform, {
      apple: k('portfolio:release.build'),
      google: k('portfolio:release.versionCodes'),
    }),
  );

/** "Copy the bundle ID" / "Copy the package name": the label of the copy button beside an identifier. */
export const copyIdentifierLabel = (platform: Platform): string =>
  t(
    byFamily(platform, {
      apple: k('portfolio:identifier.copyBundleId'),
      google: k('portfolio:identifier.copyPackageName'),
    }),
  );

const IDENTIFIER_HINTS: Readonly<Record<Platform, string>> = {
  ios: k('portfolio:identifier.hint.ios'),
  macos: k('portfolio:identifier.hint.macos'),
  android: k('portfolio:identifier.hint.android'),
};

export const identifierHint = (platform: Platform): string => t(IDENTIFIER_HINTS[platform]);

const BUNDLE_ID = /^[A-Za-z0-9.-]+$/;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_IDENTIFIER = 155;
const MAX_NAME = 100;

export type AppDraft = {
  platform: Platform;
  identifier: string;
  credentialId: string;
  name: string;
  repositoryId: string;
};

export type DraftField = 'identifier' | 'credentialId' | 'name' | 'repositoryId';
export type DraftProblems = Partial<Record<DraftField, string>>;

/** The same rules the server applies, so most mistakes are caught before the request. */
export function validateDraft(
  draft: AppDraft,
): { ok: true; input: NewApp } | { ok: false; problems: DraftProblems } {
  const problems: DraftProblems = {};
  const identifier = draft.identifier.trim();
  const name = draft.name.trim();

  if (identifier === '') {
    problems.identifier = t(
      byFamily(draft.platform, {
        apple: k('portfolio:draft.identifierRequiredBundle'),
        google: k('portfolio:draft.identifierRequiredPackage'),
      }),
    );
  } else if (identifier.length > MAX_IDENTIFIER) {
    problems.identifier = t('portfolio:draft.tooLong', { count: MAX_IDENTIFIER });
  } else if (supports(draft.platform, 'bundleIdentifier') && !BUNDLE_ID.test(identifier)) {
    problems.identifier = t('portfolio:draft.bundleInvalid');
  } else if (supports(draft.platform, 'releaseTracks') && !PACKAGE_NAME.test(identifier)) {
    problems.identifier = t('portfolio:draft.packageInvalid');
  }
  if (!draft.credentialId) problems.credentialId = t('portfolio:draft.credentialRequired');
  if (name.length > MAX_NAME) problems.name = t('portfolio:draft.tooLong', { count: MAX_NAME });
  else if (/[\r\n]/.test(name)) problems.name = t('portfolio:draft.nameOneLine');

  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const input: NewApp = { platform: draft.platform, identifier, credentialId: draft.credentialId };
  if (name) input.name = name;
  if (draft.repositoryId) input.repositoryId = draft.repositoryId;
  return { ok: true, input };
}

/** Which field a refusal from the create call is about, so the message shows beside it. */
export function addProblem(error: ErrorLike): { field: DraftField | 'form'; message: string } {
  const message = appErrorMessage(error, 'add');
  switch (error.code) {
    case 'credential_not_found':
    case 'credential_kind':
      return { field: 'credentialId', message };
    case 'repository_not_found':
      return { field: 'repositoryId', message };
    case 'already_exists':
      return { field: 'identifier', message };
    case 'invalid_request': {
      const issues = error.body?.issues;
      const first = Array.isArray(issues)
        ? (issues[0] as { path?: unknown; message?: unknown } | undefined)
        : undefined;
      const path = asText(first?.path);
      const text = asText(first?.message);
      if (
        text &&
        (path === 'identifier' ||
          path === 'name' ||
          path === 'credentialId' ||
          path === 'repositoryId')
      ) {
        return { field: path, message: text };
      }
      return { field: 'form', message };
    }
    default:
      return { field: 'form', message };
  }
}

/** Like `appErrorMessage`, for anything that was thrown. */
export function describeError(error: unknown, context: AppErrorContext = 'load'): string {
  return error instanceof ApiError
    ? appErrorMessage(error, context)
    : t('common:error.genericRetry');
}

// ---------------------------------------------------------------------------------------------
// Loading and syncing many apps

/** The releases of one app on the list screen, which load after the list itself. */
export type ReleaseLoad =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; releases: ReleaseSummary[] };

/** Runs `task` for every item with at most `limit` running at once. `task` must not throw. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export type BatchStatus = 'pending' | 'running' | 'ok' | 'failed' | 'busy' | 'skipped';

/** The outcome of one app in a "Sync all" run. `message` says what happened, or why it did not run. */
export type BatchResult = { appId: string; name: string; status: BatchStatus; message: string };

/** "Synced 3 of 5 apps. 1 failed, 1 not run." */
export function batchSummary(results: readonly BatchResult[]): string {
  const count = (status: BatchStatus) => results.filter((r) => r.status === status).length;
  const total = results.length;
  const parts = [
    count('failed') > 0 ? t('portfolio:batch.failed', { count: count('failed') }) : '',
    count('busy') > 0 ? t('portfolio:batch.busy', { count: count('busy') }) : '',
    count('skipped') > 0 ? t('portfolio:batch.skipped', { count: count('skipped') }) : '',
  ].filter(Boolean);
  return parts.length > 0
    ? t('portfolio:batch.summaryIssues', { ok: count('ok'), count: total, issues: formatList(parts, { type: 'unit' }) })
    : t('portfolio:batch.summary', { ok: count('ok'), count: total });
}

/** What to say for the apps a stopped run never reached. */
export function notRunMessage(failure: SyncFailure | null): string {
  return failure
    ? t('portfolio:batch.notRunFailure', { reason: failure.message })
    : t('portfolio:batch.notRunStopped');
}

// ---------------------------------------------------------------------------------------------
// Finding and importing apps with a credential

/** Most package names one Google Play check takes, and most apps one import request takes. */
export const MAX_PACKAGES = 50;
export const MAX_IMPORT_BATCH = 50;

const isPackageName = (value: string) => value.length <= 255 && PACKAGE_NAME.test(value);

/** True for the credentials that can find apps: App Store Connect and Google Play. */
export const isDiscoverableKind = (kind: string): kind is CredentialKind =>
  kind === 'app_store_connect' || kind === 'google_play';

export const discoverableCredentials = <T extends { kind: string }>(
  credentials: readonly T[],
): T[] => credentials.filter((c) => isDiscoverableKind(c.kind));

export const platformForKind = (kind: CredentialKind): Platform =>
  kind === 'app_store_connect' ? 'ios' : 'android';

export type PackageList = {
  /** The valid package names, in the order given, each once. */
  packages: string[];
  /** Entries that are not package names, with the line (counted from 1) they are on. */
  invalid: { line: number; value: string }[];
  /** How many repeats were dropped. */
  duplicates: number;
};

/** Reads a pasted list: one package name per line (commas and spaces also separate). */
export function parsePackageList(text: string): PackageList {
  const packages: string[] = [];
  const invalid: PackageList['invalid'] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const value of line.split(/[\s,;]+/)) {
      if (value === '') continue;
      if (!isPackageName(value)) invalid.push({ line: index + 1, value });
      else if (seen.has(value)) duplicates += 1;
      else {
        seen.add(value);
        packages.push(value);
      }
    }
  });
  return { packages, invalid, duplicates };
}

/** What is wrong with a package list, in a sentence, or '' when it can be checked. */
export function packageListProblem(list: PackageList): string {
  const first = list.invalid[0];
  if (first) {
    const shown = first.value.length > 40 ? `${first.value.slice(0, 40)}…` : first.value;
    return list.invalid.length > 1
      ? t('portfolio:packages.invalidMore', { line: first.line, value: shown, count: list.invalid.length - 1 })
      : t('portfolio:packages.invalid', { line: first.line, value: shown });
  }
  if (list.packages.length === 0) return t('portfolio:packages.none');
  if (list.packages.length > MAX_PACKAGES)
    return t('portfolio:packages.tooMany', { max: MAX_PACKAGES, count: list.packages.length });
  return '';
}

/**
 * The key an app is known by: the platform and the identifier, never the identifier alone. A bundle
 * id equal to a package name is an iOS app and an Android app. iOS bundle ids are not case
 * sensitive, package names are.
 */
export const candidateKey = (c: Pick<DiscoverCandidate, 'platform' | 'identifier'>): string =>
  `${c.platform}:${supports(c.platform, 'bundleIdentifier') ? c.identifier.toLowerCase() : c.identifier}`;

/** "1 iOS app", "2 Android apps". */
export const platformCount = (platform: Platform, count: number): string =>
  t('portfolio:platform.count', { count, platform: platformLabel(platform) });

/** What a credential adds: one platform. Shown before importing, so nobody expects both. */
export function importScopeNote(platform: Platform): string {
  if (supports(platform, 'bundleIdentifier')) {
    return t('portfolio:import.scopeApple');
  }
  return t('portfolio:import.scopeOther', { platform: platformLabel(platform) });
}

/** The candidates that can still be added. */
export const selectableCandidates = (
  candidates: readonly DiscoverCandidate[],
): DiscoverCandidate[] => candidates.filter((c) => !c.alreadyAdded);

/** The selection with `key` switched on or off. A new set, so the screen sees the change. */
export function withSelection(
  selected: ReadonlySet<string>,
  key: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** "Found 5 apps. 2 are already added." / "Checked 3 packages: 2 found, 1 could not be verified." */
export function discoverSummaryText(
  result: Pick<DiscoverResult, 'kind' | 'candidates' | 'failures'>,
): string {
  const added = result.candidates.filter((c) => c.alreadyAdded).length;
  const withAdded = (summary: string) =>
    added > 0 ? t('portfolio:discover.withAdded', { summary, added }) : summary;
  if (result.kind === 'google_play') {
    const total = result.candidates.length + result.failures.length;
    const verified = result.candidates.length;
    return withAdded(
      result.failures.length > 0
        ? t('portfolio:discover.playCheckedFailed', { count: total, verified, failed: result.failures.length })
        : t('portfolio:discover.playChecked', { count: total, verified }),
    );
  }
  if (result.candidates.length === 0) return t('portfolio:discover.noApps');
  return withAdded(t('portfolio:discover.found', { count: result.candidates.length }));
}

/** Why one Google Play package could not be verified, as a sentence a person can act on. */
export function discoverFailureMessage(
  failure: Pick<DiscoverFailure, 'error' | 'message'>,
): string {
  switch (failure.error) {
    case 'store_not_found':
      return t('portfolio:discoverFailure.storeNotFound');
    case 'store_forbidden':
      return t('portfolio:discoverFailure.storeForbidden');
    case 'store_auth':
      return t('portfolio:discoverFailure.storeAuth');
    case 'rate_limited':
      return t('portfolio:discoverFailure.rateLimited');
    case 'timeout':
      return t('portfolio:discoverFailure.timeout');
    case 'store_unavailable':
      return t('portfolio:discoverFailure.storeUnavailable');
    case 'discover_failed':
      return t('portfolio:discoverFailure.discoverFailed');
    default:
      return failure.message.trim() || t('portfolio:discoverFailure.default');
  }
}

/** The import items for the selected candidates. `repositories` maps a candidate key to a repository id. */
export function buildImportItems(
  candidates: readonly DiscoverCandidate[],
  selected: ReadonlySet<string>,
  repositories: Readonly<Record<string, string | undefined>> = {},
): ImportItem[] {
  const items: ImportItem[] = [];
  for (const c of selectableCandidates(candidates)) {
    const key = candidateKey(c);
    if (!selected.has(key)) continue;
    const item: ImportItem = {
      platform: c.platform,
      identifier: c.identifier,
      storeAppId: c.storeId,
    };
    if (c.name.trim()) item.name = c.name.trim().slice(0, 100);
    const repositoryId = repositories[key];
    if (repositoryId) item.repositoryId = repositoryId;
    items.push(item);
  }
  return items;
}

/** Splits a list into pieces of at most `size`, in order. */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const pieces: T[][] = [];
  for (let i = 0; i < list.length; i += size) pieces.push(list.slice(i, i + size));
  return pieces;
}

/** Joins the answers of several import requests into one. */
export function mergeImports(parts: readonly ImportResult[]): ImportResult {
  const results: ImportItemResult[] = [];
  for (const part of parts) results.push(...part.results);
  const count = (status: ImportItemResult['status']) =>
    results.filter((r) => r.status === status).length;
  return {
    results,
    summary: { created: count('created'), skipped: count('skipped'), failed: count('failed') },
  };
}

/**
 * "Added 3 apps. 1 was already added, 2 could not be added." With the items, the platform is named
 * when the created apps are all of one platform ("Added 1 iOS app."), or counted per platform.
 */
export function importSummaryText(
  summary: ImportSummary,
  results?: readonly Pick<ImportItemResult, 'platform' | 'status'>[],
): string {
  const rest = [
    summary.skipped > 0 ? t('portfolio:import.skipped', { count: summary.skipped }) : '',
    summary.failed > 0 ? t('portfolio:import.failed', { count: summary.failed }) : '',
  ].filter(Boolean);
  const created = (results ?? []).filter((r) => r.status === 'created');
  const platforms = [...new Set(created.map((r) => r.platform))].sort();
  let what = t('portfolio:import.appCount', { count: summary.created });
  if (created.length === summary.created && platforms.length > 0) {
    what = formatList(
      platforms.map((p) => platformCount(p, created.filter((r) => r.platform === p).length)),
      { style: 'long', type: 'conjunction' },
    );
  }
  const joined = formatList(rest, { type: 'unit' });
  if (summary.created > 0) {
    return rest.length > 0
      ? t('portfolio:import.addedWithRest', { what, rest: joined })
      : t('portfolio:import.added', { what });
  }
  return rest.length > 0 ? t('portfolio:import.noneWithRest', { rest: joined }) : t('portfolio:import.none');
}

/** What to say about one item of an import that did not create an app. */
export function importItemMessage(
  result: Pick<ImportItemResult, 'status' | 'error' | 'message'>,
): string {
  if (result.status === 'skipped') return t('portfolio:import.alreadyInWorkspace');
  if (result.status === 'failed') {
    return appErrorMessage(
      {
        status: 422,
        code: result.error ?? 'error',
        message: result.message ?? '',
        body: { message: result.message },
      },
      'import',
    );
  }
  return '';
}

/** The apps an import created, in order. */
export function importedApps(result: ImportResult): AppSummary[] {
  const apps: AppSummary[] = [];
  for (const r of result.results) if (r.status === 'created' && r.app) apps.push(r.app);
  return apps;
}

/**
 * Syncs apps one after another (as "Sync all" does). A workspace rate limit or a lost connection
 * ends the run and the apps not reached say why. `onProgress` is called before each app and after
 * every result, with copies it may keep.
 */
export async function syncApps(
  api: Pick<Api, 'syncApp'>,
  workspaceId: string,
  apps: readonly (Pick<AppSummary, 'id' | 'name'> & { platform?: Platform })[],
  onProgress?: (results: readonly BatchResult[], current: string) => void,
): Promise<BatchResult[]> {
  // With a platform, the name carries it: the same app on iOS and Android shares name and identifier.
  const labelOf = (a: { name: string; platform?: Platform | undefined }) =>
    a.platform === undefined ? a.name : appLabel({ name: a.name, platform: a.platform });
  const results: BatchResult[] = apps.map((a) => ({
    appId: a.id,
    name: labelOf(a),
    status: 'pending',
    message: '',
  }));
  const report = (current: string) =>
    onProgress?.(
      results.map((r) => ({ ...r })),
      current,
    );
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i] as Pick<AppSummary, 'id' | 'name'> & { platform?: Platform };
    const result = results[i] as BatchResult;
    result.status = 'running';
    report(labelOf(app));
    const outcome = await syncApp(api, workspaceId, app.id);
    if (outcome.ok) {
      result.status = 'ok';
      result.message = syncDetail(outcome.sync);
      report('');
      continue;
    }
    result.status = outcome.failure.kind === 'busy' ? 'busy' : 'failed';
    result.message = outcome.failure.message;
    if (outcome.failure.kind === 'limited' || outcome.failure.kind === 'abort') {
      for (let j = i + 1; j < results.length; j++) {
        const rest = results[j] as BatchResult;
        rest.status = 'skipped';
        rest.message = notRunMessage(outcome.failure);
      }
      report('');
      break;
    }
    report('');
  }
  return results;
}
