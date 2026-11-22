import {
  type ExpoBuildSummary,
  type ExpoPlatformKey,
  type ExpoSubmissionSummary,
  expoBuilds,
  expoSubmissions,
} from '@kiln/connectors';
import { type ActorType, type Platform, platformMeta, type StoreId } from '@kiln/core';
import { type Database, nullableNumber, nullableString, type Sql } from '@kiln/db';
import { getApp, type ManagedApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { type Failure, failure, type Outcome } from '../../services/repositories.ts';
import { expoClientFor, expoFailure } from './client.ts';
import type { EasDeps } from './index.ts';
import { getExpoLink, type ExpoLinkView } from './link.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * EAS Build and Submit status (docs/adr/0036-eas-build-submit-status.md, docs/api/eas-builds.md): the builds and the submissions of the Expo
 * project an app record is linked to, kept as a snapshot in `eas_builds`, `eas_submissions` and `eas_status_sync`. READ ONLY toward
 * Expo: nothing is created, cancelled or resubmitted there. A read (`refreshEasStatus`) replaces the snapshot of the app record; the
 * views (`getEasStatus`) read the database only, so listing never calls Expo.
 *
 * The snapshot holds the newest page of each list for the platform of the app record (an iOS record shows iOS builds, an Android record
 * Android builds): an app with an iOS and an Android record linked to one project reads each platform once. The ADDRESS of a build file is
 * never stored or returned: `hasArtifact` says that Expo holds one, and `expoUrl` is the page of the build at expo.dev, which is where
 * Expo shows the install link (and applies its own access rules). That keeps the builds download switch (`KILN_BUILDS_DOWNLOAD_ENABLED`)
 * the only way a build file leaves through this server.
 */

type Actor = { type: ActorType; id: string };

export const EAS_STATUS_PURPOSE = 'eas.status';
/** The web address of Expo's pages, where a build or a submission can be opened. UNVERIFIED as the default of eas-cli; see the ADR. */
export const EXPO_WEB_ORIGIN = 'https://expo.dev';

/**
 * Which platform of Expo (EAS builds iOS and Android only) an app record reads. A table, not a test: a new platform of this tool has to say
 * which Expo platform it is, or `null` when EAS has none (macOS).
 */
const expoPlatformOf: Readonly<Record<Platform, ExpoPlatformKey | null>> = {
  ios: 'ios',
  macos: null,
  android: 'android',
};
const platformOfExpo: Readonly<Record<ExpoPlatformKey, Platform>> = { ios: 'ios', android: 'android' };

/** The Expo platform an app record reads, or null when EAS does not build for it. */
export const easPlatformOf = (platform: Platform): ExpoPlatformKey | null => expoPlatformOf[platform];

/** Statuses of a build or a submission that has not ended: it is worth reading again soon. */
export const ACTIVE_BUILD_STATUSES = ['new', 'in_queue', 'in_progress', 'pending_cancel'] as const;
export const ACTIVE_SUBMISSION_STATUSES = ['awaiting_build', 'in_queue', 'in_progress'] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** After a failed read the next scheduled one waits this long, doubled for every failure in a row, up to six hours. Manual reads ignore it. */
export const EAS_BACKOFF_BASE_MS = 10 * MINUTE;
export const EAS_BACKOFF_MAX_MS = 6 * HOUR;

export const easBackoffMs = (failures: number): number =>
  Math.min(EAS_BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), EAS_BACKOFF_MAX_MS);

// ---------------------------------------------------------------------------------------------
// Views

export type EasBuildView = {
  id: string;
  platform: Platform;
  /** new, in_queue, in_progress, pending_cancel, finished, errored, canceled or unknown. */
  status: string;
  /** Expo's own word, verbatim. */
  rawStatus: string | null;
  /** The build has not ended (waiting, running or being cancelled). */
  active: boolean;
  buildProfile: string | null;
  /** The update channel baked into the binary. */
  channel: string | null;
  appVersion: string | null;
  /** The build number (iOS) or the version code (Android), as Expo reports it. */
  buildNumber: string | null;
  /** What `buildNumber` is called on this platform: "Build" or "Version code". */
  buildNumberLabel: string;
  sdkVersion: string | null;
  runtimeVersion: string | null;
  /** store, internal, simulator or unknown. */
  distribution: string | null;
  /** Internal distribution (installed from a link, outside the stores). */
  internal: boolean;
  simulator: boolean | null;
  appIdentifier: string | null;
  gitCommitHash: string | null;
  gitCommitMessage: string | null;
  error: { code: string | null; message: string | null } | null;
  /** Expo holds a build file. The address is not returned: open `expoUrl`. */
  hasArtifact: boolean;
  /** When Expo deletes the build file. */
  artifactExpiresAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  /** The page of the build at expo.dev (logs, and the install link where it has one). Null when no project is linked. */
  expoUrl: string | null;
};

export type EasSubmissionView = {
  id: string;
  platform: Platform;
  /** awaiting_build, in_queue, in_progress, finished, errored, canceled or unknown. */
  status: string;
  rawStatus: string | null;
  active: boolean;
  /** The EAS build that was submitted, and its version when that build is in the snapshot. */
  buildId: string | null;
  build: { appVersion: string | null; buildNumber: string | null; buildNumberLabel: string } | null;
  /** The store Expo sends to, derived from the platform. */
  store: { id: StoreId; name: string };
  /** The bundle id or package name Expo reports for the submission. */
  identifier: string | null;
  /** Google Play: the track and the release status of the submission. */
  track: string | null;
  releaseStatus: string | null;
  error: { code: string | null; message: string | null } | null;
  createdAt: number | null;
  completedAt: number | null;
  expoUrl: string | null;
};

export type EasStatusSync = {
  /** When the snapshot was last read successfully; null before the first read. */
  readAt: number | null;
  lastAttemptAt: number | null;
  /** A short code of the last failure (`expo_auth`, `rate_limited`, ...), null when the last read worked. */
  lastError: string | null;
  consecutiveFailures: number;
  /** The newest page was full: older builds or submissions exist at Expo and are not shown. */
  buildsTruncated: boolean;
  submissionsTruncated: boolean;
};

export type EasStatusView = {
  /** Null when the app record is not linked to an Expo project. */
  project: { fullName: string; projectId: string; url: string; credentialAvailable: boolean } | null;
  /** False for an app record EAS does not build for (macOS). */
  supported: boolean;
  builds: EasBuildView[];
  submissions: EasSubmissionView[];
  /** Something is still going: a build or a submission has not ended. */
  active: boolean;
  sync: EasStatusSync;
};

const encode = encodeURIComponent;
const projectUrl = (link: Pick<ExpoLinkView, 'accountName' | 'slug'>) =>
  `${EXPO_WEB_ORIGIN}/accounts/${encode(link.accountName)}/projects/${encode(link.slug)}`;

const flag = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : Number(value) === 1;

const errorOf = (code: unknown, message: unknown) => {
  const c = nullableString(code);
  const m = nullableString(message);
  return c === null && m === null ? null : { code: c, message: m };
};

const expoPlatformKey = (value: unknown): ExpoPlatformKey | null =>
  value === 'ios' || value === 'android' ? value : null;

function buildView(row: Record<string, unknown>, link: ExpoLinkView | null): EasBuildView | null {
  const key = expoPlatformKey(row.platform);
  if (key === null) return null;
  const platform = platformOfExpo[key];
  const id = String(row.build_id);
  const status = String(row.status);
  const distribution = nullableString(row.distribution);
  return {
    id,
    platform,
    status,
    rawStatus: nullableString(row.raw_status),
    active: (ACTIVE_BUILD_STATUSES as readonly string[]).includes(status),
    buildProfile: nullableString(row.build_profile),
    channel: nullableString(row.channel),
    appVersion: nullableString(row.app_version),
    buildNumber: nullableString(row.app_build_version),
    buildNumberLabel: platformMeta(platform).buildLabelSingular,
    sdkVersion: nullableString(row.sdk_version),
    runtimeVersion: nullableString(row.runtime_version),
    distribution,
    internal: distribution === 'internal',
    simulator: flag(row.simulator),
    appIdentifier: nullableString(row.app_identifier),
    gitCommitHash: nullableString(row.git_commit_hash),
    gitCommitMessage: nullableString(row.git_commit_message),
    error: errorOf(row.error_code, row.error_message),
    hasArtifact: Number(row.has_artifact) === 1,
    artifactExpiresAt: nullableNumber(row.expires_at),
    createdAt: nullableNumber(row.created_at),
    updatedAt: nullableNumber(row.updated_at),
    completedAt: nullableNumber(row.completed_at),
    expoUrl: link ? `${projectUrl(link)}/builds/${encode(id)}` : null,
  };
}

function submissionView(
  row: Record<string, unknown>,
  link: ExpoLinkView | null,
  builds: Map<string, EasBuildView>,
): EasSubmissionView | null {
  const key = expoPlatformKey(row.platform);
  if (key === null) return null;
  const platform = platformOfExpo[key];
  const meta = platformMeta(platform);
  const id = String(row.submission_id);
  const status = String(row.status);
  const buildId = nullableString(row.build_id);
  const built = buildId ? builds.get(buildId) : undefined;
  return {
    id,
    platform,
    status,
    rawStatus: nullableString(row.raw_status),
    active: (ACTIVE_SUBMISSION_STATUSES as readonly string[]).includes(status),
    buildId,
    build: built
      ? { appVersion: built.appVersion, buildNumber: built.buildNumber, buildNumberLabel: built.buildNumberLabel }
      : null,
    store: { id: meta.store, name: meta.consoleName },
    identifier: nullableString(row.target_identifier),
    track: nullableString(row.track),
    releaseStatus: nullableString(row.release_status),
    error: errorOf(row.error_code, row.error_message),
    createdAt: nullableNumber(row.created_at),
    completedAt: nullableNumber(row.completed_at),
    expoUrl: link ? `${projectUrl(link)}/submissions/${encode(id)}` : null,
  };
}

const NO_SYNC: EasStatusSync = {
  readAt: null,
  lastAttemptAt: null,
  lastError: null,
  consecutiveFailures: 0,
  buildsTruncated: false,
  submissionsTruncated: false,
};

/** The stored status of an app record. Database only: Expo is not called. */
export async function getEasStatus(
  sql: Sql,
  workspaceId: string,
  app: Pick<ManagedApp, 'id' | 'platform'>,
): Promise<EasStatusView> {
  const link = await getExpoLink(sql, workspaceId, app.id);
  const supported = easPlatformOf(app.platform) !== null;
  if (!link) {
    return { project: null, supported, builds: [], submissions: [], active: false, sync: { ...NO_SYNC } };
  }
  const buildRows = await sql.query(
    'SELECT * FROM eas_builds WHERE app_id = ? AND workspace_id = ? ORDER BY COALESCE(created_at, 0) DESC, build_id',
    [app.id, workspaceId],
  );
  const submissionRows = await sql.query(
    'SELECT * FROM eas_submissions WHERE app_id = ? AND workspace_id = ? ORDER BY COALESCE(created_at, 0) DESC, submission_id',
    [app.id, workspaceId],
  );
  const [state] = await sql.query('SELECT * FROM eas_status_sync WHERE app_id = ? AND workspace_id = ?', [
    app.id,
    workspaceId,
  ]);
  const builds = buildRows.flatMap((r) => buildView(r, link) ?? []);
  const byId = new Map(builds.map((b) => [b.id, b]));
  const submissions = submissionRows.flatMap((r) => submissionView(r, link, byId) ?? []);
  return {
    project: {
      fullName: link.fullName,
      projectId: link.projectId,
      url: projectUrl(link),
      credentialAvailable: link.credentialAvailable,
    },
    supported,
    builds,
    submissions,
    active: builds.some((b) => b.active) || submissions.some((s) => s.active),
    sync: state
      ? {
          readAt: nullableNumber(state.last_success_at),
          lastAttemptAt: nullableNumber(state.last_attempt_at),
          lastError: nullableString(state.last_error),
          consecutiveFailures: Number(state.consecutive_failures),
          buildsTruncated: Number(state.builds_truncated) === 1,
          submissionsTruncated: Number(state.submissions_truncated) === 1,
        }
      : { ...NO_SYNC },
  };
}

// ---------------------------------------------------------------------------------------------
// The read from Expo

export type EasStatusContext = {
  db: Database;
  masterKey: Buffer;
  now: () => number;
  deps: EasDeps | undefined;
};

export type EasRefreshTrigger = 'manual' | 'job';

const insertBuild = (
  tx: Sql,
  workspaceId: string,
  appId: string,
  b: ExpoBuildSummary & { platform: ExpoPlatformKey },
  at: number,
) =>
  tx.execute(
    `INSERT INTO eas_builds
       (app_id, build_id, workspace_id, platform, status, raw_status, build_profile, channel, app_version, app_build_version, sdk_version,
        runtime_version, distribution, simulator, app_identifier, git_commit_hash, git_commit_message, error_code, error_message,
        has_artifact, created_at, updated_at, completed_at, expires_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      b.id,
      workspaceId,
      b.platform,
      b.status,
      b.rawStatus || null,
      b.buildProfile,
      b.channel,
      b.appVersion,
      b.appBuildVersion,
      b.sdkVersion,
      b.runtimeVersion,
      b.distribution,
      b.simulator === null ? null : b.simulator ? 1 : 0,
      b.appIdentifier,
      b.gitCommitHash,
      b.gitCommitMessage,
      b.error?.code ?? null,
      b.error?.message ?? null,
      b.hasArtifact ? 1 : 0,
      b.createdAt,
      b.updatedAt,
      b.completedAt,
      b.expiresAt,
      at,
    ],
  );

const insertSubmission = (
  tx: Sql,
  workspaceId: string,
  appId: string,
  s: ExpoSubmissionSummary & { platform: ExpoPlatformKey },
  at: number,
) =>
  tx.execute(
    `INSERT INTO eas_submissions
       (app_id, submission_id, workspace_id, platform, status, raw_status, build_id, target_identifier, track, release_status,
        error_code, error_message, created_at, completed_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      appId,
      s.id,
      workspaceId,
      s.platform,
      s.status,
      s.rawStatus || null,
      s.buildId,
      s.targetIdentifier,
      s.track,
      s.releaseStatus,
      s.error?.code ?? null,
      s.error?.message ?? null,
      s.createdAt,
      s.completedAt,
      at,
    ],
  );

/** Notes a failed read: the attempt, a short code, the streak and the time before which the scheduler does not try again. */
async function recordFailure(ctx: EasStatusContext, workspaceId: string, appId: string, code: string): Promise<void> {
  const at = ctx.now();
  const [before] = await ctx.db.query('SELECT consecutive_failures FROM eas_status_sync WHERE app_id = ?', [appId]);
  const failures = Number(before?.consecutive_failures ?? 0) + 1;
  await ctx.db.execute(
    `INSERT INTO eas_status_sync (app_id, workspace_id, last_attempt_at, last_error, consecutive_failures, backoff_until)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
       consecutive_failures = excluded.consecutive_failures, backoff_until = excluded.backoff_until`,
    [appId, workspaceId, at, code, failures, at + easBackoffMs(failures)],
  );
}

/**
 * Reads the newest builds and submissions of the linked project for the platform of the app record and replaces the snapshot. A failure at
 * Expo leaves the old snapshot as it was, records the attempt and the failure streak, and answers with the shared Expo codes
 * (`expo_auth`, `expo_forbidden`, `expo_not_found`, `rate_limited`, `timeout`, `expo_unavailable`). The use of the credential is audited
 * as `credential.use` (purpose `eas.status`); a manual read is also audited as `eas.status_refresh` (ids and counts only).
 */
export async function refreshEasStatus(
  ctx: EasStatusContext,
  input: { workspaceId: string; appId: string },
  actor: Actor,
  options: { trigger: EasRefreshTrigger } = { trigger: 'manual' },
): Promise<Outcome<{ status: EasStatusView }>> {
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return failure(404, 'not_found');
  const link = await getExpoLink(ctx.db, input.workspaceId, app.id);
  if (!link) {
    return failure(
      409,
      'not_linked',
      'This app is not linked to an Expo project. Link it in the app settings.',
      coded('eas.notLinked'),
    );
  }
  const platform = easPlatformOf(app.platform);
  if (platform === null) {
    return failure(
      422,
      'platform_unsupported',
      'EAS builds and submits iOS and Android apps only.',
      coded('eas.platformsOnly'),
    );
  }
  if (!link.credentialAvailable) {
    return failure(
      422,
      'credential_not_found',
      'The Expo credential of this link was deleted. Choose another in the app settings.',
      coded('eas.credentialDeleted'),
    );
  }
  const opened = await expoClientFor(ctx.db, ctx.masterKey, input.workspaceId, link.credentialId, ctx.deps, {
    actor,
    purpose: EAS_STATUS_PURPOSE,
    now: ctx.now(),
  });
  if (!opened.ok) {
    await recordFailure(ctx, input.workspaceId, app.id, opened.body.error).catch(() => undefined);
    return opened;
  }
  let builds: Awaited<ReturnType<typeof expoBuilds>>;
  let submissions: Awaited<ReturnType<typeof expoSubmissions>>;
  try {
    builds = await expoBuilds(opened.client, link.projectId, { platform });
    submissions = await expoSubmissions(opened.client, link.projectId, { platform });
  } catch (error) {
    const failed: Failure = expoFailure(error);
    await recordFailure(ctx, input.workspaceId, app.id, failed.body.error).catch(() => undefined);
    return failed;
  }
  const at = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx.execute('DELETE FROM eas_builds WHERE app_id = ? AND workspace_id = ?', [app.id, input.workspaceId]);
    await tx.execute('DELETE FROM eas_submissions WHERE app_id = ? AND workspace_id = ?', [app.id, input.workspaceId]);
    for (const b of builds.items) {
      if (b.platform !== null) await insertBuild(tx, input.workspaceId, app.id, { ...b, platform: b.platform }, at);
    }
    for (const s of submissions.items) {
      if (s.platform !== null) {
        await insertSubmission(tx, input.workspaceId, app.id, { ...s, platform: s.platform }, at);
      }
    }
    await tx.execute(
      `INSERT INTO eas_status_sync
         (app_id, workspace_id, project_id, credential_id, last_attempt_at, last_success_at, last_error, consecutive_failures,
          backoff_until, builds_truncated, submissions_truncated)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET project_id = excluded.project_id, credential_id = excluded.credential_id,
         last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = NULL,
         consecutive_failures = 0, backoff_until = NULL, builds_truncated = excluded.builds_truncated,
         submissions_truncated = excluded.submissions_truncated`,
      [
        app.id,
        input.workspaceId,
        link.projectId,
        link.credentialId,
        at,
        at,
        builds.full ? 1 : 0,
        submissions.full ? 1 : 0,
      ],
    );
    if (options.trigger === 'manual') {
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor,
        action: 'eas.status_refresh',
        target: { type: 'app', id: app.id },
        detail: {
          appId: app.id,
          projectId: link.projectId,
          builds: builds.items.length,
          submissions: submissions.items.length,
        },
        at,
      });
    }
  });
  return { ok: true, status: await getEasStatus(ctx.db, input.workspaceId, app) };
}
