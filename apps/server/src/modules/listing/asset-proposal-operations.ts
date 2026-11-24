import { z } from 'zod';
import { type Draft, W } from '../../operations/shared.ts';

const label = z.string().max(40);
const releaseQuery = z.object({
  version: label
    .optional()
    .describe(
      'The marketing version being prepared (App Store: the editable version string). Names the release for the saved decision.',
    ),
  track: label
    .optional()
    .describe(
      'Google Play: the track of the draft release. Names the release for the saved decision.',
    ),
  build: z
    .string()
    .max(40)
    .optional()
    .describe(
      'The build number (version code) chosen for the release; its commit is the release source. Without it: the build of the stored release of that version, else the default branch.',
    ),
});
const releaseKey = {
  version: label.nullable().optional(),
  track: label.nullable().optional(),
  build: z.string().max(40).nullable().optional(),
};

const refSchema = z
  .object({
    sha: z.string(),
    source: z.enum(['build', 'default_branch', 'previous_build', 'repo_snapshot']),
  })
  .nullable();
const issueSchema = z.object({
  id: z.string(),
  itemId: z.string().nullable(),
  source: z.enum(['listing_check', 'listing_rule', 'graphics_rule']),
  severity: z.enum(['error', 'warning', 'tip']),
  code: z.string(),
  locale: z.string().nullable(),
  field: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  message: z
    .string()
    .nullable()
    .describe(
      'The documented rule in English, for `listing_rule` and `graphics_rule`; null for a listing check (the interface writes its own sentence).',
    ),
});
const fileSchema = z.object({
  path: z.string(),
  oid: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nullable(),
  format: z.string().nullable(),
});
const itemSchema = z.union([
  z.object({
    id: z.string(),
    kind: z.literal('text'),
    locale: z.string(),
    field: z.string(),
    before: z.string().nullable(),
    after: z.string(),
    hasErrors: z.boolean(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('graphics'),
    locale: z.string(),
    slot: z.string(),
    slotKind: z.string(),
    device: z.string().nullable(),
    deviceLabel: z.string(),
    before: z.number().nullable(),
    beforeFiles: z
      .array(
        z.object({
          ref: z
            .string()
            .describe(
              'The opaque id of a store image: `GET .../assets/store/thumb?ref=` (never a store address).',
            ),
          position: z.number().int(),
          name: z.string().nullable(),
          width: z.number().int().nullable(),
          height: z.number().int().nullable(),
          bytes: z.number().int().nullable(),
        }),
      )
      .optional()
      .describe(
        'The images the store holds for the set now, for the image comparison; absent when the store was not read.',
      ),
    after: z.object({ count: z.number(), commit: z.string(), files: z.array(fileSchema) }),
    hasErrors: z.boolean(),
  }),
]);
const stateSchema = z.object({
  state: z.enum(['open', 'skipped', 'later']),
  at: z.number().nullable(),
});
const proposalSchema = z.object({
  appId: z.string(),
  platform: z.string(),
  version: z.string().nullable(),
  unavailable: z.enum(['no_repository', 'no_repo_metadata', 'target_unreadable']).nullable(),
  state: stateSchema,
  locked: z.object({
    locked: z.boolean(),
    reason: z.string().nullable(),
    liveVersion: z.string().nullable(),
  }),
  baseRef: refSchema,
  targetRef: refSchema,
  noPreviousRelease: z.boolean(),
  storeUnread: z.boolean(),
  changes: z.array(itemSchema),
  alreadyStaged: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['text', 'graphics']),
      locale: z.string(),
      field: z.string(),
      state: z.enum(['same', 'edited']),
    }),
  ),
  issues: z.array(issueSchema).describe('Errors first, then warnings, then tips.'),
  summary: z.object({
    texts: z.number(),
    locales: z.number(),
    graphics: z.number(),
    errors: z.number(),
    warnings: z.number(),
    tips: z.number(),
  }),
  skipped: z.object({
    unchangedSinceRelease: z.number(),
    sameAsStore: z.number(),
    notStageable: z.number(),
  }),
  notes: z.array(z.string()),
});

export const assetProposalOperations: Draft[] = [
  {
    id: 'getReleaseAssetProposal',
    method: 'get',
    path: `${W}/apps/{id}/release/asset-proposal`,
    tags: ['releases'],
    summary:
      'Store assets that changed in the repository since the previous release, with their checks',
    description:
      'Needs `listing.read`. Reads the linked repository at two commits (the source of the previous release, and of this release: the build commit, else the default branch; `noPreviousRelease` when there is none) and the stored store state, and changes nothing. Only items that changed in that window and still differ from the store and from the cart are listed in `changes`; the listing checks and the graphics rules are run on the repository side first and returned in `issues` (errors first). `alreadyStaged` lists what the cart holds (`same`, or `edited` by a person and never overwritten). `locked` is the Apple metadata lock (nothing can be staged until a new version exists; Google Play never locks). Needs no `compareRepo` / `compareMedia` setting; an app without a repository answers `unavailable: no_repository` and the repository is not read. `state` is what was decided for this release.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    query: releaseQuery,
    responses: {
      '200': { description: 'The proposal.', schema: z.object({ proposal: proposalSchema }) },
    },
  },
  {
    id: 'getReleaseAssetProposalSummary',
    method: 'get',
    path: `${W}/apps/{id}/release/asset-proposal/summary`,
    tags: ['releases'],
    summary:
      'How many store asset changes the repository proposes for the release being prepared (count only, cached)',
    description:
      'Needs `listing.read`. The cheap form of `getReleaseAssetProposal` for the Releases list: counts only, for the app\u2019s editable release (App Store: its version; Google Play: its track; none: the default branch against the previous release). Nothing is read when the app has no repository or the proposal was skipped for this release. Otherwise the answer is cached (10 minutes) under what Kiln stores about its inputs (the repository as last read, the store as last read, the cart, the decision, the releases), computed once at a time per app and at most twice at once overall (`busy`), and cut off after 8 seconds (`computing`: it finishes in the background and the next read is cached). `available: false` says why in `reason` and counts nothing.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The count.',
        schema: z.object({
          summary: z.object({
            available: z.boolean(),
            reason: z
              .enum([
                'no_repository',
                'no_repo_metadata',
                'target_unreadable',
                'busy',
                'computing',
                'unreadable',
              ])
              .nullable(),
            version: z.string().nullable(),
            track: z.string().nullable(),
            state: z.enum(['open', 'skipped', 'later']),
            count: z
              .number()
              .int()
              .describe('Changed texts plus changed graphics sets, not yet in the cart.'),
            texts: z.number().int(),
            graphics: z.number().int(),
            locked: z.boolean(),
            cached: z.boolean(),
            computedAt: z.number().int(),
          }),
        }),
      },
    },
  },
  {
    id: 'stageReleaseAssetProposal',
    method: 'post',
    path: `${W}/apps/{id}/release/asset-proposal/stage`,
    tags: ['releases'],
    summary: 'Stage the chosen items of the proposal into the cart (nothing is written to a store)',
    description:
      'Needs `changesets.write`. The server computes the proposal again and stages the named items itself (texts through the staged text rules, graphics as the set of the release commit); a client sends ids, never a text or a path. Items with errors need `acceptIssues: true` (else `409 has_issues` with `itemIds`). An item that is in the cart already is not written again (`already_staged`), and one a person edited is kept (`kept_edited`). Apple with no editable version answers `409 metadata_locked`. Answers one result per id and the proposal as it stands then.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: z
      .object({
        ...releaseKey,
        itemIds: z.array(z.string().max(200)).min(1).max(400),
        acceptIssues: z.boolean().optional(),
      })
      .strict(),
    responses: {
      '200': {
        description: 'The results and the proposal now.',
        schema: z.object({
          results: z.array(
            z.object({
              id: z.string(),
              status: z.enum(['staged', 'already_staged', 'kept_edited', 'not_proposed', 'failed']),
              code: z.string().optional(),
            }),
          ),
          proposal: proposalSchema.optional(),
        }),
      },
    },
  },
  {
    id: 'decideReleaseAssetProposal',
    method: 'post',
    path: `${W}/apps/{id}/release/asset-proposal/dismiss`,
    tags: ['releases'],
    summary: 'Skip the proposal for this release, remind later, or bring it back',
    description:
      'Needs `changesets.write`. Saved on the server per app, version and track (no migration: a workspace setting), audited as `release.asset_proposal_decided`. `skip`: not shown again for this release. `later`: collapsed, one click to open. `reopen`: back to open. Nothing is staged or removed.',
    risk: 'write',
    access: { action: 'changesets.write' },
    appScope: { kind: 'param', name: 'id' },
    body: z
      .object({
        version: label.nullable().optional(),
        track: label.nullable().optional(),
        mode: z.enum(['skip', 'later', 'reopen']),
      })
      .strict(),
    responses: {
      '200': { description: 'The saved state.', schema: z.object({ state: stateSchema }) },
    },
  },
];
