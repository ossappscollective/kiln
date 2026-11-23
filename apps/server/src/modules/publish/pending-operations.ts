import { z } from 'zod';
import {
  type Draft,
  platform,
  reviewStore,
  stagedAppSchema,
  timestamp,
  W,
} from '../../operations/shared.ts';
import { cartDiscardBody, cartPublishBody } from './cart-routes.ts';
import { publishApplyBody, publishPreviewBody } from './pending-routes.ts';

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


const cartItemSchema = z.object({
  id: z.string().describe('`<kind>:<id>`; the id to send back to publish or discard.'),
  kind: z.enum(['listing', 'graphics', 'release', 'review_reply']),
  title: z.string(),
  summary: z.string().nullable().describe('Short excerpt of the new text (a listing text or a reply). Null for graphics.'),
  before: z.string().nullable().describe('Short excerpt of what the store has now, when known.'),
  platform: platform,
  store: z.enum(['appstoreconnect', 'googleplay']),
  locale: z.string().nullable(),
  createdAt: timestamp,
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  risk: z.enum(['store_draft', 'public_reply']),
  needsApproval: z.boolean().describe('The workspace step-up policy asks the person to confirm the send again.'),
  publishable: z.boolean(),
  reason: z
    .object({
      code: z.enum(['no_right', 'switch_off', 'invalid', 'bundle_blocked', 'in_progress', 'outcome_unknown']),
      action: z.string().optional(),
      envName: z.string().optional(),
    })
    .nullable()
    .describe('Why it cannot be published now. The item is still listed.'),
  canDiscard: z.boolean(),
  bundle: z.string().nullable().describe('Items with the same bundle are written by one push: all or none.'),
  version: z.string().describe('Send it back with the id: a changed item is skipped (`changed_since_review`).'),
  counts: z
    .record(z.number())
    .describe('Graphics: `files` (after), `uploads`, and `before` (images the last store read held for the set, when there was one).'),
  thumbs: z.array(z.string()).describe('Graphics: blob ids of up to four uploaded files of the set (`GET .../staged/assets/blob?oid=`). Empty otherwise.'),
  problems: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string() })),
  ref: z.object({
    locale: z.string().optional(),
    field: z.string().optional(),
    slot: z.string().optional(),
    reviewId: z.string().optional(),
  }),
  review: z
    .object({
      rating: z.number().int(),
      excerpt: z.string(),
      language: z.string().nullable(),
      territory: z.string().nullable(),
      status: z.string(),
    })
    .optional()
    .describe('Reply items: the review it answers.'),
});

const cartResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['ok', 'failed', 'skipped']),
      reason: z.string().nullable(),
      httpStatus: z.number().int().optional(),
    }),
  ),
  remaining: z.number().int().describe('Items still in the cart after this call.'),
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
    id: 'getAppPendingCart',
    method: 'get',
    path: `${W}/apps/{id}/pending/cart`,
    tags: ['pending'],
    summary: 'The pending cart: what was prepared here and not sent yet, one typed list',
    description:
      'Read-only, stored state only (no store or repository is read). Items: staged listing texts (`listing`), staged graphics sets (`graphics`), staged release fields (`release`) and reply drafts (`review_reply`). An item the caller cannot publish is listed with its `reason` (`no_right`, `switch_off`, `invalid`, ...) and `publishable: false`. `can` says what the caller may do per kind. Submitting, releasing and rollout steps are not here (see `getAppPending`).',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The items, ordered by kind then age.',
        schema: z.object({
          cart: z.object({
            items: z.array(cartItemSchema),
            can: z.object({
              push: z.boolean(),
              reply: z.boolean(),
              discardStaged: z.boolean(),
              discardReply: z.boolean(),
            }),
            generatedAt: timestamp,
          }),
        }),
      },
    },
  },
  {
    id: 'publishAppPendingCart',
    method: 'post',
    path: `${W}/apps/{id}/pending/publish`,
    tags: ['pending'],
    summary: 'PUBLISH the chosen items of the pending cart (staged changes as a store draft, replies publicly)',
    description:
      'A STORE WRITE. Takes an explicit list of `{ id, version }` from `getAppPendingCart` and sends only those. Delegates to the push of the staged changes (`KILN_STORE_DRAFT_WRITE_ENABLED`, `store.push_draft`, step-up; a store DRAFT, nothing is submitted) and to the reply send (`KILN_REVIEW_REPLY_ENABLED`, `reviews.reply`; public at once), with their own gates, claims, re-reads and audit. Staged changes are written by one push, so they form a bundle: a request that names only part of it is skipped (`bundle_incomplete`). An item that changed since it was listed is skipped (`changed_since_review`); one that is gone is skipped (`not_pending`), so repeating a request is safe. One failure never stops the others: the answer is `200` with a result per item (`ok`, `failed`, `skipped` and a reason code). Audited as `pending.cart_published` (ids and outcome codes, never a text).',
    risk: 'destructive',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    body: cartPublishBody,
    responses: { '200': { description: 'A result per item.', schema: z.object({ result: cartResultSchema }) } },
  },
  {
    id: 'discardAppPendingCart',
    method: 'post',
    path: `${W}/apps/{id}/pending/discard`,
    tags: ['pending'],
    summary: 'Discard the chosen items of the pending cart (Kiln’s draft only; the store is not touched)',
    description:
      'Removes the staged change or the reply draft here and nothing else: no store is contacted. Needs `changesets.write` for staged changes and `reviews.triage` for reply drafts (an item without the right is skipped as `no_right`). A reply draft in flight or with an unknown outcome is kept. Audited as `pending.cart_discarded`.',
    risk: 'write',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    body: cartDiscardBody,
    responses: { '200': { description: 'A result per item.', schema: z.object({ result: cartResultSchema }) } },
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
      'Needs `store.publish` and `KILN_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`). READS the stores through the steps’ own preview functions and writes nothing. `steps` (optional) names the steps and their input; without it every step that is available and has work is included. Each step in the plan says whether it is `available` or why not (`feature_disabled`: its own switch is off; `forbidden`: the caller or token lacks the step’s own right; `nothing_to_do`; `blocked`: errors stand in the way; `needs_input`: for example a Google Play release without a track or share). A step that needs an earlier one (submit after a push, a Play release after a push) is `deferred`: it is previewed again after the earlier step applied and runs only if it matches its promised `summary`. `planHash` covers the included steps, their input, their confirmHashes and phrases; it is null while a requested step is not available. `confirmation.phrase` (`publish <app name> <n> steps`) is the ONE phrase to type when any included step is irreversible.',
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
      'A STORE WRITE, possibly several that cannot be taken back. Needs `store.publish` AND, for every step in `steps`, that step’s right (`store.push_draft`, `store.submit`, `store.release`, `releases.rollout`): an owner or admin, or a token whose actions name the batch and every step (`403 forbidden`, listing the missing steps). Needs `KILN_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`) and each step’s own switch (`409 step_disabled`). `phrase` must be the `confirmation.phrase` of the plan when a step is irreversible (`422 confirmation_mismatch`, nothing read or written). The plan is rebuilt and must have the `planHash` previewed (`409 plan_changed`, with the new `plan`; `409 plan_blocked` when a step is no longer available). The steps then run IN ORDER through their own services, each with its own claim, its own re-read of the store and its own refusal on drift (`state_changed` is a failed step, not a retry). The batch STOPS at the first step that is not applied: the rest are `skipped` (`previous_step_not_applied`). Nothing is ever retried; an unknown outcome is read back by the step and reported (`outcome: unknown`: look at the store). A deferred step that no longer matches its promise is skipped as `plan_drifted`. One publish per app at a time (`409 publish_in_progress`). The answer is `200` with the result of every step even when a step failed: look at `completed`, `stoppedAt` and `steps`. Audited as `pending.published` (ids, hashes, per step outcomes; never a text or a credential) and emitted as the event `pending.published` when something was applied.',
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
