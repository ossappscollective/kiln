import { z } from 'zod';
import {
  type Draft,
  platform,
  reviewStore,
  stagedAppSchema,
  timestamp,
  W,
} from '../../operations/shared.ts';
import { stagedPriceSchema } from '../monetization/operations.ts';
import { cartDiscardBody, cartPublishBody } from './cart-routes.ts';
import { publishApplyBody, publishPreviewBody } from './pending-routes.ts';

const publishStepEnum = z.enum(['push_draft', 'push_and_submit', 'submit', 'release', 'rollout']);

const pendingProblemSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  item: z.string().optional(),
});

const publishingSchema = z
  .object({
    startedAt: timestamp.describe('When the batch took its claim.'),
    steps: z
      .array(publishStepEnum)
      .describe('The steps it runs, in order. Empty for a claim older than migration 71.'),
    currentStep: publishStepEnum
      .nullable()
      .describe('The step that runs now; null before the first starts and between steps.'),
    stepStartedAt: timestamp.nullable().describe('When the current step started.'),
    by: z
      .object({ id: z.string(), name: z.string().nullable() })
      .nullable()
      .describe('Who started it (`name` is null when the person is gone).'),
    heartbeatAt: timestamp.describe(
      'The last sign of life of the process that runs it (a timer renews it every 20 seconds, also inside a step).',
    ),
    detail: z
      .object({
        phase: z.enum(['writing_texts', 'uploading_images', 'processing_images', 'placing_images']),
        done: z.number().int().nullable(),
        total: z.number().int().nullable(),
        at: timestamp,
      })
      .nullable()
      .describe(
        'What the running step says it is doing, as a fixed word and two counts (`uploading_images` 12 of 40); null when it says nothing. Never a text of the store.',
      ),
    stepsDone: z.number().int().describe('How many steps ended applied so far.'),
    interruptible: z
      .boolean()
      .describe(
        'The server lets a person end this claim now (`interruptStorePublish`): it has been silent for a minute, or it has run longer than any batch should (15 minutes).',
      ),
  })
  .nullable()
  .describe(
    'A batch publish of this app that is running now, else null. A claim whose heartbeat is older than 2 minutes (a process that died) is not reported and becomes an `interrupted` run. Ids, step names, times and counts only.',
  );

const storeFactsSchema = z
  .object({
    kind: z
      .string()
      .describe('The connector\u2019s kind of error (`unexpected`, `forbidden`, ...).'),
    httpStatus: z.number().int().optional(),
    details: z
      .array(
        z.object({
          code: z.string().optional(),
          title: z.string().optional(),
          detail: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        'The store\u2019s own words (its reason code, status word and sentence), sanitised: no credential or token.',
      ),
  })
  .describe('What the store answered. Sanitised.');

const runStepSchema = z.object({
  type: publishStepEnum,
  status: z.enum(['applied', 'skipped', 'failed']),
  startedAt: timestamp,
  finishedAt: timestamp,
  error: z
    .string()
    .optional()
    .describe('Failed: the error code (`store_rejected`, `state_changed`, ...).'),
  httpStatus: z.number().int().optional(),
  outcome: z.enum(['refused', 'not_applied', 'unknown', 'partial']).optional(),
  reason: z.string().optional().describe('Skipped: why.'),
  blockers: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        locale: z.string().optional(),
        item: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      'Skipped as `blocked`: what stood in the way (the check code, its sentence, the locale and field it is about; at most 20). Absent from runs kept before this was added.',
    ),
  message: z
    .string()
    .optional()
    .describe('The server\u2019s sentence, sanitised and cut to 500 characters.'),
  code: z
    .string()
    .optional()
    .describe(
      'The catalogue code of that sentence or of the store\u2019s cause (`store.google.draftApp`).',
    ),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  store: storeFactsSchema.optional(),
});

const lastPublishSchema = z
  .object({
    id: z.string(),
    platform: platform,
    startedAt: timestamp,
    finishedAt: timestamp,
    outcome: z.enum(['completed', 'partial', 'failed']),
    completed: z.boolean(),
    steps: z.array(publishStepEnum),
    results: z.array(runStepSchema),
    by: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    dismissed: z.boolean().describe('A person hid this failure; a newer run is not hidden by it.'),
  })
  .describe(
    'A batch publish of an app that was kept (the newest five per app). Ids, step names, codes, HTTP statuses, times and sanitised words of the store; never a credential, a request or an upload.',
  );

const lastFailedPublishSchema = lastPublishSchema
  .nullable()
  .describe(
    'The latest batch publish of this app when it did not complete (a failed or partial run); null when the latest run went through or there was none.',
  );

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

const cartImageSchema = z.object({
  position: z.number().int(),
  name: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  url: z
    .string()
    .describe(
      'A same origin address of one of Kiln\u2019s own image routes; never a store address.',
    ),
});

const cartItemSchema = z.object({
  id: z.string().describe('`<kind>:<id>`; the id to send back to publish or discard.'),
  kind: z.enum(['listing', 'graphics', 'release', 'price', 'review_reply']),
  title: z.string(),
  summary: z
    .string()
    .nullable()
    .describe('Short excerpt of the new text (a listing text or a reply). Null for graphics.'),
  before: z.string().nullable().describe('Short excerpt of what the store has now, when known.'),
  platform: platform,
  store: z.enum(['appstoreconnect', 'googleplay']),
  locale: z.string().nullable(),
  createdAt: timestamp,
  author: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  risk: z
    .enum(['store_draft', 'public_reply', 'financial'])
    .describe('`financial`: a price change, charged to customers; the strictest gates.'),
  needsApproval: z
    .boolean()
    .describe('The workspace step-up policy asks the person to confirm the send again.'),
  publishable: z.boolean(),
  reason: z
    .object({
      code: z.enum([
        'no_right',
        'switch_off',
        'workspace_off',
        'invalid',
        'bundle_blocked',
        'in_progress',
        'outcome_unknown',
      ]),
      action: z.string().optional(),
      envName: z.string().optional(),
    })
    .nullable()
    .describe('Why it cannot be published now. The item is still listed.'),
  canDiscard: z.boolean(),
  bundle: z
    .string()
    .nullable()
    .describe('Items with the same bundle are written by one push: all or none.'),
  version: z
    .string()
    .describe('Send it back with the id: a changed item is skipped (`changed_since_review`).'),
  counts: z
    .record(z.number())
    .describe(
      'Graphics: `files` (after), `uploads`, and `before` (images the last store read held for the set, when there was one).',
    ),
  thumbs: z
    .array(z.string())
    .describe(
      'Graphics: addresses (`GET .../staged/assets/blob?oid=`, relative to the server) of up to four uploaded files of the set. Empty otherwise.',
    ),
  problems: z.array(
    z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string() }),
  ),
  ref: z.object({
    locale: z.string().optional(),
    field: z.string().optional(),
    slot: z.string().optional(),
    reviewId: z.string().optional(),
  }),
  price: stagedPriceSchema
    .optional()
    .describe(
      'Price items: before and after per territory (minor units), percent change in basis points, date, what happens to existing subscribers.',
    ),
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
      price: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Price items: per territory what the store did (`applied`, `already_applied`, `failed`, `unknown`, `not_sent`) with before and after amounts, `verification` (`confirmed`: the re-read shows the asked prices; `store_shows`: it shows others, with `mismatches`; `unverified`), and the existing-subscriber migration outcome.',
        ),
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
  publishing: publishingSchema,
  lastPublish: lastFailedPublishSchema,
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
        publishing: publishingSchema,
        lastPublish: lastFailedPublishSchema,
      }),
    )
    .describe(
      'Only apps with something pending or in review, or with a publish running (`count` can be 0 then).',
    ),
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
  oneCommit: z
    .boolean()
    .describe(
      'Google Play: `push_and_submit` and `release` named together are ONE step: the texts, the graphics and the release go in one edit and one commit (never two commits that each send for review). The `push_and_submit` step carries the whole content (`summary.release`); the `release` step runs nothing of its own.',
    ),
  replacesReview: z
    .boolean()
    .describe(
      'The commit replaces the review that Google Play has in progress with everything together (`CANCEL_IN_REVIEW_AND_SUBMIT`). Only when the step asked for `replaceReview`; never implied.',
    ),
  combined: z
    .object({
      offered: z
        .boolean()
        .describe('The plan lists the combined step beside the push and the submit.'),
      draftRefused: z
        .boolean()
        .describe(
          'Google Play refused to keep a draft for this app on its last run (`draft_not_allowed`), and no draft push went through since.',
        ),
      defaulted: z
        .boolean()
        .describe(
          'No `steps` were sent and `draftRefused` holds, so the plan was made with `push_and_submit` instead of `push_draft` + `submit` (the pair stays selectable).',
        ),
    })
    .describe(
      'Google Play: the push and the submit as ONE step (`push_and_submit`: one commit without the hold-back, so Google sends the changes for review). Never a fallback: it runs only when a plan names it and the person confirmed it.',
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
  blockers: runStepSchema.shape.blockers,
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
  lastPublish: lastPublishSchema
    .nullable()
    .describe(
      'This run as the server keeps it, with the reason each failed step gave; null when it could not be kept.',
    ),
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
              price: z.boolean(),
            }),
            publishing: publishingSchema,
            generatedAt: timestamp,
          }),
        }),
      },
    },
  },
  {
    id: 'getAppPendingCartDetail',
    method: 'get',
    path: `${W}/apps/{id}/pending/cart/detail`,
    tags: ['pending'],
    summary: 'One cart item with its full before and after (text, images or reply) for a preview',
    description:
      'Read-only, stored state only (no store or repository is read), same right as `getAppPendingCart` (`listing.read`). `id` is the id of an item of that cart (`listing:\u2026`, `graphics:\u2026`, `release:\u2026`, `review_reply:\u2026`; a `price:\u2026` item carries no extra: its before and after per territory are in the cart). A listing text carries the staged text and the text last known in the store (`before`, null when none is stored), a release field its staged value (`before` is null: the store is not read), a graphics set the images the last remembered store read held (`before`, null when there was no read) and the staged files, as same origin image addresses of Kiln\u2019s own routes, a reply the draft and the review it answers. A text over 8000 characters is cut (`truncated`); at most 30 images per side. The item must be in this app\u2019s cart (404 otherwise, also for another workspace\u2019s id). `version` is the item\u2019s version in the cart.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      id: z.string().min(3).max(220).describe('The id of a cart item, `<kind>:<id>`.'),
    }),
    responses: {
      '200': {
        description: 'The detail of the item.',
        schema: z.object({
          detail: z.object({
            id: z.string(),
            kind: z.enum(['listing', 'graphics', 'release', 'price', 'review_reply']),
            version: z.string(),
            text: z
              .object({
                field: z.string(),
                locale: z.string().nullable(),
                before: z.string().nullable(),
                after: z.string(),
                limit: z.number().int().nullable(),
                unit: z.enum(['characters', 'bytes']),
                truncated: z.boolean(),
              })
              .optional(),
            graphics: z
              .object({
                before: z.array(cartImageSchema).nullable(),
                beforeReadAt: timestamp.nullable(),
                after: z.array(cartImageSchema),
                truncated: z.boolean(),
              })
              .optional(),
            reply: z
              .object({
                text: z.string(),
                truncated: z.boolean(),
                review: z.object({
                  rating: z.number().int(),
                  title: z.string().nullable(),
                  body: z.string(),
                  language: z.string().nullable(),
                  territory: z.string().nullable(),
                  truncated: z.boolean(),
                }),
              })
              .optional(),
          }),
        }),
      },
    },
  },
  {
    id: 'getAppPendingItemDetail',
    method: 'get',
    path: `${W}/apps/{id}/pending/detail`,
    tags: ['pending'],
    summary:
      'What one pending item that is not a staged change contains (pushed draft, release, rollout)',
    description:
      'Read-only, stored state only (no store is contacted), same right as `getAppPending` (`listing.read`). `kind` and `id` are the `kind` and `id` of an item of `getAppPending`; the staged kinds (`listing_text`, `asset_set`, `release_field`) are cart items, read with `getAppPendingCartDetail` (`listing:<ref id>`, `graphics:<id>`, `release:<id>`). A pushed draft lists what the push wrote (locale and field of each text, locale, slot and file count of each set, the draft release of Google Play): never a text, a file or a hash. A draft release carries track and version codes, a version in review or approved its version, track and status as of the last sync, a due rollout step the plan version, percent and planned time. At most 200 texts and 200 sets (`truncated`). `404` when the item is not in this app\u2019s pending view now (also for another workspace\u2019s app), `400` for a missing or unknown `kind` or a missing `id`.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      kind: z.enum(['pushed_draft', 'draft_release', 'in_review', 'approved', 'rollout_step']),
      id: z.string().min(1).max(220).describe('The id of the item in the pending view.'),
    }),
    responses: {
      '200': {
        description: 'The detail of the item.',
        schema: z.object({
          detail: z.object({
            kind: z.enum([
              'pushed_draft',
              'draft_release',
              'in_review',
              'approved',
              'rollout_step',
            ]),
            id: z.string(),
            pushedDraft: z
              .object({
                versionString: z.string().nullable(),
                pushedAt: timestamp,
                texts: z.array(z.object({ locale: z.string(), field: z.string() })),
                sets: z.array(
                  z.object({
                    locale: z.string(),
                    key: z.string(),
                    kind: z.string(),
                    device: z.string().nullable(),
                    files: z.number().int(),
                  }),
                ),
                release: z.object({ track: z.string(), codes: z.array(z.string()) }).nullable(),
                truncated: z.boolean(),
              })
              .optional(),
            draftRelease: z
              .object({
                track: z.string(),
                codes: z.array(z.string()),
                since: timestamp.nullable(),
              })
              .optional(),
            release: z
              .object({
                version: z.string(),
                track: z.string().nullable(),
                status: z.enum(['in_review', 'approved']),
                since: timestamp.nullable(),
              })
              .optional(),
            rolloutStep: z
              .object({ planVersion: z.string(), percent: z.number(), plannedAt: timestamp })
              .optional(),
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
    summary:
      'PUBLISH the chosen items of the pending cart (staged changes as a store draft, replies publicly)',
    description:
      'A STORE WRITE. Takes an explicit list of `{ id, version }` from `getAppPendingCart` and sends only those. PRICE items (`price:\u2026`, risk `financial`) are the strictest: a request that names one needs `KILN_PRICE_WRITES_ENABLED` and the workspace setting `prices.writeEnabled` (else the item is skipped with reason `switch_off` / `workspace_off`), the right `monetization.price`, step-up (`store.price`, `403 step_up_required` before anything is read) and `confirmation`, the typed phrase `CHANGE <n> PRICES MAX <p>%` naming the number of price items sent and the largest change (`422 confirmation_mismatch` sends NOTHING, not even a reply). Each product is independent (any subset may be named; its territories go together); the live prices are re-read and every rule re-run right before the write (`stale_price`, `currency_mismatch`, `price_point_invalid`, `acknowledgement_required` leave the item staged), and after the write the store is read back: `price.verification` says `confirmed` or `store_shows`. Existing subscribers are untouched unless the staged choice says otherwise. Delegates to the push of the staged changes (`KILN_STORE_DRAFT_WRITE_ENABLED`, `store.push_draft`, step-up; a store DRAFT, nothing is submitted) and to the reply send (`KILN_REVIEW_REPLY_ENABLED`, `reviews.reply`; public at once), with their own gates, claims, re-reads and audit. Staged changes are written by one push, so they form a bundle: a request that names only part of it is skipped (`bundle_incomplete`). An item that changed since it was listed is skipped (`changed_since_review`); one that is gone is skipped (`not_pending`), so repeating a request is safe. One failure never stops the others: the answer is `200` with a result per item (`ok`, `failed`, `skipped` and a reason code). Audited as `pending.cart_published` (ids and outcome codes, never a text). While a batch publish of the app runs (`getPendingPublishing`) this is refused with `409 publish_in_progress`, and the message names when that publish started.',
    risk: 'destructive',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    body: cartPublishBody,
    responses: {
      '200': { description: 'A result per item.', schema: z.object({ result: cartResultSchema }) },
    },
  },
  {
    id: 'discardAppPendingCart',
    method: 'post',
    path: `${W}/apps/{id}/pending/discard`,
    tags: ['pending'],
    summary:
      'Discard the chosen items of the pending cart (Kiln’s draft only; the store is not touched)',
    description:
      'Removes the staged change or the reply draft here and nothing else: no store is contacted. Needs `changesets.write` for staged changes and `reviews.triage` for reply drafts (an item without the right is skipped as `no_right`). A reply draft in flight or with an unknown outcome is kept. Audited as `pending.cart_discarded`. While a batch publish of the app runs (`getPendingPublishing`) this is refused with `409 publish_in_progress`, and the message names when that publish started.',
    risk: 'write',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    body: cartDiscardBody,
    responses: {
      '200': { description: 'A result per item.', schema: z.object({ result: cartResultSchema }) },
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
    id: 'getPendingPublishing',
    method: 'get',
    path: `${W}/pending/publishing`,
    tags: ['pending'],
    summary: 'Which apps have a batch publish running now, and where it is (cheap to poll)',
    description:
      'One read of the publish claims, no pending state is built: the apps of the workspace for which `publishStoreBatch` is running, with the steps it runs, the step that runs now and when it started. Apps that are not listed are not publishing. A claim whose heartbeat (a timer renews it every 20 seconds while the batch runs) is older than 2 minutes is a process that died: it is ended and kept as a run that failed with `interrupted` (outcome `unknown`), and left out. A server that starts again does the same for every claim of the process before it. While an app is listed, `409 publish_in_progress` refuses a second publish, a release, a submit, a rollout change, a push of the staged changes, a version, and a cart publish or discard for it. Stored state only; a token limited to some apps sees only those apps. Ids, step names and times only.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'list' },
    responses: {
      '200': {
        description: 'One entry per app with a publish running (empty when none is).',
        schema: z.object({
          apps: z.array(z.object({ appId: z.string(), publishing: publishingSchema.unwrap() })),
          lastPublish: z
            .array(z.object({ appId: z.string(), lastPublish: lastPublishSchema }))
            .describe(
              'Apps whose latest publish did not complete and was not dismissed, with the reason.',
            ),
          generatedAt: timestamp,
        }),
      },
    },
  },
  {
    id: 'listStorePublishRuns',
    method: 'get',
    path: `${W}/apps/{id}/publish/runs`,
    tags: ['pending'],
    summary:
      'The latest batch publishes of an app (newest first, at most five), with why a step failed',
    description:
      'What `publishStoreBatch` did, kept on the server so a failure survives a reload and shows in another browser: per step the error code, the HTTP status, the outcome, the server\u2019s sentence and what the store said (its reason code and sentence), sanitised and cut. The newest five runs of an app are kept; they are deleted with the app.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The runs, newest first.',
        schema: z.object({ runs: z.array(lastPublishSchema) }),
      },
    },
  },
  {
    id: 'interruptStorePublish',
    method: 'post',
    path: `${W}/apps/{id}/publish/interrupt`,
    tags: ['pending'],
    summary:
      'End the claim of a publish that is silent or has run too long, and keep it as an interrupted run',
    description:
      'For a person who sees "Publishing\u2026" and nothing moves. Needs `store.publish`. Allowed only when the claim says it can be ended (`publishing.interruptible`: no heartbeat for a minute, or running for more than 15 minutes); a batch that is alive and recent is never stopped (`409 still_running`). Nothing is sent to a store: the claim is ended and a run is kept whose running step failed with `interrupted` and outcome `unknown`, so the person is told to look at the store and review again. `404 not_publishing` when no publish of the app runs.',
    risk: 'write',
    access: { action: 'store.publish' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'Ended.', schema: z.object({ interrupted: z.boolean() }) },
    },
  },
  {
    id: 'dismissStorePublishRun',
    method: 'post',
    path: `${W}/apps/{id}/publish/runs/{runId}/dismiss`,
    tags: ['pending'],
    summary: 'Hide the failure of one publish run until a newer run',
    description:
      'Marks the run as dismissed (`lastPublish.dismissed`). Needs `store.publish`. A later run is not hidden by it, and a later run that completes clears the failure by itself. `404 not_found` for a run that is not this app\u2019s.',
    risk: 'write',
    access: { action: 'store.publish' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'Dismissed.', schema: z.object({ dismissed: z.boolean() }) },
    },
  },
  {
    id: 'getPendingCartSummary',
    method: 'get',
    path: `${W}/pending/cart-summary`,
    tags: ['pending'],
    summary: 'How many items the pending carts hold, per app and in total (no item payload)',
    description:
      'The count behind the navigation badge: every app that has something in its pending cart (staged listing texts, graphics, release fields, prices and reply drafts) with the number of items, built by the same function as `getAppPendingCart`, so an app\u2019s `count` equals the length of its cart. Stored state only; no store or repository is read. Apps without anything are not listed. A token limited to some apps sees only those apps. At most 200 apps are read per request.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'list' },
    responses: {
      '200': {
        description: 'One line per app with a non-empty cart, and the totals.',
        schema: z.object({
          apps: z.array(
            z.object({
              appId: z.string(),
              id: z.string(),
              app: stagedAppSchema,
              count: z.number().int().describe('Items in the app\u2019s cart.'),
              kinds: z
                .record(z.string(), z.number().int())
                .describe(
                  'Items per kind (`listing`, `graphics`, `release`, `price`, `review_reply`).',
                ),
            }),
          ),
          totals: z.object({ apps: z.number().int(), count: z.number().int() }),
          generatedAt: timestamp,
        }),
      },
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
      'A STORE WRITE, possibly several that cannot be taken back. Needs `store.publish` AND, for every step in `steps`, that step’s right (`store.push_draft`, `store.submit`, `store.release`, `releases.rollout`; the combined step `push_and_submit` needs both `store.push_draft` and `store.submit`; named together with a `release` on Google Play it is ONE edit and ONE commit that makes the release too, and needs `store.push_draft` and `store.release`; `replaceReview` on it replaces the review in progress): an owner or admin, or a token whose actions name the batch and every step (`403 forbidden`, listing the missing steps). Needs `KILN_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`) and each step’s own switch (`409 step_disabled`). `phrase` must be the `confirmation.phrase` of the plan when a step is irreversible (`422 confirmation_mismatch`, nothing read or written). The plan is rebuilt and must have the `planHash` previewed (`409 plan_changed`, with the new `plan`; `409 plan_blocked` when a step is no longer available). The steps then run IN ORDER through their own services, each with its own claim, its own re-read of the store and its own refusal on drift (`state_changed` is a failed step, not a retry). The batch STOPS at the first step that is not applied: the rest are `skipped` (`previous_step_not_applied`). Nothing is ever retried; an unknown outcome is read back by the step and reported (`outcome: unknown`: look at the store). A deferred step that no longer matches its promise is skipped as `plan_drifted`. One publish per app at a time (`409 publish_in_progress`). The answer is `200` with the result of every step even when a step failed: look at `completed`, `stoppedAt` and `steps`. Audited as `pending.published` (ids, hashes, per step outcomes; never a text or a credential) and emitted as the event `pending.published` when something was applied.',
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
