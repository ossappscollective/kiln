import { ApiError } from '../api.ts';
import { formatBytes as formatByteSize, formatList, formatNumber, formatPercent, formatRelativeTime } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { waitText } from './eas.ts';

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

const CHECK_LABELS = {
  ok: k('eas:update.check.ok'),
  mismatch: k('eas:update.check.mismatch'),
  newest_build_unreached: k('eas:update.check.newestBuildUnreached'),
  no_updates: k('eas:update.check.noUpdates'),
  no_builds: k('eas:update.check.noBuilds'),
  unknown: k('eas:update.check.unknown'),
} as const;

export function checkLabel(status: RuntimeCheckStatus): string {
  const key = CHECK_LABELS[status] ?? CHECK_LABELS.unknown;
  return t(key);
}

/** The channels whose newest update would not reach what was shipped (an error or a warning), errors first. */
export function channelsWithMismatch(state: EasUpdateState): EasUpdateChannel[] {
  return state.channels
    .filter((c) => c.runtimeCheck.severity === 'error' || c.runtimeCheck.severity === 'warning')
    .sort((a, b) => (a.runtimeCheck.severity === 'error' ? 0 : 1) - (b.runtimeCheck.severity === 'error' ? 0 : 1));
}

/** The one line of the collapsed card. */
export function updateSummary(state: EasUpdateState | null, loading: boolean): string {
  if (state === null) return loading ? t('eas:update.summary.loading') : t('eas:update.summary.notRead');
  const bad = channelsWithMismatch(state).length;
  const rollouts = state.channels.reduce((sum, c) => sum + c.rollouts.length, 0);
  const parts = [t('eas:update.summary.channels', { count: state.channels.length })];
  if (bad > 0) parts.push(t('eas:update.summary.warnings', { count: bad }));
  if (rollouts > 0) parts.push(t('eas:update.summary.rollouts', { count: rollouts }));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Lines

/** Where a channel's clients get their updates from, in a sentence. */
export function mappingText(channel: EasUpdateChannel): string {
  const m = channel.mapping;
  const name = (e: { branchName: string | null; branchId: string }) => e.branchName ?? t('eas:update.mapping.otherBranch');
  if (m.kind === 'none') return t('eas:update.mapping.none');
  if (m.kind === 'unreadable') return t('eas:update.mapping.unreadable');
  const first = m.entries[0];
  if (m.kind === 'branch' && first) {
    return first.logic === 'always'
      ? t('eas:update.mapping.always', { branch: name(first) })
      : t('eas:update.mapping.conditional', { branch: name(first) });
  }
  const branches = formatList(m.entries.map(name));
  const condition = m.entries.filter((e) => e.condition !== null).map((e) => e.condition);
  return condition.length > 0
    ? t('eas:update.mapping.rolloutCondition', { branches, condition: condition.join('; ') })
    : t('eas:update.mapping.rollout', { branches });
}

export const shortCommit = (hash: string | null): string => (hash ? hash.slice(0, 7) : '');

/** "Fix the login button", or what the update is when it has no message. */
export function updateTitle(u: EasUpdateRow): string {
  if (u.isRollBackToEmbedded) return u.message ? t('eas:update.title.rollbackMessage', { message: u.message }) : t('eas:update.title.rollback');
  return u.message && u.message.trim() !== '' ? u.message : t('eas:update.title.none');
}

/** "runtime 1.4.0 · 3 days ago · a1b2c3d". */
export function updateDetail(u: EasUpdateRow, now: number): string {
  const parts: string[] = [];
  parts.push(u.runtimeVersion ? t('eas:update.detail.runtime', { version: u.runtimeVersion }) : t('eas:update.detail.noRuntime'));
  if (u.createdAt !== null) parts.push(formatRelativeTime(u.createdAt, { now }));
  const commit = shortCommit(u.gitCommitHash);
  if (commit) parts.push(commit);
  return parts.join(' · ');
}

export function formatBytes(bytes: number | null): string {
  return bytes === null ? t('eas:update.notReported') : formatByteSize(bytes);
}

export const formatCount = (n: number | null): string => (n === null ? t('eas:update.notReported') : formatNumber(Math.round(n)));

export function crashRateText(rate: number | null): string {
  return rate === null ? t('eas:update.noLaunches') : formatPercent(rate / 100, { maximumFractionDigits: 2 });
}

/** The lines of the insights panel, label and text. */
export function insightLines(i: EasUpdateInsights): { label: string; text: string }[] {
  const x = i.insights;
  return [
    { label: t('eas:update.insight.launches'), text: formatCount(x.launches) },
    { label: t('eas:update.insight.failedLaunches'), text: formatCount(x.failedLaunches) },
    { label: t('eas:update.insight.crashRate'), text: crashRateText(x.crashRatePercent) },
    { label: t('eas:update.insight.uniqueUsers'), text: formatCount(x.uniqueUsers) },
    { label: t('eas:update.insight.payload'), text: formatBytes(x.averagePayloadBytes) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Raising a rollout

/** The new share as typed: a whole percent above the current one and at most 100. A sentence when it is not, else the number. */
export function parseShare(text: string, current: number): { ok: true; percentage: number } | { ok: false; message: string } {
  const value = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}$/.test(value)) return { ok: false, message: t('eas:update.share.whole') };
  const percentage = Number(value);
  if (percentage > 100) return { ok: false, message: t('eas:update.share.max') };
  if (percentage <= current) return { ok: false, message: t('eas:update.share.raiseOnly', { current }) };
  return { ok: true, percentage };
}

export type RolloutFailure = { kind: 'changed' | 'unknown' | 'off' | 'other'; message: string };

/** What a failed preview or apply means for the dialog. */
export function rolloutFailure(error: unknown): RolloutFailure {
  if (!(error instanceof ApiError)) return { kind: 'other', message: t('eas:update.rollout.other') };
  switch (error.code) {
    case 'eas_update_write_disabled':
      return { kind: 'off', message: t('eas:update.rollout.off') };
    case 'state_changed':
      return { kind: 'changed', message: t('eas:update.rollout.changed') };
    case 'rollout_not_found':
      return { kind: 'changed', message: t('eas:update.rollout.notFound') };
    case 'rollout_not_raised':
      return { kind: 'other', message: t('eas:update.rollout.notRaised') };
    case 'write_failed':
      return { kind: 'other', message: t('eas:update.rollout.writeFailed') };
    case 'outcome_unknown':
      return { kind: 'unknown', message: t('eas:update.rollout.unknown') };
    case 'write_in_progress':
      return { kind: 'other', message: t('eas:update.rollout.inProgress') };
    default:
      return { kind: 'other', message: easUpdateErrorText(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what a read of EAS Update said. */
export function easUpdateErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return t('eas:update.err.forbidden');
    case 'not_found':
      return t('eas:err.appGone');
    case 'expo_not_linked':
      return t('eas:update.err.notLinked');
    case 'credential_not_found':
      return t('eas:update.err.credentialDeleted');
    case 'platform_unsupported':
      return t('eas:update.err.platform');
    case 'credential_unreadable':
      return t('eas:update.err.credentialUnreadable');
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
    case 'invalid_group':
    case 'invalid_days':
      return own || t('eas:err.expoAsk');
    case 'rate_limited':
      return t('eas:err.rateLimited', { wait: waitText(error.retryAfter ?? 60) });
    case 'timeout':
      return t('eas:err.timeout');
    default:
      return error.status >= 500 ? t('errors:http.serverError') : error.message;
  }
}

/** "Read from Expo 2 minutes ago." */
export const readCaption = (state: EasUpdateState, now: number): string => t('eas:update.readCaption', { ago: formatRelativeTime(state.readAt, { now }) });
