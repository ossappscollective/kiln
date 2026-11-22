import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, timestamp, W } from '../../operations/shared.ts';
import { INSIGHTS_DEFAULT_DAYS, INSIGHTS_MAX_DAYS } from './update.ts';
import { rolloutApplyBody, rolloutPreviewBody } from './update-routes.ts';

/**
 * The operations of EAS Update (docs/api/eas-update.md, docs/adr/0037-eas-update.md). The two reads need `apps.read` and call Expo with
 * the app's Expo credential (audited as `credential.use`). Raising a rollout is the one write: `releases.rollout`, the switch
 * KILN_EAS_UPDATE_ROLLOUT_ENABLED, a preview and a step-up confirmation.
 */

const update = z.object({
  id: z.string(),
  group: z.string().describe('The update group: the updates published together, one per platform.'),
  message: z.string().nullable(),
  createdAt: timestamp.nullable(),
  platform: z.string().describe("Expo's key, lower case."),
  runtimeVersion: z.string().nullable(),
  gitCommitHash: z.string().nullable(),
  isRollBackToEmbedded: z.boolean(),
  rolloutPercentage: z
    .number()
    .nullable()
    .describe(
      'The share of clients that get this update while it is mid-rollout (1 to 99); null otherwise.',
    ),
  rolloutControlGroup: z.string().nullable(),
});

const runtimeCheck = z.object({
  channel: z.string(),
  status: z
    .enum(['ok', 'mismatch', 'newest_build_unreached', 'no_updates', 'no_builds', 'unknown'])
    .describe(
      '`mismatch`: the newest update has a runtime version that no store build on this channel has, so it reaches no shipped binary. `newest_build_unreached`: it reaches an older store build only.',
    ),
  severity: z.enum(['error', 'warning', 'info', 'none']),
  latestUpdate: z
    .object({
      runtimeVersion: z.string().nullable(),
      group: z.string(),
      branch: z.string(),
      createdAt: timestamp.nullable(),
    })
    .nullable(),
  latestBuild: z
    .object({
      id: z.string(),
      runtimeVersion: z.string().nullable(),
      appVersion: z.string().nullable(),
      appBuildVersion: z.string().nullable(),
      createdAt: timestamp.nullable(),
    })
    .nullable(),
  shippedRuntimeVersions: z.array(z.string()),
  message: z.string(),
});

const channel = z.object({
  id: z.string(),
  name: z.string(),
  isPaused: z.boolean().nullable(),
  isProtected: z.boolean().nullable(),
  updatedAt: timestamp.nullable(),
  mapping: z.object({
    kind: z
      .enum(['none', 'branch', 'rollout', 'unreadable'])
      .describe(
        '`branch`: one branch for every client. `rollout`: two or more entries (a rollout between branches). The share of such a rollout is NOT derived: the scale of its condition is unverified, so `condition` is shown as text.',
      ),
    entries: z.array(
      z.object({
        branchId: z.string(),
        branchName: z
          .string()
          .nullable()
          .describe('Null when the branch is not among the five Expo lists under the channel.'),
        logic: z.enum(['always', 'conditional']),
        condition: z.string().nullable(),
      }),
    ),
  }),
  branches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mapped: z.boolean(),
      groups: z
        .array(z.object({ group: z.string(), updates: z.array(update) }))
        .describe(
          'The newest update groups of the branch with an update for this platform (at most 3 read), newest first.',
        ),
    }),
  ),
  rollouts: z.array(
    z.object({
      branch: z.string(),
      group: z.string(),
      updateId: z.string(),
      runtimeVersion: z.string().nullable(),
      percentage: z.number(),
      controlGroup: z.string().nullable(),
    }),
  ),
  runtimeCheck,
});

const state = z.object({
  project: z.object({ id: z.string(), fullName: z.string() }),
  platform: z.enum(['ios', 'android']).describe("Expo's key of the platform of this app record."),
  channels: z.array(channel),
  channelsTruncated: z
    .boolean()
    .describe('Expo returned a full page (25): there may be more channels.'),
  builds: z
    .array(
      z.object({
        id: z.string(),
        runtimeVersion: z.string().nullable(),
        appVersion: z.string().nullable(),
        appBuildVersion: z.string().nullable(),
        channel: z.string().nullable(),
        createdAt: timestamp.nullable(),
      }),
    )
    .describe(
      'The finished store-distribution builds the runtime check compared with, newest first (at most 10).',
    ),
  rolloutWriteEnabled: z.boolean().describe('KILN_EAS_UPDATE_ROLLOUT_ENABLED.'),
  readAt: timestamp,
});

const insights = z.object({
  group: z.string(),
  platform: z.enum(['ios', 'android']),
  days: z.number().int(),
  start: timestamp,
  end: timestamp,
  insights: z.object({
    updateId: z.string(),
    platform: z.string(),
    launches: z.number().nullable().describe('Installs of the update in the span.'),
    failedLaunches: z.number().nullable().describe('Failed installs in the span.'),
    crashRatePercent: z
      .number()
      .nullable()
      .describe(
        'failed / (installs + failed) as a percentage (the formula `eas update:insights` documents); null with no launch at all.',
      ),
    uniqueUsers: z.number().nullable(),
    launchAssetCount: z.number().nullable(),
    averagePayloadBytes: z.number().nullable(),
  }),
});

const appRef = z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS) });

const preview = z.object({
  app: appRef,
  project: z.object({ id: z.string(), fullName: z.string() }),
  channel: z.string(),
  branch: z.string(),
  group: z.string(),
  updateId: z.string(),
  runtimeVersion: z.string().nullable(),
  from: z.number().int(),
  to: z.number().int(),
  summary: z.string(),
  irreversible: z
    .boolean()
    .describe('True for 100: the rollout ends and nothing here lowers it again.'),
  confirmHash: z
    .string()
    .describe('Send it back to apply. Valid only while Expo still shows `from`.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});

const result = z.object({
  app: appRef,
  group: z.string(),
  updateId: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  confirmedByReread: z
    .boolean()
    .describe('The answer of Expo was lost and a read afterwards showed the new share.'),
});

export const easUpdateOperations: Draft[] = [
  {
    id: 'getExpoUpdates',
    method: 'get',
    path: `${W}/apps/{appId}/expo/updates`,
    tags: ['eas'],
    summary:
      'EAS Update of the linked Expo project: channels, branches, newest updates, rollouts and the runtime version check',
    description:
      'READS EXPO live (two requests: channels with branches and updates, and the finished store builds of the platform), audited as `credential.use` with purpose `eas.update`; nothing is stored. Only the updates and builds of the platform of this app record are shown. `runtimeCheck` compares the runtime version of the newest update of each channel with the store builds that name the channel: `mismatch` means the update would reach no shipped binary. "Shipped" is approximated by a finished build with store distribution (whether it was submitted is not read). `409 expo_not_linked`; `422` `credential_not_found` / `platform_unsupported` / `expo_auth` / `expo_forbidden` / `expo_not_found`; `429` (30 a minute per workspace, or Expo said to slow down); `502` `expo_unavailable`; `504` `timeout`. Needs `apps.read`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    responses: { '200': { description: 'What Expo shows now.', schema: z.object({ state }) } },
  },
  {
    id: 'getExpoUpdateInsights',
    method: 'get',
    path: `${W}/apps/{appId}/expo/updates/{group}/insights`,
    tags: ['eas'],
    summary:
      'Insights of one update group: launches, failed launches, crash rate, unique users and payload size',
    description: `READS EXPO live, audited as \`credential.use\` with purpose \`eas.update_insights\`. \`group\` is an update group id (a UUID); the insights are those of the update of this app record's platform in that group, over the last \`days\` (1 to ${INSIGHTS_MAX_DAYS}, default ${INSIGHTS_DEFAULT_DAYS}; the limit is ours, Expo's own is unverified). \`422\` \`invalid_group\` / \`invalid_days\` / \`expo_not_found\`; the other codes of \`getExpoUpdates\`. Needs \`apps.read\`.`,
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    query: z.object({
      days: z
        .string()
        .optional()
        .describe(`Whole days, 1 to ${INSIGHTS_MAX_DAYS}. Default ${INSIGHTS_DEFAULT_DAYS}.`),
    }),
    responses: { '200': { description: 'The insights.', schema: z.object({ insights }) } },
  },
  {
    id: 'previewExpoUpdateRollout',
    method: 'post',
    path: `${W}/apps/{appId}/expo/updates/rollout/preview`,
    tags: ['eas'],
    summary:
      'Preview raising the rollout of an update: the current share, the new one and a confirmHash',
    description:
      'READS EXPO, writes nothing (audited as `credential.use`, purpose `eas.update_rollout`). `group` is the update group whose update of this platform is mid-rollout; `percentage` the new share, a whole percent above the current one (100 ends the rollout). `409 rollout_not_found` when no update of that group is mid-rollout among the newest groups read; `422` `invalid_group` / `invalid_rollout` / `rollout_not_raised` (the share only goes up here; lowering or reverting needs the Expo CLI). Needs `releases.rollout` and `KILN_EAS_UPDATE_ROLLOUT_ENABLED=true` (`409 eas_update_write_disabled` otherwise).',
    risk: 'read',
    access: { action: 'releases.rollout' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    body: rolloutPreviewBody,
    responses: { '200': { description: 'The preview.', schema: z.object({ preview }) } },
  },
  {
    id: 'applyExpoUpdateRollout',
    method: 'post',
    path: `${W}/apps/{appId}/expo/updates/rollout/apply`,
    tags: ['eas'],
    summary:
      'Raise the rollout of an update at Expo (what clients receive; 100 ends the rollout and cannot be lowered here)',
    description:
      'AN EXPO WRITE (`update.setRolloutPercentage`, as `eas update:edit` does). Needs `releases.rollout` (owner and admin), `KILN_EAS_UPDATE_ROLLOUT_ENABLED=true` and, when the workspace policy covers `rollout`, a step-up confirmation bound to the app and the `confirmHash`. `confirmHash` must come from a preview of exactly this request. Expo is READ AGAIN right before the write: if the rollout is not the one previewed nothing is written (`409 state_changed`, with a new `confirmHash` when the rollout still exists). Never retried: after a timeout or a 5xx the update is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`) or `409 outcome_unknown` (check at Expo, then preview again). One write per update at a time (`409 write_in_progress`). Audited as `eas.update_rollout_changed` / `eas.update_rollout_failed` (ids and values, never a token).',
    risk: 'destructive',
    access: { action: 'releases.rollout' },
    appScope: { kind: 'param', name: 'appId' },
    rateLimited: true,
    body: rolloutApplyBody,
    responses: {
      '200': { description: 'The share before and after.', schema: z.object({ result }) },
    },
  },
];
