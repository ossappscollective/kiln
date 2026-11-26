import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { translateNotesBody } from '../modules/ai/notes-translate-routes.ts';
import { type Draft, platform, stagedAppSchema, timestamp, W } from './shared.ts';

// ----- the release pipeline signal (docs/api/release-pipeline.md) -------------------------------------------------
const pipelineStateEnum = z.enum([
  'unknown',
  'idle',
  'ci_running',
  'ci_failed',
  'build_processing',
  'build_ready',
  'draft',
  'in_review',
  'rejected',
  'approved',
  'rolling_out',
  'halted',
  'live',
]);

const pipelineEvidenceSchema = z.object({
  kind: z.enum(['run', 'build', 'version']),
  id: z.string().describe('The run id, the build number, or `version` / `version@track`.'),
  at: timestamp.nullable(),
  label: z.string(),
  url: z.string().nullable().optional(),
});

const pipelineStallSchema = z.object({
  step: z.enum([
    'approved',
    'rejected',
    'draft',
    'build_ready',
    'build_invalid',
    'build_processing',
    'ci_run',
  ]),
  key: z.string().describe('`step:anchor`: a new one is a new episode.'),
  anchor: z.string().describe('What is stuck: a run id, a build number or a version.'),
  since: timestamp,
  hours: z.number().int(),
  stale: z.boolean().describe('Older than 14 days: shown, never reminded.'),
  message: z
    .string()
    .describe(
      'A sentence for a person, with the evidence in words. Built from ids, versions and times only.',
    ),
  label: z.string(),
  evidence: z.array(pipelineEvidenceSchema),
});

const pipelineSchema = z.object({
  appId: z.string(),
  platform: platform,
  state: pipelineStateEnum,
  waitingOn: z.enum(['ci', 'store', 'you']).nullable(),
  since: timestamp.nullable(),
  stalledAfterHours: z
    .number()
    .int()
    .describe('The workspace setting `release.stalledAfterHours` (0: detection is off).'),
  stalled: pipelineStallSchema
    .nullable()
    .describe('The most advanced stall that is not stale (else the most advanced stale one).'),
  stalls: z.array(pipelineStallSchema),
  steps: z.array(
    z.object({
      id: z.enum(['ci', 'build', 'prepare', 'review', 'release']),
      status: z.enum(['done', 'current', 'waiting', 'failed', 'stalled', 'todo', 'unknown']),
      at: timestamp.nullable(),
      detail: z.string().nullable(),
    }),
  ),
  summary: z.string(),
  latest: z.object({
    run: z.record(z.unknown()).nullable(),
    build: z.record(z.unknown()).nullable(),
    version: z.record(z.unknown()).nullable(),
  }),
});

const pipelineAppRef = z.object({
  id: z.string(),
  name: z.string(),
  platform: platform,
  store: z.enum(['appstoreconnect', 'googleplay']),
});

const pipelineResponseSchema = z.object({
  app: pipelineAppRef,
  pipeline: pipelineSchema,
  lastSyncedAt: timestamp.nullable(),
  generatedAt: timestamp,
});

const pipelineSummarySchema = z.object({
  stalledAfterHours: z.number().int(),
  apps: z.array(
    z.object({
      app: pipelineAppRef,
      state: pipelineStateEnum,
      waitingOn: z.enum(['ci', 'store', 'you']).nullable(),
      since: timestamp.nullable(),
      summary: z.string(),
      lastSyncedAt: timestamp.nullable(),
      stalled: z
        .object({
          step: z.string(),
          label: z.string(),
          message: z.string(),
          hours: z.number().int(),
          since: timestamp,
          stale: z.boolean(),
          evidence: z.array(
            z.object({ kind: z.string(), id: z.string(), at: timestamp.nullable() }),
          ),
        })
        .nullable(),
    }),
  ),
  totals: z.object({
    apps: z.number().int(),
    stalled: z.number().int().describe('Without the stale ones.'),
    byState: z.record(z.number().int()),
  }),
  generatedAt: timestamp,
});

// ----- releasing: reads of builds and version codes, and the irreversible release step (docs/api/releases-write.md) ----
const eligibilitySchema = z.object({
  eligible: z.boolean().describe('It can be chosen for the draft now.'),
  severity: z
    .enum(['ok', 'warning', 'blocked'])
    .describe(
      '`blocked`: it cannot be chosen. `warning`: it can, read the message. `ok`: nothing to say.',
    ),
  code: z
    .enum([
      'ok',
      'processing',
      'failed',
      'invalid',
      'state_unknown',
      'expired',
      'wrong_version',
      'no_editable_version',
      'already_attached',
      'export_compliance_missing',
      'already_in_draft',
      'already_live',
    ])
    .describe('A machine reason. New codes may be added: treat an unknown one as its `severity`.'),
  message: z
    .string()
    .describe('A plain sentence for a person, built from build numbers, versions and states only.'),
});

const buildTestNotesSchema = z.object({
  read: z
    .boolean()
    .describe(
      'False: not asked for this build (not processed, expired, or not among the newest eight) or the read failed (`error`).',
    ),
  locales: z
    .array(
      z.object({
        locale: z.string(),
        text: z
          .string()
          .describe(
            'TestFlight "What to Test". Shown to the caller only: never logged and never audited.',
          ),
        truncated: z.boolean().describe('Cut at 4000 characters.'),
      }),
    )
    .describe('At most 40 languages; empty texts are left out.'),
  error: z
    .enum(['forbidden', 'rate_limited', 'not_found', 'unavailable'])
    .optional()
    .describe('The read of this build failed; the other builds are not affected.'),
});

const buildCandidateSchema = z.object({
  id: z.string(),
  buildNumber: z.string().nullable().describe('The build number (`CFBundleVersion`).'),
  version: z.string().nullable().describe('The marketing version the build belongs to.'),
  uploadedDate: z.string().nullable(),
  processingState: z
    .string()
    .nullable()
    .describe('Apple’s names (UNVERIFIED): `PROCESSING`, `FAILED`, `INVALID`, `VALID`.'),
  expired: z.boolean().nullable(),
  selectable: z
    .boolean()
    .describe(
      'Processed and not expired: it can be staged as the `build` field. Older than `eligibility`, which also looks at the version.',
    ),
  reason: z.string().nullable().describe('Why it cannot be selected.'),
  attached: z.boolean().describe('It is the build attached to the editable version now.'),
  eligibility: eligibilitySchema,
  exportCompliance: z
    .enum(['answered', 'missing', 'unknown'])
    .describe(
      'Apple’s export compliance answer for the build (`usesNonExemptEncryption`, UNVERIFIED): `unknown` when Apple did not return it.',
    ),
  testNotes: buildTestNotesSchema,
});

const releaseCandidatesSchema = z.union([
  z.object({
    store: z.literal('appstoreconnect'),
    platform: z.enum(PLATFORMS),
    version: z
      .object({ id: z.string(), versionString: z.string().nullable(), state: z.string() })
      .nullable()
      .describe('The editable version the build would be attached to.'),
    builds: z.array(buildCandidateSchema),
    attachedBuildId: z.string().nullable(),
    truncatedAt: z
      .number()
      .int()
      .nullable()
      .describe('The list was cut at this many builds (null: complete).'),
  }),
  z.object({
    store: z.literal('googleplay'),
    platform: z.literal('android'),
    track: z.string(),
    codes: z.array(
      z.object({
        versionCode: z.string(),
        source: z.enum(['bundle', 'apk']),
        sha256: z.string().nullable(),
        inTrack: z.array(z.object({ name: z.string().nullable(), status: z.string() })),
        eligibility: eligibilitySchema,
        version: z
          .string()
          .nullable()
          .describe(
            'The version of the build: the versionName of a CI file Kiln read (`origin` ci), of the store build it synced (`store`), or the NAME of the track release that holds the code (`release`: typed by a person, not read from the file). Null: not known.',
          ),
        builtAt: z
          .number()
          .int()
          .nullable()
          .describe(
            'Epoch milliseconds the build was made (`builtFrom` ci: the CI artifact was created) or uploaded (`store`). Google Play gives no build date, so null for a code Kiln has not seen elsewhere. Never the date of a release.',
          ),
        origin: z
          .enum(['ci', 'store', 'release'])
          .nullable()
          .describe(
            'Where `version` came from (else where `builtAt` came from). Not `source`: that is `bundle` or `apk`.',
          ),
        builtFrom: z.enum(['ci', 'store']).nullable().describe('Where `builtAt` came from.'),
        ci: z
          .object({
            runNumber: z.number().int().nullable(),
            branch: z.string().nullable(),
            commit: z.string().nullable().describe('The short commit of the run.'),
            url: z.string().nullable(),
          })
          .optional()
          .describe(
            'The CI run that made the file, when a CI file with this version code was read.',
          ),
        builtGap: z
          .enum([
            'not_read',
            'file_gone',
            'github_unreachable',
            'github_no_access',
            'no_repository',
          ])
          .nullable()
          .describe(
            'Why `builtAt` is null (null when it is known): `not_read` (Kiln has not read a CI file with this code), `file_gone` (read, but GitHub no longer has the file and no date was kept), `github_unreachable` / `github_no_access` (the artifact list could not be read), `no_repository` (no CI repository is linked). Google Play itself never gives a build date.',
          ),
        ciExpiredAt: z
          .number()
          .int()
          .nullable()
          .describe(
            'When `builtGap` is `file_gone`: epoch milliseconds GitHub deletes (or deleted) the file, when known.',
          ),
        matchedBy: z
          .enum(['package', 'build_number_only'])
          .nullable()
          .describe(
            "How a CI file was matched to the code: `package` (the file is this app's package) or `build_number_only` (only the build number matched, the package differs); null: no file.",
          ),
        firstSeenAt: z
          .number()
          .int()
          .nullable()
          .describe(
            "Epoch milliseconds Kiln's store sync first saw this code. NOT a build date (Google Play gives none); null: never synced.",
          ),
      }),
    ),
  }),
]);

const notesHistorySchema = z.object({
  app: z.object({
    id: z.string(),
    platform: platform,
    store: z.enum(['appstoreconnect', 'googleplay']),
  }),
  locale: z.string().nullable().describe('The language asked for, or null (all).'),
  notes: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            'One text, however many places used it. Shown to the caller only: never logged and never audited.',
          ),
        truncated: z.boolean().describe('The store text was cut at 4000 characters.'),
        locales: z.array(z.string()),
        lastUsedAt: timestamp
          .nullable()
          .describe(
            'The newest date of its uses; null when none has one (Google Play gives no dates).',
          ),
        uses: z
          .array(
            z.object({
              source: z.enum(['appstoreconnect', 'googleplay', 'plan']),
              locale: z.string(),
              version: z
                .string()
                .nullable()
                .describe(
                  'The marketing version, the Google Play release name, or the version of the plan.',
                ),
              track: z.string().nullable(),
              versionCodes: z
                .array(z.string())
                .optional()
                .describe('Google Play: the version codes of the release.'),
              state: z
                .string()
                .nullable()
                .describe('The store’s state of the version or release; null for a plan.'),
              at: timestamp.nullable(),
            }),
          )
          .describe('Newest first, at most 10.'),
      }),
    )
    .describe('Newest first by `lastUsedAt`; texts without a date follow, in the store’s order.'),
  truncated: z.boolean().describe('More texts exist than `limit`.'),
  limit: z.number().int(),
  store: z.object({
    read: z
      .boolean()
      .describe(
        'False: the store could not be read (see `error`); the plans’ notes are still listed.',
      ),
    error: z
      .string()
      .nullable()
      .describe(
        'The error code of the failed store read (for example `rate_limited`, `forbidden`, `timeout`).',
      ),
    cached: z
      .boolean()
      .describe(
        'Answered from memory: the store is read at most once in ten minutes per app and language.',
      ),
    versionsRead: z.number().int(),
    failed: z.number().int().describe('Versions listed whose notes could not be read.'),
    truncated: z.boolean().describe('More versions exist than were read (the newest twelve are).'),
  }),
  generatedAt: timestamp,
});

const playReleaseReadSchema = z.object({
  name: z.string().nullable(),
  status: z.string(),
  userFraction: z.number().nullable(),
  versionCodes: z.array(z.string()),
  notes: z.array(z.object({ locale: z.string(), text: z.string() })),
});

const editableReleaseSchema = z.union([
  z.object({
    store: z.literal('appstoreconnect'),
    platform: z.enum(PLATFORMS),
    version: z.object({
      id: z.string(),
      versionString: z.string().nullable(),
      state: z.string(),
      editable: z.literal(true),
    }),
    releaseType: z.string().nullable(),
    earliestReleaseDate: z.string().nullable(),
    copyright: z.string().nullable(),
    build: z
      .object({
        id: z.string(),
        buildNumber: z.string().nullable(),
        processingState: z.string().nullable(),
        expired: z.boolean().nullable(),
      })
      .nullable(),
    phasedRelease: z
      .object({ id: z.string(), state: z.string().nullable() })
      .nullable()
      .describe('Null: the version has no phased release (off).'),
    releaseNotes: z
      .array(z.object({ locale: z.string(), text: z.string() }))
      .describe('The "what is new" of each locale (the listing field `release_notes`).'),
  }),
  z.object({
    store: z.literal('googleplay'),
    platform: z.literal('android'),
    track: z.string(),
    draft: playReleaseReadSchema
      .nullable()
      .describe('The draft release of the track (status `draft`).'),
    others: z.array(playReleaseReadSchema).describe('The other releases of the track, read only.'),
  }),
]);

const playCheckBodySchema = z.object({
  track: z
    .string()
    .min(1)
    .max(100)
    .describe('The track the release would be in (for example `production`).'),
  versionCodes: z
    .array(z.string().regex(/^[0-9]{1,10}$/))
    .min(1)
    .max(20)
    .describe('The version codes of the release.'),
  releaseName: z
    .string()
    .max(100)
    .optional()
    .describe('The release name (only shown in Play Console).'),
  status: z
    .enum(['draft', 'inProgress', 'completed'])
    .optional()
    .describe(
      'The state to check the release in. Default: `draft` without `userFraction`, `completed` for 1, otherwise `inProgress`.',
    ),
  userFraction: z
    .number()
    .gt(0)
    .lte(1)
    .optional()
    .describe(
      'The share of users (0.1 is 10%), at most 4 decimals. Not with `draft`; 1 is `completed`.',
    ),
  notes: z
    .array(z.object({ locale: z.string().min(1).max(20), text: z.string().max(4000) }))
    .max(80)
    .optional()
    .describe(
      'The release notes per language (Google Play allows 500 characters). Empty texts are not sent.',
    ),
});

const playCheckSchema = z.object({
  store: z.literal('googleplay'),
  track: z.string(),
  versionCodes: z.array(z.string()),
  status: z.enum(['draft', 'inProgress', 'completed']),
  userFraction: z.number().nullable(),
  outcome: z
    .enum(['no_errors', 'errors'])
    .describe(
      '`no_errors`: Google Play found no error. It does NOT mean there are no warnings: the API reports errors only.',
    ),
  findings: z
    .array(
      z.object({
        stage: z.enum(['stage', 'validate']),
        message: z.string().describe('Google’s own words (cut, redacted). Third party text.'),
      }),
    )
    .describe('What Google refused. Empty with `no_errors`.'),
  committed: z.literal(false).describe('Always false: the edit was deleted, nothing was saved.'),
  checkedAt: z.number().describe('Epoch milliseconds.'),
  note: z.string().describe('A fixed sentence on what the check does and does not cover.'),
});

const releaseWhat = {
  version: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'App Store: the marketing version (required when more than one version waits for release).',
    ),
  track: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Google Play (required): the track of the draft release.'),
  versionCodes: z
    .array(z.string().regex(/^[0-9]{1,10}$/))
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Google Play: the version codes that identify the draft release (needed when the track holds more than one draft).',
    ),
  userFraction: z
    .number()
    .gt(0)
    .lte(1)
    .optional()
    .describe(
      'Google Play (required, never implied): the share of users, more than 0 and at most 1. 1 completes the release.',
    ),
  direct: z
    .boolean()
    .optional()
    .describe(
      'Google Play, DIRECT release (docs/adr/0029-direct-play-release.md): release the STAGED release fields in one step. With no draft release holding the version codes the release is made from the staged version codes (when `versionCodes` names none), release name and notes, in the same edit, started at `userFraction` (`completed` for 1) and committed without the hold-back, so Google reviews it. A draft with those codes that exists is released as it is. `track` defaults to the staged track. `422 version_codes_required` when none are staged or named; `422 not_applicable` for the App Store.',
    ),
};

const appReleaseSettingsSchema = z.object({
  defaultSharePercent: z
    .number()
    .nullable()
    .describe(
      'A percent from 1 to 100 that the release steps start the share from (a pre-fill: the typed phrase still names the share). Null: none, the person is asked. A staged `user_fraction` wins.',
    ),
  stagedRollout: z
    .enum(['auto', 'always_ask', 'never'])
    .describe(
      '`auto` (default): a staged rollout is offered when an earlier production release exists in the stored releases (the first release in production is always 100%: Google Play offers no staged rollout for a first publication). `always_ask`: always offered. `never`: always 100%.',
    ),
});

const appReleaseSettingsBody = z.object({
  defaultSharePercent: appReleaseSettingsSchema.shape.defaultSharePercent.optional(),
  stagedRollout: appReleaseSettingsSchema.shape.stagedRollout.optional(),
});

const releaseConfigSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'KILN_STORE_RELEASE_ENABLED (default false). While false the preview and release routes answer `409 store_release_disabled`. The reads of builds and version codes do not depend on it.',
    ),
  envName: z.string(),
  action: z.literal('store.release'),
  minimumRole: z
    .literal('admin')
    .describe(
      'The lowest role that can release. A token needs `store.release` named in its actions.',
    ),
  irreversible: z.literal(true).describe('Nothing here can recall a release.'),
  note: z.string(),
});

const releaseStateSchema = z.object({
  enabled: z.boolean(),
  inFlight: z.object({ release: z.boolean(), push: z.boolean(), submit: z.boolean() }),
  unknownOutcome: z
    .object({ release: z.boolean(), push: z.boolean(), submit: z.boolean() })
    .describe(
      'An earlier release, push or submit whose outcome is unknown: preview again (a release) or look at the store.',
    ),
});

const releaseCheckSchema = z.object({
  code: z
    .string()
    .describe(
      'For example `not_releasable`, `ambiguous_version`, `no_draft_release`, `ambiguous_release`, `not_a_draft`, `version_codes_not_uploaded`, `rollout_in_progress`, `push_in_progress`, `submit_in_progress`, `unpushed_release_fields`, `full_rollout`, `fraction_differs_from_staged`, `play_review_state_unknown`, and for a direct release `direct_release`, `draft_used_as_is`, `codes_already_in_track`.',
    ),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
  item: z.string().optional(),
});

const releaseRequestSchema = z.object({
  version: z.string().optional(),
  track: z.string().optional(),
  versionCodes: z.array(z.string()).optional(),
  userFraction: z.number().optional(),
});

const releaseDirectSchema = z
  .object({
    creates: z
      .boolean()
      .describe(
        'False: a draft with these version codes exists in the track and is released as it is.',
      ),
    versionCodes: z.array(z.string()),
    name: z.string().nullable(),
    notesLanguages: z
      .array(z.string())
      .describe('The languages that have release notes. Never a note.'),
    summary: z
      .string()
      .describe(
        'Plain words: what is sent, to whom, and that Google reviews it and it cannot be undone from here.',
      ),
  })
  .nullable()
  .describe('Google Play, direct release only (`direct: true`); null otherwise.');

const releaseAudienceSchema = z.object({
  kind: z.enum(['all', 'phased', 'percent']),
  userFraction: z.number().nullable(),
  description: z.string(),
});

const releasePreviewSchema = z.object({
  app: stagedAppSchema,
  request: releaseRequestSchema.describe(
    'What was asked. The share is always the one the person named.',
  ),
  version: z
    .object({
      id: z.string(),
      versionString: z.string().nullable(),
      state: z.string(),
      releaseType: z.string().nullable(),
    })
    .nullable()
    .describe(
      'App Store: the version that would be released (in `PENDING_DEVELOPER_RELEASE`). Google Play: null.',
    ),
  build: z
    .object({
      id: z.string(),
      buildNumber: z.string().nullable(),
      processingState: z.string().nullable(),
      expired: z.boolean().nullable(),
    })
    .nullable(),
  phasedRelease: z
    .object({ id: z.string(), state: z.string().nullable() })
    .nullable()
    .describe(
      'App Store: a phased release exists (UNVERIFIED how Apple starts it for a release request). Null: everybody at once.',
    ),
  track: z.string().nullable(),
  release: z
    .object({
      name: z.string().nullable(),
      status: z.string(),
      versionCodes: z.array(z.string()),
      notes: z.number().int().describe('How many languages have release notes.'),
    })
    .nullable()
    .describe('Google Play: the draft release that would start.'),
  others: z
    .array(
      z.object({
        name: z.string().nullable(),
        status: z.string(),
        userFraction: z.number().nullable(),
        versionCodes: z.array(z.string()),
      }),
    )
    .describe('Google Play: the other releases of the track, read only.'),
  audience: releaseAudienceSchema,
  direct: releaseDirectSchema,
  irreversible: z
    .array(z.string())
    .describe('What cannot be undone from this server, in words, for the confirmation dialog.'),
  releases: z.literal(true),
  checks: z.object({
    blocking: z.array(releaseCheckSchema),
    warnings: z.array(releaseCheckSchema),
    canRelease: z.boolean(),
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
      'The text the person types to confirm (`release <identifier> <version>` or `release <identifier> <track> <percent>%`); send it back as `confirmation`.',
    ),
  readAt: timestamp,
});

const releaseApplyBody = z.object({
  ...releaseWhat,
  confirmHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('The `confirmHash` of a preview of exactly this request, made now.'),
  confirmation: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'The `confirmation.phrase` of that preview, typed by the person. A different text is `422 confirmation_mismatch` and nothing is written.',
    ),
});

const releaseResultSchema = z.object({
  app: stagedAppSchema,
  request: releaseRequestSchema,
  version: z.object({ id: z.string(), versionString: z.string().nullable() }).nullable(),
  track: z.string().nullable(),
  releaseRequestId: z
    .string()
    .nullable()
    .describe('App Store: the release request Apple created, when it said. Google Play: null.'),
  via: z.enum(['release_request', 'edit_commit']),
  audience: releaseAudienceSchema,
  released: z.literal(true),
  confirmedByReread: z
    .boolean()
    .describe('True when the store did not answer and reading it back showed the release.'),
  releasedAt: timestamp,
  note: z.string(),
});

// ----- pending changes and the batch publish (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md) ----

export const releasesOperations: Draft[] = [
  {
    id: 'getReleasePipeline',
    method: 'get',
    path: `${W}/apps/{id}/release/pipeline`,
    tags: ['releases'],
    summary: 'Where the release of the app is between a CI run and live, and whether it is stalled',
    description:
      'Read-only, from the data stored here (the stored CI runs, the builds and versions of the last store sync); it calls neither GitHub nor a store. `stalled` says what is stuck in a sentence, with the ids and times it rests on. Detection is off when the workspace setting `release.stalledAfterHours` is 0. Times of store states are lower bounds (the last sync that saw the state) when the app was synced before they were recorded.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '200': { description: 'The pipeline.', schema: pipelineResponseSchema } },
  },
  {
    id: 'getReleasePipelineSummary',
    method: 'get',
    path: `${W}/release/pipeline/summary`,
    tags: ['releases'],
    summary: 'The release pipeline of every app, stalled ones first',
    description:
      'Same facts and rules as `getReleasePipeline`, one line per app. A token limited to some apps sees only those apps.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'list' },
    responses: {
      '200': { description: 'One line per app and the totals.', schema: pipelineSummarySchema },
    },
  },
  {
    id: 'listReleaseCandidates',
    method: 'get',
    path: `${W}/apps/{id}/release/candidates`,
    tags: ['releases'],
    summary:
      'List the builds and version codes a draft release can use (processed builds, uploaded codes)',
    description:
      'READS the store with the credential of the app (audited as `credential.use`, purpose `store.release_read`) and changes nothing; not behind a switch. App Store: the builds of the app for this platform, newest first, each with `selectable` (processed, not expired) and `attached`; `version` optionally narrows them to a marketing version. Google Play: `track` is required (`422 track_required`); the uploaded version codes with the releases of that track that hold them. Every build and code has an `eligibility` verdict (`eligible`, `severity`, a machine `code` and a plain `message`). App Store builds also carry `exportCompliance` and `testNotes` (the TestFlight "What to Test" of the newest eight processed builds, up to 40 languages and 4000 characters each; one build that cannot be read never hides the others, and the text is never logged or audited). Rate limited per workspace (`429`). Needs `listing.read`.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      track: z.string().max(100).optional().describe('Google Play: required.'),
      version: z
        .string()
        .max(40)
        .optional()
        .describe('App Store: narrow the builds to this marketing version.'),
    }),
    responses: {
      '200': {
        description: 'The candidates.',
        schema: z.object({ candidates: releaseCandidatesSchema }),
      },
    },
  },
  {
    id: 'getReleaseNotesHistory',
    method: 'get',
    path: `${W}/apps/{id}/release/notes-history`,
    tags: ['releases'],
    summary:
      'The "what is new" texts earlier releases used, newest first, deduplicated, to reuse in the next one',
    description:
      'READS the store with the credential of the app (audited as `credential.use`, purpose `store.release_read`) and changes nothing; not behind a switch. The same text used by several versions is one entry with every place in `uses` (store, version or release, track, state, date). App Store: the notes of the newest twelve versions of the platform (the order and the date come from `createdDate`, UNVERIFIED). Google Play: only the releases the tracks hold now (Google lists no replaced release), with no dates. The notes of this app’s release plans are included (`source` `plan`). The store read is cached for ten minutes per app and language; only a read that goes to the store counts against the rate limit (`store.error` `rate_limited`, with `Retry-After`). A failed store read still answers `200` with the plans’ notes and `store.read` false. The texts are never logged and never audited. Needs `listing.read`.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      platform: platform
        .optional()
        .describe('Must be the platform of the app (`422 platform_mismatch`).'),
      locale: z
        .string()
        .max(20)
        .optional()
        .describe('One language, for example `en-US`. Default: all.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
      track: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Google Play: only the release(s) of this track (for example `internal`); the notes of the release plans are left out.',
        ),
      codes: z
        .string()
        .max(250)
        .optional()
        .describe(
          'With `track`: only the release that holds one of these version codes, separated by commas (up to 20). This is how the notes of the release being promoted are read.',
        ),
    }),
    responses: {
      '200': { description: 'The history.', schema: z.object({ history: notesHistorySchema }) },
    },
  },
  {
    id: 'translateReleaseNotes',
    method: 'post',
    path: `${W}/apps/{id}/release-notes/translate`,
    tags: ['releases'],
    summary: 'Translate the "what is new" text of a release into other languages (machine or AI)',
    description:
      'Sends ONE text (up to 4000 characters) in `sourceLocale` to the workspace\u2019s provider and returns the text for each of up to 40 `targetLocales`, so a person can put it in the editors of the step "What is new". It RETURNS TEXT: nothing is stored, no suggestion is created, nothing is staged and nothing reaches a store. `engine` `machine` is the translation provider of the workspace settings (`translation.enabled`, the daily character budget; needs `reviews.translate`). `engine` `ai` is the AI provider (`ai.enabled`, the monthly token budget and cost cap; needs `ai.use`, which a token holds only when its `actions` name it); it is told the store limit (500 characters on Google Play, 4000 on the App Store), to keep line breaks, bullets, version numbers and the names of the app\u2019s AI context, and to write plain text. A language that failed is in `failed` with a fixed sentence and does not void the others; a text longer than the store limit is returned anyway and listed in `over`; `warnings` lists codes a person should check (`version_missing`, `brand_term_missing`). When nothing could be translated the answer is the failure itself: `422 translation_not_configured`, `translation_auth`, `translation_quota`, `429 translation_budget`, `translation_rate_limited`, `502`/`504 translation_unavailable`, or for `ai` `409 ai_not_enabled`, `422 ai_not_configured`, `ai_auth`, `ai_input_too_large`, `429 ai_budget_exhausted`, `ai_cost_cap_reached`, `ai_busy`, `ai_rate_limited`, `502`/`504 ai_unavailable`, `502 ai_invalid_output`. Rate limited per workspace (`429 rate_limited`). Needs `changesets.write` (a member can use it). The text is sent to the provider you chose; it is never logged and never audited (the audit entry `release_notes.translate` has ids, the engine, the provider, counts and a code).',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: translateNotesBody,
    responses: {
      '200': {
        description: 'The translated texts, and what failed.',
        schema: z.object({
          engine: z.enum(['machine', 'ai']),
          provider: z.string().describe('The translation or AI provider that answered.'),
          model: z.string().nullable().describe('The model that answered (`ai`).'),
          texts: z
            .record(z.string(), z.string())
            .describe('The text by language. Shown to the caller only.'),
          failed: z
            .record(z.string(), z.string())
            .describe('A fixed sentence by language that was not translated.'),
          over: z
            .record(z.string(), z.number())
            .describe('Languages whose text is longer than the limit: how long it is.'),
          warnings: z.record(z.string(), z.array(z.string())),
          limit: z.number().describe('The limit of the store, in characters.'),
          usage: z.object({
            chars: z.number().describe('Characters sent to the translation provider (`machine`).'),
            inputTokens: z.number(),
            outputTokens: z.number(),
          }),
          warning: z
            .object({
              kind: z.enum(['tokens', 'cost']),
              level: z.enum(['soft', 'limit']),
              percent: z.number(),
              message: z.string(),
            })
            .nullable()
            .describe('`ai`: this month is near a limit.'),
        }),
      },
    },
  },
  {
    id: 'getEditableRelease',
    method: 'get',
    path: `${W}/apps/{id}/release/editable`,
    tags: ['releases'],
    summary:
      'The release fields the store holds: the editable App Store version, or the draft release of a Google Play track',
    description:
      'READS the store (same rules as `listReleaseCandidates`) and changes nothing. App Store: the editable version’s release type, earliest release date, copyright, attached build, phased release and the "what is new" per locale; `422 no_editable_version` when there is none. Google Play: `track` is required; the draft release (name, version codes, notes per language) and the other releases of the track. Needs `listing.read`.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({ track: z.string().max(100).optional().describe('Google Play: required.') }),
    responses: {
      '200': {
        description: 'The release fields.',
        schema: z.object({ editable: editableReleaseSchema }),
      },
    },
  },
  {
    id: 'checkPlayRelease',
    method: 'post',
    path: `${W}/apps/{id}/release/play-check`,
    tags: ['releases'],
    summary:
      'Check with Google Play: would Google refuse this release? Nothing is saved (Android only)',
    description:
      'READS the store with the credential of the app (audited as `credential.use`, purpose `store.release_check`) and changes nothing; not behind a switch. Opens an edit, stages the proposed release in the track (codes, name, notes per language, state and share as given), calls `edits.validate` and ALWAYS deletes the edit: it never commits. `outcome` `no_errors` means Google found no error; it does NOT mean there are no warnings: the API reports errors only, so notices of Play Console such as a missing deobfuscation file or the target API level are not covered (the `note` says so). `outcome` `errors` lists `findings` in Google’s words (`stage` `stage`: refused when the release was put in the edit; `validate`: refused by `edits.validate`). What `validate` checks is UNVERIFIED (Google’s page does not say). Android apps only (`422 not_applicable`); `422 track_required`, `422 invalid_version_codes`, `422 invalid_user_fraction`, `422 invalid_locale`. Rate limited per workspace (`429`, `Retry-After`). The release notes are never logged or audited. Needs `listing.read`.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    body: playCheckBodySchema,
    rateLimited: true,
    responses: {
      '200': {
        description: 'What Google Play said.',
        schema: z.object({ check: playCheckSchema }),
      },
    },
  },
  {
    id: 'getAppReleaseSettings',
    method: 'get',
    path: `${W}/apps/{id}/release-settings`,
    tags: ['releases'],
    summary:
      'The Google Play release settings of an app: a default share and whether a staged rollout is offered',
    description:
      'Needs `apps.read`. Reads the database only. The defaults (`defaultSharePercent: null`, `stagedRollout: auto`) apply to an app that never changed them. Not a secret, never written to a store (docs/adr/0029-direct-play-release.md).',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description:
          'The settings, and whether the stored releases show an earlier production release.',
        schema: z.object({
          settings: appReleaseSettingsSchema,
          earlierProductionRelease: z
            .boolean()
            .describe(
              'A production release that is live, rolling out or halted, as of the last store sync. `auto` offers a staged rollout only when this is true (production track).',
            ),
        }),
      },
    },
  },
  {
    id: 'updateAppReleaseSettings',
    method: 'put',
    path: `${W}/apps/{id}/release-settings`,
    tags: ['releases'],
    summary: 'Change the Google Play release settings of an app (a partial update)',
    description:
      'Needs `apps.write` (admin and up). A partial update: send only what changes; `defaultSharePercent: null` removes the default. All or nothing (`422 invalid_setting` with `issues`). Google Play apps only (`422 not_applicable`). Writes nothing to a store: a default share only pre-fills the release steps, and the typed phrase of a release still names the share. Audited as `app.release_settings_update` (the app id and the old and new values).',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'id' },
    body: appReleaseSettingsBody,
    responses: {
      '200': {
        description: 'The settings after the change, and the keys that changed.',
        schema: z.object({ settings: appReleaseSettingsSchema, changed: z.array(z.string()) }),
      },
    },
  },
  {
    id: 'getStoreReleaseConfig',
    method: 'get',
    path: `${W}/store-release/config`,
    tags: ['releases'],
    summary: 'Whether releasing from this server is switched on',
    risk: 'read',
    access: { action: 'apps.read' },
    responses: {
      '200': {
        description: 'The switch, the action and the lowest role that can release.',
        schema: releaseConfigSchema,
      },
    },
  },
  {
    id: 'getStoreReleaseState',
    method: 'get',
    path: `${W}/apps/{id}/store-release`,
    tags: ['releases'],
    summary:
      'Where the release of an app stands here: in flight, unknown outcomes (no store contacted)',
    description:
      'Needs `store.release`. Reads the database only: whether a release, a draft push or a submit is in flight or has an unknown outcome. It works while the switch is off too (`enabled` says which).',
    risk: 'read',
    access: { action: 'store.release' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'The state.', schema: z.object({ release: releaseStateSchema }) },
    },
  },
  {
    id: 'previewStoreRelease',
    method: 'post',
    path: `${W}/apps/{id}/store-release/preview`,
    tags: ['releases'],
    summary:
      'Preview a release: what is released, to whom, checks, a confirmHash and the text to type',
    description:
      'Needs `store.release` and `KILN_STORE_RELEASE_ENABLED=true`. READS the store, writes nothing, and settles an earlier unknown outcome (a successful read). App Store: the version in Pending Developer Release (name `version` when more than one waits; macOS is the macOS version). Google Play: `track` and an explicit `userFraction` are required (`422 track_required`, `422 user_fraction_required`); `versionCodes` pick the draft when the track holds several. `checks.blocking` stops a release (nothing releasable, more than one candidate, version codes not uploaded, a rollout already running in the track, a push or submit in flight); `checks.warnings` do not. While anything blocks, `confirmHash` and `confirmation` are null.',
    risk: 'read',
    access: { action: 'store.release' },
    appScope: { kind: 'param', name: 'id' },
    body: z.object(releaseWhat),
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: releasePreviewSchema }) },
    },
  },
  {
    id: 'applyStoreRelease',
    method: 'post',
    path: `${W}/apps/{id}/store-release`,
    tags: ['releases'],
    summary:
      'RELEASE the approved version, or start the Google Play draft release at the named share (irreversible)',
    description:
      'A STORE WRITE THAT CANNOT BE TAKEN BACK from this server. Needs `store.release` (owner and admin; a token only when its actions name it; `403` otherwise) and `KILN_STORE_RELEASE_ENABLED=true` (`409 store_release_disabled`). `confirmHash` must come from a preview of the same request and state, and `confirmation` must be its `confirmation.phrase` (`422 confirmation_mismatch`). The store is READ AGAIN right before the write: if it is not the one previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). One release per app and platform at a time (`409 write_in_progress`); a draft push or a submit in flight blocks it. App Store: `POST appStoreVersionReleaseRequests` for the version in Pending Developer Release. Google Play: an edit that sets the draft release to `inProgress` with `userFraction` (or `completed` for 1), committed without `changesNotSentForReview` and with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review`). Never retried: after a timeout or a 5xx the store is read back: `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`, App Store), or `409 outcome_unknown` (preview again; Google Play can be slow to show a commit). Audited as `store.released` / `store.release_failed` (ids, a share, hashes and outcomes, never a text or a credential) and emitted as the event `release.started`. While a batch publish of the app runs (`getPendingPublishing`) this is refused with `409 publish_in_progress`, and the message names when that publish started.',
    risk: 'destructive',
    access: { action: 'store.release' },
    appScope: { kind: 'param', name: 'id' },
    body: releaseApplyBody,
    responses: {
      '200': {
        description: 'What was released.',
        schema: z.object({ result: releaseResultSchema }),
      },
    },
  },
];
