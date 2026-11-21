import { z } from 'zod';
import { type Draft, stagedAppSchema, timestamp, W } from '../../operations/shared.ts';

// ----- submitting the pushed draft for store review (docs/api/submit.md) ---------------------------------
const submitConfigSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'KILN_STORE_SUBMIT_ENABLED (default false). While false the preview and submit routes answer `409 store_submit_disabled`.',
    ),
  envName: z.string(),
  action: z.literal('store.submit'),
  minimumRole: z
    .literal('admin')
    .describe(
      'The lowest role that can submit. A token needs `store.submit` named in its actions.',
    ),
  irreversible: z.literal(true).describe('Nothing here can recall a submission.'),
  releases: z
    .literal(false)
    .describe('A submit never releases a version and never changes a rollout.'),
  note: z.string(),
});

const submitStateSchema = z.object({
  enabled: z.boolean(),
  pushed: z.boolean().describe('A successful draft push is recorded and not yet submitted.'),
  push: z
    .object({
      pushedAt: timestamp,
      pushedBy: z.string(),
      versionString: z.string().nullable(),
      texts: z.number().int(),
      assetSets: z.number().int(),
    })
    .nullable(),
  inFlight: z.object({ submit: z.boolean(), push: z.boolean() }),
  unknownOutcome: z
    .object({ submit: z.boolean(), push: z.boolean() })
    .describe('An earlier submit or push whose outcome is unknown: preview again to settle it.'),
});

const submitCheckSchema = z.object({
  code: z
    .string()
    .describe(
      'For example `draft_differs`, `no_build`, `release_not_manual`, `already_submitted`, `no_locales`, `no_screenshots`, `locale_without_screenshots`, `missing_text`, `image_not_ready`, `asset_spec`, `version_changed`, `push_in_progress`, `play_review_state_unknown`, and as warnings `releases_after_approval`, `releases_by_itself`.',
    ),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
  locale: z.string().optional(),
  item: z.string().optional(),
  rule: z
    .string()
    .optional()
    .describe('Set for a finding of the documented asset specs or listing field specs.'),
  source: z.string().optional(),
  verified: z
    .boolean()
    .optional()
    .describe('False: the rule’s number is not on an official page that was read.'),
});

const submitPreviewSchema = z.object({
  app: stagedAppSchema,
  version: z
    .object({
      id: z.string(),
      versionString: z.string().nullable(),
      state: z.string(),
      releaseType: z.string().nullable(),
    })
    .nullable()
    .describe('App Store: the version that goes to review. Google Play: null.'),
  build: z
    .object({
      id: z.string(),
      version: z.string().nullable(),
      processingState: z.string().nullable(),
      expired: z.boolean().nullable(),
    })
    .nullable(),
  contents: z.object({
    locales: z.array(
      z.object({
        locale: z.string(),
        textFields: z.number().int(),
        screenshotSets: z.array(
          z.object({ target: z.string(), device: z.string().nullable(), images: z.number().int() }),
        ),
      }),
    ),
    pushed: z.object({
      pushedAt: timestamp,
      pushedBy: z.string(),
      texts: z.number().int(),
      assetSets: z.number().int(),
    }),
    includesChangesNotPushedHere: z
      .boolean()
      .describe(
        'Google Play: true. Changes made in Play Console go to review too, and Google lists none of them.',
      ),
  }),
  tracks: z
    .array(
      z.object({
        track: z.string(),
        releases: z.array(
          z.object({
            name: z.string().nullable(),
            status: z.string(),
            userFraction: z.number().nullable(),
            versionCodes: z.array(z.string()),
          }),
        ),
      }),
    )
    .describe('Google Play: read only, never written by a submit. App Store: empty.'),
  irreversible: z
    .array(z.string())
    .describe('What cannot be undone from this server, in words, for the confirmation dialog.'),
  submits: z.literal(true),
  releases: z
    .literal(false)
    .describe('Always false: a submit never releases a version and never changes a rollout.'),
  checks: z.object({
    blocking: z.array(submitCheckSchema),
    warnings: z.array(submitCheckSchema),
    canSubmit: z.boolean(),
  }),
  confirmHash: z
    .string()
    .nullable()
    .describe(
      'Send it back with `confirmation`. Null while a blocking check stands. Valid only while the store is as previewed.',
    ),
  confirmation: z
    .object({ phrase: z.string(), instruction: z.string() })
    .nullable()
    .describe(
      'The text the person types to confirm; send it back as `confirmation`. Null while a blocking check stands.',
    ),
  readAt: timestamp,
});

const submitApplyBody = z.object({
  confirmHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('The `confirmHash` of a preview made now.'),
  confirmation: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'The `confirmation.phrase` of that preview, typed by the person. A different text is `422 confirmation_mismatch` and nothing is read or written.',
    ),
});

const submitResultSchema = z.object({
  app: stagedAppSchema,
  version: z.object({ id: z.string(), versionString: z.string().nullable() }).nullable(),
  submission: z
    .object({ id: z.string(), state: z.string().nullable() })
    .nullable()
    .describe('App Store: the review submission. Google Play: null.'),
  via: z.enum(['review_submission', 'edit_commit']),
  submitted: z.literal(true),
  released: z.literal(false).describe('Always false: nothing was released and no rollout changed.'),
  confirmedByReread: z
    .boolean()
    .describe(
      'True when the store did not answer and reading it back showed the submission (App Store only).',
    ),
  submittedAt: timestamp,
  note: z.string(),
});

export const submitOperations: Draft[] = [
  {
    id: 'getStoreSubmitConfig',
    method: 'get',
    path: `${W}/store-submit/config`,
    tags: ['submit'],
    summary: 'Whether submitting drafts for store review is switched on',
    risk: 'read',
    access: { action: 'apps.read' },
    responses: {
      '200': {
        description: 'The switch, the action and the lowest role that can submit.',
        schema: submitConfigSchema,
      },
    },
  },
  {
    id: 'getStoreSubmitState',
    method: 'get',
    path: `${W}/apps/{id}/store-submit`,
    tags: ['submit'],
    summary:
      'Where the submit of an app stands here: push recorded, in flight (no store contacted)',
    description:
      'Needs `store.submit`. Reads the database only: whether a successful draft push is recorded and not yet submitted, and whether a submit or push is in flight or has an unknown outcome. It works while the switch is off too (`enabled` says which), so a screen can show where things stand either way.',
    risk: 'read',
    access: { action: 'store.submit' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'The state.', schema: z.object({ submit: submitStateSchema }) },
    },
  },
  {
    id: 'previewStoreSubmit',
    method: 'post',
    path: `${W}/apps/{id}/store-submit/preview`,
    tags: ['submit'],
    summary: 'Preview a submit for review: what goes, checks, a confirmHash and the text to type',
    description:
      'Needs `store.submit` and `KILN_STORE_SUBMIT_ENABLED=true`. READS the store, writes nothing, and settles an earlier unknown outcome (a successful read). `409 nothing_pushed` when no successful draft push is recorded. `checks.blocking` stops a submit (the store’s draft no longer holds what was pushed, no or an expired build, a version that would release by itself, a version already in review, no locales or screenshots, a documented spec broken, an image not processed); `checks.warnings` do not. While anything blocks, `confirmHash` and `confirmation` are null.',
    risk: 'read',
    access: { action: 'store.submit' },
    appScope: { kind: 'param', name: 'id' },
    body: z.object({}),
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: submitPreviewSchema }) },
    },
  },
  {
    id: 'applyStoreSubmit',
    method: 'post',
    path: `${W}/apps/{id}/store-submit`,
    tags: ['submit'],
    summary:
      'Hand the pushed draft to store REVIEW (irreversible; never releases or changes a rollout)',
    description:
      'A STORE WRITE THAT CANNOT BE TAKEN BACK from this server. Needs `store.submit` (owner and admin; a token only when its actions name it; `403` otherwise) and `KILN_STORE_SUBMIT_ENABLED=true` (`409 store_submit_disabled`). `confirmHash` must come from a preview of the same state and `confirmation` must be its `confirmation.phrase` (`422 confirmation_mismatch`). The store is READ AGAIN right before the write: if it is not the one previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). One submit per app and platform at a time (`409 write_in_progress`); a draft push in flight or with an unknown outcome blocks it. App Store: a review submission with the editable version as its item, then submitted; only that last request cannot be undone here; a version that would release by itself is blocked. Google Play: an edit committed without `changesNotSentForReview` and with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review` when changes are in review); no track is written. Never retried: after a timeout or a 5xx the store is read back. App Store: `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), or `409 outcome_unknown`. Google Play shows no review state, so it is `409 outcome_unknown` until the person has looked in Play Console and previews again. Audited as `listing.submitted` / `listing.submit_failed` (ids, hashes and outcomes, never a text or a credential) and emitted as the event `listing.submitted`.',
    risk: 'destructive',
    access: { action: 'store.submit' },
    appScope: { kind: 'param', name: 'id' },
    body: submitApplyBody,
    responses: {
      '200': {
        description: 'What was submitted.',
        schema: z.object({ result: submitResultSchema }),
      },
    },
  },
];
