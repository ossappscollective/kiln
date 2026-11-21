import type { Platform } from '@kiln/core';
import { ApiError, waitPhrase } from '../api.ts';
import { timeAgo } from '../format.ts';

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
  project: { fullName: string; projectId: string; url: string; credentialAvailable: boolean } | null;
  supported: boolean;
  builds: EasBuildView[];
  submissions: EasSubmissionView[];
  active: boolean;
  sync: EasStatusSync;
};

// ---------------------------------------------------------------------------------------------
// Words

const BUILD_WORDS: Record<string, { label: string; tone: EasTone }> = {
  new: { label: 'Waiting', tone: 'info' },
  in_queue: { label: 'In the queue', tone: 'info' },
  in_progress: { label: 'Building', tone: 'info' },
  pending_cancel: { label: 'Being cancelled', tone: 'warn' },
  finished: { label: 'Finished', tone: 'ok' },
  errored: { label: 'Failed', tone: 'bad' },
  canceled: { label: 'Cancelled', tone: 'neutral' },
};

const SUBMISSION_WORDS: Record<string, { label: string; tone: EasTone }> = {
  awaiting_build: { label: 'Waiting for the build', tone: 'info' },
  in_queue: { label: 'In the queue', tone: 'info' },
  in_progress: { label: 'Submitting', tone: 'info' },
  finished: { label: 'Submitted', tone: 'ok' },
  errored: { label: 'Failed', tone: 'bad' },
  canceled: { label: 'Cancelled', tone: 'neutral' },
};

const sentence = (raw: string | null): string =>
  raw ? raw.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown status';

export function easBuildState(b: Pick<EasBuildView, 'status' | 'rawStatus'>): { label: string; tone: EasTone } {
  return BUILD_WORDS[b.status] || { label: sentence(b.rawStatus), tone: 'neutral' };
}

export function easSubmissionState(s: Pick<EasSubmissionView, 'status' | 'rawStatus'>): { label: string; tone: EasTone } {
  return SUBMISSION_WORDS[s.status] || { label: sentence(s.rawStatus), tone: 'neutral' };
}

export const easDistributionLabel = (distribution: string | null): string =>
  distribution === 'internal'
    ? 'Internal distribution'
    : distribution === 'store'
      ? 'Store distribution'
      : distribution === 'simulator'
        ? 'Simulator'
        : '';

const shortId = (id: string): string => id.slice(0, 8);

/** `1.4.0 (57)`, `1.4.0` or `(57)`; the short id when Expo sent neither. */
export function easBuildTitle(b: Pick<EasBuildView, 'appVersion' | 'buildNumber' | 'id'>): string {
  const parts: string[] = [];
  if (b.appVersion) parts.push(b.appVersion);
  if (b.buildNumber) parts.push(`(${b.buildNumber})`);
  return parts.length > 0 ? parts.join(' ') : `Build ${shortId(b.id)}`;
}

/** The muted line under a build: profile, channel, distribution, runtime and commit. */
export function easBuildDetail(b: EasBuildView): string {
  const parts: string[] = [];
  if (b.buildProfile) parts.push(`Profile ${b.buildProfile}`);
  if (b.channel) parts.push(`Channel ${b.channel}`);
  const distribution = easDistributionLabel(b.distribution);
  if (distribution) parts.push(distribution);
  if (b.runtimeVersion) parts.push(`Runtime ${b.runtimeVersion}`);
  if (b.gitCommitHash) parts.push(b.gitCommitHash.slice(0, 7));
  return parts.join(' · ');
}

/** The version of a submission's build, when the build is known: "1.4.0 (57)". */
export function easSubmissionBuild(s: EasSubmissionView): string {
  if (!s.build) return s.buildId ? `Build ${shortId(s.buildId)}` : 'No build named';
  return easBuildTitle({ appVersion: s.build.appVersion, buildNumber: s.build.buildNumber, id: s.buildId || '' });
}

/** The submission's target in words: "App Store Connect · 1234567890" or "Google Play Console · com.acme · internal track". */
export function easSubmissionTarget(s: EasSubmissionView): string {
  const parts: string[] = [s.store.name];
  if (s.identifier) parts.push(s.identifier);
  if (s.track) parts.push(`${s.track.toLowerCase()} track`);
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
    const when = sync.readAt !== null ? ` The builds shown were read ${timeAgo(sync.readAt, now)}.` : '';
    return { tone: 'warn', text: `Expo could not be read (${sync.lastError.replace(/_/g, ' ')}).${when}` };
  }
  if (sync.readAt === null) {
    return { tone: 'info', text: 'The EAS builds of this app have not been read yet. Use Read again.' };
  }
  const truncated = sync.buildsTruncated || sync.submissionsTruncated ? ' Older builds exist at Expo and are not shown.' : '';
  return {
    tone: 'info',
    text: `EAS builds read ${timeAgo(sync.readAt, now)}${status.active ? '; a build is still running, so they are read again every few minutes' : ''}.${truncated}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A sentence for what the API said when reading or refreshing the status. */
export function easStatusErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const own = typeof error.body.message === 'string' ? error.body.message : '';
  switch (error.code) {
    case 'forbidden':
      return 'Reading EAS builds needs the member role.';
    case 'not_found':
      return 'That app no longer exists. Reload the page.';
    case 'not_linked':
      return own || 'This app is not linked to an Expo project. Link it in the app settings.';
    case 'platform_unsupported':
      return own || 'EAS builds and submits iOS and Android apps only.';
    case 'credential_not_found':
    case 'credential_kind':
    case 'credential_unreadable':
      return own || 'The Expo credential of this link cannot be used. Choose another in the app settings.';
    case 'expo_auth':
    case 'expo_forbidden':
    case 'expo_not_found':
    case 'expo_unavailable':
      return own || 'Expo could not be asked. Try again in a moment.';
    case 'rate_limited':
      return `Too many reads. Try again in ${waitPhrase(error.retryAfter || 60)}.`;
    case 'timeout':
      return 'Expo took too long to answer. Try again.';
    default:
      return error.status >= 500 ? 'The server had a problem. Try again.' : error.message;
  }
}

/** Whether the person may read EAS status at all (the server answers 403 below the member role). */
export const easStatusAvailable = (status: EasStatusView | null): boolean =>
  status !== null && status.project !== null && status.supported;
