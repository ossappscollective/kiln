import { z } from 'zod';
import { type Draft, object, stagedAppSchema, timestamp, W } from '../../operations/shared.ts';

const stagedProblemSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z
    .string()
    .describe(
      'A listing rule (`too_long`, `invalid_url`, ...), an asset spec rule (`apple.screenshot.size`, ...) or a push rule (`slot_not_pushable`, `format_not_pushable`, `file_too_large`, `set_too_large`, `mixed_display_types`, `no_display_type`, `field_not_pushable`).',
    ),
  message: z.string(),
  limit: z.number().optional(),
  actual: z.number().optional(),
  unit: z.enum(['characters', 'bytes']).optional(),
});

const stagedSource = z.enum(['local', 'repo', 'store']);

const stagedSlotSchema = z.object({
  kind: z.string().describe('`screenshot`, `icon`, `feature_graphic`, `tv_banner`, ...'),
  device: z
    .string()
    .nullable()
    .describe(
      'A display id (`iphone_6_5`) or a Play device (`phone`); null for graphics that have none.',
    ),
});

const stagedTextSchema = z.object({
  id: z.string(),
  kind: z.literal('listing_text'),
  locale: z.string(),
  field: z.string(),
  label: z.string(),
  source: stagedSource,
  value: z
    .string()
    .describe('The staged text (listing copy: shown in the product, never logged or audited).'),
  valueHash: z.string(),
  limit: z.number().nullable(),
  unit: z.enum(['characters', 'bytes']),
  before: z
    .string()
    .nullable()
    .describe(
      'The last value this tool stored from the store (the live listing, or the editable one when the app has no live version). Null: none stored. The push preview shows the real draft.',
    ),
  status: z.enum(['changed', 'unchanged', 'invalid']),
  problems: z.array(stagedProblemSchema),
  pushedAt: timestamp.nullable(),
  pushed: z.boolean().describe('Pushed, and the staged value is still the one that was pushed.'),
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const stagedAssetSchema = z.object({
  id: z.string().describe('`<locale>/<slotKey>`. Send it to the remove route.'),
  kind: z.literal('asset'),
  locale: z.string(),
  slot: stagedSlotSchema,
  slotKey: z.string().describe('`screenshot:iphone_6_5`, `icon`, ...'),
  label: z.string(),
  source: stagedSource,
  files: z
    .array(
      z.object({
        id: z.string(),
        position: z.number().int(),
        path: z.string(),
        commit: z.string(),
        oid: z.string().describe('The git blob id; the bytes are checked against it when pushed.'),
        bytes: z.number().int().nullable(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        format: z.string().nullable(),
        hasAlpha: z.boolean().nullable(),
      }),
    )
    .describe('The set, in order. A push makes the store’s set exactly these files.'),
  status: z.enum(['changed', 'invalid']),
  problems: z.array(stagedProblemSchema),
  pushedAt: timestamp.nullable(),
  pushed: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const stagedReleaseFieldSchema = z.object({
  id: z.string(),
  kind: z.literal('release_field'),
  field: z
    .string()
    .describe(
      'App Store: `build`, `version_string`, `release_type`, `earliest_release_date`, `copyright`, `phased_release`. Google Play: `track`, `release_name`, `version_codes`, `user_fraction`, `release_notes`. The App Store "what is new" is the listing field `release_notes` of `stageListingText`.',
    ),
  label: z.string(),
  locale: z
    .string()
    .describe('The language of a per language field (Play `release_notes`); empty otherwise.'),
  value: z
    .string()
    .describe(
      'The canonical staged value (version codes `240,241`, a share `0.1`, a date `2026-12-01T10:00:00Z`, phased release `on` or `off`).',
    ),
  valueHash: z.string(),
  localOnly: z
    .boolean()
    .describe(
      'True for `user_fraction`: kept here, never written to the store by a push (Google Play cannot hold a share in a draft). The release step needs an explicit share.',
    ),
  maxLength: z.number().int().nullable(),
  status: z.enum(['changed', 'invalid']),
  problems: z.array(stagedProblemSchema),
  pushedAt: timestamp.nullable(),
  pushed: z.boolean().describe('Pushed, and the staged value is still the one that was pushed.'),
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const stagedLimitsSchema = z.object({
  maxItems: z.number().int(),
  maxTextChars: z.number().int(),
  maxLocaleChars: z.number().int(),
  maxAssetFilesPerPush: z.number().int(),
  maxAssetBytesPerPush: z.number().int(),
  maxAssetFileBytes: z.number().int(),
});

const stagedChangesSchema = z.object({
  app: stagedAppSchema,
  text: z.array(stagedTextSchema),
  assets: z.array(stagedAssetSchema),
  release: z
    .array(stagedReleaseFieldSchema)
    .describe(
      'The release fields staged for the app (docs/api/releases-write.md): App Store version fields or a Google Play draft release.',
    ),
  totals: z.object({
    text: z.number().int(),
    assetSets: z.number().int(),
    assetFiles: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
    changed: z.number().int(),
    release: z.number().int(),
  }),
  valid: z
    .boolean()
    .describe('False when any item has an error: a push is refused while there are some.'),
  pushable: z.object({
    textFields: z.array(z.string()),
    releaseFields: z.array(z.string()).describe('The release fields this platform can stage.'),
  }),
  limits: stagedLimitsSchema,
});

const stagedTextBody = z.object({
  locale: z.string().min(2).max(35).describe('A store locale code such as `en-US`.'),
  field: z
    .string()
    .min(1)
    .max(60)
    .describe(
      'A pushable listing field: App Store `description`, `keywords`, `promotional_text`, `release_notes`, `marketing_url`, `support_url`; Google Play `title`, `short_description`, `full_description`, `video`.',
    ),
  from: stagedSource.describe(
    '`local`: send `value`. `repo`: the repository snapshot the listing reads stored. `store`: the store snapshot the last sync stored. No store or repository is read now.',
  ),
  value: z.string().max(40_000).optional().describe('Required for `local`, refused otherwise.'),
});

const stagedAssetsBody = z.object({
  locale: z.string().min(2).max(35),
  kind: z
    .string()
    .describe(
      'A kind of graphic of the Assets tab: `screenshot`, `icon`, `feature_graphic`, `tv_banner`. Previews, the App Store app icon and the Play promo graphic cannot be pushed (`422 slot_not_pushable`).',
    ),
  device: z
    .string()
    .max(60)
    .nullable()
    .optional()
    .describe(
      'Required for `screenshot` (a display id such as `iphone_6_5`, or a Play device such as `phone`); null otherwise.',
    ),
  from: stagedSource
    .optional()
    .describe(
      'Only `repo` is supported (default). Store images are pulled into the repository (`pullStoreImages`) and files are uploaded with `uploadStagedAsset`.',
    ),
  paths: z
    .array(z.string().max(1024))
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The files of the set, in order, as the asset index lists them. Default: every file of the slot in index order.',
    ),
  commit: z
    .string()
    .max(64)
    .optional()
    .describe('Read this commit of the repository (a full hash). Default: the branch tip.'),
});

const stagedReleaseFieldBody = z.object({
  field: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'A release field of this platform: App Store `build` (the id of a processed build from `listReleaseCandidates`), `version_string`, `release_type` (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`), `earliest_release_date`, `copyright`, `phased_release` (`on` or `off`); Google Play `track`, `release_name`, `version_codes`, `user_fraction`, `release_notes`.',
    ),
  locale: z
    .string()
    .min(2)
    .max(35)
    .optional()
    .describe('Google Play `release_notes` only: the language, for example `en-US`.'),
  value: z
    .union([z.string().max(40_000), z.number(), z.boolean(), z.array(z.string().max(20)).max(50)])
    .describe(
      'The value. Version codes may be an array or `240,241`; a share `0.1` or `10%`; `phased_release` `on`/`off` or a boolean. It is normalized and checked; an empty value is refused (nothing clears a store field).',
    ),
});

const stagedPushBody = z.object({
  confirmHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe('The `confirmHash` of a preview made now.'),
});

const stagedPushPreviewBody = z.object({});

const draftConfigSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'KILN_STORE_DRAFT_WRITE_ENABLED. While false the push routes answer `409 store_draft_disabled`; staging and the staged view work.',
    ),
  envName: z.string(),
  submit: z
    .object({ implemented: z.literal(true), configRoute: z.string(), note: z.string() })
    .describe(
      'A push never submits. Submitting is a separate, gated step: see `GET store-submit/config` (docs/api/submit.md).',
    ),
  limits: stagedLimitsSchema,
});

const draftStateVersion = z
  .object({ id: z.string(), versionString: z.string().nullable(), state: z.string() })
  .nullable()
  .describe('App Store: the editable version that is written. Google Play: null.');

const draftPreviewSchema = z.object({
  app: stagedAppSchema,
  version: draftStateVersion,
  text: z.array(
    z.object({
      id: z.string(),
      locale: z.string(),
      field: z.string(),
      before: z.string().nullable().describe('The draft’s value now.'),
      after: z.string(),
      localeExists: z.boolean(),
      status: z.enum(['changed', 'unchanged', 'new_locale']),
    }),
  ),
  assets: z.array(
    z.object({
      id: z.string(),
      locale: z.string(),
      slot: stagedSlotSchema,
      slotKey: z.string(),
      target: z
        .string()
        .describe(
          'The store’s own name of the set: the App Store `screenshotDisplayType` (UNVERIFIED names) or the Google Play `AppImageType`.',
        ),
      placementGroup: z
        .string()
        .optional()
        .describe(
          'App Store: the App Asset Library placement group the set is written to (found from Apple’s reference data and the pixel size). Google Play: absent.',
        ),
      before: z.object({
        setExists: z.boolean(),
        files: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            checksum: z.string().nullable(),
            state: z.string().nullable(),
          }),
        ),
      }),
      after: z.object({
        files: z.array(
          z.object({
            path: z.string(),
            name: z.string(),
            oid: z.string(),
            bytes: z.number().int(),
            width: z.number().int().nullable(),
            height: z.number().int().nullable(),
            format: z.string().nullable(),
          }),
        ),
      }),
      status: z.enum(['changed', 'unchanged']),
      willUpload: z.number().int(),
      willRemove: z.number().int(),
    }),
  ),
  release: z
    .array(
      z.object({
        id: z.string(),
        field: z.string(),
        label: z.string(),
        locale: z.string(),
        before: z
          .string()
          .nullable()
          .describe('The store’s value now, in the same canonical text. Null: not set.'),
        after: z.string(),
        status: z
          .enum(['changed', 'unchanged', 'local'])
          .describe('`local`: kept here and never written (the intended Play share).'),
        localOnly: z.boolean(),
      }),
    )
    .describe('The staged release fields, before and after.'),
  checks: z
    .object({
      blocking: z.array(
        z.object({
          code: z
            .string()
            .describe(
              'For example `build_not_found`, `build_expired`, `build_not_processed`, `version_codes_not_uploaded`, `no_draft_release`, `field_unreadable`.',
            ),
          severity: z.enum(['blocking', 'warning']),
          message: z.string(),
          field: z.string().optional(),
          locale: z.string().optional(),
        }),
      ),
      warnings: z.array(
        z.object({
          code: z.string(),
          severity: z.enum(['blocking', 'warning']),
          message: z.string(),
          field: z.string().optional(),
          locale: z.string().optional(),
        }),
      ),
      canPush: z.boolean(),
    })
    .describe(
      'What the store says about the staged release fields. A blocking check refuses the push (`409 blocked`, nothing written).',
    ),
  summary: z.object({
    textChanged: z.number().int(),
    textUnchanged: z.number().int(),
    assetSetsChanged: z.number().int(),
    assetSetsUnchanged: z.number().int(),
    filesToUpload: z.number().int(),
    filesToRemove: z.number().int(),
    fieldsChanged: z.number().int(),
    fieldsUnchanged: z.number().int(),
    nothingToDo: z.boolean(),
  }),
  submits: z
    .literal(false)
    .describe('Always false: a push writes a draft and never submits or publishes.'),
  confirmHash: z
    .string()
    .describe(
      'Send it back to push. Valid only while the staged items and the store’s draft are as previewed.',
    ),
  warnings: z.array(z.string()),
  readAt: timestamp,
});

const draftResultSchema = z.object({
  app: stagedAppSchema,
  version: draftStateVersion,
  steps: z.array(
    z.object({
      type: z.enum(['text', 'asset', 'locale', 'field']),
      locale: z.string(),
      target: z.string(),
      outcome: z.enum(['applied', 'already_same']),
      uploaded: z.number().int().optional(),
      removed: z.number().int().optional(),
    }),
  ),
  counts: z.object({
    applied: z.number().int(),
    alreadySame: z.number().int(),
    filesUploaded: z.number().int(),
    filesRemoved: z.number().int(),
  }),
  fields: z.number().int().describe('How many release fields were part of the push.'),
  commit: z
    .enum(['not_sent_for_review', 'draft_release', 'none'])
    .describe(
      'Google Play: the edit was committed with `changesNotSentForReview=true`, or `draft_release` when Google refused that and the edit held only the draft release of a track (committed without it). App Store: `none` (every request changes the draft at once).',
    ),
  draft: z.literal(true),
  submitted: z
    .literal(false)
    .describe('Always false: nothing was submitted, sent for review or published.'),
  confirmedByReread: z
    .boolean()
    .describe(
      'True when the write’s outcome was unknown and reading the draft back showed the changes.',
    ),
  pushedAt: timestamp,
  note: z.string(),
});

export const stagedChangesOperations: Draft[] = [
  {
    id: 'uploadStagedAsset',
    method: 'put',
    path: `${W}/apps/{id}/staged/assets/upload`,
    tags: ['staged-changes'],
    summary: 'Add an uploaded image to a staged set, or replace one of its files',
    description:
      'The request body is the raw image bytes (at most 8 MiB; PNG or JPEG by content; the kept total is capped per app). The set is composed from what is staged, else from the repository\u2019s files for the slot, and the whole set is staged (a push replaces the store\u2019s set). A file with an error against the store specs is refused with `422 spec_errors` and the fixes that apply. Bytes are kept by this server until the set is unstaged. Nothing is written to a store or a repository. Audited with blob ids only.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    bodyLimit: 8 * 1024 * 1024,
    query: z.object({
      locale: z.string().min(2).max(35),
      kind: z.string().describe('screenshot, icon, feature_graphic, promo_graphic or tv_banner.'),
      device: z
        .string()
        .max(60)
        .optional()
        .describe('Required for screenshot: a display id (iphone_6_9) or a Play device (phone).'),
      mode: z.string().optional().describe('`add` (default) or `replace`.'),
      position: z.string().optional().describe('1-based: the file to replace, or where to insert.'),
      name: z.string().max(200).optional(),
      fix: z
        .string()
        .optional()
        .describe(
          '`remove_alpha`, `rename_extension` or `resize`: correct the file before it is checked and staged (send a refused file again with the fix the `spec_errors` answer offered).',
        ),
      background: z.string().optional().describe('`#rrggbb` for `remove_alpha`, default white.'),
    }),
    responses: {
      '200': {
        description: 'The staged changes after the change.',
        schema: z.object({ staged: stagedChangesSchema, position: z.number() }),
      },
    },
  },
  {
    id: 'removeStagedAssetFile',
    method: 'delete',
    path: `${W}/apps/{id}/staged/assets/file`,
    tags: ['staged-changes'],
    summary: 'Take one file out of a staged set',
    description:
      'The set is composed as for an upload. A push replaces the store\u2019s set with the files that remain; the last file cannot be removed (`422 empty_set`): a push cannot clear a set.',
    risk: 'destructive',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      locale: z.string().min(2).max(35),
      kind: z.string().describe('screenshot, icon, feature_graphic, promo_graphic or tv_banner.'),
      device: z
        .string()
        .max(60)
        .optional()
        .describe('Required for screenshot: a display id (iphone_6_9) or a Play device (phone).'),
      position: z.string().describe('1-based.'),
    }),
    responses: {
      '200': {
        description: 'The staged changes after the change.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'fixStagedAssetFile',
    method: 'post',
    path: `${W}/apps/{id}/staged/assets/fix`,
    tags: ['staged-changes'],
    summary: 'Stage a corrected copy of a file of a set (remove the alpha channel, rename, resize)',
    description:
      'Never changes a file in place: the corrected bytes are kept by this server and replace the file in the staged set, to be previewed like an upload. `remove_alpha` flattens onto a background colour (default white); only 8 bit, non-interlaced PNG files are changed (`422 fix_unsupported` says why otherwise). `resize` is PNG only, to the nearest size the store requires. `422 fix_no_target_size` states what is required.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: z.object({
      locale: z.string().min(2).max(35),
      kind: z.string(),
      device: z.string().max(60).nullable().optional(),
      position: z.number().int().min(1),
      fix: z.enum(['remove_alpha', 'rename_extension', 'resize']),
      background: z.string().max(9).optional().describe('`#rrggbb`, default white.'),
    }),
    responses: {
      '200': {
        description: 'The staged changes and one sentence on what was done.',
        schema: z.object({ staged: stagedChangesSchema, summary: z.string() }),
      },
    },
  },
  {
    id: 'getStagedAssetBlob',
    method: 'get',
    path: `${W}/apps/{id}/staged/assets/blob`,
    tags: ['staged-changes'],
    summary: 'An image that was uploaded or fixed here',
    description:
      'Only the bytes this server keeps for the app, by git blob id. Same safe image headers as the asset file route; `ETag` is the blob id.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      oid: z.string().describe('The blob id (`oid` of a staged file with `upload: true`).'),
    }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/png' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'stagedAssetsToRepo',
    method: 'post',
    path: `${W}/apps/{id}/staged/assets/to-repo`,
    tags: ['staged-changes'],
    summary: 'Draft a change set that puts staged graphics sets into the repository',
    description:
      'Each repository set becomes exactly the staged one (files the staged set no longer holds are deleted; files already right are untouched). Nothing is applied: the draft is reviewed, approved and applied like any change set. Needs `changesets.write`.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    partial: true,
    body: z.object({
      sets: z
        .array(z.string())
        .max(200)
        .optional()
        .describe('Set ids `locale/slotKey`; default every staged set.'),
    }),
    bodyOptional: true,
    responses: {
      '200': {
        description:
          'The change set (null when the repository already has the sets) and what was skipped.',
        schema: object,
      },
    },
  },
  {
    id: 'getStoreDraftConfig',
    method: 'get',
    path: `${W}/store-draft/config`,
    tags: ['staged-changes'],
    summary: 'Whether writing store drafts is switched on, and the limits',
    risk: 'read',
    access: { action: 'apps.read' },
    responses: {
      '200': {
        description: 'The switch, the limits, and that submitting is not implemented.',
        schema: draftConfigSchema,
      },
    },
  },
  {
    id: 'getStagedChanges',
    method: 'get',
    path: `${W}/apps/{id}/staged`,
    tags: ['staged-changes'],
    summary: 'The staged listing text and graphics of an app, with limits and problems',
    description:
      'Reads the database only: no store, no repository. Each item has `problems` from the listing limits and the asset specs and what a push needs; an item with an `error` blocks a push. `before` is the last value this tool stored from the store.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The staged changes.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'stageListingText',
    method: 'put',
    path: `${W}/apps/{id}/staged/text`,
    tags: ['staged-changes'],
    summary: 'Stage a listing text of one locale (nothing is written to a store)',
    description:
      'Adds or replaces the staged value of one locale and field, taken from the repository snapshot (`from: repo`), the store snapshot (`from: store`) or typed (`from: local`, with `value`). The value is normalized (line breaks, trailing white space). `422 field_not_pushable` for a field a push cannot write (App Store name, subtitle and privacy policy URL), `422 empty_text`, `422 no_source_value`. Needs `changesets.write`. Audited as `staged.text_set` with a hash, never the text.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: stagedTextBody,
    responses: {
      '200': {
        description: 'The staged changes after the change.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'stageListingAssets',
    method: 'put',
    path: `${W}/apps/{id}/staged/assets`,
    tags: ['staged-changes'],
    summary:
      'Stage a set of graphics of one locale and slot from the repository (nothing is written to a store)',
    description:
      'Replaces the staged set of a locale and slot with files of the repository’s asset index (the Assets tab), kept by reference: path, commit and git blob id. A push makes the store’s set exactly these files, in this order. `422 slot_not_pushable` (App Store previews and app icon, Play promo graphic), `422 source_not_supported` (only `repo` here: pull store images into the repository with `pullStoreImages`, upload with `uploadStagedAsset`), `422 asset_not_pushable` (not PNG or JPEG, not opened, over 8 MiB), `422 too_many_files` / `too_many_bytes`. Needs `changesets.write`; the repository read costs like an Assets tab read (rate limited). Audited as `staged.assets_set` with blob ids.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: stagedAssetsBody,
    responses: {
      '200': {
        description: 'The staged changes after the change.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'unstageItem',
    method: 'delete',
    path: `${W}/apps/{id}/staged/items`,
    tags: ['staged-changes'],
    summary: 'Remove one staged text (its id) or one staged set (`locale/slotKey`)',
    risk: 'destructive',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      id: z
        .string()
        .describe(
          'The id of a staged text, or the `id` of a staged set (`en-US/screenshot:iphone_6_5`).',
        ),
    }),
    responses: {
      '200': {
        description: 'The staged changes after the removal.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'clearStagedChanges',
    method: 'delete',
    path: `${W}/apps/{id}/staged`,
    tags: ['staged-changes'],
    summary: 'Remove every staged item of an app',
    risk: 'destructive',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The (empty) staged changes.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
  {
    id: 'previewStagedPush',
    method: 'post',
    path: `${W}/apps/{id}/staged/push/preview`,
    tags: ['staged-changes'],
    summary:
      'Preview pushing the staged changes to the store as a draft: per item before and after, and a confirmHash',
    description:
      'READS THE STORE (the draft; Google Play opens and deletes an edit, which invalidates other open edits of the same service account) and the bytes of the staged files from the repository. Writes nothing. `422 nothing_staged`, `422 staged_invalid` (items with errors), `422 asset_changed`, `422 no_editable_version` (App Store: no version in Prepare for Submission). Needs `store.push_draft` and `KILN_STORE_DRAFT_WRITE_ENABLED=true` (`409 store_draft_disabled` otherwise).',
    risk: 'read',
    access: { action: 'store.push_draft' },
    appScope: { kind: 'param', name: 'id' },
    body: stagedPushPreviewBody,
    bodyOptional: true,
    responses: {
      '200': { description: 'The preview.', schema: z.object({ preview: draftPreviewSchema }) },
    },
  },
  {
    id: 'pushStagedDraft',
    method: 'post',
    path: `${W}/apps/{id}/staged/push`,
    tags: ['staged-changes'],
    summary:
      'Write the staged changes to the store as a DRAFT (never submits, sends for review or publishes)',
    description:
      'A STORE WRITE. Needs `store.push_draft` (owner and admin; a token only when its actions name it) and `KILN_STORE_DRAFT_WRITE_ENABLED=true`. `confirmHash` must come from a preview of the same staged items. The store’s draft is READ AGAIN right before the first write: if it is not the one previewed, or the staged items changed, nothing is written (`409 state_changed`, with a new `preview`). One write per app at a time (`409 write_in_progress`). App Store: the editable version’s localizations and screenshots change one request at a time (a refusal part way is `502 draft_partial`, with `completed` and `failed`). Google Play: one edit, committed with `changesNotSentForReview=true` (`409 draft_not_allowed` when Google refuses that, `409 changes_in_review` when changes are in review: nothing is committed). Never retried: after a timeout or a 5xx the draft is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), `409 draft_partial`, or `409 outcome_unknown` (then preview again). Audited as `listing.draft_pushed` / `listing.draft_push_failed` (ids, counts and hashes, never a text or a credential) and emitted as the event `listing.draft_pushed`.',
    risk: 'destructive',
    access: { action: 'store.push_draft' },
    appScope: { kind: 'param', name: 'id' },
    body: stagedPushBody,
    responses: {
      '200': { description: 'What was written.', schema: z.object({ result: draftResultSchema }) },
    },
  },
  {
    id: 'stageReleaseField',
    method: 'put',
    path: `${W}/apps/{id}/staged/release-fields`,
    tags: ['staged-changes'],
    summary: 'Stage one release field of the draft release; nothing is written to a store',
    description:
      'Stages ONE field, normalized and checked on its own (`422 field_not_stageable`, `422 invalid_locale`, `422 empty_value`, `422 invalid_staged` with the first error, `422 too_many_items`). The App Store "what is new" is the listing field `release_notes` (`stageListingText`). Google Play `user_fraction` is kept here only: a draft cannot hold a share, and the release step needs an explicit one. The values reach a store only through the draft push (`pushStagedDraft`), whose preview shows each field before and after with the store’s facts (`checks`). Needs `changesets.write`. Audited as `staged.release_field_set` with a hash, never the value.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: stagedReleaseFieldBody,
    responses: {
      '200': {
        description: 'The staged changes after the change.',
        schema: z.object({ staged: stagedChangesSchema }),
      },
    },
  },
];
