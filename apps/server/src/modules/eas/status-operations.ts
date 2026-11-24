import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, W } from '../../operations/shared.ts';

/**
 * The operations of EAS Build and Submit status (docs/adr/0036-eas-build-submit-status.md, docs/api/eas-builds.md). Reading the stored snapshot needs
 * `builds.read`; a manual read from Expo needs `apps.sync`. Neither changes anything at Expo.
 */

const timestamp = z.number().int().describe('Epoch milliseconds.');
const platform = z.enum(PLATFORMS);
const expoError = z
  .object({ code: z.string().nullable(), message: z.string().nullable() })
  .nullable();

const build = z.object({
  id: z.string().describe('The EAS build id (a UUID).'),
  platform,
  status: z
    .string()
    .describe(
      '`new`, `in_queue`, `in_progress`, `pending_cancel`, `finished`, `errored`, `canceled` or `unknown` (see `rawStatus`).',
    ),
  rawStatus: z.string().nullable().describe("Expo's own word for the status."),
  active: z.boolean().describe('The build has not ended.'),
  buildProfile: z.string().nullable(),
  channel: z.string().nullable().describe('The update channel baked into the binary.'),
  appVersion: z.string().nullable(),
  buildNumber: z
    .string()
    .nullable()
    .describe('The build number (iOS) or the version code (Android), as Expo reports it.'),
  buildNumberLabel: z.string().describe('What `buildNumber` is called on this platform.'),
  sdkVersion: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  distribution: z.string().nullable().describe('`store`, `internal`, `simulator` or `unknown`.'),
  internal: z
    .boolean()
    .describe('Internal distribution: installed from a link, outside the stores.'),
  simulator: z.boolean().nullable(),
  appIdentifier: z.string().nullable(),
  gitCommitHash: z.string().nullable(),
  gitCommitMessage: z.string().nullable().describe('The first line, at most 200 characters.'),
  error: expoError.describe(
    "Expo's error code and text (at most 500 characters), when the build failed.",
  ),
  hasArtifact: z
    .boolean()
    .describe('Expo holds a build file. Its address is never returned: open `expoUrl`.'),
  artifactExpiresAt: timestamp.nullable().describe('When Expo deletes the build file.'),
  createdAt: timestamp.nullable(),
  updatedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  expoUrl: z
    .string()
    .nullable()
    .describe(
      'The page of the build at expo.dev: logs, and the install link where the build has one.',
    ),
});

const submission = z.object({
  id: z.string().describe('The EAS submission id (a UUID).'),
  platform,
  status: z
    .string()
    .describe(
      '`awaiting_build`, `in_queue`, `in_progress`, `finished`, `errored`, `canceled` or `unknown` (see `rawStatus`).',
    ),
  rawStatus: z.string().nullable(),
  active: z.boolean(),
  buildId: z.string().nullable().describe('The EAS build that was submitted.'),
  build: z
    .object({
      appVersion: z.string().nullable(),
      buildNumber: z.string().nullable(),
      buildNumberLabel: z.string(),
    })
    .nullable()
    .describe('Its version, when that build is in the stored snapshot.'),
  store: z
    .object({ id: z.enum(['appstoreconnect', 'googleplay']), name: z.string() })
    .describe('The store Expo sends to, derived from the platform.'),
  identifier: z.string().nullable().describe('The bundle id or package name Expo reports.'),
  track: z.string().nullable().describe('Google Play: the track of the submission.'),
  releaseStatus: z.string().nullable(),
  error: expoError,
  createdAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  expoUrl: z.string().nullable(),
});

const otaUpdate = z.object({
  id: z.string(),
  group: z.string().describe('The update group id.'),
  platform: z.string().describe('`ios` or `android`.'),
  channel: z.string(),
  branch: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  message: z.string().nullable().describe("The publisher's text, first line, 200 characters. Never in an alert or an event."),
  createdAt: timestamp.nullable(),
  rolloutPercentage: z.number().int().nullable().describe('1 to 99 while a per-update rollout is going, else null.'),
  rolloutSince: timestamp.nullable().describe('When this server first read this percentage; null when not mid-rollout.'),
  expoUrl: z.string().nullable().describe('The page of the update group at expo.dev (the address shape is assumed).'),
});

const status = z.object({
  project: z
    .object({
      fullName: z.string().describe('`@account/slug`.'),
      projectId: z.string(),
      url: z.string().describe('The project page at expo.dev.'),
      credentialAvailable: z.boolean(),
    })
    .nullable()
    .describe('Null when the app is not linked to an Expo project.'),
  supported: z.boolean().describe('False for an app record EAS does not build for (macOS).'),
  builds: z
    .array(build)
    .describe(
      'Newest first. The newest page Expo returned for the platform of the app, not the whole history.',
    ),
  submissions: z.array(submission),
  active: z.boolean().describe('A build or a submission has not ended.'),
  sync: z.object({
    readAt: timestamp
      .nullable()
      .describe('When the snapshot was last read successfully; null before the first read.'),
    lastAttemptAt: timestamp.nullable(),
    lastError: z
      .string()
      .nullable()
      .describe(
        'A short code of the last failure (`expo_auth`, `rate_limited`, ...); null when the last read worked.',
      ),
    consecutiveFailures: z.number().int(),
    buildsTruncated: z
      .boolean()
      .describe('The page of builds was full: older builds exist at Expo and are not shown.'),
    submissionsTruncated: z.boolean(),
  }),
  updates: z
    .object({
      readAt: timestamp
        .nullable()
        .describe('When the updates were last read successfully; null before the first read.'),
      lastError: z
        .string()
        .nullable()
        .describe('A short code when the last read of the updates failed (the builds may have been read fine); never Expo text.'),
      channels: z.array(
        z.object({
          channel: z.string(),
          current: otaUpdate
            .nullable()
            .describe('The newest update of the branches the channel serves, for the platform of this app record.'),
          rollouts: z.array(otaUpdate).describe('Other updates of the channel that are mid-rollout.'),
        }),
      ),
    })
    .describe('The stored OTA (EAS Update) state, read by the same status read (ADR 0060). Database only.'),
});

export const easStatusOperations: Draft[] = [
  {
    id: 'getEasStatus',
    method: 'get',
    path: `${W}/apps/{appId}/eas/status`,
    tags: ['eas'],
    summary:
      'EAS builds and submissions of the Expo project an app is linked to (the stored snapshot)',
    description:
      'Answers `{ status }` from the database only: Expo is not called. The snapshot is refreshed by the scheduled status read (`KILN_EAS_STATUS_INTERVAL_MINUTES`, every few minutes while a build or submission is running) and by `refreshEasStatus`. `project` is null when the app has no link; `sync.readAt` is null before the first read. Builds and submissions are those of the platform of this app record. Build file addresses are never returned. Needs `builds.read`.',
    risk: 'read',
    access: { action: 'builds.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The snapshot.', schema: z.object({ status }) } },
  },
  {
    id: 'refreshEasStatus',
    method: 'post',
    path: `${W}/apps/{appId}/eas/status/refresh`,
    tags: ['eas'],
    summary: 'Read the EAS builds and submissions of the linked Expo project again',
    description:
      'READS Expo with the credential of the link (audited as `credential.use`, purpose `eas.status`, and as `eas.status_refresh`) and replaces the stored snapshot; nothing at Expo is created, cancelled or changed. Answers `{ status }` like `getEasStatus`. `409` `not_linked`; `422` `platform_unsupported` / `credential_not_found` / `credential_kind` / `expo_auth` / `expo_forbidden` / `expo_not_found`; `429` (the budget of the app syncs per workspace, or Expo said to slow down); `502` `expo_unavailable`; `504` `timeout`. A failed read keeps the old snapshot. Needs `apps.sync`.',
    risk: 'write',
    access: { action: 'apps.sync' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: { '200': { description: 'The new snapshot.', schema: z.object({ status }) } },
  },
];
