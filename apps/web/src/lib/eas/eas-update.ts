import { ApiError, waitPhrase } from '../api.ts';
import { timeAgo } from '../format.ts';

/**
 * Pure helpers of the "EAS Update" card (components/eas/EasUpdateCard.svelte, docs/api/eas-update.md, docs/adr/0037-eas-update.md):
 * the types of what the API answers, the tone and sentence of each runtime check, the lines of a channel, an update and its insights,
 * the check of a new rollout share, and the sentence for each error code. Written for the ES2017 web build.
 */

export type EasUpdateRow = {
  id: string;
  group: string;
  message: string | null;
  createdAt: number | null;
  platform: string;
  runtimeVersion: string | null;
  gitCommitHash: string | null;
  isRollBackToEmbedded: boolean;
  /** Mid-rollout: 1 to 99; null otherwise. */
  rolloutPercentage: number | null;
  rolloutControlGroup: string | null;
};

export type RuntimeCheckStatus = 'ok' | 'mismatch' | 'newest_build_unreached' | 'no_updates' | 'no_builds' | 'unknown';
export type RuntimeSeverity = 'error' | 'warning' | 'info' | 'none';

export type RuntimeCheck = {
  channel: string;
  status: RuntimeCheckStatus;
  severity: RuntimeSeverity;
  latestUpdate: { runtimeVersion: string | null; group: string; branch: string; createdAt: number | null } | null;
  latestBuild: {
    id: string;
    runtimeVersion: string | null;
    appVersion: string | null;
    appBuildVersion: string | null;
    createdAt: number | null;
  } | null;
  shippedRuntimeVersions: string[];
  message: string;
};

export type EasUpdateChannel = {
  id: string;
  name: string;
  isPaused: boolean | null;
  isProtected: boolean | null;
  updatedAt: number | null;
  mapping: {
    kind: 'none' | 'branch' | 'rollout' | 'unreadable';
    entries: { branchId: string; branchName: string | null; logic: 'always' | 'conditional'; condition: string | null }[];
  };
  branches: {
    id: string;
    name: string;
    mapped: boolean;
    groups: { group: string; updates: EasUpdateRow[] }[];
  }[];
  rollouts: {
    branch: string;
    group: string;
    updateId: string;
    runtimeVersion: string | null;
    percentage: number;
    controlGroup: string | null;
  }[];
  runtimeCheck: RuntimeCheck;
};

/** `GET /apps/{appId}/expo/updates`. */
export type EasUpdateState = {
  project: { id: string; fullName: string };
  platform: 'ios' | 'android';
  channels: EasUpdateChannel[];
  channelsTruncated: boolean;
  builds: {
    id: string;
    runtimeVersion: string | null;
    appVersion: string | null;
    appBuildVersion: string | null;
    channel: string | null;
    createdAt: number | null;
  }[];
  rolloutWriteEnabled: boolean;
  readAt: number;
};

/** `GET /apps/{appId}/expo/updates/{group}/insights`. */
export type EasUpdateInsights = {
  group: string;
  platform: 'ios' | 'android';
  days: number;
  start: number;
  end: number;
  insights: {
    updateId: string;
    platform: string;
    launches: number | null;
    failedLaunches: number | null;
    crashRatePercent: number | null;
    uniqueUsers: number | null;
    launchAssetCount: number | null;
    averagePayloadBytes: number | null;
  };
};

export type EasRolloutRequest = { group: string; percentage: number };

export type EasRolloutPreview = {
  app: { id: string; name: string; platform: string };
  project: { id: string; fullName: string };
  channel: string;
  branch: string;
  group: string;
  updateId: string;
  runtimeVersion: string | null;
  from: number;
  to: number;
  summary: string;
  irreversible: boolean;
  confirmHash: string;
  warnings: string[];
  readAt: number;
};

export type EasRolloutResult = {
  app: { id: string; name: string; platform: string };
  group: string;
  updateId: string;
  from: number;
  to: number;
  confirmedByReread: boolean;
};

// ---------------------------------------------------------------------------------------------
// The runtime version check

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export const checkTone = (check: RuntimeCheck): BadgeTone =>
  check.severity === 'error' ? 'bad' : check.severity === 'warning' ? 'warn' : check.status === 'ok' ? 'ok' : 'neutral';

export function checkLabel(status: RuntimeCheckStatus): string {
  switch (status) {
    case 'ok':
      return 'Runtime matches';
    case 'mismatch':
      return 'Reaches no shipped build';
    case 'newest_build_unreached':
      return 'Newest build gets no update';
    case 'no_updates':
      return 'No updates';
    case 'no_builds':
      return 'No store build';
    default:
      return 'Cannot compare';
  }
}

/** The channels whose newest update would not reach what was shipped (an error or a warning), errors first. */
export function channelsWithMismatch(state: EasUpdateState): EasUpdateChannel[] {
  return state.channels
    .filter((c) => c.runtimeCheck.severity === 'error' || c.runtimeCheck.severity === 'warning')
    .sort((a, b) => (a.runtimeCheck.severity === 'error' ? 0 : 1) - (b.runtimeCheck.severity === 'error' ? 0 : 1));
}

/** The one line of the collapsed card. */
export function updateSummary(state: EasUpdateState | null, loading: boolean): string {
  if (state === null) return loading ? 'Reading from Expo' : 'Not read yet';
  const n = state.channels.length;
  const channels = `${n} ${n === 1 ? 'channel' : 'channels'}`;
  const bad = channelsWithMismatch(state).length;
  const rollouts = state.channels.reduce((sum, c) => sum + c.rollouts.length, 0);
  const parts = [channels];
  if (bad > 0) parts.push(`${bad} ${bad === 1 ? 'warning' : 'warnings'}`);
  if (rollouts > 0) parts.push(`${rollouts} ${rollouts === 1 ? 'rollout' : 'rollouts'}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Lines

/** Where a channel's clients get their updates from, in a sentence. */
export function mappingText(channel: EasUpdateChannel): string {
  const m = channel.mapping;
  const name = (e: { branchName: string | null; branchId: string }) => e.branchName ?? 'another branch';
  if (m.kind === 'none') return 'Points at no branch: clients get no update.';
  if (m.kind === 'unreadable') return 'The branch mapping could not be read.';
  const first = m.entries[0];
  if (m.kind === 'branch' && first) {
    return first.logic === 'always' ? `Every client gets branch ${name(first)}.` : `Branch ${name(first)} for the clients its condition selects.`;
  }
  const names = m.entries.map(name);
  const condition = m.entries.filter((e) => e.condition !== null).map((e) => e.condition);
  return `Rollout between branches ${names.join(' and ')}${condition.length > 0 ? ` (${condition.join('; ')})` : ''}.`;
}

export const shortCommit = (hash: string | null): string => (hash ? hash.slice(0, 7) : '');

/** "Fix the login button", or what the update is when it has no message. */
export function updateTitle(u: EasUpdateRow): string {
  if (u.isRollBackToEmbedded) return u.message ? `${u.message} (roll back to the embedded update)` : 'Roll back to the embedded update';
  return u.message && u.message.trim() !== '' ? u.message : 'No message';
}

/** "runtime 1.4.0 · 3 days ago · a1b2c3d". */
export function updateDetail(u: EasUpdateRow, now: number): string {
  const parts: string[] = [];
  parts.push(u.runtimeVersion ? `runtime ${u.runtimeVersion}` : 'no runtime version');
  if (u.createdAt !== null) parts.push(timeAgo(u.createdAt, now));
  const commit = shortCommit(u.gitCommitHash);
  if (commit) parts.push(commit);
  return parts.join(' · ');
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'not reported';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const formatCount = (n: number | null): string => (n === null ? 'not reported' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

export function crashRateText(rate: number | null): string {
  return rate === null ? 'no launches yet' : `${rate}%`;
}

/** The lines of the insights panel, label and text. */
export function insightLines(i: EasUpdateInsights): { label: string; text: string }[] {
  const x = i.insights;
  return [
    { label: 'Launches', text: formatCount(x.launches) },
    { label: 'Failed launches', text: formatCount(x.failedLaunches) },
    { label: 'Crash rate', text: crashRateText(x.crashRatePercent) },
    { label: 'Unique users', text: formatCount(x.uniqueUsers) },
    { label: 'Payload size', text: formatBytes(x.averagePayloadBytes) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Raising a rollout

/** The new share as typed: a whole percent above the current one and at most 100. A sentence when it is not, else the number. */
export function parseShare(text: string, current: number): { ok: true; percentage: number } | { ok: false; message: string } {
  const value = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}$/.test(value)) return { ok: false, message: 'Enter a whole percent, such as 50.' };
  const percentage = Number(value);
  if (percentage > 100) return { ok: false, message: 'A share cannot be more than 100%.' };
  if (percentage <= current) return { ok: false, message: `The rollout is at ${current}%. It can only be raised here.` };
  return { ok: true, percentage };
}

export type RolloutFailure = { kind: 'changed' | 'unknown' | 'off' | 'other'; message: string };

/** What a failed preview or apply means for the dialog. */
export function rolloutFailure(error: unknown): RolloutFailure {
  if (!(error instanceof ApiError)) return { kind: 'other', message: 'Something went wrong. Nothing was confirmed as changed; read the state again.' };
  switch (error.code) {
    case 'eas_update_write_disabled':
      return { kind: 'off', message: 'Raising a rollout is switched off on this server (MRM_EAS_UPDATE_ROLLOUT_ENABLED).' };
    case 'state_changed':
      return { kind: 'changed', message: 'The rollout changed at Expo since it was previewed. Nothing was changed. Review the new state and preview again.' };
    case 'rollout_not_found':
      return { kind: 'changed', message: 'That update is no longer mid-rollout. Read the state again.' };
    case 'rollout_not_raised':
      return { kind: 'other', message: 'The share can only be raised here. Lowering or reverting a rollout needs the Expo CLI.' };
    case 'write_failed':
      return { kind: 'other', message: 'Expo did not apply the change. The rollout is as before.' };
    case 'outcome_unknown':
      return { kind: 'unknown', message: 'Expo did not answer and the result could not be read back. Check the rollout in Expo, then read the state again before trying anything.' };
    case 'write_in_progress':
      return { kind: 'other', message: 'A change of this rollout is already in progress. Wait for it to finish.' };
    default:
      return { kind: 'other', message: easUpdateErrorText(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what a read of EAS Update said. */
export function easUpdateErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return 'Your role does not allow that.';
    case 'not_found':
      return 'That app no longer exists. Reload the page.';
    case 'expo_not_linked':
      return 'This app is not linked to an Expo project. Link it in the app Settings.';
    case 'credential_not_found':
      return 'The Expo credential of this link was deleted. Choose another in the app Settings.';
    case 'platform_unsupported':
      return 'EAS Update has no updates for this platform.';
    case 'credential_unreadable':
      return 'The Expo credential could not be decrypted. Enter its token again under Credentials.';
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
    case 'invalid_group':
    case 'invalid_days':
      return own || 'Expo could not be asked. Try again in a moment.';
    case 'rate_limited':
      return `Too many requests. Try again in ${waitPhrase(error.retryAfter ?? 60)}.`;
    case 'timeout':
      return 'Expo took too long to answer. Try again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : error.message;
  }
}

/** "Read from Expo 2 minutes ago." */
export const readCaption = (state: EasUpdateState, now: number): string => `Read from Expo ${timeAgo(state.readAt, now)}.`;
