import { z } from 'zod';
import { changeSetSchema, type Draft, listingQuery, object, W } from '../../operations/shared.ts';
import { assetProposalOperations } from './asset-proposal-operations.ts';

const pullListingBody = z.object({
  channel: z
    .enum(['live', 'editable'])
    .optional()
    .describe(
      'Which store copy to pull. Default: live, or editable when the app has no live version.',
    ),
  locales: z
    .array(z.string().max(35))
    .max(100)
    .optional()
    .describe('Only these locales (store codes).'),
  fields: z
    .array(z.string().max(40))
    .max(20)
    .optional()
    .describe(
      'Only these fields. Naming fields also pulls a field the repository has no value for.',
    ),
  items: z
    .array(z.object({ locale: z.string().max(35), field: z.string().max(40) }).strict())
    .max(1000)
    .optional()
    .describe('Exactly these locale and field pairs.'),
  addLocales: z
    .boolean()
    .optional()
    .describe(
      'Create the folders of store locales the repository does not have. Default: only locales that exist in the repository.',
    ),
  summary: z.string().trim().min(1).max(200).optional(),
  refresh: z
    .boolean()
    .optional()
    .describe('Read the store again first (needs `apps.sync`; shares the sync rate limit).'),
  target: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A saved listing target id, or `auto:<key>`.'),
  roots: z
    .object({
      appStore: z.string().max(400).optional(),
      googlePlay: z.string().max(400).optional(),
    })
    .strict()
    .optional(),
});

const appListingSettingsSchema = z.object({
  compareRepo: z
    .boolean()
    .describe(
      'Compare the repository (fastlane text) with the store and show the differences. Default false: the store page is checked on its own.',
    ),
  compareMedia: z
    .boolean()
    .describe(
      'Compare the repository graphics with the store graphics. Default false: the store graphics are listed on their own.',
    ),
});

export const listingOperations: Draft[] = [
  ...assetProposalOperations,
  {
    id: 'getAppListingSettings',
    method: 'get',
    path: `${W}/apps/{id}/listing-settings`,
    tags: ['listing'],
    summary: 'The listing settings of an app: whether the repository is compared with the store',
    description:
      'Needs `apps.read`. Reads the database only. An app that never changed them (every app before this setting existed) reads `compareRepo: false, compareMedia: false`.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The settings.',
        schema: z.object({ settings: appListingSettingsSchema }),
      },
    },
  },
  {
    id: 'updateAppListingSettings',
    method: 'put',
    path: `${W}/apps/{id}/listing-settings`,
    tags: ['listing'],
    summary: 'Change the listing settings of an app (a partial update)',
    description:
      'Needs `apps.write` (admin and up). Send only what changes. All or nothing (`422 invalid_setting` with `issues`). Changes how Kiln shows the listing and its graphics; nothing is written to a store or a repository. Audited as `app.listing_settings_update` (the app id and the old and new values).',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'id' },
    body: z
      .object({ compareRepo: z.boolean().optional(), compareMedia: z.boolean().optional() })
      .strict(),
    responses: {
      '200': {
        description: 'The settings after the change, and the keys that changed.',
        schema: z.object({ settings: appListingSettingsSchema, changed: z.array(z.string()) }),
      },
    },
  },
  {
    id: 'getLiveListing',
    method: 'get',
    path: `${W}/apps/{id}/listing/live`,
    tags: ['listing'],
    summary: 'The listing as the store has it (from the last listing read)',
    description:
      'Reads the database. Nothing is sent to a store. Besides the texts per channel and locale it returns `warnings` (what the connector noticed in the last read), `schedule` (the scheduled listing read, KILN_LISTING_INTERVAL_MINUTES) and, per channel, `sections` (categories, ageRating, privacy, media, details, releaseNotes): a section that is missing was not read, one that is present and empty was read and is empty. Read-only; never pulled into a repository.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: listingQuery,
    partial: true,
    responses: { '200': { description: 'The live listing.', schema: object } },
  },
  {
    id: 'getListingDrift',
    method: 'get',
    path: `${W}/apps/{id}/listing/drift`,
    tags: ['listing'],
    summary: 'How the live listing differs from the repository',
    description:
      'Texts per locale and field, plus `sections`: the store\u2019s categories, age rating, privacy choices URL, app details and media counts against what the repository can express, each with a compare status (`identical`, `differs`, `missing-in-repo`, `missing-in-store`, `not-comparable`, `not-read`). Reads the database only.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: listingQuery,
    partial: true,
    responses: { '200': { description: 'The differences.', schema: object } },
  },
  {
    id: 'getListingHistory',
    method: 'get',
    path: `${W}/apps/{id}/listing/history`,
    tags: ['listing'],
    summary: 'How a listing field changed between syncs',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      locale: z.string().optional(),
      field: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    }),
    partial: true,
    responses: { '200': { description: 'Changes, newest first.', schema: object } },
  },
  {
    id: 'getAppAssets',
    method: 'get',
    path: `${W}/apps/{id}/assets`,
    tags: ['assets'],
    summary:
      'The screenshots, graphics and icons in the app\u2019s repository, with problems against the documented store specs',
    description:
      'Read-only: reads the connected repository (a local clone when there is one, else GitHub) and writes nothing, not even to this server\u2019s database. Only the first bytes of each image are read to get its size; a GitHub read has a budget and says `partial` when it ran out. The index is cached per commit. `storeSide` is reserved for the store\u2019s own counts and is null. The checks are against the specs as documented in docs/api/assets.md, never against a store. Rate limited per workspace when it has to read the repository.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    partial: true,
    responses: {
      '200': {
        description:
          'The index: assets with their facts, problems, counts per set, the source and the commit that was read.',
        schema: object,
      },
    },
  },
  {
    id: 'getAppAssetFile',
    method: 'get',
    path: `${W}/apps/{id}/assets/file`,
    tags: ['assets'],
    summary: 'One image of the asset index',
    description:
      'Only a path the index lists for this app. The type is sniffed from the bytes (png, jpeg, webp or gif), never svg or html; `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` and a sandboxing CSP are set. `ETag` is the git blob id and `If-None-Match` is answered with `304`. Files over 8 MB are refused (`413`). The image is not resized: the browser scales it.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({
      path: z.string().describe('A path from the index.'),
      commit: z
        .string()
        .optional()
        .describe('The commit of the index (a full hash). Without it the branch tip is read.'),
    }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/png' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'getAppIcon',
    method: 'get',
    path: `${W}/apps/{id}/icon`,
    tags: ['assets'],
    summary: 'The icon of an app',
    description:
      'From the repository when it has one, else (iOS) from the public iTunes Lookup API; kept by the server, at most 256 KB. The first request may take a few seconds while it is looked up; `404` when there is none. Same safe image headers as the asset file route.',
    risk: 'read',
    access: { action: 'apps.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      v: z
        .string()
        .optional()
        .describe('The etag from `iconUrl`: makes the answer cacheable for a year.'),
    }),
    responses: {
      '200': { description: 'The icon.', contentType: 'image/png' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'getAppStoreImages',
    method: 'get',
    path: `${W}/apps/{id}/assets/store`,
    tags: ['assets'],
    summary: 'The images the store holds for the app',
    description:
      'Reads the store through the app\u2019s credential (audited as `credential.use`, purpose `store.images_read`) and changes nothing in it. App Store: the editable version if there is one, else the live one; Google Play: the live listing. Kept for 60 seconds. Images have an opaque `ref` (never a store address) for the thumbnail route. `429 rate_limited` when the workspace reads the store too often.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ fresh: z.string().optional().describe('`1` skips the cache.') }),
    responses: { '200': { description: 'The store\u2019s sets and images.', schema: object } },
  },
  {
    id: 'getAppAssetDiff',
    method: 'get',
    path: `${W}/apps/{id}/assets/diff`,
    tags: ['assets'],
    summary: 'The repository\u2019s graphics against the store\u2019s, file by file',
    description:
      'Per set and file: `identical`, `likely_same` (no checksum on the store side: compared by size), `differs`, `only_repo`, `only_store`. Reads the store (cached 60 seconds) and the repository (the asset index, and files only where the store gives a checksum, within a budget). Changes nothing.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    partial: true,
    query: z.object({ fresh: z.string().optional().describe('`1` skips the store cache.') }),
    responses: { '200': { description: 'The comparison.', schema: object } },
  },
  {
    id: 'getStoreImageThumbnail',
    method: 'get',
    path: `${W}/apps/{id}/assets/store/thumb`,
    tags: ['assets'],
    summary:
      'A thumbnail of a store image (a proxy: the browser never contacts the store\u2019s CDN)',
    description:
      'Fetches from the store\u2019s image hosts only (https, an allowlist of hosts checked again on every redirect, resolved addresses checked, a size cap, a timeout), sniffs the type from the bytes and serves it with the safe image headers. `ETag` is derived from the ref: `If-None-Match` is answered with `304`. `404 ref_expired` when the ref is not known any more (read the comparison again).',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({
      ref: z.string().describe('The `ref` of an image from the store view.'),
      size: z.string().optional().describe('160, 320 (default) or 640: the long side.'),
    }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/jpeg' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'getStoreImageFile',
    method: 'get',
    path: `${W}/apps/{id}/assets/store/file`,
    tags: ['assets'],
    summary: 'The original file of a store image (for saving or copying it)',
    description:
      'The same proxy rules as the thumbnail (store hosts only, checked on every redirect, a size cap of 8 MiB), but the ORIGINAL size: a Google Play address is asked for `=s0`, an App Store template is filled with the asset\u2019s own size. Never a rendition. `ETag` is derived from the ref (`304` for `If-None-Match`); `404 ref_expired` when the ref is not known any more.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ ref: z.string().describe('The `ref` of an image from the store view.') }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/png' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'pullStoreImages',
    method: 'post',
    path: `${W}/apps/{id}/assets/pull`,
    tags: ['assets'],
    summary: 'Pull the store\u2019s images into a draft change set for the repository',
    description:
      'Downloads the store\u2019s images (hosts allowlisted, per-file and total caps) and drafts a change set that adds or replaces the files in the repository\u2019s own layout. Nothing is written to the repository or the store: the change set is reviewed, approved and applied like any other (a pull request, or a commit on a new branch in a local clone). Google Play images are checked against the SHA-256 the store gives (a mismatch is not taken); the App Store gives none, so they are `unverified`. Files of the repository the store does not have stay unless `prune`. Needs `changesets.write`.',
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
        .describe('Set keys such as `ios/en-US/screenshot:iphone_6_9`.'),
      files: z
        .array(z.string())
        .max(120)
        .optional()
        .describe('Image keys: a set key and `#position`.'),
      prune: z.boolean().optional(),
    }),
    bodyOptional: true,
    responses: {
      '200': {
        description:
          'What was drafted, skipped and why. `changeSet` is null when nothing had to change.',
        schema: object,
      },
    },
  },
  {
    id: 'inspectAssetFile',
    method: 'post',
    path: `${W}/apps/{id}/assets/inspect`,
    tags: ['assets'],
    summary: 'What an image is and what is wrong with it for a slot (nothing is stored)',
    description:
      'The request body is the raw image bytes (at most 8 MiB). The type comes from the bytes: PNG or JPEG only. Answers the facts, the problems against the documented specs and the fixes the app can make. Needs `changesets.write`.',
    risk: 'read',
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
      name: z.string().max(200).optional(),
    }),
    responses: { '200': { description: 'The inspection.', schema: object } },
  },
  {
    id: 'refreshListingFromRepo',
    method: 'post',
    path: `${W}/apps/{id}/listing/repo-refresh`,
    tags: ['listing'],
    summary: 'Read the listing from the connected repository again',
    description: 'Reads GitHub; writes only to this server’s database.',
    risk: 'write',
    access: { action: 'repositories.scan' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: { '200': { description: 'The refreshed listing.', schema: object } },
  },
  {
    id: 'pullStoreListing',
    method: 'post',
    path: `${W}/apps/{id}/listing/pull`,
    tags: ['listing'],
    summary: 'Draft a change set from the live store listing',
    description:
      'Applies the store\u2019s values to the repository\u2019s own listing files as a draft change set. Reads GitHub (and the store with `refresh`); writes nothing to a store or to the repository: the draft is reviewed, approved and applied like any change set. Needs `changesets.write` and `listing.read`; `refresh` also needs `apps.sync`.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: pullListingBody,
    partial: true,
    responses: {
      '200': {
        description: 'Nothing to pull: `changeSet` is null and `explanation` says why.',
        schema: object,
      },
      '201': {
        description: 'The draft, what changes, what was skipped and why.',
        schema: z.object({
          changeSet: changeSetSchema,
          changes: z.array(object),
          skipped: z.array(object),
          problems: z.array(object),
          warnings: z.array(z.string()),
        }),
      },
    },
  },
];
