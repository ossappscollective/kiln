import { type Platform, type ReleaseEvent, type ReleaseState, transition } from '@mrm/core';
import { type Api, ApiError } from './api.ts';
import { timeAgo } from './format.ts';
import type { AppSummary, NewApp, ReleaseSummary, SyncSummary } from './types.ts';

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

export const platformLabel = (platform: Platform) => (platform === 'ios' ? 'iOS' : 'Android');

export const storeName = (platform: Platform) => (platform === 'ios' ? 'App Store' : 'Google Play');

const TRACKS: Record<string, string> = {
  production: 'Production',
  beta: 'Open testing (beta)',
  alpha: 'Closed testing (alpha)',
  internal: 'Internal testing',
};

/** The Play track as a person reads it. `null` (iOS) is the App Store. */
export function trackLabel(track: string | null): string {
  if (track === null) return 'App Store';
  return TRACKS[track] ?? track;
}

export type StatusInfo = { label: string; tone: BadgeTone; description: string };

const STATUS: Record<ReleaseState, StatusInfo> = {
  draft: { label: 'Draft', tone: 'neutral', description: 'Being prepared. No build is chosen yet.' },
  build_chosen: { label: 'Build chosen', tone: 'neutral', description: 'A build is attached. It is not ready to submit yet.' },
  ready: { label: 'Ready', tone: 'info', description: 'Ready to submit for review.' },
  in_review: { label: 'In review', tone: 'info', description: 'Waiting for the store to review it.' },
  rejected: { label: 'Rejected', tone: 'bad', description: 'The store rejected it. A fix is needed before it can go out.' },
  approved: { label: 'Approved', tone: 'accent', description: 'Approved and waiting to be released.' },
  propagating: { label: 'Propagating', tone: 'info', description: 'Released, but not yet visible in the store.' },
  rolling_out: { label: 'Rolling out', tone: 'info', description: 'Going out to users in stages.' },
  live: { label: 'Live', tone: 'ok', description: 'Available to users.' },
  halted: { label: 'Halted', tone: 'warn', description: 'The rollout was stopped.' },
};

/** The label, tone and a sentence for a normalized status. `null` means the store state has no mapping. */
export function statusInfo(status: ReleaseState | null | undefined, rawState?: string | null): StatusInfo {
  if (status) return STATUS[status];
  return {
    label: 'Unmapped',
    tone: 'neutral',
    description: rawState
      ? `The store reports “${rawState}”, which has no normalized status.`
      : 'The store state has no normalized status.',
  };
}

/** "20%", "0.5%", or null when the store reports no staged rollout. */
export function formatRollout(fraction: number | null | undefined): string | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null;
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
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
export function latestRelease(releases: readonly ReleaseSummary[], platform?: Platform): ReleaseSummary | null {
  const pool = platform ? releases.filter((r) => r.platform === platform) : releases;
  return sortReleases(pool)[0] ?? null;
}

/** The newest release of each platform that has one. */
export function latestByPlatform(releases: readonly ReleaseSummary[]): Partial<Record<Platform, ReleaseSummary>> {
  const result: Partial<Record<Platform, ReleaseSummary>> = {};
  for (const platform of ['ios', 'android'] as const) {
    const release = latestRelease(releases, platform);
    if (release) result[platform] = release;
  }
  return result;
}

/** The newest release that is fully live. Used to show what users have while a newer one is in progress. */
export function liveRelease(releases: readonly ReleaseSummary[], platform?: Platform): ReleaseSummary | null {
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
      title: latest.track === null ? `${platformLabel(latest.platform)} · ${storeName(latest.platform)}` : `${platformLabel(latest.platform)} · ${trackLabel(latest.track)}`,
      releases: list,
      latest,
    });
  }
  return result.sort(
    (a, b) => (a.platform === b.platform ? 0 : a.platform === 'ios' ? -1 : 1) || compareTracks(a.track, b.track),
  );
}

// ---------------------------------------------------------------------------------------------
// The lifecycle timeline, walked from the state machine in @mrm/core

const FORWARD: readonly ReleaseEvent[] = ['choose_build', 'mark_ready', 'submit', 'approve', 'release', 'propagated', 'complete'];

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
  const anchor: ReleaseState = status === 'rejected' ? 'in_review' : status === 'halted' ? 'rolling_out' : status;
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
    if (a.platform !== b.platform) return a.platform === 'ios' ? -1 : 1;
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
export function syncInfo(app: Pick<AppSummary, 'lastSyncedAt' | 'lastSyncAttemptAt' | 'lastSyncError'>, now: number = Date.now(), locale?: string): SyncInfo {
  const label = app.lastSyncedAt === null ? 'Never synced' : `Synced ${timeAgo(app.lastSyncedAt, now, locale)}`;
  const error = app.lastSyncError?.trim() ? app.lastSyncError.trim() : null;
  if (error) {
    const attempt = app.lastSyncAttemptAt === null ? null : `Last attempt ${timeAgo(app.lastSyncAttemptAt, now, locale)}`;
    return { kind: 'failed', label, error, attempt };
  }
  return { kind: app.lastSyncedAt === null ? 'never' : 'ok', label, error: null, attempt: null };
}

/** What a successful sync found: "3 releases, 1 added, 1 updated." */
export function syncDetail(sync: SyncSummary): string {
  if (sync.found === 0) return 'The store reported no releases.';
  const parts = [
    sync.added > 0 ? `${sync.added} added` : '',
    sync.updated > 0 ? `${sync.updated} updated` : '',
    sync.removed > 0 ? `${sync.removed} removed` : '',
  ].filter(Boolean);
  const changes = parts.length > 0 ? parts.join(', ') : 'no changes';
  const unmapped = sync.unmapped > 0 ? ` ${sync.unmapped} with a state that has no normalized status.` : '';
  return `${sync.found} release${sync.found === 1 ? '' : 's'}, ${changes}.${unmapped}`;
}

/** A sentence for a screen reader and a toast: what a successful sync found. */
export function syncSummaryText(name: string, sync: SyncSummary): string {
  return sync.found === 0 ? `Synced ${name}. ${syncDetail(sync)}` : `Synced ${name}: ${syncDetail(sync)}`;
}

// ---------------------------------------------------------------------------------------------
// Errors

/** "30 seconds", "1 minute", "10 minutes", rounded up. */
function waitPhrase(seconds: number): string {
  if (seconds < 60) {
    const n = Math.max(1, Math.ceil(seconds));
    return `${n} second${n === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export type AppErrorContext = 'load' | 'add' | 'sync' | 'delete';

type ErrorLike = Pick<ApiError, 'status' | 'code' | 'message'> & Partial<Pick<ApiError, 'retryAfter' | 'body'>>;

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
  return typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.platform === 'string'
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
      return 'That app is not in this workspace any more. It may have been removed.';
    case 'already_exists':
      return 'This workspace already has an app with that identifier on this platform.';
    case 'credential_not_found':
      return context === 'add'
        ? 'That credential no longer exists. Pick another one.'
        : 'The credential this app uses was deleted. Add a new credential, then add the app again.';
    case 'credential_kind':
      return asText(error.body?.message) || 'iOS needs an App Store Connect credential and Android a Google Play one.';
    case 'repository_not_found':
      return 'That repository is not connected to this workspace. Pick another one or leave it empty.';
    case 'sync_in_progress':
      return 'A sync of this app is already running. Wait for it to finish, then refresh.';
    case 'credential_unreadable':
      return 'The stored secret cannot be read. Replace the secret of its credential on the Credentials screen.';
    case 'store_auth':
      return 'The store rejected the key. Check the key and the issuer, and that this server’s clock is right, or replace the secret on the Credentials screen.';
    case 'store_forbidden':
      return 'The key is valid but has no access. Check its role, that the app is shared with it, and that the store API is enabled.';
    case 'store_not_found':
      return 'The store has no app with this identifier for this key. Check the identifier and the credential.';
    case 'rate_limited': {
      const when = wait === null ? 'a minute' : waitPhrase(wait);
      // The workspace limit answers without an app; the store's own limit comes with one.
      return error.body?.app
        ? `The store asked us to slow down. Try again in ${when}.`
        : `This workspace has run too many syncs (the limit is 10 a minute). Try again in ${when}.`;
    }
    case 'store_unavailable':
      return 'The store failed to answer properly. Try again in a moment.';
    case 'timeout':
      return 'The store did not answer in time. Try again.';
    case 'sync_failed':
      return 'The sync failed and the server has no more detail. Try again; if it keeps failing, check the server log.';
    default:
      return error.message || (context === 'sync' ? 'Could not sync the app.' : 'Something went wrong. Try again.');
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
    return { kind: 'failed', code: 'error', message: 'Something went wrong. Try again.', retryAfterSeconds: null };
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
export async function syncApp(api: Pick<Api, 'syncApp'>, workspaceId: string, id: string): Promise<SyncOutcome> {
  try {
    const result = await api.syncApp(workspaceId, id);
    return { ok: true, app: result.app, releases: result.releases, sync: result.sync };
  } catch (error) {
    return { ok: false, failure: classifySyncError(error), app: error instanceof ApiError ? appFromError(error) : null };
  }
}

// ---------------------------------------------------------------------------------------------
// Adding an app

export type CredentialKind = 'app_store_connect' | 'google_play';

export const credentialKindFor = (platform: Platform): CredentialKind =>
  platform === 'ios' ? 'app_store_connect' : 'google_play';

/** The credentials that can read this platform's store. */
export function credentialsFor<T extends { kind: string }>(platform: Platform, credentials: readonly T[]): T[] {
  const kind = credentialKindFor(platform);
  return credentials.filter((c) => c.kind === kind);
}

export const identifierLabel = (platform: Platform) => (platform === 'ios' ? 'Bundle ID' : 'Package name');

export const identifierHint = (platform: Platform) =>
  platform === 'ios'
    ? 'The bundle ID from App Store Connect, such as com.acme.app.'
    : 'The package name from the Play Console, such as com.acme.app.';

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
export function validateDraft(draft: AppDraft): { ok: true; input: NewApp } | { ok: false; problems: DraftProblems } {
  const problems: DraftProblems = {};
  const identifier = draft.identifier.trim();
  const name = draft.name.trim();

  if (identifier === '') {
    problems.identifier = `Enter the ${identifierLabel(draft.platform).toLowerCase()}.`;
  } else if (identifier.length > MAX_IDENTIFIER) {
    problems.identifier = `Use at most ${MAX_IDENTIFIER} characters.`;
  } else if (draft.platform === 'ios' && !BUNDLE_ID.test(identifier)) {
    problems.identifier = 'A bundle ID has only letters, digits, dots and hyphens, such as com.acme.app.';
  } else if (draft.platform === 'android' && !PACKAGE_NAME.test(identifier)) {
    problems.identifier = 'A package name has at least two parts separated by dots, such as com.acme.app. Each part starts with a letter.';
  }
  if (!draft.credentialId) problems.credentialId = 'Choose the credential that can read this app in the store.';
  if (name.length > MAX_NAME) problems.name = `Use at most ${MAX_NAME} characters.`;
  else if (/[\r\n]/.test(name)) problems.name = 'The name must be on one line.';

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
      const first = Array.isArray(issues) ? (issues[0] as { path?: unknown; message?: unknown } | undefined) : undefined;
      const path = asText(first?.path);
      const text = asText(first?.message);
      if (text && (path === 'identifier' || path === 'name' || path === 'credentialId' || path === 'repositoryId')) {
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
  return error instanceof ApiError ? appErrorMessage(error, context) : 'Something went wrong. Try again.';
}

// ---------------------------------------------------------------------------------------------
// Loading and syncing many apps

/** The releases of one app on the list screen, which load after the list itself. */
export type ReleaseLoad = { state: 'loading' } | { state: 'error' } | { state: 'ready'; releases: ReleaseSummary[] };

/** Runs `task` for every item with at most `limit` running at once. `task` must not throw. */
export async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
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
    count('failed') > 0 ? `${count('failed')} failed` : '',
    count('busy') > 0 ? `${count('busy')} already syncing` : '',
    count('skipped') > 0 ? `${count('skipped')} not run` : '',
  ].filter(Boolean);
  return `Synced ${count('ok')} of ${total} app${total === 1 ? '' : 's'}.${parts.length > 0 ? ` ${parts.join(', ')}.` : ''}`;
}

/** What to say for the apps a stopped run never reached. */
export function notRunMessage(failure: SyncFailure | null): string {
  return failure ? `Not run: ${failure.message}` : 'Not run: you stopped the sync.';
}
