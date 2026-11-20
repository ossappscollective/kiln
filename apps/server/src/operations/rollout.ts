import { PLATFORMS } from '@mrm/core';
import { z } from 'zod';
import { type Draft, reviewStore, timestamp, W } from './shared.ts';

const rolloutStateSchema = z
  .object({
    store: z.enum(['googleplay', 'appstoreconnect']),
    platform: z.enum(PLATFORMS),
    track: z.string().optional().describe('Google Play only.'),
    versionCodes: z.array(z.string()).optional().describe('Google Play only. Sorted.'),
    name: z.string().nullable().optional().describe('Google Play only: the release name.'),
    status: z
      .string()
      .optional()
      .describe('Google Play only: `draft`, `inProgress`, `halted`, `completed`, verbatim.'),
    userFraction: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Google Play only: the share of users, more than 0 and less than 1, for `inProgress` and `halted`.',
      ),
    otherReleases: z
      .number()
      .int()
      .optional()
      .describe('Google Play only: how many other releases the track holds.'),
    version: z.string().optional().describe('App Store only.'),
    storeVersionId: z.string().optional().describe('App Store only.'),
    versionState: z
      .string()
      .nullable()
      .optional()
      .describe('App Store only: `appVersionState`, verbatim.'),
    phasedReleaseId: z
      .string()
      .nullable()
      .optional()
      .describe('App Store only: null when the version has no phased release.'),
    phasedReleaseState: z
      .string()
      .nullable()
      .optional()
      .describe('App Store only: `INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE`, verbatim.'),
    currentDayNumber: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('App Store only: day 1 to 7 of the phased release.'),
    startDate: timestamp.nullable().optional().describe('App Store only.'),
    totalPauseDays: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('App Store only: days paused, of the 30 Apple allows.'),
  })
  .describe('Where the release stands in the store, as read just now.');

const rolloutAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  store: reviewStore,
});

const rolloutAllowedSchema = z.object({
  action: z.string(),
  allowed: z.boolean(),
  reason: z.string().optional(),
  irreversible: z.boolean(),
});

const rolloutRequestFields = {
  action: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'Google Play: `set_fraction`, `halt`, `resume`, `complete`. App Store: `pause`, `resume`, `release_to_all`.',
    ),
  track: z
    .string()
    .max(100)
    .optional()
    .describe('Google Play: the track, for example `production`.'),
  versionCodes: z
    .array(z.string().max(12))
    .min(1)
    .max(50)
    .optional()
    .describe('Google Play: exactly the version codes of the release.'),
  version: z
    .string()
    .max(64)
    .optional()
    .describe('App Store: the marketing version, for example `2.4.0`.'),
  userFraction: z
    .number()
    .optional()
    .describe(
      'Google Play `set_fraction` (required) and `resume` (optional): more than 0 and less than 1, and never lower than now. Not for the App Store.',
    ),
};

const rolloutPreviewBody = z.object(rolloutRequestFields);

const rolloutApplyBody = z.object({
  ...rolloutRequestFields,
  confirmHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('The `confirmHash` of a preview of exactly this request.'),
});

const rolloutConfigSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'MRM_STORE_ROLLOUT_ENABLED. While false every rollout route answers `409 rollout_disabled`.',
    ),
  envName: z.string(),
  actions: z.object({ android: z.array(z.string()), ios: z.array(z.string()) }),
  irreversible: z.array(z.string()).describe('Actions that cannot be undone from here.'),
  fraction: z.object({ exclusiveMin: z.number(), exclusiveMax: z.number() }),
});

const rolloutStateViewSchema = z.object({
  app: rolloutAppSchema,
  current: rolloutStateSchema,
  allowedActions: z
    .array(rolloutAllowedSchema)
    .describe(
      'What could be done from the current state. For `set_fraction` the share must be above `minUserFraction`.',
    ),
  minUserFraction: z
    .number()
    .nullable()
    .describe('Google Play: the share now; a new share must be higher.'),
  readAt: timestamp,
});

const rolloutPreviewSchema = z.object({
  app: rolloutAppSchema,
  action: z.string(),
  target: z.record(z.unknown()),
  current: rolloutStateSchema,
  proposed: rolloutStateSchema.describe('What the store should show after the change.'),
  summary: z.string().describe('One sentence for the confirmation dialog.'),
  irreversible: z
    .boolean()
    .describe('True for `complete` and `release_to_all`: nothing here undoes it.'),
  confirmHash: z
    .string()
    .describe('Send it back to apply. Valid only while the store still shows `current`.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});

const rolloutResultSchema = z.object({
  app: rolloutAppSchema,
  action: z.string(),
  before: rolloutStateSchema,
  after: rolloutStateSchema,
  irreversible: z.boolean(),
  confirmedByReread: z
    .boolean()
    .describe(
      'True when the write’s outcome was unknown and reading the store back showed the change.',
    ),
  appliedAt: timestamp,
  note: z.string(),
});

// ----- staged listing text and graphics, and writing them to a store as a draft (docs/api/staged-changes.md) ----

export const rolloutOperations: Draft[] = [
  {
    id: 'getRolloutConfig',
    method: 'get',
    path: `${W}/rollout/config`,
    tags: ['rollout'],
    summary: 'Whether changing a store rollout is switched on, and what can be done',
    risk: 'read',
    access: { action: 'apps.read' },
    responses: {
      '200': {
        description: 'The switch and the actions per platform.',
        schema: rolloutConfigSchema,
      },
    },
  },
  {
    id: 'getRolloutState',
    method: 'get',
    path: `${W}/apps/{id}/rollout/state`,
    tags: ['rollout'],
    summary: 'Read where a release stands in the store, and what may be done from there',
    description:
      'READS THE STORE (Google Play opens and deletes an edit, which invalidates other open edits of the same service account). Changes nothing. Needs `releases.rollout` and `MRM_STORE_ROLLOUT_ENABLED=true` (`409 rollout_disabled` otherwise). Google Play: `track` and `versionCodes` (comma separated); App Store: `version`.',
    risk: 'read',
    access: { action: 'releases.rollout' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      track: z.string().optional(),
      versionCodes: z.string().optional().describe('Comma separated version codes.'),
      version: z.string().optional(),
    }),
    responses: {
      '200': {
        description: 'The live state and the allowed actions.',
        schema: rolloutStateViewSchema,
      },
    },
  },
  {
    id: 'previewRollout',
    method: 'post',
    path: `${W}/apps/{id}/rollout/preview`,
    tags: ['rollout'],
    summary: 'Preview a rollout change: the live state, the proposed state and a confirmHash',
    description:
      'READS THE STORE, writes nothing. Validates the request for the app’s platform (`422 invalid_rollout`), refuses a change the current state does not allow (`422 rollout_not_allowed`, with `current`), and returns `confirmHash`: a hash of the app, the release, the change and the state that was read. Google Play: the share only goes up (`not_an_increase` otherwise; halt is the way to stop); App Store: no un-release. Needs `releases.rollout` and `MRM_STORE_ROLLOUT_ENABLED=true`.',
    risk: 'read',
    access: { action: 'releases.rollout' },
    appScope: { kind: 'param', name: 'id' },
    body: rolloutPreviewBody,
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: rolloutPreviewSchema }) },
    },
  },
  {
    id: 'applyRollout',
    method: 'post',
    path: `${W}/apps/{id}/rollout/apply`,
    tags: ['rollout'],
    summary:
      'Change the live rollout in the store (what users receive; complete and release to all cannot be undone here)',
    description:
      'A STORE WRITE. Needs `releases.rollout` (owner and admin; a token only when its actions name it) and `MRM_STORE_ROLLOUT_ENABLED=true`. `confirmHash` must come from a preview of exactly this request. The store is READ AGAIN right before the write: if its state is not the one previewed nothing is written (`409 state_changed`, with `current`, `proposed` and a new `confirmHash`). One write per app at a time (`409 write_in_progress`). Never retried: after a timeout or a 5xx the state is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), or `409 outcome_unknown` (then preview again). Google Play never cancels a review in progress (`409 changes_in_review`). Audited as `release.rollout_changed` / `release.rollout_failed` (ids and values, never a credential) and emitted as the event `release.rollout_changed`.',
    risk: 'destructive',
    access: { action: 'releases.rollout' },
    appScope: { kind: 'param', name: 'id' },
    body: rolloutApplyBody,
    responses: {
      '200': {
        description: 'The state before and after.',
        schema: z.object({ result: rolloutResultSchema }),
      },
    },
  },
];
