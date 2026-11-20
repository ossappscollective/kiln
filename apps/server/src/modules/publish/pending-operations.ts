import { z } from 'zod';
import { publishApplyBody, publishPreviewBody } from './pending-routes.ts';
import { type Draft, platform, reviewStore, stagedAppSchema, timestamp, W } from '../../operations/shared.ts';

const publishStepEnum = z.enum(['push_draft', 'submit', 'release', 'rollout']);

const pendingProblemSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  item: z.string().optional(),
});

const pendingItemSchema = z.object({
  kind: z.enum([
    'listing_text',
    'asset_set',
    'release_field',
    'pushed_draft',
    'draft_release',
    'in_review',
    'approved',
    'rollout_step',
  ]),
  platform: platform,
  id: z.string().describe('Stable within the kind.'),
  label: z.string().describe('One sentence for a list. Never a staged text.'),
  state: z.enum(['staged', 'invalid', 'pushed', 'in_review', 'approved', 'due']),
  problems: z
    .array(pendingProblemSchema)
    .describe('An `error` blocks the step this item waits for.'),
  nextStep: publishStepEnum
    .nullable()
    .describe('The publish step this item waits for. Null: informational (in review).'),
  counts: z.record(z.number()),
  refs: z
    .array(
      z.object({ id: z.string(), locale: z.string().optional(), field: z.string().optional() }),
    )
    .describe('Ids only, at most 200.'),
  truncated: z.boolean(),
  since: timestamp.nullable(),
});

const pendingTotalsSchema = z.object({
  items: z.number().int(),
  actionable: z.number().int(),
  blocking: z.number().int(),
});

const pendingViewSchema = z.object({
  app: stagedAppSchema,
  platforms: z.array(
    z.object({
      platform: platform,
      store: reviewStore,
      items: z.array(pendingItemSchema),
      totals: pendingTotalsSchema,
    }),
  ),
  totals: pendingTotalsSchema.extend({
    platforms: z.array(platform),
    nextSteps: z.array(publishStepEnum),
  }),
  lastSyncedAt: timestamp.nullable(),
  generatedAt: timestamp,
});

const pendingSummarySchema = z.object({
  apps: z
    .array(
      z.object({
        appId: z.string(),
        id: z.string(),
        app: stagedAppSchema,
        count: z.number().int().describe('Items that wait for a publish step.'),
        blocking: z.number().int().describe('Items with an error.'),
        waiting: z.number().int().describe('Informational items (in review).'),
        kinds: z.array(z.string()),
        nextSteps: z.array(publishStepEnum),
      }),
    )
    .describe('Only apps with something pending or in review.'),
  totals: z.object({ apps: z.number().int(), count: z.number().int(), blocking: z.number().int() }),
  generatedAt: timestamp,
});

const publishConfigSchema = z.object({
  enabled: z.boolean(),
  envName: z.string(),
  action: z.string(),
  minimumRole: z.string(),
  steps: z.record(
    z.object({
      action: z.string(),
      envName: z.string(),
      enabled: z.boolean(),
      irreversible: z.boolean(),
    }),
  ),
  phrase: z.string(),
  note: z.string(),
});

const planStepSchema = z.object({
  type: publishStepEnum,
  platform: platform,
  order: z.number().int(),
  label: z.string(),
  requested: z.boolean(),
  included: z.boolean().describe('Part of the plan: available and asked for. Only these run.'),
  availability: z.enum([
    'available',
    'feature_disabled',
    'forbidden',
    'nothing_to_do',
    'blocked',
    'needs_input',
    'not_requested',
  ]),
  reason: z.string().nullable(),
  requires: z.object({
    action: z.string(),
    envName: z.string(),
    enabled: z.boolean(),
    allowed: z.boolean(),
  }),
  irreversible: z.boolean(),
  deferred: z
    .boolean()
    .describe(
      'Previewed again after the earlier steps applied; `summary` is a promise it must keep, else the step is skipped as `plan_drifted`.',
    ),
  summary: z.record(z.unknown()).nullable(),
  request: z
    .record(z.unknown())
    .nullable()
    .describe('The step as to send it back to `publishStoreBatch`.'),
  preview: z
    .record(z.unknown())
    .nullable()
    .describe(
      'The preview the step’s own route gives (null for a deferred step that cannot be previewed yet).',
    ),
  confirmHash: z.string().nullable(),
  stepPhrase: z
    .string()
    .nullable()
    .describe('The phrase the step’s own gate asks for. The batch phrase stands in for it.'),
  problems: z.array(pendingProblemSchema),
});

const publishPlanSchema = z.object({
  app: stagedAppSchema,
  steps: z.array(planStepSchema),
  publishSteps: z
    .array(z.record(z.unknown()))
    .describe('The `steps` to send to `publishStoreBatch`.'),
  included: z.number().int(),
  irreversible: z.boolean(),
  irreversibleSteps: z.array(publishStepEnum),
  warnings: z.array(z.string()),
  confirmable: z
    .boolean()
    .describe('Every requested step is available and at least one is included.'),
  planHash: z.string().nullable().describe('Null while the plan is not confirmable.'),
  confirmationRequired: z.boolean(),
  confirmation: z
    .object({ phrase: z.string(), instruction: z.string() })
    .nullable()
    .describe('The ONE phrase to type for the whole batch.'),
  direct: z
    .object({
      track: z.string(),
      versionCodes: z.array(z.string()),
      stagedFraction: z.number().nullable(),
    })
    .nullable()
    .describe(
      'Google Play: the track and version codes the staged release fields name (and the staged intended share), so a release can be made from them in one step. Never a note.',
    ),
  defaultedToDirect: z
    .boolean()
    .describe(
      'Google Play: no `steps` were sent and only release fields are staged, so the plan is ONE direct release step (the share still needs input) instead of push, submit and release. Send `steps: [{ "type": "push_draft" }]` to save only as a draft.',
    ),
  readAt: timestamp,
});

const publishStepResultSchema = z.object({
  type: publishStepEnum,
  status: z.enum(['applied', 'skipped', 'failed']),
  confirmedByReread: z
    .boolean()
    .optional()
    .describe('Applied: the store did not answer and reading it back showed the change.'),
  result: z
    .record(z.unknown())
    .optional()
    .describe('Applied: the result the individual route gives.'),
  reason: z
    .enum(['previous_step_not_applied', 'plan_drifted', 'blocked', 'preview_failed'])
    .optional()
    .describe('Skipped.'),
  checks: z
    .array(z.string())
    .optional()
    .describe('Skipped as `blocked`: the codes of the blocking checks.'),
  error: z
    .string()
    .optional()
    .describe(
      'Failed: the individual error code (`state_changed`, `blocked`, `outcome_unknown`, `write_in_progress`, ...).',
    ),
  httpStatus: z
    .number()
    .int()
    .optional()
    .describe('Failed: the status the individual route would have answered.'),
  outcome: z
    .enum(['refused', 'not_applied', 'unknown', 'partial'])
    .optional()
    .describe(
      'Failed: `refused` nothing changed, `not_applied` read back and not applied, `unknown` look at the store, `partial` some of it was written.',
    ),
  code: z.string().optional(),
  message: z.string().optional(),
  detail: z
    .record(z.unknown())
    .optional()
    .describe(
      'Failed: the rest of the individual error body (for example a new `preview` after `state_changed`).',
    ),
});

const publishResultSchema = z.object({
  app: stagedAppSchema,
  planHash: z.string(),
  completed: z.boolean().describe('Every included step was applied.'),
  applied: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  stoppedAt: publishStepEnum
    .nullable()
    .describe('The first step that was not applied; the steps after it were skipped.'),
  steps: z.array(publishStepResultSchema),
  pending: pendingTotalsSchema.describe('The stored pending state after the batch.'),
  publishedAt: timestamp,
});

export const pendingOperations: Draft[] = [
  {
    id: 'getAppPending',
    method: 'get',
    path: `${W}/apps/{id}/pending`,
    tags: ['pending'],
    summary: 'Everything the app has pending in one place, with the step that publishes each item',
    description:
      'Read-only, from the data stored here: no store and no repository is read, so it is cheap and needs no switch. One list of items per platform. Each item has a `kind`, a `state`, its `problems` (an `error` blocks the step it waits for) and the `nextStep` that publishes it (`push_draft`, `submit`, `release`, `rollout`; null for an item that only waits for the store). What is said about versions is as of the last store sync (`lastSyncedAt`). Counts and ids only: never a staged text.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The pending items.',
        schema: z.object({ pending: pendingViewSchema }),
      },
    },
  },
  {
    id: 'getPendingSummary',
    method: 'get',
    path: `${W}/pending/summary`,
    tags: ['pending'],
    summary: 'Which apps have pending changes, with counts and kinds',
    description:
      'Same facts as `getAppPending`, one line per app that has something pending or in review (an app that is not listed has nothing). Stored state only. A token limited to some apps sees only those apps.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'list' },
    responses: {
      '200': { description: 'One line per app and the totals.', schema: pendingSummarySchema },
    },
  },
  {
    id: 'getStorePublishConfig',
    method: 'get',
    path: `${W}/store-publish/config`,
    tags: ['pending'],
    summary: 'Whether publishing several steps at once is switched on, and what each step needs',
    risk: 'read',
    access: { action: 'apps.read' },
    responses: {
      '200': {
        description: 'The switch, the action, the phrase and the switch of every step.',
        schema: publishConfigSchema,
      },
    },
  },
  {
    id: 'previewStoreBatch',
    method: 'post',
    path: `${W}/apps/{id}/publish/preview`,
    tags: ['pending'],
    summary:
      'Preview publishing several steps at once: the plan, each step’s preview, a planHash and ONE phrase',
    description:
      'Needs `store.publish` and `MRM_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`). READS the stores through the steps’ own preview functions and writes nothing. `steps` (optional) names the steps and their input; without it every step that is available and has work is included. Each step in the plan says whether it is `available` or why not (`feature_disabled`: its own switch is off; `forbidden`: the caller or token lacks the step’s own right; `nothing_to_do`; `blocked`: errors stand in the way; `needs_input`: for example a Google Play release without a track or share). A step that needs an earlier one (submit after a push, a Play release after a push) is `deferred`: it is previewed again after the earlier step applied and runs only if it matches its promised `summary`. `planHash` covers the included steps, their input, their confirmHashes and phrases; it is null while a requested step is not available. `confirmation.phrase` (`publish <app name> <n> steps`) is the ONE phrase to type when any included step is irreversible.',
    risk: 'read',
    access: { action: 'store.publish' },
    appScope: { kind: 'param', name: 'id' },
    body: publishPreviewBody,
    responses: {
      '200': { description: 'The plan.', schema: z.object({ plan: publishPlanSchema }) },
    },
  },
  {
    id: 'publishStoreBatch',
    method: 'post',
    path: `${W}/apps/{id}/publish`,
    tags: ['pending'],
    summary: 'PUBLISH several steps at once with one confirmation (can be irreversible)',
    description:
      'A STORE WRITE, possibly several that cannot be taken back. Needs `store.publish` AND, for every step in `steps`, that step’s right (`store.push_draft`, `store.submit`, `store.release`, `releases.rollout`): an owner or admin, or a token whose actions name the batch and every step (`403 forbidden`, listing the missing steps). Needs `MRM_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`) and each step’s own switch (`409 step_disabled`). `phrase` must be the `confirmation.phrase` of the plan when a step is irreversible (`422 confirmation_mismatch`, nothing read or written). The plan is rebuilt and must have the `planHash` previewed (`409 plan_changed`, with the new `plan`; `409 plan_blocked` when a step is no longer available). The steps then run IN ORDER through their own services, each with its own claim, its own re-read of the store and its own refusal on drift (`state_changed` is a failed step, not a retry). The batch STOPS at the first step that is not applied: the rest are `skipped` (`previous_step_not_applied`). Nothing is ever retried; an unknown outcome is read back by the step and reported (`outcome: unknown`: look at the store). A deferred step that no longer matches its promise is skipped as `plan_drifted`. One publish per app at a time (`409 publish_in_progress`). The answer is `200` with the result of every step even when a step failed: look at `completed`, `stoppedAt` and `steps`. Audited as `pending.published` (ids, hashes, per step outcomes; never a text or a credential) and emitted as the event `pending.published` when something was applied.',
    risk: 'destructive',
    access: { action: 'store.publish' },
    appScope: { kind: 'param', name: 'id' },
    body: publishApplyBody,
    responses: {
      '200': {
        description: 'What happened to every step.',
        schema: z.object({ result: publishResultSchema }),
      },
    },
  },
];
