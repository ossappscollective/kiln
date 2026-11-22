import type { Platform } from '@kiln/core';
import { ApiError } from '../api.ts';
import { formatRelativeTime } from '../i18n/format.ts';
import { k, t } from '../i18n/t.ts';
import { waitText } from './eas.ts';

/**
 * Pure helpers of the EAS builds and submissions in "Builds to test" (docs/adr/0036-eas-build-submit-status.md, docs/api/eas-builds.md): the types
 * of what the API answers, the words for each status, the title and detail line of a row, the line about the last read, and the sentence for
 * each error code. Written for the ES2017 web build (no `flatMap`, no `Object.fromEntries`).
 */

export type EasTone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';

export type EasErrorDetail = { code: string | null; message: string | null };

/** One EAS build, as `GET /apps/{appId}/eas/status` answers. */
export type EasBuildView = {
  id: string;
  platform: Platform;
  status: string;
  rawStatus: string | null;
  active: boolean;
  buildProfile: string | null;
  channel: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  /** "Build" or "Version code". */
  buildNumberLabel: string;
  sdkVersion: string | null;
  runtimeVersion: string | null;
  distribution: string | null;
  internal: boolean;
  simulator: boolean | null;
  appIdentifier: string | null;
  gitCommitHash: string | null;
  gitCommitMessage: string | null;
  error: EasErrorDetail | null;
  hasArtifact: boolean;
  artifactExpiresAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  expoUrl: string | null;
};

export type EasSubmissionView = {
  id: string;
  platform: Platform;
  status: string;
  rawStatus: string | null;
  active: boolean;
  buildId: string | null;
  build: { appVersion: string | null; buildNumber: string | null; buildNumberLabel: string } | null;
  store: { id: 'appstoreconnect' | 'googleplay'; name: string };
  identifier: string | null;
  track: string | null;
  releaseStatus: string | null;
  error: EasErrorDetail | null;
  createdAt: number | null;
  completedAt: number | null;
  expoUrl: string | null;
};

export type EasStatusSync = {
  readAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  buildsTruncated: boolean;
  submissionsTruncated: boolean;
};

export type EasStatusView = {
  project: {
    fullName: string;
    projectId: string;
    url: string;
    credentialAvailable: boolean;
  } | null;
  supported: boolean;
  builds: EasBuildView[];
  submissions: EasSubmissionView[];
  active: boolean;
  sync: EasStatusSync;
};

// ---------------------------------------------------------------------------------------------
// Words

// The label is a catalog key (`k()` keeps it a literal for the checker); it is translated where the state is asked for.
const BUILD_WORDS: Record<string, { key: string; tone: EasTone }> = {
  new: { key: k('eas:status.waiting'), tone: 'info' },
  in_queue: { key: k('eas:status.inQueue'), tone: 'info' },
  in_progress: { key: k('eas:status.building'), tone: 'info' },
  pending_cancel: { key: k('eas:status.cancelling'), tone: 'warn' },
  finished: { key: k('eas:status.finished'), tone: 'ok' },
  errored: { key: k('eas:status.failed'), tone: 'bad' },
  canceled: { key: k('eas:status.cancelled'), tone: 'neutral' },
};

const SUBMISSION_WORDS: Record<string, { key: string; tone: EasTone }> = {
  awaiting_build: { key: k('eas:status.awaitingBuild'), tone: 'info' },
  in_queue: { key: k('eas:status.inQueue'), tone: 'info' },
  in_progress: { key: k('eas:status.submitting'), tone: 'info' },
  finished: { key: k('eas:status.submitted'), tone: 'ok' },
  errored: { key: k('eas:status.failed'), tone: 'bad' },
  canceled: { key: k('eas:status.cancelled'), tone: 'neutral' },
};

// An unknown status of Expo is shown as Expo wrote it, in sentence case.
const sentence = (raw: string | null): string =>
  raw
    ? raw
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/^./, (c) => c.toUpperCase())
    : t('eas:status.unknown');

function stateOf(
  words: Record<string, { key: string; tone: EasTone }>,
  status: string,
  raw: string | null,
): { label: string; tone: EasTone } {
  const known = words[status];
  return known
    ? { label: t(known.key), tone: known.tone }
    : { label: sentence(raw), tone: 'neutral' };
}

export function easBuildState(b: Pick<EasBuildView, 'status' | 'rawStatus'>): {
  label: string;
  tone: EasTone;
} {
  return stateOf(BUILD_WORDS, b.status, b.rawStatus);
}

export function easSubmissionState(s: Pick<EasSubmissionView, 'status' | 'rawStatus'>): {
  label: string;
  tone: EasTone;
} {
  return stateOf(SUBMISSION_WORDS, s.status, s.rawStatus);
}

export const easDistributionLabel = (distribution: string | null): string =>
  distribution === 'internal'
    ? t('eas:status.distribution.internal')
    : distribution === 'store'
      ? t('eas:status.distribution.store')
      : distribution === 'simulator'
        ? t('eas:status.distribution.simulator')
        : '';

const shortId = (id: string): string => id.slice(0, 8);

/** `1.4.0 (57)`, `1.4.0` or `(57)`; the short id when Expo sent neither. */
export function easBuildTitle(b: Pick<EasBuildView, 'appVersion' | 'buildNumber' | 'id'>): string {
  const parts: string[] = [];
  if (b.appVersion) parts.push(b.appVersion);
  if (b.buildNumber) parts.push(`(${b.buildNumber})`);
  return parts.length > 0 ? parts.join(' ') : t('eas:status.buildTitle', { id: shortId(b.id) });
}

/** The muted line under a build: profile, channel, distribution, runtime and commit. */
export function easBuildDetail(b: EasBuildView): string {
  const parts: string[] = [];
  if (b.buildProfile) parts.push(t('eas:status.detail.profile', { name: b.buildProfile }));
  if (b.channel) parts.push(t('eas:status.detail.channel', { name: b.channel }));
  const distribution = easDistributionLabel(b.distribution);
  if (distribution) parts.push(distribution);
  if (b.runtimeVersion) parts.push(t('eas:status.detail.runtime', { version: b.runtimeVersion }));
  if (b.gitCommitHash) parts.push(b.gitCommitHash.slice(0, 7));
  return parts.join(' · ');
}

/** The version of a submission's build, when the build is known: "1.4.0 (57)". */
export function easSubmissionBuild(s: EasSubmissionView): string {
  if (!s.build)
    return s.buildId
      ? t('eas:status.buildTitle', { id: shortId(s.buildId) })
      : t('eas:status.noBuild');
  return easBuildTitle({
    appVersion: s.build.appVersion,
    buildNumber: s.build.buildNumber,
    id: s.buildId || '',
  });
}

/** The submission's target in words: "App Store Connect · 1234567890" or "Google Play Console · com.acme · internal track". */
export function easSubmissionTarget(s: EasSubmissionView): string {
  const parts: string[] = [s.store.name];
  if (s.identifier) parts.push(s.identifier);
  if (s.track) parts.push(t('eas:status.track', { track: s.track.toLowerCase() }));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// The last read

/** One line about how fresh the data is and what went wrong, or null when there is nothing to say. */
export function easSyncLine(
  status: Pick<EasStatusView, 'sync' | 'active'>,
  now: number,
): { tone: 'info' | 'warn'; text: string } | null {
  const sync = status.sync;
  if (sync.lastError) {
    const reason = sync.lastError.replace(/_/g, ' ');
    return {
      tone: 'warn',
      text:
        sync.readAt !== null
          ? t('eas:status.sync.errorKnown', {
              reason,
              ago: formatRelativeTime(sync.readAt, { now }),
            })
          : t('eas:status.sync.error', { reason }),
    };
  }
  if (sync.readAt === null) {
    return { tone: 'info', text: t('eas:status.sync.never') };
  }
  const ago = formatRelativeTime(sync.readAt, { now });
  const truncated = sync.buildsTruncated || sync.submissionsTruncated;
  const key = status.active
    ? truncated
      ? k('eas:status.sync.readActiveTruncated')
      : k('eas:status.sync.readActive')
    : truncated
      ? k('eas:status.sync.readTruncated')
      : k('eas:status.sync.read');
  return { tone: 'info', text: t(key, { ago }) };
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what the API said when reading or refreshing the status. */
export function easStatusErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return t('common:error.genericRetry');
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return t('eas:err.status.forbidden');
    case 'not_found':
      return t('eas:err.appGone');
    case 'not_linked':
      return own || t('eas:err.status.notLinked');
    case 'platform_unsupported':
      return own || t('eas:err.status.platform');
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return own || t('eas:err.status.credential');
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || t('eas:err.expoAsk');
    case 'rate_limited':
      return t('eas:err.status.rateLimited', { wait: waitText(error.retryAfter || 60) });
    case 'timeout':
      return t('eas:err.timeout');
    default:
      return error.status >= 500 ? t('errors:http.serverError') : error.message;
  }
}

/** Whether the person may read EAS status at all (the server answers 403 below the member role). */
export const easStatusAvailable = (status: EasStatusView | null): boolean =>
  status !== null && status.project !== null && status.supported;
