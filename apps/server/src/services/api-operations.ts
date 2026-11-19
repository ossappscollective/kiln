import { PLATFORMS, credentialKinds, invitableRoles, roles, translationModes, translationProviders } from '@mrm/core';
import { z } from 'zod';
import { publishApplyBody, publishPreviewBody } from '../routes/pending.ts';
import { addCompetitorBody, addKeywordsBody, updateKeywordBody } from '../routes/aso.ts';
import { aiOperations } from './api-operations-ai.ts';
import { analyticsOperations } from './api-operations-analytics.ts';
import { eventTypes } from './event-types.ts';
import type { Operation } from './openapi.ts';
import { createTokenBody } from './tokens.ts';
import { createWebhookBody, updateWebhookBody } from './webhooks.ts';

/**
 * The registry: every operation of the API that is documented, with the permission it needs and
 * the risk it carries. It feeds `GET /api/openapi.json` and decides which routes an API token may
 * call (bearer.ts): a route that is not listed here is reachable with a session cookie only.
 *
 * Request bodies for the routes that existed before this file mirror the schemas in their route
 * files (they are not exported). Where a route's body or answer is large or still moving, the
 * operation says `partial` and describes only what is stable. The tests check that every listed
 * operation exists in the app and that the permission listed here is the one the route enforces.
 */

const id = z.string().min(1).max(100);
const timestamp = z.number().int().describe('Epoch milliseconds.');

// ----- resources ---------------------------------------------------------------------------------

export const eventSchema = z.object({
  id: z.number().int().describe('Increases with every event. Use it as the `since` cursor.'),
  type: z.enum(eventTypes),
  workspaceId: z.string(),
  subject: z.object({ appId: z.string().optional(), repositoryId: z.string().optional(), releaseId: z.string().optional() }),
  payload: z.record(z.unknown()).describe('Plain JSON. Never holds a secret.'),
  createdAt: timestamp,
});

export const tokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().describe('`mrm_` and six more characters, to recognise the token. Not enough to use it.'),
  role: z.enum(['viewer', 'member', 'admin']),
  appIds: z.array(z.string()).nullable(),
  actions: z.array(z.string()).nullable(),
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  createdAt: timestamp,
  createdBy: z.object({ id: z.string(), name: z.string().nullable() }),
  status: z.enum(['active', 'revoked', 'expired']),
});

export const webhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastDelivery: z.object({ status: z.string(), at: timestamp, responseCode: z.number().int().nullable() }).nullable(),
});

export const deliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.number().int().nullable(),
  eventType: z.string(),
  status: z.enum(['pending', 'retrying', 'success', 'failed']),
  attempts: z.number().int(),
  responseCode: z.number().int().nullable(),
  responseBody: z.string().nullable().describe('Truncated, with the signing secret removed.'),
  error: z.string().nullable(),
  redeliveryOf: z.string().nullable(),
  createdAt: timestamp,
  deliveredAt: timestamp.nullable(),
});

const userSchema = z.object({ id: z.string(), email: z.string(), displayName: z.string() });
const credentialSchema = z.object({
  id: z.string(),
  kind: z.enum(credentialKinds),
  label: z.string(),
  createdAt: timestamp,
  rotatedAt: timestamp.nullable(),
  lastTest: z.object({ at: timestamp, ok: z.boolean(), message: z.string() }).nullable(),
});
const memberSchema = z.object({ userId: z.string(), email: z.string(), displayName: z.string(), role: z.enum(roles) });
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(invitableRoles),
  createdAt: timestamp,
  expiresAt: timestamp,
  createdByName: z.string().nullable(),
});
const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  identifier: z.string(),
  storeAppId: z.string().nullable(),
  credentialId: z.string(),
  repositoryId: z.string().nullable(),
  createdAt: timestamp,
  lastSyncedAt: timestamp.nullable(),
  lastSyncAttemptAt: timestamp.nullable(),
  lastSyncError: z.string().nullable(),
  hasIcon: z.boolean().describe('Whether the tool holds an icon for the app right now. A hint: `GET /apps/{id}/icon` is the truth.'),
  iconUrl: z.string().nullable().describe('Where to load the icon from (ends in `?v=<etag>` when one is held), or null when the last look found none and the next one is not due.'),
});
const releaseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  platform: z.enum(PLATFORMS),
  version: z.string(),
  track: z.string().nullable(),
  build: z.string().nullable(),
  status: z.string().nullable().describe('The normalized lifecycle state, or null when the store state is not mapped.'),
  rawState: z.string(),
  rolloutFraction: z.number().nullable(),
  versionCodes: z.array(z.string()).nullable(),
  storeUpdatedAt: timestamp.nullable(),
  syncedAt: timestamp,
});
const changeSetSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  summary: z.string(),
  status: z.string(),
  createdBy: z.object({ type: z.enum(['user', 'token', 'assistant', 'system']), id: z.string() }),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  commitSha: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  approvedBy: z.string().nullable(),
  approvedAt: timestamp.nullable(),
  appliedAt: timestamp.nullable(),
  filesChanged: z.number().int(),
  files: z.array(z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) })),
  outcome: z
    .object({
      mode: z.literal('local_branch'),
      base: z.object({ branch: z.string(), commit: z.string() }).describe('The local branch the commit was made on, and its tip then.'),
      commit: z.object({ branch: z.string(), sha: z.string(), at: timestamp }),
      requested: z.object({ push: z.boolean(), openPr: z.boolean() }),
      signature: z.object({ status: z.literal('signed'), format: z.enum(['ssh', 'gpg']) }).optional().describe('Present when the commit was signed with the server\'s key (MRM_GIT_SIGN): the commit object holds a signature header of that format. It means signed, not verified; GitHub shows Verified only when the public key is a signing key on the committer\'s account.'),
      push: z.object({ status: z.enum(['not_requested', 'pushed', 'failed', 'behind']), at: timestamp.optional(), code: z.string().optional(), error: z.string().optional() }).describe('`behind`: a fix-up commit was added after the push and the branch on GitHub is behind the local one.'),
      pr: z.object({ status: z.enum(['not_requested', 'opened', 'failed', 'skipped']), at: timestamp.optional(), url: z.string().optional(), number: z.number().int().optional(), code: z.string().optional(), error: z.string().optional() }),
    })
    .nullable()
    .describe('Step by step result of a commit on a new branch of a local clone (commit, push, pull request). Null for a change set applied as a pull request through GitHub. A failed push or pull request does not undo the commit. After a fix-up `commit` is the latest commit and `base` is unchanged.'),
  fixups: z
    .array(
      z.object({
        at: timestamp,
        commit: z.string(),
        parent: z.string().describe('The branch tip the commit was added on.'),
        files: z.number().int(),
        pushed: z.boolean(),
        signature: z.object({ status: z.literal('signed'), format: z.enum(['ssh', 'gpg']) }).optional(),
      }),
    )
    .describe('Fix-up commits added on top of the branch, oldest first (local commit or pull request through GitHub).'),
  origin: z
    .object({ source: z.string(), appId: z.string().optional(), channel: z.string().optional() })
    .nullable()
    .describe('Where the change set came from when it can be recomputed (`store_pull`); null otherwise.'),
});
const object = z.record(z.unknown());
const localConfigSchema = z.object({
  enabled: z.boolean(),
  envName: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  roots: z.array(z.string()).optional().describe('Only for people who may attach a folder.'),
  write: z.object({ enabled: z.boolean(), envName: z.string(), message: z.string().optional() }).describe('Whether a change set may be committed to a new branch of a local clone (MRM_LOCAL_REPO_WRITE).'),
  signing: z.object({ enabled: z.boolean(), format: z.enum(['ssh', 'gpg']).optional() }).describe('Whether those commits are signed with the server\'s key (MRM_GIT_SIGN) and how. Never the key or where it is.'),
});
const conventionsInput = z.object({
  appId: z.string().optional().describe('Set for an override of one app; leave out for the repository.'),
  tagPatterns: z.array(z.string()).describe('Patterns with {buildNumber}, {version}, {platform}, {flavor}, {prefix}, *. Empty: defaults.'),
  releasePatterns: z.array(z.string()).describe('The same for release names. Empty: defaults.'),
  prefix: z.string().optional().describe('The literal that fills {prefix}.'),
  workflow: z.string().nullable().optional().describe('The release workflow (file name or name); null to detect it.'),
});
const applyBody = z.object({
  mode: z.enum(['github_pr', 'local_branch']).optional().describe('Default github_pr.'),
  branch: z.string().trim().min(1).max(200).optional().describe('local_branch: the branch to create. Default mrm/<slug of the summary>-<short id>. ASCII letters, digits and . _ - / only; must not exist.'),
  push: z.boolean().optional().describe('local_branch: push the branch to GitHub afterwards.'),
  openPr: z.boolean().optional().describe('local_branch: open a pull request after the push (needs push).'),
});
const publishBody = z.object({ openPr: z.boolean().optional().describe('Also open the pull request.') });
const cloneSchema = z.object({
  repositoryId: z.string(),
  name: z.string().nullable().describe('`owner/repo` or the local folder name; null when no repository has this id any more.'),
  kind: z.enum(['github', 'local']),
  bytes: z.number().int(),
  sizeIsLowerBound: z.boolean(),
  lastUsedAt: timestamp,
  createdAt: timestamp.nullable(),
  inUse: z.boolean(),
});
const cloneLimitsSchema = z.object({ maxBytes: z.number().int().describe('0: no limit.'), idleDays: z.number().int().describe('0: never.') });
const refreshBody = z.object({
  resolutions: z.record(z.enum(['mine', 'theirs'])).optional().describe('Per conflicting path: `mine` keeps the change set\'s text (overwriting the repository\'s), `theirs` drops the change set\'s change for that file.'),
});
const fileStateSchema = z.enum(['same', 'changed', 'already_applied', 'conflict']);
const refreshFileSchema = z.object({
  path: z.string(),
  state: fileStateSchema,
  outcome: z.enum(['unchanged', 'merged', 'dropped', 'kept_mine', 'kept_theirs', 'conflict']),
  reason: z.enum(['overlap', 'added_upstream', 'edited_upstream', 'deleted_upstream', 'invalid_json', 'too_large']).optional(),
  base: z.string().nullable().optional(),
  ours: z.string().nullable().optional(),
  theirs: z.string().nullable().optional(),
});
const choicesSchema = z.record(z.enum(['mine', 'theirs']));
const fixupBody = z.object({
  resolutions: choicesSchema.optional().describe('Per path that conflicts with the REPOSITORY (the 409 `refresh_conflicts` of the first comparison): `mine` keeps the change set\'s text, `theirs` drops its change and resets the file on the branch to the repository\'s text.'),
  branchResolutions: choicesSchema.optional().describe('Per path that conflicts with the BRANCH (the 409 `fixup_conflicts` of the second comparison): `mine` overwrites the branch\'s text, `theirs` keeps the branch\'s.'),
  push: z.boolean().optional().describe('Local commit only: push the new tip (never forced).'),
  openPr: z.boolean().optional().describe('Local commit only: open the pull request when there is none (needs push).'),
  dryRun: z.boolean().optional().describe('Work out and report everything, write nothing.'),
  recompute: z.boolean().optional().describe('Take the content from the live store listing (a store pull only), as `POST /change-sets/{id}/recompute` does, instead of the stored files. Needs `listing.read`.'),
  refresh: z.boolean().optional().describe('With `recompute`: read the store first (needs `apps.sync`; rate limited like the pull).'),
});
const fixupFileSchema = z.object({
  path: z.string(),
  state: z.enum(['same', 'changed', 'already_applied', 'conflict', 'recomputed', 'removed']),
  outcome: z.enum(['commit', 'unchanged', 'kept_branch', 'kept_mine', 'kept_theirs', 'conflict']),
  leavesSet: z.boolean(),
  stage: z.enum(['repository', 'branch']).optional(),
  reason: z.enum(['overlap', 'added_upstream', 'edited_upstream', 'deleted_upstream', 'invalid_json', 'too_large']).optional(),
  base: z.string().nullable().optional(),
  ours: z.string().nullable().optional(),
  theirs: z.string().nullable().optional(),
});
const fieldDiffSchema = z.object({
  locale: z.string(),
  repoLocale: z.string(),
  field: z.string(),
  change: z.enum(['store_changed', 'unchanged', 'added', 'dropped']),
  reason: z.string().optional(),
});
const recomputeBody = z.object({ refresh: z.boolean().optional().describe('Read the store first (needs `apps.sync`; rate limited like the pull).') });
const changeSetAnswer = { description: 'The change set.', schema: z.object({ changeSet: changeSetSchema }) };
const none = { description: 'Done. No body.' };
const testOutcome = z.object({ ok: z.boolean(), message: z.string(), details: z.array(z.string()).optional(), superseded: z.boolean().optional() });

// ----- request bodies that mirror their route files ---------------------------------------------

const registerBody = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200),
  workspaceName: z.string().trim().min(1).max(100),
});
const loginBody = z.object({ email: z.string().max(254), password: z.string().max(200) });
const secretText = z.string().min(1).max(64 * 1024).describe('Write only: never returned.');
const credentialBody = z.object({ kind: z.enum(credentialKinds), label: z.string().trim().min(1).max(100), secret: secretText });
const rotateBody = z.object({ secret: secretText });
const testBody = z.object({ kind: z.enum(credentialKinds), secret: secretText });
const roleBody = z.object({ role: z.enum(roles) });
const inviteBody = z.object({ email: z.string().trim().email().max(254), role: z.enum(invitableRoles) });
const acceptBody = z.object({ displayName: z.string().trim().max(100).optional(), password: z.string().max(200).optional() });
const platform = z.enum(PLATFORMS);
const appBody = z.object({
  platform,
  identifier: z.string().trim().min(1).max(255),
  credentialId: id,
  name: z.string().trim().min(1).max(100).optional(),
  repositoryId: id.optional(),
});
const discoverBody = z.object({
  credentialId: id,
  packages: z.array(z.string().trim().min(1).max(255)).min(1).max(50).optional().describe('Google Play only: package names to verify.'),
});
const importBody = z.object({
  credentialId: id,
  items: z
    .array(
      z.object({
        platform,
        identifier: z.string().trim().min(1).max(255),
        storeAppId: z.string().trim().min(1).max(255).optional(),
        name: z.string().trim().max(100).optional(),
        repositoryId: id.optional(),
      }),
    )
    .min(1)
    .max(50),
});
const connectBody = z.object({
  credentialId: id,
  owner: z.string().trim().describe('A GitHub user or organization name.'),
  repo: z.string().trim().max(100).describe('A GitHub repository name.'),
});
const localPathText = z.string().min(1).max(4096).describe('An absolute folder on the server, inside one of the folders MRM_LOCAL_REPO_ROOTS allows. Symbolic links are resolved first.');
const localBranchText = z.string().trim().min(1).max(200).describe('A local branch whose committed tip is read. Default: the branch the clone has checked out.');
const localCheckBody = z.object({ path: localPathText, branch: localBranchText.optional() });
const localConnectBody = z.object({ path: localPathText, branch: localBranchText.optional(), name: z.string().trim().max(100).optional().describe('Default: the folder name.') });
const localAttachBody = z.object({
  path: localPathText.optional().describe('Omit to keep the attached folder and change only the branch.'),
  branch: localBranchText.optional(),
  allowRemoteMismatch: z.boolean().optional().describe('Confirm a clone whose origin is another repository (a fork or mirror).'),
});
const targetBody = z.object({
  name: z.string().max(200),
  appId: z.string().max(400).nullable().optional(),
  appStoreRoot: z.string().max(400).nullable().optional(),
  googlePlayRoot: z.string().max(400).nullable().optional(),
});
const changeSetBody = z.object({
  target: z.string().min(1).max(200).optional().describe('A saved listing target id, or `auto:<key>`.'),
  roots: z.object({ appStore: z.string().max(400).optional(), googlePlay: z.string().max(400).optional() }).strict().optional(),
  summary: z.string().trim().min(1).max(200),
  listing: z.record(z.unknown()).describe('The store listing to write: `{ appStore?: {...}, googlePlay?: {...} }`. See docs/api/repositories.md.'),
});

const pullListingBody = z.object({
  channel: z.enum(['live', 'editable']).optional().describe('Which store copy to pull. Default: live, or editable when the app has no live version.'),
  locales: z.array(z.string().max(35)).max(100).optional().describe('Only these locales (store codes).'),
  fields: z.array(z.string().max(40)).max(20).optional().describe('Only these fields. Naming fields also pulls a field the repository has no value for.'),
  items: z.array(z.object({ locale: z.string().max(35), field: z.string().max(40) }).strict()).max(1000).optional().describe('Exactly these locale and field pairs.'),
  addLocales: z.boolean().optional().describe('Create the folders of store locales the repository does not have. Default: only locales that exist in the repository.'),
  summary: z.string().trim().min(1).max(200).optional(),
  refresh: z.boolean().optional().describe('Read the store again first (needs `apps.sync`; shares the sync rate limit).'),
  target: z.string().min(1).max(200).optional().describe('A saved listing target id, or `auto:<key>`.'),
  roots: z.object({ appStore: z.string().max(400).optional(), googlePlay: z.string().max(400).optional() }).strict().optional(),
});

const listingQuery = z.object({
  target: z.string().max(200).optional(),
  appStoreRoot: z.string().max(400).optional(),
  googlePlayRoot: z.string().max(400).optional(),
});

// ----- customer reviews (read-only inbox, internal triage; docs/api/reviews.md) ----------------------

const reviewStore = z.enum(['appstoreconnect', 'googleplay']);
const reviewStatusEnum = z.enum(['new', 'triaged', 'replied_in_console', 'ignored']);

export const reviewSchema = z.object({
  id: z.string(),
  appId: z.string(),
  store: reviewStore,
  platform: z.enum(PLATFORMS),
  storeReviewId: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().describe('Plain text written by a customer. Personal data of a third party: show it as text, never as HTML.'),
  authorName: z.string().nullable().describe('The public display name the customer chose. Personal data.'),
  territory: z.string().nullable(),
  language: z.string().nullable(),
  appVersion: z.string().nullable(),
  buildNumber: z.string().nullable(),
  device: z.string().nullable(),
  createdAt: timestamp.describe('When the customer wrote it. For Google Play, when this server first saw it (the API has no creation time).'),
  updatedAt: timestamp.describe('When the review was last edited, per the store.'),
  firstSeenAt: timestamp,
  fetchedAt: timestamp,
  developerResponse: z.object({ body: z.string(), at: timestamp.nullable(), state: z.string().nullable() }).nullable().describe('The reply the store shows for this review (published from this server, or from the store console).'),
  status: reviewStatusEnum.describe('Internal triage state. `replied_in_console` is a note by a person; nothing is sent.'),
  assigneeUserId: z.string().nullable(),
  internalNote: z.string().nullable().describe('Internal. Never sent to a store.'),
  statusChangedAt: timestamp.nullable(),
  statusChangedBy: z.string().nullable(),
});

const reviewSyncResultSchema = z.object({
  at: timestamp,
  fetched: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  responses: z.number().int().describe('Reviews whose developer response appeared, changed or went away.'),
  skipped: z.number().int().describe('Entries the store sent that could not be read.'),
  complete: z.boolean().describe('False when the read stopped before the end (limits, rate limit reserve, page cap).'),
  gap: z.object({ from: timestamp, to: timestamp }).nullable().describe('Reviews may have been missed: Google Play only returns the last 7 days and the previous success is older.'),
  warnings: z.array(z.string()),
  baseline: z.boolean().describe('The first read of an app: no events are emitted for the reviews it finds.'),
  lowRatingEvents: z.number().int(),
  lowRatingThreshold: z.number().int().optional().describe('The threshold this read used: the workspace setting `reviews.lowRatingThreshold` at that time.'),
  ratingSummary: z.enum(['stored', 'unchanged', 'unavailable', 'off']),
  translation: z
    .object({
      mode: z.literal('auto'),
      attempted: z.number().int().describe('New reviews in another language that were considered (at most 20 per sync).'),
      translated: z.number().int(),
      fromCache: z.number().int(),
      chars: z.number().int().describe('Characters sent to the provider.'),
      error: z.string().optional().describe('The translation error code when it stopped. It never fails the sync.'),
    })
    .optional()
    .describe('Only when `translation.mode` is `auto`.'),
});

const reviewSyncStateSchema = z.object({
  store: reviewStore,
  lastAttemptAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  backoffUntil: timestamp.nullable().describe('The scheduler does not read again before this. A manual sync ignores it.'),
  lastGapAt: timestamp.nullable(),
  moreToRead: z.boolean(),
  lastResult: reviewSyncResultSchema.nullable(),
});

const reviewListQuery = z.object({
  rating: z.string().optional().describe('One or more ratings from 1 to 5, comma separated: `1,2`.'),
  store: reviewStore.optional(),
  platform: z.enum(PLATFORMS).optional(),
  territory: z.string().optional(),
  language: z.string().optional(),
  version: z.string().optional(),
  status: z.string().optional().describe('One or more of new, triaged, replied_in_console, ignored, comma separated.'),
  hasResponse: z.enum(['true', 'false']).optional(),
  q: z.string().max(100).optional().describe('Text search in the title and body. Sent in the query string: review text itself never is.'),
  since: z.number().int().min(0).optional().describe('Epoch milliseconds; reviews created at or after.'),
  until: z.number().int().min(0).optional().describe('Epoch milliseconds; reviews created before.'),
  sort: z.enum(['newest', 'rating', 'updated']).optional().describe('`rating` is the lowest first.'),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional().describe('The `nextCursor` of the previous page, with the same filters and sort.'),
});

const reviewsSummarySchema = z.object({
  app: z.object({ id: z.string(), platform: z.enum(PLATFORMS), store: reviewStore }),
  stored: z.object({
    basis: z.literal('stored_reviews'),
    label: z.string().describe('Where the numbers come from, in words. Show it next to them.'),
    count: z.number().int(),
    average: z.number().nullable(),
    histogram: z.array(z.number().int()).length(5).describe('Index 0 is one star.'),
    oldestAt: timestamp.nullable(),
    newestAt: timestamp.nullable(),
    truncated: z.boolean(),
    byVersion: z.array(z.object({ version: z.string(), count: z.number().int(), average: z.number() })),
    weeks: z.array(z.object({ weekStart: timestamp, count: z.number().int(), average: z.number().nullable() })).describe('Oldest first, Monday UTC, weeks without reviews included.'),
    territories: z.array(z.object({ value: z.string(), count: z.number().int() })),
    languages: z.array(z.object({ value: z.string(), count: z.number().int() })),
  }),
  storeWide: z.array(z.object({
    basis: z.literal('store_wide'),
    label: z.string(),
    source: z.literal('itunes_lookup'),
    territory: z.string(),
    average: z.number().nullable(),
    ratingCount: z.number().int().nullable(),
    currentVersionAverage: z.number().nullable(),
    currentVersionCount: z.number().int().nullable(),
    observedAt: timestamp,
  })).describe('The public store-wide rating (App Store only), when it was read. Empty for Google Play: its API has no such number.'),
  unanswered: z.object({
    count: z.number().int().describe('Reviews with no developer response, not ignored, rated at or below `maxRating`.'),
    oldestAt: timestamp.nullable().describe('When the oldest of them was written.'),
    maxRating: z.number().int().describe('The highest rating counted (the `maxRating` query, default 5: every rating).'),
  }),
  byStatus: z.object({ new: z.number().int(), triaged: z.number().int(), replied_in_console: z.number().int(), ignored: z.number().int() }),
  sync: reviewSyncStateSchema,
  lowRatingThreshold: z.number().int().describe('A review with this rating or lower raises `review.new_low_rating`.'),
  retentionDays: z.number().int().nullable().describe('MRM_REVIEW_RETENTION_DAYS; 0 keeps every review.'),
});

// ----- replying to reviews (a store write, off by default: docs/api/reviews.md#replying-to-a-review) ----

const replyStatusEnum = z.enum(['draft', 'sending', 'sent', 'failed', 'unknown']);
export const replyDraftSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  appId: z.string(),
  store: reviewStore,
  text: z.string().describe('The plain text that would be published. Written by your team; shown to members who can read reviews.'),
  textHash: z.string().describe('SHA-256 hex of `text`. Repeat it as `confirmHash` to send exactly this text.'),
  length: z.number().int(),
  limit: z.number().int().describe('What the store allows: 350 for Google Play (documented); 5000 for the App Store (this server\u2019s own cap, unverified).'),
  status: replyStatusEnum.describe('`draft`: not sent. `sending`: a send is in flight. `sent`: published (the App Store may show it as pending for a while). `failed`: the store refused or did not apply it; the draft is kept. `unknown`: it is not known whether it was published; send again to check.'),
  errorCode: z.string().nullable(),
  evidence: z.record(z.unknown()).nullable().describe('How an unknown outcome was settled by reading the review back. Never the text.'),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  sentAt: timestamp.nullable(),
  sentBy: z.string().nullable(),
  storeResponseId: z.string().nullable(),
});
const replyStateSchema = z.object({ status: z.enum(['none', 'draft', 'sending', 'sent', 'failed', 'unknown']), sentAt: timestamp.nullable() });
export const reviewViewSchema = reviewSchema.extend({
  replyDraft: replyDraftSchema.nullable().describe('The draft reply of this review, or the record of the last reply sent from here.'),
  reply: replyStateSchema.describe('The state of the reply in one place; `none` without a draft. `developerResponse` is what the store shows.'),
});
const inboxReviewSchema = reviewViewSchema.extend({
  app: z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS) }),
});
const replyDraftBody = z.object({
  text: z.string().max(20000).optional().describe('Plain text. Line breaks are kept; HTML-looking tags, tabs and other control characters are refused. At most the store\u2019s limit.'),
  templateId: z.string().min(1).max(100).optional().describe('Instead of `text`: fill this workspace template (`{{author}}`, `{{app}}`) for this review.'),
});
const replySendBody = z.object({ confirmHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The `textHash` of the draft as the person saw it. A draft that changed since answers `409 stale_draft`.') });
const replyTemplateSchema = z.object({ id: z.string(), name: z.string(), body: z.string(), createdBy: z.string(), createdAt: timestamp, updatedAt: timestamp });
const replyTemplateBody = z.object({ name: z.string().min(1).max(80), body: z.string().min(1).max(5000).describe('Plain text with `{{author}}` and `{{app}}`.') });
const replyTranslateBody = z.object({ text: z.string().min(1).max(5000), target: z.string().max(20), source: z.string().max(20).optional() });
const replyConfigSchema = z.object({
  enabled: z.boolean().describe('MRM_REVIEW_REPLY_ENABLED. While false every reply route answers `409 reply_disabled`.'),
  envName: z.string(),
  limits: z.object({ appstoreconnect: z.number().int(), googleplay: z.number().int() }),
  sendsPerHour: z.number().int(),
  translation: z.object({ available: z.boolean() }),
  templates: z.object({ max: z.number().int(), placeholders: z.array(z.string()) }),
});
const inboxQuery = reviewListQuery.extend({
  appIds: z.string().optional().describe('Only these apps, comma separated (at most 50). A token limited to some apps sees only those.'),
  assignee: z.string().optional().describe('`me` or a member\u2019s user id.'),
  unassigned: z.enum(['true', 'false']).optional(),
  unanswered: z.enum(['true', 'false']).optional().describe('`true`: no developer response yet.'),
});
const workspaceCounts = z.object({
  total: z.number().int(),
  new: z.number().int().describe('Triage status `new`.'),
  unanswered: z.number().int().describe('No developer response and not ignored, rated at or below `unansweredMaxRating`.'),
  lowRating: z.number().int().describe('Rating at or below the threshold and not ignored.'),
  average: z.number().nullable().describe('Mean of the stored ratings, two decimals.'),
});
const workspaceSummarySchema = z.object({
  basis: z.literal('stored_reviews'),
  label: z.string().describe('Where the numbers come from, to show next to them.'),
  lowRatingThreshold: z.number().int(),
  unansweredMaxRating: z.number().int().describe('The highest rating `unanswered` counts: the `maxRating` query, default 5 (every rating).'),
  apps: z.array(workspaceCounts.extend({ app: z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS), store: reviewStore }), unansweredOldestAt: timestamp.nullable().describe('When the oldest unanswered review was written.'), oldestAt: timestamp.nullable(), newestAt: timestamp.nullable() })),
  totals: workspaceCounts.extend({ unansweredOldestAt: timestamp.nullable() }),
});

const triageReviewBody = z.object({
  status: reviewStatusEnum.optional(),
  assigneeUserId: z.string().min(1).max(100).nullable().optional().describe('A member of the workspace, or null to clear.'),
  internalNote: z.string().max(2000).nullable().optional().describe('Internal. Null or empty clears it.'),
});

// ----- ASO: keyword ranks and competitors from public store data ---------------------------------------
const asoPlatform = z.enum(PLATFORMS);
const asoStore = z.enum(['app_store', 'google_play']);
const asoRankChangeSchema = z.object({
  kind: z.enum(['first', 'same', 'up', 'down', 'entered', 'dropped', 'still_unranked']),
  delta: z.number().int().optional().describe('Places gained (positive) or lost (negative) when both checks ranked.'),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
});
const asoKeywordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  platform: asoPlatform,
  country: z.string().describe('The storefront, two lower case letters.'),
  locale: z.string().describe('A language tag such as en-US.'),
  term: z.string().describe('As typed (white space collapsed).'),
  key: z.string().describe('What makes two terms the same: folded words joined by one space.'),
  tag: z.string().nullable(),
  notes: z.string().nullable(),
  priority: z.number().int().describe('1 low, 2 normal, 3 high.'),
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastCheckedAt: timestamp.nullable().describe('The last SUCCESSFUL check; null: never checked.'),
  state: z.enum(['ranked', 'not_ranked']).nullable().describe('Result of the last successful check. `not_ranked` means the app is not within the first `total` results; it never means the store could not be read.'),
  rank: z.number().int().nullable().describe('1 is the first result.'),
  total: z.number().int().nullable().describe('How many results that check looked at.'),
  previous: z.object({ state: z.enum(['ranked', 'not_ranked']), rank: z.number().int().nullable() }).nullable(),
  change: asoRankChangeSchema.nullable().describe('How the last two successful checks compare.'),
  error: z.string().nullable().describe('Why the latest attempt failed (a short code); cleared by the next success.'),
});
const asoKeywordResultSchema = z.object({
  index: z.number().int().describe('The position of the item in the request.'),
  status: z.enum(['created', 'exists', 'invalid', 'limit']),
  keyword: asoKeywordSchema.optional().describe('For created and exists.'),
  message: z.string().optional().describe('For invalid and limit.'),
});
const asoChangeSchema = z.object({
  field: z.string().describe('version, rating, rating_count, price, title, subtitle, description, screenshots or media.'),
  from: z.union([z.string(), z.number()]).nullable().optional(),
  to: z.union([z.string(), z.number()]).nullable().optional(),
});
const asoSnapshotSchema = z.object({
  id: z.string(),
  checkedAt: timestamp,
  kind: z.enum(['first', 'change', 'heartbeat']),
  version: z.string().nullable(),
  rating: z.number().nullable().describe('Stars, 0 to 5.'),
  ratingCount: z.number().int().nullable(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  descriptionExcerpt: z.string().nullable().describe('The first 1000 characters. Written by the developer of that app: untrusted plain text.'),
  screenshotCount: z.number().int().nullable(),
  changes: z.array(asoChangeSchema).nullable(),
});
const asoCompetitorSchema = z.object({
  id: z.string(),
  appId: z.string(),
  store: asoStore,
  externalId: z.string().describe('The numeric App Store id, or the Android package name.'),
  country: z.string(),
  name: z.string(),
  addedBy: z.string(),
  addedAt: timestamp,
  lastCheckedAt: timestamp.nullable(),
  state: z.enum(['ok', 'not_found', 'unavailable']).nullable(),
  error: z.string().nullable(),
  latest: asoSnapshotSchema.nullable(),
});
const asoRefreshResultSchema = z.object({
  at: timestamp,
  keywords: z.object({ due: z.number().int(), checked: z.number().int(), ranked: z.number().int(), notRanked: z.number().int(), failed: z.number().int(), cached: z.number().int(), moved: z.number().int() }),
  competitors: z.object({ due: z.number().int(), checked: z.number().int(), changed: z.number().int(), notFound: z.number().int(), failed: z.number().int() }),
  deferred: z.boolean().describe('Work is left for a later refresh.'),
  retryAfterSeconds: z.number().int().optional(),
  stoppedBecause: z.enum(['rate_limit', 'unavailable', 'errors', 'time', 'cap']).optional(),
  errors: z.array(z.string()).describe('Short codes, distinct.'),
  warnings: z.array(z.string()),
});
const asoStateSchema = z.object({
  lastAttemptAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  backoffUntil: timestamp.nullable(),
  lastResult: asoRefreshResultSchema.nullable(),
});
const asoSummarySchema = z.object({
  app: z.object({ id: z.string(), platform: asoPlatform, store: asoStore }),
  keywords: z.object({ total: z.number().int(), ranked: z.number().int(), notRanked: z.number().int(), unchecked: z.number().int(), failing: z.number().int(), top3: z.number().int(), top10: z.number().int() }),
  movers: z.array(z.object({ keywordId: z.string(), term: z.string(), country: z.string(), locale: z.string(), kind: z.string(), from: z.number().int().nullable(), to: z.number().int().nullable(), delta: z.number().int().nullable() })),
  competitors: z.object({ total: z.number().int(), notFound: z.number().int(), changedRecently: z.number().int() }),
  state: asoStateSchema,
});
const asoLocaleQuery = z.object({ locale: z.string().optional().describe('A language tag such as en-US. Default: the locale most tracked keywords use.'), limit: z.number().int().min(1).max(100).optional() });
const asoBackgroundQuery = z.object({
  background: z.enum(['true']).optional(),
  scope: z.enum(['all', 'keywords', 'competitors']).optional().describe('Default all.'),
});
const asoNote = 'Reads this server’s database only: no store is contacted. ';


// ----- workspace settings and review translation ----------------------------------------------------
const translationLang = z.string().regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/).max(35).describe('A BCP-47 language tag such as en, pt-BR or zh-Hant.');
const settingValueSchema = z.union([z.number(), z.boolean(), z.string()]);
const settingsBody = z.object({
  'reviews.lowRatingThreshold': z.number().int().min(1).max(4).nullable().optional().describe('Ratings at or below this raise `review.new_low_rating`. Default 2. Raising it never re-sends events for reviews already read.'),
  'aso.rankMoveThreshold': z.number().int().min(1).max(100).nullable().optional().describe('A keyword that moves this many places or more between two checks raises `aso.rank_changed`. Default 5. Entering or leaving the results raises it only within the top 10.'),
  'translation.enabled': z.boolean().nullable().optional().describe('Default false.'),
  'translation.provider': z.enum(translationProviders).nullable().optional().describe('Default google.'),
  'translation.targetLanguage': translationLang.nullable().optional().describe('Default en.'),
  'translation.mode': z.enum(translationModes).nullable().optional().describe('Default on_demand.'),
  'translation.dailyCharBudget': z.number().int().min(0).max(100_000_000).nullable().optional().describe('Characters per UTC day; 0 is unlimited. Default 50000.'),
  'translation.libretranslate.url': z.string().max(2048).nullable().optional().describe('https://host[/path]. A private or loopback address needs MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true. Credentials in the URL are refused.'),
});
const settingsBase = z.object({
  values: z.record(settingValueSchema).describe('Every key with its effective value.'),
  defaults: z.record(settingValueSchema),
  overridden: z.array(z.string()).describe('Keys that have a stored value.'),
  writable: z.array(z.string()).describe('Keys the caller may change (admins and owners: all).'),
  docs: z.record(z.string()),
});
const settingsSchema = settingsBase.extend({
  translation: z.object({
    provider: z.enum(translationProviders),
    credentialRequired: z.boolean(),
    credentialConfigured: z.boolean().describe('A credential of the provider\u2019s kind exists. The oldest one is used.'),
    credential: z.object({ id: z.string(), label: z.string() }).optional().describe('Only for those who may read credentials.'),
    usage: z.object({ day: z.string().describe('UTC day, YYYY-MM-DD.'), used: z.number().int(), budget: z.number().int().describe('0: no limit.') }),
  }),
});
const translateReviewsBody = z.object({
  reviewIds: z.array(z.string().min(1).max(100)).min(1).max(25).describe('Reviews of this app. The text is read from this server\u2019s database: it is never sent in the request.'),
  target: translationLang.optional().describe('Default: the workspace setting `translation.targetLanguage`.'),
}).strict();
const reviewTranslationSchema = z.object({
  reviewId: z.string(),
  title: z.string().optional().describe('Plain text, written by a translation provider from customer text: untrusted.'),
  body: z.string().optional().describe('Plain text: untrusted.'),
  detectedSource: z.string().optional().describe('The language the provider detected, when it says.'),
  provider: z.enum(translationProviders),
  cached: z.boolean().describe('Served from the stored translation: nothing was sent to a provider.'),
  sameLanguage: z.boolean().optional().describe('The review is already in the target language: nothing was translated.'),
  truncated: z.boolean().optional().describe('The text was longer than 5000 characters and was cut before translating.'),
});

// ----- changing a live rollout in a store (a store write, off by default: docs/api/rollout.md) ---------------

const rolloutStateSchema = z
  .object({
    store: z.enum(['googleplay', 'appstoreconnect']),
    platform: z.enum(PLATFORMS),
    track: z.string().optional().describe('Google Play only.'),
    versionCodes: z.array(z.string()).optional().describe('Google Play only. Sorted.'),
    name: z.string().nullable().optional().describe('Google Play only: the release name.'),
    status: z.string().optional().describe('Google Play only: `draft`, `inProgress`, `halted`, `completed`, verbatim.'),
    userFraction: z.number().nullable().optional().describe('Google Play only: the share of users, more than 0 and less than 1, for `inProgress` and `halted`.'),
    otherReleases: z.number().int().optional().describe('Google Play only: how many other releases the track holds.'),
    version: z.string().optional().describe('App Store only.'),
    storeVersionId: z.string().optional().describe('App Store only.'),
    versionState: z.string().nullable().optional().describe('App Store only: `appVersionState`, verbatim.'),
    phasedReleaseId: z.string().nullable().optional().describe('App Store only: null when the version has no phased release.'),
    phasedReleaseState: z.string().nullable().optional().describe('App Store only: `INACTIVE`, `ACTIVE`, `PAUSED`, `COMPLETE`, verbatim.'),
    currentDayNumber: z.number().int().nullable().optional().describe('App Store only: day 1 to 7 of the phased release.'),
    startDate: timestamp.nullable().optional().describe('App Store only.'),
    totalPauseDays: z.number().int().nullable().optional().describe('App Store only: days paused, of the 30 Apple allows.'),
  })
  .describe('Where the release stands in the store, as read just now.');
const rolloutAppSchema = z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS), store: reviewStore });
const rolloutAllowedSchema = z.object({ action: z.string(), allowed: z.boolean(), reason: z.string().optional(), irreversible: z.boolean() });
const rolloutRequestFields = {
  action: z.string().min(1).max(40).describe('Google Play: `set_fraction`, `halt`, `resume`, `complete`. App Store: `pause`, `resume`, `release_to_all`.'),
  track: z.string().max(100).optional().describe('Google Play: the track, for example `production`.'),
  versionCodes: z.array(z.string().max(12)).min(1).max(50).optional().describe('Google Play: exactly the version codes of the release.'),
  version: z.string().max(64).optional().describe('App Store: the marketing version, for example `2.4.0`.'),
  userFraction: z.number().optional().describe('Google Play `set_fraction` (required) and `resume` (optional): more than 0 and less than 1, and never lower than now. Not for the App Store.'),
};
const rolloutPreviewBody = z.object(rolloutRequestFields);
const rolloutApplyBody = z.object({ ...rolloutRequestFields, confirmHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The `confirmHash` of a preview of exactly this request.') });
const rolloutConfigSchema = z.object({
  enabled: z.boolean().describe('MRM_STORE_ROLLOUT_ENABLED. While false every rollout route answers `409 rollout_disabled`.'),
  envName: z.string(),
  actions: z.object({ android: z.array(z.string()), ios: z.array(z.string()) }),
  irreversible: z.array(z.string()).describe('Actions that cannot be undone from here.'),
  fraction: z.object({ exclusiveMin: z.number(), exclusiveMax: z.number() }),
});
const rolloutStateViewSchema = z.object({
  app: rolloutAppSchema,
  current: rolloutStateSchema,
  allowedActions: z.array(rolloutAllowedSchema).describe('What could be done from the current state. For `set_fraction` the share must be above `minUserFraction`.'),
  minUserFraction: z.number().nullable().describe('Google Play: the share now; a new share must be higher.'),
  readAt: timestamp,
});
const rolloutPreviewSchema = z.object({
  app: rolloutAppSchema,
  action: z.string(),
  target: z.record(z.unknown()),
  current: rolloutStateSchema,
  proposed: rolloutStateSchema.describe('What the store should show after the change.'),
  summary: z.string().describe('One sentence for the confirmation dialog.'),
  irreversible: z.boolean().describe('True for `complete` and `release_to_all`: nothing here undoes it.'),
  confirmHash: z.string().describe('Send it back to apply. Valid only while the store still shows `current`.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});
const rolloutResultSchema = z.object({
  app: rolloutAppSchema,
  action: z.string(),
  before: rolloutStateSchema,
  after: rolloutStateSchema,
  irreversible: z.boolean(),
  confirmedByReread: z.boolean().describe('True when the write’s outcome was unknown and reading the store back showed the change.'),
  appliedAt: timestamp,
  note: z.string(),
});

// ----- staged listing text and graphics, and writing them to a store as a draft (docs/api/staged-changes.md) ----

const stagedProblemSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().describe('A listing rule (`too_long`, `invalid_url`, ...), an asset spec rule (`apple.screenshot.size`, ...) or a push rule (`slot_not_pushable`, `format_not_pushable`, `file_too_large`, `set_too_large`, `mixed_display_types`, `no_display_type`, `field_not_pushable`).'),
  message: z.string(),
  limit: z.number().optional(),
  actual: z.number().optional(),
  unit: z.enum(['characters', 'bytes']).optional(),
});
const stagedSource = z.enum(['local', 'repo', 'store']);
const stagedAppSchema = z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS), store: reviewStore });
const stagedSlotSchema = z.object({ kind: z.string().describe('`screenshot`, `icon`, `feature_graphic`, `tv_banner`, ...'), device: z.string().nullable().describe('A display id (`iphone_6_5`) or a Play device (`phone`); null for graphics that have none.') });
const stagedTextSchema = z.object({
  id: z.string(),
  kind: z.literal('listing_text'),
  locale: z.string(),
  field: z.string(),
  label: z.string(),
  source: stagedSource,
  value: z.string().describe('The staged text (listing copy: shown in the product, never logged or audited).'),
  valueHash: z.string(),
  limit: z.number().nullable(),
  unit: z.enum(['characters', 'bytes']),
  before: z.string().nullable().describe('The last value this tool stored from the store (the live listing, or the editable one when the app has no live version). Null: none stored. The push preview shows the real draft.'),
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
  files: z.array(z.object({ id: z.string(), position: z.number().int(), path: z.string(), commit: z.string(), oid: z.string().describe('The git blob id; the bytes are checked against it when pushed.'), bytes: z.number().int().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable(), format: z.string().nullable(), hasAlpha: z.boolean().nullable() })).describe('The set, in order. A push makes the store’s set exactly these files.'),
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
  field: z.string().describe('App Store: `build`, `version_string`, `release_type`, `earliest_release_date`, `copyright`, `phased_release`. Google Play: `track`, `release_name`, `version_codes`, `user_fraction`, `release_notes`. The App Store "what is new" is the listing field `release_notes` of `stageListingText`.'),
  label: z.string(),
  locale: z.string().describe('The language of a per language field (Play `release_notes`); empty otherwise.'),
  value: z.string().describe('The canonical staged value (version codes `240,241`, a share `0.1`, a date `2026-12-01T10:00:00Z`, phased release `on` or `off`).'),
  valueHash: z.string(),
  localOnly: z.boolean().describe('True for `user_fraction`: kept here, never written to the store by a push (Google Play cannot hold a share in a draft). The release step needs an explicit share.'),
  maxLength: z.number().int().nullable(),
  status: z.enum(['changed', 'invalid']),
  problems: z.array(stagedProblemSchema),
  pushedAt: timestamp.nullable(),
  pushed: z.boolean().describe('Pushed, and the staged value is still the one that was pushed.'),
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const stagedLimitsSchema = z.object({ maxItems: z.number().int(), maxTextChars: z.number().int(), maxLocaleChars: z.number().int(), maxAssetFilesPerPush: z.number().int(), maxAssetBytesPerPush: z.number().int(), maxAssetFileBytes: z.number().int() });
const stagedChangesSchema = z.object({
  app: stagedAppSchema,
  text: z.array(stagedTextSchema),
  assets: z.array(stagedAssetSchema),
  release: z.array(stagedReleaseFieldSchema).describe('The release fields staged for the app (docs/api/releases-write.md): App Store version fields or a Google Play draft release.'),
  totals: z.object({ text: z.number().int(), assetSets: z.number().int(), assetFiles: z.number().int(), errors: z.number().int(), warnings: z.number().int(), changed: z.number().int(), release: z.number().int() }),
  valid: z.boolean().describe('False when any item has an error: a push is refused while there are some.'),
  pushable: z.object({ textFields: z.array(z.string()), releaseFields: z.array(z.string()).describe('The release fields this platform can stage.') }),
  limits: stagedLimitsSchema,
});
const stagedTextBody = z.object({
  locale: z.string().min(2).max(35).describe('A store locale code such as `en-US`.'),
  field: z.string().min(1).max(60).describe('A pushable listing field: App Store `description`, `keywords`, `promotional_text`, `release_notes`, `marketing_url`, `support_url`; Google Play `title`, `short_description`, `full_description`, `video`.'),
  from: stagedSource.describe('`local`: send `value`. `repo`: the repository snapshot the listing reads stored. `store`: the store snapshot the last sync stored. No store or repository is read now.'),
  value: z.string().max(40_000).optional().describe('Required for `local`, refused otherwise.'),
});
const stagedAssetsBody = z.object({
  locale: z.string().min(2).max(35),
  kind: z.string().describe('A kind of graphic of the Assets tab: `screenshot`, `icon`, `feature_graphic`, `tv_banner`. Previews, the App Store app icon and the Play promo graphic cannot be pushed (`422 slot_not_pushable`).'),
  device: z.string().max(60).nullable().optional().describe('Required for `screenshot` (a display id such as `iphone_6_5`, or a Play device such as `phone`); null otherwise.'),
  from: stagedSource.optional().describe('Only `repo` is supported (default). Store images are pulled into the repository (`pullStoreImages`) and files are uploaded with `uploadStagedAsset`.'),
  paths: z.array(z.string().max(1024)).min(1).max(100).optional().describe('The files of the set, in order, as the asset index lists them. Default: every file of the slot in index order.'),
  commit: z.string().max(64).optional().describe('Read this commit of the repository (a full hash). Default: the branch tip.'),
});
const stagedReleaseFieldBody = z.object({
  field: z.string().min(1).max(40).describe('A release field of this platform: App Store `build` (the id of a processed build from `listReleaseCandidates`), `version_string`, `release_type` (`MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`), `earliest_release_date`, `copyright`, `phased_release` (`on` or `off`); Google Play `track`, `release_name`, `version_codes`, `user_fraction`, `release_notes`.'),
  locale: z.string().min(2).max(35).optional().describe('Google Play `release_notes` only: the language, for example `en-US`.'),
  value: z.union([z.string().max(40_000), z.number(), z.boolean(), z.array(z.string().max(20)).max(50)]).describe('The value. Version codes may be an array or `240,241`; a share `0.1` or `10%`; `phased_release` `on`/`off` or a boolean. It is normalized and checked; an empty value is refused (nothing clears a store field).'),
});
const stagedPushBody = z.object({ confirmHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The `confirmHash` of a preview made now.') });
const stagedPushPreviewBody = z.object({});
const draftConfigSchema = z.object({
  enabled: z.boolean().describe('MRM_STORE_DRAFT_WRITE_ENABLED. While false the push routes answer `409 store_draft_disabled`; staging and the staged view work.'),
  envName: z.string(),
  submit: z.object({ implemented: z.literal(true), configRoute: z.string(), note: z.string() }).describe('A push never submits. Submitting is a separate, gated step: see `GET store-submit/config` (docs/api/submit.md).'),
  limits: stagedLimitsSchema,
});
const draftStateVersion = z.object({ id: z.string(), versionString: z.string().nullable(), state: z.string() }).nullable().describe('App Store: the editable version that is written. Google Play: null.');
const draftPreviewSchema = z.object({
  app: stagedAppSchema,
  version: draftStateVersion,
  text: z.array(z.object({ id: z.string(), locale: z.string(), field: z.string(), before: z.string().nullable().describe('The draft’s value now.'), after: z.string(), localeExists: z.boolean(), status: z.enum(['changed', 'unchanged', 'new_locale']) })),
  assets: z.array(z.object({
    id: z.string(),
    locale: z.string(),
    slot: stagedSlotSchema,
    slotKey: z.string(),
    target: z.string().describe('The store’s own name of the set: the App Store `screenshotDisplayType` (UNVERIFIED names) or the Google Play `AppImageType`.'),
    placementGroup: z.string().optional().describe('App Store: the App Asset Library placement group the set is written to (found from Apple’s reference data and the pixel size). Google Play: absent.'),
    before: z.object({ setExists: z.boolean(), files: z.array(z.object({ id: z.string(), name: z.string().nullable(), checksum: z.string().nullable(), state: z.string().nullable() })) }),
    after: z.object({ files: z.array(z.object({ path: z.string(), name: z.string(), oid: z.string(), bytes: z.number().int(), width: z.number().int().nullable(), height: z.number().int().nullable(), format: z.string().nullable() })) }),
    status: z.enum(['changed', 'unchanged']),
    willUpload: z.number().int(),
    willRemove: z.number().int(),
  })),
  release: z.array(z.object({
    id: z.string(),
    field: z.string(),
    label: z.string(),
    locale: z.string(),
    before: z.string().nullable().describe('The store’s value now, in the same canonical text. Null: not set.'),
    after: z.string(),
    status: z.enum(['changed', 'unchanged', 'local']).describe('`local`: kept here and never written (the intended Play share).'),
    localOnly: z.boolean(),
  })).describe('The staged release fields, before and after.'),
  checks: z.object({
    blocking: z.array(z.object({ code: z.string().describe('For example `build_not_found`, `build_expired`, `build_not_processed`, `version_codes_not_uploaded`, `no_draft_release`, `field_unreadable`.'), severity: z.enum(['blocking', 'warning']), message: z.string(), field: z.string().optional(), locale: z.string().optional() })),
    warnings: z.array(z.object({ code: z.string(), severity: z.enum(['blocking', 'warning']), message: z.string(), field: z.string().optional(), locale: z.string().optional() })),
    canPush: z.boolean(),
  }).describe('What the store says about the staged release fields. A blocking check refuses the push (`409 blocked`, nothing written).'),
  summary: z.object({ textChanged: z.number().int(), textUnchanged: z.number().int(), assetSetsChanged: z.number().int(), assetSetsUnchanged: z.number().int(), filesToUpload: z.number().int(), filesToRemove: z.number().int(), fieldsChanged: z.number().int(), fieldsUnchanged: z.number().int(), nothingToDo: z.boolean() }),
  submits: z.literal(false).describe('Always false: a push writes a draft and never submits or publishes.'),
  confirmHash: z.string().describe('Send it back to push. Valid only while the staged items and the store’s draft are as previewed.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});
const draftResultSchema = z.object({
  app: stagedAppSchema,
  version: draftStateVersion,
  steps: z.array(z.object({ type: z.enum(['text', 'asset', 'locale', 'field']), locale: z.string(), target: z.string(), outcome: z.enum(['applied', 'already_same']), uploaded: z.number().int().optional(), removed: z.number().int().optional() })),
  counts: z.object({ applied: z.number().int(), alreadySame: z.number().int(), filesUploaded: z.number().int(), filesRemoved: z.number().int() }),
  fields: z.number().int().describe('How many release fields were part of the push.'),
  commit: z.enum(['not_sent_for_review', 'none']).describe('Google Play: the edit was committed with `changesNotSentForReview=true`. App Store: `none` (every request changes the draft at once).'),
  draft: z.literal(true),
  submitted: z.literal(false).describe('Always false: nothing was submitted, sent for review or published.'),
  confirmedByReread: z.boolean().describe('True when the write’s outcome was unknown and reading the draft back showed the changes.'),
  pushedAt: timestamp,
  note: z.string(),
});

// ----- submitting the pushed draft for store review (docs/api/submit.md) ---------------------------------
const submitConfigSchema = z.object({
  enabled: z.boolean().describe('MRM_STORE_SUBMIT_ENABLED (default false). While false the preview and submit routes answer `409 store_submit_disabled`.'),
  envName: z.string(),
  action: z.literal('store.submit'),
  minimumRole: z.literal('admin').describe('The lowest role that can submit. A token needs `store.submit` named in its actions.'),
  irreversible: z.literal(true).describe('Nothing here can recall a submission.'),
  releases: z.literal(false).describe('A submit never releases a version and never changes a rollout.'),
  note: z.string(),
});
const submitStateSchema = z.object({
  enabled: z.boolean(),
  pushed: z.boolean().describe('A successful draft push is recorded and not yet submitted.'),
  push: z.object({ pushedAt: timestamp, pushedBy: z.string(), versionString: z.string().nullable(), texts: z.number().int(), assetSets: z.number().int() }).nullable(),
  inFlight: z.object({ submit: z.boolean(), push: z.boolean() }),
  unknownOutcome: z.object({ submit: z.boolean(), push: z.boolean() }).describe('An earlier submit or push whose outcome is unknown: preview again to settle it.'),
});
const submitCheckSchema = z.object({
  code: z.string().describe('For example `draft_differs`, `no_build`, `release_not_manual`, `already_submitted`, `no_locales`, `no_screenshots`, `locale_without_screenshots`, `missing_text`, `image_not_ready`, `asset_spec`, `version_changed`, `push_in_progress`, `play_review_state_unknown`.'),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
  locale: z.string().optional(),
  item: z.string().optional(),
  rule: z.string().optional().describe('Set for a finding of the documented asset specs or listing field specs.'),
  source: z.string().optional(),
  verified: z.boolean().optional().describe('False: the rule’s number is not on an official page that was read.'),
});
const submitPreviewSchema = z.object({
  app: stagedAppSchema,
  version: z.object({ id: z.string(), versionString: z.string().nullable(), state: z.string(), releaseType: z.string().nullable() }).nullable().describe('App Store: the version that goes to review. Google Play: null.'),
  build: z.object({ id: z.string(), version: z.string().nullable(), processingState: z.string().nullable(), expired: z.boolean().nullable() }).nullable(),
  contents: z.object({
    locales: z.array(z.object({ locale: z.string(), textFields: z.number().int(), screenshotSets: z.array(z.object({ target: z.string(), device: z.string().nullable(), images: z.number().int() })) })),
    pushed: z.object({ pushedAt: timestamp, pushedBy: z.string(), texts: z.number().int(), assetSets: z.number().int() }),
    includesChangesNotPushedHere: z.boolean().describe('Google Play: true. Changes made in Play Console go to review too, and Google lists none of them.'),
  }),
  tracks: z.array(z.object({ track: z.string(), releases: z.array(z.object({ name: z.string().nullable(), status: z.string(), userFraction: z.number().nullable(), versionCodes: z.array(z.string()) })) })).describe('Google Play: read only, never written by a submit. App Store: empty.'),
  irreversible: z.array(z.string()).describe('What cannot be undone from this server, in words, for the confirmation dialog.'),
  submits: z.literal(true),
  releases: z.literal(false).describe('Always false: a submit never releases a version and never changes a rollout.'),
  checks: z.object({ blocking: z.array(submitCheckSchema), warnings: z.array(submitCheckSchema), canSubmit: z.boolean() }),
  confirmHash: z.string().nullable().describe('Send it back with `confirmation`. Null while a blocking check stands. Valid only while the store is as previewed.'),
  confirmation: z.object({ phrase: z.string(), instruction: z.string() }).nullable().describe('The text the person types to confirm; send it back as `confirmation`. Null while a blocking check stands.'),
  readAt: timestamp,
});
const submitApplyBody = z.object({
  confirmHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The `confirmHash` of a preview made now.'),
  confirmation: z.string().min(1).max(300).describe('The `confirmation.phrase` of that preview, typed by the person. A different text is `422 confirmation_mismatch` and nothing is read or written.'),
});
const submitResultSchema = z.object({
  app: stagedAppSchema,
  version: z.object({ id: z.string(), versionString: z.string().nullable() }).nullable(),
  submission: z.object({ id: z.string(), state: z.string().nullable() }).nullable().describe('App Store: the review submission. Google Play: null.'),
  via: z.enum(['review_submission', 'edit_commit']),
  submitted: z.literal(true),
  released: z.literal(false).describe('Always false: nothing was released and no rollout changed.'),
  confirmedByReread: z.boolean().describe('True when the store did not answer and reading it back showed the submission (App Store only).'),
  submittedAt: timestamp,
  note: z.string(),
});

// ----- the release pipeline signal (docs/api/release-pipeline.md) -------------------------------------------------
const pipelineStateEnum = z.enum(['unknown', 'idle', 'ci_running', 'ci_failed', 'build_processing', 'build_ready', 'draft', 'in_review', 'rejected', 'approved', 'rolling_out', 'halted', 'live']);
const pipelineEvidenceSchema = z.object({
  kind: z.enum(['run', 'build', 'version']),
  id: z.string().describe('The run id, the build number, or `version` / `version@track`.'),
  at: timestamp.nullable(),
  label: z.string(),
  url: z.string().nullable().optional(),
});
const pipelineStallSchema = z.object({
  step: z.enum(['approved', 'rejected', 'draft', 'build_ready', 'build_invalid', 'build_processing', 'ci_run']),
  key: z.string().describe('`step:anchor`: a new one is a new episode.'),
  anchor: z.string().describe('What is stuck: a run id, a build number or a version.'),
  since: timestamp,
  hours: z.number().int(),
  stale: z.boolean().describe('Older than 14 days: shown, never reminded.'),
  message: z.string().describe('A sentence for a person, with the evidence in words. Built from ids, versions and times only.'),
  label: z.string(),
  evidence: z.array(pipelineEvidenceSchema),
});
const pipelineSchema = z.object({
  appId: z.string(),
  platform: platform,
  state: pipelineStateEnum,
  waitingOn: z.enum(['ci', 'store', 'you']).nullable(),
  since: timestamp.nullable(),
  stalledAfterHours: z.number().int().describe('The workspace setting `release.stalledAfterHours` (0: detection is off).'),
  stalled: pipelineStallSchema.nullable().describe('The most advanced stall that is not stale (else the most advanced stale one).'),
  stalls: z.array(pipelineStallSchema),
  steps: z.array(z.object({ id: z.enum(['ci', 'build', 'prepare', 'review', 'release']), status: z.enum(['done', 'current', 'waiting', 'failed', 'stalled', 'todo', 'unknown']), at: timestamp.nullable(), detail: z.string().nullable() })),
  summary: z.string(),
  latest: z.object({ run: z.record(z.unknown()).nullable(), build: z.record(z.unknown()).nullable(), version: z.record(z.unknown()).nullable() }),
});
const pipelineAppRef = z.object({ id: z.string(), name: z.string(), platform: platform, store: z.enum(['appstoreconnect', 'googleplay']) });
const pipelineResponseSchema = z.object({ app: pipelineAppRef, pipeline: pipelineSchema, lastSyncedAt: timestamp.nullable(), generatedAt: timestamp });
const pipelineSummarySchema = z.object({
  stalledAfterHours: z.number().int(),
  apps: z.array(z.object({
    app: pipelineAppRef,
    state: pipelineStateEnum,
    waitingOn: z.enum(['ci', 'store', 'you']).nullable(),
    since: timestamp.nullable(),
    summary: z.string(),
    lastSyncedAt: timestamp.nullable(),
    stalled: z.object({ step: z.string(), label: z.string(), message: z.string(), hours: z.number().int(), since: timestamp, stale: z.boolean(), evidence: z.array(z.object({ kind: z.string(), id: z.string(), at: timestamp.nullable() })) }).nullable(),
  })),
  totals: z.object({ apps: z.number().int(), stalled: z.number().int().describe('Without the stale ones.'), byState: z.record(z.number().int()) }),
  generatedAt: timestamp,
});

// ----- releasing: reads of builds and version codes, and the irreversible release step (docs/api/releases-write.md) ----
const eligibilitySchema = z.object({
  eligible: z.boolean().describe('It can be chosen for the draft now.'),
  severity: z.enum(['ok', 'warning', 'blocked']).describe('`blocked`: it cannot be chosen. `warning`: it can, read the message. `ok`: nothing to say.'),
  code: z.enum(['ok', 'processing', 'failed', 'invalid', 'state_unknown', 'expired', 'wrong_version', 'no_editable_version', 'already_attached', 'export_compliance_missing', 'already_in_draft', 'already_live']).describe('A machine reason. New codes may be added: treat an unknown one as its `severity`.'),
  message: z.string().describe('A plain sentence for a person, built from build numbers, versions and states only.'),
});
const buildTestNotesSchema = z.object({
  read: z.boolean().describe('False: not asked for this build (not processed, expired, or not among the newest eight) or the read failed (`error`).'),
  locales: z.array(z.object({ locale: z.string(), text: z.string().describe('TestFlight "What to Test". Shown to the caller only: never logged and never audited.'), truncated: z.boolean().describe('Cut at 4000 characters.') })).describe('At most 40 languages; empty texts are left out.'),
  error: z.enum(['forbidden', 'rate_limited', 'not_found', 'unavailable']).optional().describe('The read of this build failed; the other builds are not affected.'),
});
const buildCandidateSchema = z.object({
  id: z.string(),
  buildNumber: z.string().nullable().describe('The build number (`CFBundleVersion`).'),
  version: z.string().nullable().describe('The marketing version the build belongs to.'),
  uploadedDate: z.string().nullable(),
  processingState: z.string().nullable().describe('Apple’s names (UNVERIFIED): `PROCESSING`, `FAILED`, `INVALID`, `VALID`.'),
  expired: z.boolean().nullable(),
  selectable: z.boolean().describe('Processed and not expired: it can be staged as the `build` field. Older than `eligibility`, which also looks at the version.'),
  reason: z.string().nullable().describe('Why it cannot be selected.'),
  attached: z.boolean().describe('It is the build attached to the editable version now.'),
  eligibility: eligibilitySchema,
  exportCompliance: z.enum(['answered', 'missing', 'unknown']).describe('Apple’s export compliance answer for the build (`usesNonExemptEncryption`, UNVERIFIED): `unknown` when Apple did not return it.'),
  testNotes: buildTestNotesSchema,
});
const releaseCandidatesSchema = z.union([
  z.object({
    store: z.literal('appstoreconnect'),
    platform: z.enum(PLATFORMS),
    version: z.object({ id: z.string(), versionString: z.string().nullable(), state: z.string() }).nullable().describe('The editable version the build would be attached to.'),
    builds: z.array(buildCandidateSchema),
    attachedBuildId: z.string().nullable(),
    truncatedAt: z.number().int().nullable().describe('The list was cut at this many builds (null: complete).'),
  }),
  z.object({
    store: z.literal('googleplay'),
    platform: z.literal('android'),
    track: z.string(),
    codes: z.array(z.object({ versionCode: z.string(), source: z.enum(['bundle', 'apk']), sha256: z.string().nullable(), inTrack: z.array(z.object({ name: z.string().nullable(), status: z.string() })), eligibility: eligibilitySchema })),
  }),
]);
const notesHistorySchema = z.object({
  app: z.object({ id: z.string(), platform: platform, store: z.enum(['appstoreconnect', 'googleplay']) }),
  locale: z.string().nullable().describe('The language asked for, or null (all).'),
  notes: z.array(z.object({
    text: z.string().describe('One text, however many places used it. Shown to the caller only: never logged and never audited.'),
    truncated: z.boolean().describe('The store text was cut at 4000 characters.'),
    locales: z.array(z.string()),
    lastUsedAt: timestamp.nullable().describe('The newest date of its uses; null when none has one (Google Play gives no dates).'),
    uses: z.array(z.object({
      source: z.enum(['appstoreconnect', 'googleplay', 'plan']),
      locale: z.string(),
      version: z.string().nullable().describe('The marketing version, the Google Play release name, or the version of the plan.'),
      track: z.string().nullable(),
      state: z.string().nullable().describe('The store’s state of the version or release; null for a plan.'),
      at: timestamp.nullable(),
    })).describe('Newest first, at most 10.'),
  })).describe('Newest first by `lastUsedAt`; texts without a date follow, in the store’s order.'),
  truncated: z.boolean().describe('More texts exist than `limit`.'),
  limit: z.number().int(),
  store: z.object({
    read: z.boolean().describe('False: the store could not be read (see `error`); the plans’ notes are still listed.'),
    error: z.string().nullable().describe('The error code of the failed store read (for example `rate_limited`, `forbidden`, `timeout`).'),
    cached: z.boolean().describe('Answered from memory: the store is read at most once in ten minutes per app and language.'),
    versionsRead: z.number().int(),
    failed: z.number().int().describe('Versions listed whose notes could not be read.'),
    truncated: z.boolean().describe('More versions exist than were read (the newest twelve are).'),
  }),
  generatedAt: timestamp,
});
const playReleaseReadSchema = z.object({ name: z.string().nullable(), status: z.string(), userFraction: z.number().nullable(), versionCodes: z.array(z.string()), notes: z.array(z.object({ locale: z.string(), text: z.string() })) });
const editableReleaseSchema = z.union([
  z.object({
    store: z.literal('appstoreconnect'),
    platform: z.enum(PLATFORMS),
    version: z.object({ id: z.string(), versionString: z.string().nullable(), state: z.string(), editable: z.literal(true) }),
    releaseType: z.string().nullable(),
    earliestReleaseDate: z.string().nullable(),
    copyright: z.string().nullable(),
    build: z.object({ id: z.string(), buildNumber: z.string().nullable(), processingState: z.string().nullable(), expired: z.boolean().nullable() }).nullable(),
    phasedRelease: z.object({ id: z.string(), state: z.string().nullable() }).nullable().describe('Null: the version has no phased release (off).'),
    releaseNotes: z.array(z.object({ locale: z.string(), text: z.string() })).describe('The "what is new" of each locale (the listing field `release_notes`).'),
  }),
  z.object({
    store: z.literal('googleplay'),
    platform: z.literal('android'),
    track: z.string(),
    draft: playReleaseReadSchema.nullable().describe('The draft release of the track (status `draft`).'),
    others: z.array(playReleaseReadSchema).describe('The other releases of the track, read only.'),
  }),
]);
const releaseWhat = {
  version: z.string().min(1).max(40).optional().describe('App Store: the marketing version (required when more than one version waits for release).'),
  track: z.string().min(1).max(100).optional().describe('Google Play (required): the track of the draft release.'),
  versionCodes: z.array(z.string().regex(/^[0-9]{1,10}$/)).min(1).max(20).optional().describe('Google Play: the version codes that identify the draft release (needed when the track holds more than one draft).'),
  userFraction: z.number().gt(0).lte(1).optional().describe('Google Play (required, never implied): the share of users, more than 0 and at most 1. 1 completes the release.'),
};
const releaseConfigSchema = z.object({
  enabled: z.boolean().describe('MRM_STORE_RELEASE_ENABLED (default false). While false the preview and release routes answer `409 store_release_disabled`. The reads of builds and version codes do not depend on it.'),
  envName: z.string(),
  action: z.literal('store.release'),
  minimumRole: z.literal('admin').describe('The lowest role that can release. A token needs `store.release` named in its actions.'),
  irreversible: z.literal(true).describe('Nothing here can recall a release.'),
  note: z.string(),
});
const releaseStateSchema = z.object({
  enabled: z.boolean(),
  inFlight: z.object({ release: z.boolean(), push: z.boolean(), submit: z.boolean() }),
  unknownOutcome: z.object({ release: z.boolean(), push: z.boolean(), submit: z.boolean() }).describe('An earlier release, push or submit whose outcome is unknown: preview again (a release) or look at the store.'),
});
const releaseCheckSchema = z.object({
  code: z.string().describe('For example `not_releasable`, `ambiguous_version`, `no_draft_release`, `ambiguous_release`, `not_a_draft`, `version_codes_not_uploaded`, `rollout_in_progress`, `push_in_progress`, `submit_in_progress`, `unpushed_release_fields`, `full_rollout`, `fraction_differs_from_staged`, `play_review_state_unknown`.'),
  severity: z.enum(['blocking', 'warning']),
  message: z.string(),
  item: z.string().optional(),
});
const releaseRequestSchema = z.object({ version: z.string().optional(), track: z.string().optional(), versionCodes: z.array(z.string()).optional(), userFraction: z.number().optional() });
const releaseAudienceSchema = z.object({ kind: z.enum(['all', 'phased', 'percent']), userFraction: z.number().nullable(), description: z.string() });
const releasePreviewSchema = z.object({
  app: stagedAppSchema,
  request: releaseRequestSchema.describe('What was asked. The share is always the one the person named.'),
  version: z.object({ id: z.string(), versionString: z.string().nullable(), state: z.string(), releaseType: z.string().nullable() }).nullable().describe('App Store: the version that would be released (in `PENDING_DEVELOPER_RELEASE`). Google Play: null.'),
  build: z.object({ id: z.string(), buildNumber: z.string().nullable(), processingState: z.string().nullable(), expired: z.boolean().nullable() }).nullable(),
  phasedRelease: z.object({ id: z.string(), state: z.string().nullable() }).nullable().describe('App Store: a phased release exists (UNVERIFIED how Apple starts it for a release request). Null: everybody at once.'),
  track: z.string().nullable(),
  release: z.object({ name: z.string().nullable(), status: z.string(), versionCodes: z.array(z.string()), notes: z.number().int().describe('How many languages have release notes.') }).nullable().describe('Google Play: the draft release that would start.'),
  others: z.array(z.object({ name: z.string().nullable(), status: z.string(), userFraction: z.number().nullable(), versionCodes: z.array(z.string()) })).describe('Google Play: the other releases of the track, read only.'),
  audience: releaseAudienceSchema,
  irreversible: z.array(z.string()).describe('What cannot be undone from this server, in words, for the confirmation dialog.'),
  releases: z.literal(true),
  checks: z.object({ blocking: z.array(releaseCheckSchema), warnings: z.array(releaseCheckSchema), canRelease: z.boolean() }),
  confirmHash: z.string().nullable().describe('Send it back with `confirmation`. Null while a blocking check stands. Valid only while the store is as previewed.'),
  confirmation: z.object({ phrase: z.string(), instruction: z.string() }).nullable().describe('The text the person types to confirm (`release <identifier> <version>` or `release <identifier> <track> <percent>%`); send it back as `confirmation`.'),
  readAt: timestamp,
});
const releaseApplyBody = z.object({
  ...releaseWhat,
  confirmHash: z.string().regex(/^[0-9a-f]{64}$/).describe('The `confirmHash` of a preview of exactly this request, made now.'),
  confirmation: z.string().min(1).max(300).describe('The `confirmation.phrase` of that preview, typed by the person. A different text is `422 confirmation_mismatch` and nothing is written.'),
});
const releaseResultSchema = z.object({
  app: stagedAppSchema,
  request: releaseRequestSchema,
  version: z.object({ id: z.string(), versionString: z.string().nullable() }).nullable(),
  track: z.string().nullable(),
  releaseRequestId: z.string().nullable().describe('App Store: the release request Apple created, when it said. Google Play: null.'),
  via: z.enum(['release_request', 'edit_commit']),
  audience: releaseAudienceSchema,
  released: z.literal(true),
  confirmedByReread: z.boolean().describe('True when the store did not answer and reading it back showed the release.'),
  releasedAt: timestamp,
  note: z.string(),
});

// ----- pending changes and the batch publish (docs/api/pending.md, docs/adr/0015-pending-and-batch-publish.md) ----

const publishStepEnum = z.enum(['push_draft', 'submit', 'release', 'rollout']);
const pendingProblemSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(), item: z.string().optional() });
const pendingItemSchema = z.object({
  kind: z.enum(['listing_text', 'asset_set', 'release_field', 'pushed_draft', 'in_review', 'approved', 'rollout_step']),
  platform: platform,
  id: z.string().describe('Stable within the kind.'),
  label: z.string().describe('One sentence for a list. Never a staged text.'),
  state: z.enum(['staged', 'invalid', 'pushed', 'in_review', 'approved', 'due']),
  problems: z.array(pendingProblemSchema).describe('An `error` blocks the step this item waits for.'),
  nextStep: publishStepEnum.nullable().describe('The publish step this item waits for. Null: informational (in review).'),
  counts: z.record(z.number()),
  refs: z.array(z.object({ id: z.string(), locale: z.string().optional(), field: z.string().optional() })).describe('Ids only, at most 200.'),
  truncated: z.boolean(),
  since: timestamp.nullable(),
});
const pendingTotalsSchema = z.object({ items: z.number().int(), actionable: z.number().int(), blocking: z.number().int() });
const pendingViewSchema = z.object({
  app: stagedAppSchema,
  platforms: z.array(z.object({ platform: platform, store: reviewStore, items: z.array(pendingItemSchema), totals: pendingTotalsSchema })),
  totals: pendingTotalsSchema.extend({ platforms: z.array(platform), nextSteps: z.array(publishStepEnum) }),
  lastSyncedAt: timestamp.nullable(),
  generatedAt: timestamp,
});
const pendingSummarySchema = z.object({
  apps: z.array(z.object({
    appId: z.string(),
    id: z.string(),
    app: stagedAppSchema,
    count: z.number().int().describe('Items that wait for a publish step.'),
    blocking: z.number().int().describe('Items with an error.'),
    waiting: z.number().int().describe('Informational items (in review).'),
    kinds: z.array(z.string()),
    nextSteps: z.array(publishStepEnum),
  })).describe('Only apps with something pending or in review.'),
  totals: z.object({ apps: z.number().int(), count: z.number().int(), blocking: z.number().int() }),
  generatedAt: timestamp,
});
const publishConfigSchema = z.object({
  enabled: z.boolean(),
  envName: z.string(),
  action: z.string(),
  minimumRole: z.string(),
  steps: z.record(z.object({ action: z.string(), envName: z.string(), enabled: z.boolean(), irreversible: z.boolean() })),
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
  availability: z.enum(['available', 'feature_disabled', 'forbidden', 'nothing_to_do', 'blocked', 'needs_input', 'not_requested']),
  reason: z.string().nullable(),
  requires: z.object({ action: z.string(), envName: z.string(), enabled: z.boolean(), allowed: z.boolean() }),
  irreversible: z.boolean(),
  deferred: z.boolean().describe('Previewed again after the earlier steps applied; `summary` is a promise it must keep, else the step is skipped as `plan_drifted`.'),
  summary: z.record(z.unknown()).nullable(),
  request: z.record(z.unknown()).nullable().describe('The step as to send it back to `publishStoreBatch`.'),
  preview: z.record(z.unknown()).nullable().describe('The preview the step’s own route gives (null for a deferred step that cannot be previewed yet).'),
  confirmHash: z.string().nullable(),
  stepPhrase: z.string().nullable().describe('The phrase the step’s own gate asks for. The batch phrase stands in for it.'),
  problems: z.array(pendingProblemSchema),
});
const publishPlanSchema = z.object({
  app: stagedAppSchema,
  steps: z.array(planStepSchema),
  publishSteps: z.array(z.record(z.unknown())).describe('The `steps` to send to `publishStoreBatch`.'),
  included: z.number().int(),
  irreversible: z.boolean(),
  irreversibleSteps: z.array(publishStepEnum),
  warnings: z.array(z.string()),
  confirmable: z.boolean().describe('Every requested step is available and at least one is included.'),
  planHash: z.string().nullable().describe('Null while the plan is not confirmable.'),
  confirmationRequired: z.boolean(),
  confirmation: z.object({ phrase: z.string(), instruction: z.string() }).nullable().describe('The ONE phrase to type for the whole batch.'),
  readAt: timestamp,
});
const publishStepResultSchema = z.object({
  type: publishStepEnum,
  status: z.enum(['applied', 'skipped', 'failed']),
  confirmedByReread: z.boolean().optional().describe('Applied: the store did not answer and reading it back showed the change.'),
  result: z.record(z.unknown()).optional().describe('Applied: the result the individual route gives.'),
  reason: z.enum(['previous_step_not_applied', 'plan_drifted', 'blocked', 'preview_failed']).optional().describe('Skipped.'),
  checks: z.array(z.string()).optional().describe('Skipped as `blocked`: the codes of the blocking checks.'),
  error: z.string().optional().describe('Failed: the individual error code (`state_changed`, `blocked`, `outcome_unknown`, `write_in_progress`, ...).'),
  httpStatus: z.number().int().optional().describe('Failed: the status the individual route would have answered.'),
  outcome: z.enum(['refused', 'not_applied', 'unknown', 'partial']).optional().describe('Failed: `refused` nothing changed, `not_applied` read back and not applied, `unknown` look at the store, `partial` some of it was written.'),
  code: z.string().optional(),
  message: z.string().optional(),
  detail: z.record(z.unknown()).optional().describe('Failed: the rest of the individual error body (for example a new `preview` after `state_changed`).'),
});
const publishResultSchema = z.object({
  app: stagedAppSchema,
  planHash: z.string(),
  completed: z.boolean().describe('Every included step was applied.'),
  applied: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  stoppedAt: publishStepEnum.nullable().describe('The first step that was not applied; the steps after it were skipped.'),
  steps: z.array(publishStepResultSchema),
  pending: pendingTotalsSchema.describe('The stored pending state after the batch.'),
  publishedAt: timestamp,
});

const W = '/api/workspaces/{workspaceId}';
type Draft = Omit<Operation, 'tags'> & { tags?: string[] };

const drafts: Draft[] = [
  // ----- system and auth ------------------------------------------------------------------------
  {
    id: 'getHealth', method: 'get', path: '/api/health', tags: ['system'], summary: 'Health of the server and its database', risk: 'read', access: 'public',
    responses: { '200': { description: 'Healthy. `503` with `status: degraded` when the database does not answer.', schema: z.object({ status: z.string(), version: z.string(), database: z.object({ dialect: z.string(), ok: z.boolean() }) }) } },
  },
  {
    id: 'getAuthStatus', method: 'get', path: '/api/auth/status', tags: ['auth'], summary: 'Whether setup is needed and who is signed in', risk: 'read', access: 'public',
    responses: { '200': { description: 'The mode, whether first-run setup is open, and the signed-in user or null.', schema: z.object({ mode: z.enum(['multi', 'single_user']), setupRequired: z.boolean(), user: userSchema.nullable() }) } },
  },
  {
    id: 'register', method: 'post', path: '/api/auth/register', tags: ['auth'], summary: 'Create the first account and workspace', description: 'Only on an empty instance; later it answers `403 registration_closed`. Sets the session cookie.', risk: 'write', access: 'public', body: registerBody, bodyLimit: 256 * 1024,
    responses: { '201': { description: 'The owner and the new workspace.', schema: z.object({ user: userSchema, workspaceId: z.string() }) } },
  },
  {
    id: 'login', method: 'post', path: '/api/auth/login', tags: ['auth'], summary: 'Sign in with email and password', description: 'Sets the session cookie. Rate limited per email address and per client address (`429 too_many_attempts`).', risk: 'write', access: 'public', body: loginBody, bodyLimit: 256 * 1024, rateLimited: true,
    responses: { '200': { description: 'The signed-in user.', schema: z.object({ user: userSchema }) } },
  },
  { id: 'logout', method: 'post', path: '/api/auth/logout', tags: ['auth'], summary: 'End the session', risk: 'write', access: 'public', responses: { '204': none } },
  {
    id: 'getMe', method: 'get', path: '/api/me', tags: ['auth'], summary: 'The signed-in user and their workspaces', description: 'Session cookie only: an API token is limited to one workspace and has no identity of its own here.', risk: 'read', access: 'user',
    responses: { '200': { description: 'The user and each workspace with their role.', schema: z.object({ user: userSchema, workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(roles) })) }) } },
  },
  {
    id: 'getOpenApi', method: 'get', path: '/api/openapi.json', tags: ['system'], summary: 'This document', description: 'The OpenAPI 3.1 description of the API. For signed-in users and API tokens only.', risk: 'read', access: 'user', token: true,
    responses: { '200': { description: 'The OpenAPI document.', schema: object } },
  },

  // ----- credentials and audit ------------------------------------------------------------------
  { id: 'listCredentials', method: 'get', path: `${W}/credentials`, tags: ['credentials'], summary: 'List credentials (metadata only)', risk: 'read', access: { action: 'credentials.read' }, responses: { '200': { description: 'Credentials without their secrets.', schema: z.object({ credentials: z.array(credentialSchema) }) } } },
  { id: 'createCredential', method: 'post', path: `${W}/credentials`, tags: ['credentials'], summary: 'Store a credential', risk: 'write', access: { action: 'credentials.write' }, body: credentialBody, responses: { '201': { description: 'The credential, without its secret.', schema: z.object({ credential: credentialSchema }) } } },
  { id: 'testCredentialSecret', method: 'post', path: `${W}/credentials/test`, tags: ['credentials'], summary: 'Test a secret that is not saved', risk: 'read', access: { action: 'credentials.write' }, body: testBody, rateLimited: true, responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } } },
  { id: 'rotateCredential', method: 'put', path: `${W}/credentials/{id}`, tags: ['credentials'], summary: 'Replace the secret of a credential', risk: 'write', access: { action: 'credentials.write' }, body: rotateBody, responses: { '204': none } },
  { id: 'deleteCredential', method: 'delete', path: `${W}/credentials/{id}`, tags: ['credentials'], summary: 'Delete a credential', risk: 'destructive', access: { action: 'credentials.write' }, responses: { '204': none } },
  { id: 'testCredential', method: 'post', path: `${W}/credentials/{id}/test`, tags: ['credentials'], summary: 'Test a saved credential and remember the result', risk: 'read', access: { action: 'credentials.write' }, rateLimited: true, responses: { '200': { description: 'The outcome of the test.', schema: testOutcome } } },
  {
    id: 'listAudit', method: 'get', path: `${W}/audit`, tags: ['workspaces'], summary: 'The audit log, newest first', description: 'Every write is recorded with its actor. `actorType` is `user`, `token`, `assistant` or `system`; for a token, `actorId` is the token id and `actorName` its name.', risk: 'read', access: { action: 'audit.read' },
    query: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    responses: { '200': { description: 'Audit events.', schema: z.object({ events: z.array(z.object({ id: z.string(), actorType: z.string(), actorId: z.string(), actorName: z.string().nullable(), action: z.string(), targetType: z.string().nullable(), targetId: z.string().nullable(), detail: object.nullable(), at: timestamp })) }) } },
  },

  // ----- members and invitations ----------------------------------------------------------------
  { id: 'listMembers', method: 'get', path: `${W}/members`, tags: ['members'], summary: 'List members', risk: 'read', access: { action: 'members.read' }, responses: { '200': { description: 'Members.', schema: z.object({ members: z.array(memberSchema) }) } } },
  { id: 'changeMemberRole', method: 'patch', path: `${W}/members/{userId}`, tags: ['members'], summary: 'Change a member’s role', risk: 'write', access: { action: 'members.manage' }, body: roleBody, responses: { '204': none } },
  { id: 'removeMember', method: 'delete', path: `${W}/members/{userId}`, tags: ['members'], summary: 'Remove a member, or leave the workspace', description: 'Any member may call this on themselves; removing someone else needs `members.manage`.', risk: 'destructive', access: 'member', responses: { '204': none } },
  { id: 'listInvitations', method: 'get', path: `${W}/invitations`, tags: ['invitations'], summary: 'List pending invitations', risk: 'read', access: { action: 'members.manage' }, responses: { '200': { description: 'Pending invitations.', schema: z.object({ invitations: z.array(invitationSchema) }) } } },
  { id: 'createInvitation', method: 'post', path: `${W}/invitations`, tags: ['invitations'], summary: 'Create an invitation link', description: 'The one-time `token` is in this response only.', risk: 'write', access: { action: 'members.manage' }, body: inviteBody, responses: { '201': { description: 'The invitation and its one-time token.', schema: z.object({ invitation: invitationSchema, token: z.string() }) } } },
  { id: 'revokeInvitation', method: 'delete', path: `${W}/invitations/{id}`, tags: ['invitations'], summary: 'Revoke an invitation', risk: 'destructive', access: { action: 'members.manage' }, responses: { '204': none } },
  { id: 'previewInvitation', method: 'get', path: '/api/invitations/{token}', tags: ['invitations'], summary: 'What an invitation link is for', description: 'Public. An unknown, used, expired or revoked token is `404`.', risk: 'read', access: 'public', responses: { '200': { description: 'The workspace name, email and role.', schema: z.object({ workspaceName: z.string(), email: z.string(), role: z.enum(invitableRoles), valid: z.literal(true) }) } } },
  { id: 'acceptInvitation', method: 'post', path: '/api/invitations/{token}/accept', tags: ['invitations'], summary: 'Accept an invitation', description: 'Public. Signed in with the matching email, or a new account with `displayName` and `password`.', risk: 'write', access: 'public', body: acceptBody, bodyLimit: 256 * 1024, responses: { '201': { description: 'The member.', schema: z.object({ user: userSchema, workspaceId: z.string(), role: z.enum(roles) }) } } },

  // ----- repositories and change sets -----------------------------------------------------------
  { id: 'listRepositories', method: 'get', path: `${W}/repositories`, tags: ['repositories'], summary: 'List connected repositories', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'Repositories.', schema: z.object({ repositories: z.array(object) }) } } },
  { id: 'connectRepository', method: 'post', path: `${W}/repositories`, tags: ['repositories'], summary: 'Connect a GitHub repository', risk: 'write', access: { action: 'repositories.write' }, body: connectBody, partial: true, responses: { '201': { description: 'The repository.', schema: z.object({ repository: object }) } } },
  { id: 'getLocalCloneConfig', method: 'get', path: `${W}/repositories/local/config`, tags: ['repositories'], summary: 'Whether local clones are enabled on this server', description: 'Local clones are off unless MRM_LOCAL_REPO_ROOTS is set. The allowed folders are listed only to people who may attach one. `write` says whether commits to a local clone are allowed (MRM_LOCAL_REPO_WRITE) and `signing` whether they are signed (MRM_GIT_SIGN: `enabled`, and `format` ssh or gpg); the key and its location are never part of the answer.', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'The setting.', schema: z.object({ local: localConfigSchema }) } } },
  { id: 'checkLocalClone', method: 'post', path: `${W}/repositories/local/check`, tags: ['repositories'], summary: 'Check a folder before attaching it', description: 'Reads the folder with hardened, read-only git: real path, branch, tip commit, origin (owner/repo only), number of uncommitted files, and the connected repository it matches. Only the committed branch is ever read, never uncommitted edits.', risk: 'read', access: { action: 'repositories.write' }, body: localCheckBody, partial: true, responses: { '200': { description: 'What was found.', schema: z.object({ check: object }) } } },
  { id: 'connectLocalRepository', method: 'post', path: `${W}/repositories/local`, tags: ['repositories'], summary: 'Connect a local folder as a repository without GitHub', description: 'A local-only repository is read from the folder. A change set for it is applied as a commit on a new branch of the folder (`mode: local_branch`, needs MRM_LOCAL_REPO_WRITE=true); `github_pr` is refused with 409 local_only.', risk: 'write', access: { action: 'repositories.write' }, body: localConnectBody, partial: true, responses: { '201': { description: 'The repository (owner, repo and credentialId are null).', schema: z.object({ repository: object }) } } },
  { id: 'attachLocalClone', method: 'put', path: `${W}/repositories/{id}/local`, tags: ['repositories'], summary: 'Attach a local clone to a repository, or change its folder or branch', description: 'Scan, listing and change set creation then read the committed branch of the folder. A change set can still be applied as a pull request through GitHub, or (MRM_LOCAL_REPO_WRITE=true) as a commit on a new branch of the folder.', risk: 'write', access: { action: 'repositories.write' }, body: localAttachBody, partial: true, responses: { '200': { description: 'The repository.', schema: z.object({ repository: object }) } } },
  { id: 'detachLocalClone', method: 'delete', path: `${W}/repositories/{id}/local`, tags: ['repositories'], summary: 'Detach the local clone of a repository', description: 'Reads go back to GitHub. A local-only repository cannot be detached (409 local_only): disconnect it.', risk: 'destructive', access: { action: 'repositories.write' }, partial: true, responses: { '200': { description: 'The repository.', schema: z.object({ repository: object }) } } },
  { id: 'getRepository', method: 'get', path: `${W}/repositories/{id}`, tags: ['repositories'], summary: 'A repository and what was detected in it', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'The repository and its detection.', schema: object } } },
  { id: 'disconnectRepository', method: 'delete', path: `${W}/repositories/{id}`, tags: ['repositories'], summary: 'Disconnect a repository', risk: 'destructive', access: { action: 'repositories.write' }, responses: { '204': none } },
  { id: 'scanRepository', method: 'post', path: `${W}/repositories/{id}/scan`, tags: ['repositories'], summary: 'Scan a repository and store what is detected', risk: 'write', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'The repository and its detection.', schema: object } } },
  { id: 'getRepositoryListing', method: 'get', path: `${W}/repositories/{id}/listing`, tags: ['repositories'], summary: 'The store listing found in the repository', risk: 'read', access: { action: 'repositories.scan' }, query: listingQuery, partial: true, responses: { '200': { description: 'The listing and its problems.', schema: object } } },
  { id: 'listListingTargets', method: 'get', path: `${W}/repositories/{id}/listing-targets`, tags: ['repositories'], summary: 'Saved listing targets of a repository', risk: 'read', access: { action: 'repositories.read' }, partial: true, responses: { '200': { description: 'Targets.', schema: z.object({ targets: z.array(object) }) } } },
  { id: 'createListingTarget', method: 'post', path: `${W}/repositories/{id}/listing-targets`, tags: ['repositories'], summary: 'Save a listing target', risk: 'write', access: { action: 'repositories.write' }, body: targetBody, partial: true, responses: { '201': { description: 'The target.', schema: z.object({ target: object }) } } },
  { id: 'updateListingTarget', method: 'patch', path: `${W}/repositories/{id}/listing-targets/{targetId}`, tags: ['repositories'], summary: 'Change a listing target', risk: 'write', access: { action: 'repositories.write' }, body: targetBody.partial(), partial: true, responses: { '200': { description: 'The target.', schema: z.object({ target: object }) } } },
  { id: 'deleteListingTarget', method: 'delete', path: `${W}/repositories/{id}/listing-targets/{targetId}`, tags: ['repositories'], summary: 'Delete a listing target', risk: 'destructive', access: { action: 'repositories.write' }, responses: { '204': none } },
  { id: 'createChangeSet', method: 'post', path: `${W}/repositories/{id}/change-sets`, tags: ['change-sets'], summary: 'Draft a change set from a listing', description: 'Writes nothing to the repository: a person with approval rights approves it, then it is applied as a pull request.', risk: 'write', access: { action: 'changesets.write' }, body: changeSetBody, partial: true, responses: { '201': { description: 'The draft, its problems and warnings.', schema: z.object({ changeSet: changeSetSchema, problems: z.array(object), warnings: z.array(z.string()).optional() }) } } },
  { id: 'listChangeSets', method: 'get', path: `${W}/change-sets`, tags: ['change-sets'], summary: 'List change sets', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ repositoryId: z.string().optional(), status: z.string().optional() }), responses: { '200': { description: 'Change sets.', schema: z.object({ changeSets: z.array(changeSetSchema) }) } } },
  { id: 'getChangeSet', method: 'get', path: `${W}/change-sets/{id}`, tags: ['change-sets'], summary: 'A change set with its file contents', risk: 'read', access: { action: 'repositories.read' }, responses: { '200': changeSetAnswer } },
  { id: 'approveChangeSet', method: 'post', path: `${W}/change-sets/{id}/approve`, tags: ['change-sets'], summary: 'Approve a draft change set', risk: 'write', access: { action: 'changesets.approve' }, responses: { '200': changeSetAnswer } },
  { id: 'applyChangeSet', method: 'post', path: `${W}/change-sets/{id}/apply`, tags: ['change-sets'], summary: 'Apply an approved change set (a pull request through GitHub, or a commit on a new branch of the local clone)', description: 'No body, or `mode: github_pr`: a branch and a pull request through the GitHub API (409 local_only for a local-only repository). `mode: local_branch`: one commit on a NEW branch of the repository\'s local clone, built with git plumbing (the working tree, index, HEAD and current branch are not touched); needs MRM_LOCAL_REPO_WRITE=true (409 local_write_disabled), a local clone (409 no_local_checkout) and files that still match the clone\'s branch (409 base_changed, with `paths`); an existing branch is never moved (409 branch_exists). When the server signs commits (MRM_GIT_SIGN) the commit is signed with its own key and `outcome.signature` says so; if signing fails nothing is committed, the change set stays approved and the answer is 502 (504 when it timed out) `signing_failed` with a fixed `reason` (`timeout`, `locked`, `key`, `program`, `failed`). `push` pushes that branch to the connected GitHub repository and `openPr` (needs `push`) opens the pull request; a failed push or pull request does not undo the commit: the answer is 200 and `changeSet.outcome` says what happened, then `POST /change-sets/{id}/push` retries.', risk: 'write', access: { action: 'changesets.approve' }, body: applyBody, bodyOptional: true, partial: true, responses: { '200': { description: 'The applied change set (`outcome` for a local commit).', schema: z.object({ changeSet: changeSetSchema, alreadyApplied: z.boolean().optional() }) } } },
  { id: 'pushChangeSet', method: 'post', path: `${W}/change-sets/{id}/push`, tags: ['change-sets'], summary: 'Push the branch of a local commit, and optionally open the pull request', description: 'For a change set applied with `mode: local_branch`. Pushes the commit to `refs/heads/<branch>` of the connected GitHub repository through the managed, hardened push (never the clone\'s own remote or hooks), and with `openPr` opens a pull request into the branch the commit was made on. Repeating it is safe: finished steps are skipped (`alreadyDone`). 502 with the change set when a step fails; `changeSet.outcome` says which.', risk: 'write', access: { action: 'changesets.approve' }, body: publishBody, bodyOptional: true, partial: true, responses: { '200': { description: 'The change set with its outcome.', schema: z.object({ changeSet: changeSetSchema, alreadyDone: z.boolean().optional() }) } } },
  { id: 'listClones', method: 'get', path: `${W}/clones`, tags: ['repositories'], summary: 'The managed git clones of this workspace: size and last use', description: 'Admin and owner. Only this workspace\'s clones are listed (the folder and its limits are the server\'s): per repository the bytes on disk (cached for ten minutes, a lower bound when the walk reached its cap), when it was last used and whether it is in use now. `kind` is `local` for the managed copy of an attached local folder. No server path is part of the answer. A sweep (MRM_CLONE_SWEEP_INTERVAL_MINUTES) removes clones idle for MRM_CLONE_IDLE_DAYS, then the least recently used above MRM_CLONE_MAX_BYTES; a removed clone is fetched again by the next read. `enabled` is false when reads do not use clones (MRM_READS=api).', risk: 'read', access: { action: 'repositories.write' }, responses: { '200': { description: 'The clones.', schema: z.object({ enabled: z.boolean(), clones: z.array(cloneSchema), totalBytes: z.number().int(), limits: cloneLimitsSchema }) } } },
  { id: 'getRepositoryClone', method: 'get', path: `${W}/repositories/{id}/clone`, tags: ['repositories'], summary: 'The clone of one repository: size and last use', description: '`clone` is null when there is none on disk. A repository with an attached local folder shows its two copies as one.', risk: 'read', access: { action: 'repositories.read' }, responses: { '200': { description: 'The clone, if any.', schema: z.object({ enabled: z.boolean(), clone: cloneSchema.nullable(), limits: cloneLimitsSchema }) } } },
  { id: 'purgeRepositoryClone', method: 'post', path: `${W}/repositories/{id}/clone/purge`, tags: ['repositories'], summary: 'Remove the clone of a repository now (free the space)', description: 'Admin and owner. The clone is a cache: the next read fetches it again. `409 clone_busy` while a read is running. Audited as `clone.purge` with counts.', risk: 'destructive', access: { action: 'repositories.write' }, responses: { '200': { description: 'What was removed.', schema: z.object({ removed: z.number().int(), freedBytes: z.number().int() }) } } },
  { id: 'refreshChangeSet', method: 'post', path: `${W}/change-sets/{id}/refresh`, tags: ['change-sets'], summary: 'Refresh a stale change set: re-base it onto the repository as it is now', description: 'For a draft, approved or failed change set (a failed one only when no branch was created; once a branch exists the answer is `409 branch_created`, and `POST /change-sets/{id}/fixup` adds one commit to the branch instead). Each file is read again (from the local clone, or GitHub) and compared: unchanged files stay, files whose change is already in the repository leave the set, and files that changed elsewhere are merged line by line (a three-way merge; an Expo JSON file must still parse). Where both sides changed the same place the answer is `409 refresh_conflicts` with, per conflicting file, `base`, `ours` (the change set\'s text) and `theirs` (the repository\'s), and NOTHING is changed; send `resolutions` (`mine`: keep our text and overwrite theirs, `theirs`: drop our change) for each conflicting path to settle it. A refresh that changes the text returns the set to `draft` and clears its approval (`approvalCleared`); one that changes nothing leaves it as it is (`unchanged`). `nothingLeft` means no file remains: discard it. Audited as `changeset.refresh` with counts only.', risk: 'write', access: { action: 'changesets.write' }, body: refreshBody, bodyOptional: true, partial: true, responses: { '200': { description: 'The refreshed change set and what happened to each file.', schema: z.object({ changeSet: changeSetSchema, files: z.array(refreshFileSchema), refreshedFrom: z.string(), unchanged: z.boolean(), nothingLeft: z.boolean(), approvalCleared: z.boolean() }) } } },
  { id: 'getChangeSetStaleness', method: 'get', path: `${W}/change-sets/{id}/staleness`, tags: ['change-sets'], summary: 'Is the change set still what the repository holds? (read only)', description: 'Reads the files of the change set from the repository now and says, per file, `same`, `changed` (a clean merge is possible), `already_applied` or `conflict`. Writes nothing. Needs the right a scan needs, because it reads with the stored credential.', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Whether it is stale, and per file.', schema: z.object({ stale: z.boolean(), files: z.array(z.object({ path: z.string(), state: fileStateSchema })), readAt: z.string() }) } } },
  { id: 'fixupChangeSet', method: 'post', path: `${W}/change-sets/{id}/fixup`, tags: ['change-sets'], summary: 'Fix up the branch of a change set: add ONE commit on top of it', description: 'For a change set that has a branch: `applied` (a pull request through GitHub, or a commit on a new branch of a local clone) or `failed` with the branch GitHub made before the pull request failed. The content is refreshed first (a three-way merge against the repository, then against the branch: the base of that merge is the text this tool last committed, so edits a person made on the branch are merged, not overwritten), the difference is committed as ONE new commit whose parent is the branch tip that was read, and the branch is moved forward to it with a fast-forward only. History is never rewritten and nothing is forced. 409 `refresh_conflicts` (per file against the repository, resolve with `resolutions`) and 409 `fixup_conflicts` (per file against the branch, resolve with `branchResolutions`) change nothing. No difference: 200 with `nothingToFix` and no commit. `dryRun` reports the plan and writes nothing. Refusals that write nothing: 409 `branch_moved` (the branch is not at the tip that was read), 409 `branch_checked_out` (the local branch is checked out, in a worktree or being rebased: moving it would leave that working folder stale), 409 `pr_closed` (the pull request is merged or closed: create a new change set), 409 `branch_missing`, 409 `fixup_in_progress`, 409 `no_branch`. Local mode needs MRM_LOCAL_REPO_WRITE (409 `local_write_disabled`), signs like apply, and with `push` pushes the new tip without force (409 `remote_diverged` when the branch on GitHub has other commits; the local commit is kept). With `recompute` the content comes from the live store listing. Needs `changesets.approve` (and `listing.read` for `recompute`, `apps.sync` for `refresh`). Audited as `changeset.fixup` / `changeset.fixup_failed` with counts only.', risk: 'write', access: { action: 'changesets.approve' }, body: fixupBody, bodyOptional: true, partial: true, responses: { '200': { description: 'What was done.', schema: z.object({ changeSet: changeSetSchema, mode: z.enum(['local_branch', 'github_pr']), branch: z.string(), nothingToFix: z.boolean(), files: z.array(fixupFileSchema), willCommit: z.array(z.string()), refreshedFrom: z.string(), tip: z.string(), commit: z.object({ sha: z.string(), parent: z.string(), files: z.number().int(), signed: z.boolean() }).optional(), pullRequest: z.object({ state: z.enum(['open', 'opened', 'none']), number: z.number().int().optional(), url: z.string().optional() }), dryRun: z.boolean().optional(), conflicts: z.number().int().optional(), recompute: object.optional() }) } } },
  { id: 'recomputeChangeSet', method: 'post', path: `${W}/change-sets/{id}/recompute`, tags: ['change-sets'], summary: 'Recompute a store pull from the live store listing and the current repository', description: 'For a change set made by the store pull (`origin.source` is `store_pull`; older change sets and other sources answer 409 `not_recomputable`). The pull is planned again from its stored request, the latest stored store snapshot (or a fresh read with `refresh`) and the repository now, and the files of the SAME change set are replaced: same id and creator, status `draft`, approval cleared (`approvalCleared`). Allowed for a draft, approved or failed change set without a branch; one with a branch answers 409 `has_branch` (use `POST /change-sets/{id}/fixup` with `recompute`). The answer has the shape of the pull plus `diffFromPrevious` (per field: `store_changed`, `unchanged`, `added`, `dropped` with a reason, such as `identical` when the store went back to the repository\'s text) and `nothingLeft` when the store and the repository agree now (discard it). Needs `changesets.write` and `listing.read`; `refresh` also needs `apps.sync` and is rate limited like the pull. Audited as `changeset.recompute` with counts only.', risk: 'write', access: { action: 'changesets.write' }, body: recomputeBody, bodyOptional: true, partial: true, responses: { '200': { description: 'The recomputed change set, what changes, what was skipped, and what changed since the draft.', schema: z.object({ changeSet: changeSetSchema, changes: z.array(object), skipped: z.array(object), problems: z.array(object), warnings: z.array(z.string()), diffFromPrevious: z.array(fieldDiffSchema), nothingLeft: z.boolean(), unchanged: z.boolean(), approvalCleared: z.boolean() }) } } },
  { id: 'discardChangeSet', method: 'post', path: `${W}/change-sets/{id}/discard`, tags: ['change-sets'], summary: 'Discard a change set', risk: 'destructive', access: { action: 'changesets.write' }, responses: { '200': changeSetAnswer } },

  // ----- apps -----------------------------------------------------------------------------------
  { id: 'listApps', method: 'get', path: `${W}/apps`, tags: ['apps'], summary: 'List apps', description: 'A token restricted to some apps sees only those.', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'list' }, responses: { '200': { description: 'Apps.', schema: z.object({ apps: z.array(appSchema) }) } } },
  { id: 'createApp', method: 'post', path: `${W}/apps`, tags: ['apps'], summary: 'Add an app', risk: 'write', access: { action: 'apps.write' }, body: appBody, responses: { '201': { description: 'The app.', schema: z.object({ app: appSchema }) } } },
  { id: 'discoverApps', method: 'post', path: `${W}/apps/discover`, tags: ['apps'], summary: 'Find the apps behind a credential', description: 'Reads the store. Shares the per-workspace sync budget.', risk: 'read', access: { action: 'apps.write' }, body: discoverBody, bodyLimit: 16 * 1024, rateLimited: true, partial: true, responses: { '200': { description: 'Candidates and failures.', schema: object } } },
  { id: 'importApps', method: 'post', path: `${W}/apps/import`, tags: ['apps'], summary: 'Add several apps at once', risk: 'write', access: { action: 'apps.write' }, body: importBody, bodyLimit: 32 * 1024, partial: true, responses: { '200': { description: 'A result per item and a summary.', schema: z.object({ results: z.array(object), summary: z.object({ created: z.number().int(), skipped: z.number().int(), failed: z.number().int() }) }) } } },
  { id: 'getApp', method: 'get', path: `${W}/apps/{id}`, tags: ['apps'], summary: 'An app and its stored releases', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The app and its releases.', schema: z.object({ app: appSchema, releases: z.array(releaseSchema) }) } } },
  { id: 'deleteApp', method: 'delete', path: `${W}/apps/{id}`, tags: ['apps'], summary: 'Remove an app', risk: 'destructive', access: { action: 'apps.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'syncApp', method: 'post', path: `${W}/apps/{id}/sync`, tags: ['apps'], summary: 'Read the store and replace the stored snapshot', description: 'Read-only toward the store. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace.', risk: 'write', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ background: z.enum(['true']).optional() }), responses: { '200': { description: 'The app, its releases and what the sync changed.', schema: z.object({ app: appSchema, releases: z.array(releaseSchema), sync: z.object({ at: timestamp, found: z.number().int(), added: z.number().int(), updated: z.number().int(), removed: z.number().int(), unmapped: z.number().int() }) }) }, '202': { description: 'Queued (with `?background=true`).', schema: z.object({ jobId: z.string() }) } } },

  // ----- tokens ---------------------------------------------------------------------------------
  { id: 'listTokens', method: 'get', path: `${W}/tokens`, tags: ['tokens'], summary: 'List API tokens', description: 'Metadata only: the token itself is shown once, when it is made.', risk: 'read', access: { action: 'tokens.read' }, responses: { '200': { description: 'Tokens, newest first.', schema: z.object({ tokens: z.array(tokenSummarySchema) }) } } },
  { id: 'createToken', method: 'post', path: `${W}/tokens`, tags: ['tokens'], summary: 'Create an API token', description: 'The `token` is in this response and nowhere else, ever. The role cannot be above your own, and never `owner`.', risk: 'write', access: { action: 'tokens.manage' }, body: createTokenBody, bodyLimit: 16 * 1024, responses: { '201': { description: 'The token (shown once) and its metadata.', schema: z.object({ token: z.string(), summary: tokenSummarySchema }) } } },
  { id: 'revokeToken', method: 'delete', path: `${W}/tokens/{id}`, tags: ['tokens'], summary: 'Revoke an API token', description: 'Takes effect at once. Revoking twice is fine.', risk: 'destructive', access: { action: 'tokens.manage' }, responses: { '204': none } },

  // ----- events ---------------------------------------------------------------------------------
  { id: 'listEvents', method: 'get', path: `${W}/events`, tags: ['events'], summary: 'Events, oldest first from a cursor', description: 'With `since`: events after that id, up to `limit`; `hasMore` says to ask again with `nextCursor`. Without it: the newest `limit` events. Only events about things the role may read are returned; an app restricted token sees only events about its apps.', risk: 'read', access: { action: 'events.read' }, appScope: { kind: 'events' }, query: z.object({ since: z.number().int().min(0).optional().describe('Return events with an id above this.'), limit: z.number().int().min(1).max(200).optional(), type: z.string().optional().describe('Comma separated event types to keep.') }), responses: { '200': { description: 'A page of events.', schema: z.object({ events: z.array(eventSchema), hasMore: z.boolean(), nextCursor: z.number().int() }) } } },
  { id: 'streamEvents', method: 'get', path: `${W}/events/stream`, tags: ['events'], summary: 'Server-sent events: the live event stream', description: 'Each event is an SSE message with `id` (the event id), `event` (the type) and `data` (the event as JSON). A comment heartbeat is sent every 15 seconds. Reconnect with `Last-Event-ID` (or `?since=`) to resume. At most 5 open streams per person.', risk: 'read', access: { action: 'events.read' }, appScope: { kind: 'events' }, query: z.object({ since: z.number().int().min(0).optional(), type: z.string().optional() }), responses: { '200': { description: 'An event stream.', contentType: 'text/event-stream' } } },

  // ----- webhooks -------------------------------------------------------------------------------
  { id: 'listWebhooks', method: 'get', path: `${W}/webhooks`, tags: ['webhooks'], summary: 'List webhook endpoints', risk: 'read', access: { action: 'webhooks.read' }, responses: { '200': { description: 'Endpoints (never their secrets).', schema: z.object({ webhooks: z.array(webhookSchema) }) } } },
  { id: 'createWebhook', method: 'post', path: `${W}/webhooks`, tags: ['webhooks'], summary: 'Add a webhook endpoint', description: 'The signing `secret` is in this response only. https URLs to public addresses only.', risk: 'write', access: { action: 'webhooks.manage' }, body: createWebhookBody, bodyLimit: 16 * 1024, responses: { '201': { description: 'The endpoint and its secret (shown once).', schema: z.object({ webhook: webhookSchema, secret: z.string() }) } } },
  { id: 'getWebhook', method: 'get', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'A webhook endpoint', risk: 'read', access: { action: 'webhooks.read' }, responses: { '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) } } },
  { id: 'updateWebhook', method: 'patch', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'Change a webhook endpoint', risk: 'write', access: { action: 'webhooks.manage' }, body: updateWebhookBody, bodyLimit: 16 * 1024, responses: { '200': { description: 'The endpoint.', schema: z.object({ webhook: webhookSchema }) } } },
  { id: 'deleteWebhook', method: 'delete', path: `${W}/webhooks/{id}`, tags: ['webhooks'], summary: 'Delete a webhook endpoint and its delivery log', risk: 'destructive', access: { action: 'webhooks.manage' }, responses: { '204': none } },
  { id: 'rotateWebhookSecret', method: 'post', path: `${W}/webhooks/{id}/rotate-secret`, tags: ['webhooks'], summary: 'Make a new signing secret', description: 'The old secret stops working at once. The new one is in this response only.', risk: 'write', access: { action: 'webhooks.manage' }, responses: { '200': { description: 'The new secret.', schema: z.object({ secret: z.string() }) } } },
  { id: 'testWebhook', method: 'post', path: `${W}/webhooks/{id}/test`, tags: ['webhooks'], summary: 'Send a test event', description: 'Queues a `webhook.test` delivery through the normal path. Rate limited per workspace.', risk: 'write', access: { action: 'webhooks.manage' }, rateLimited: true, responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } } },
  { id: 'listWebhookDeliveries', method: 'get', path: `${W}/webhooks/{id}/deliveries`, tags: ['webhooks'], summary: 'Recent deliveries of an endpoint', risk: 'read', access: { action: 'webhooks.read' }, query: z.object({ limit: z.number().int().min(1).max(100).optional() }), responses: { '200': { description: 'Deliveries, newest first.', schema: z.object({ deliveries: z.array(deliverySchema) }) } } },
  { id: 'redeliverWebhook', method: 'post', path: `${W}/webhooks/{id}/deliveries/{deliveryId}/redeliver`, tags: ['webhooks'], summary: 'Send a delivery again', description: 'A new delivery with the same body. Rate limited per workspace.', risk: 'write', access: { action: 'webhooks.manage' }, rateLimited: true, responses: { '202': { description: 'Queued.', schema: z.object({ deliveryId: z.string() }) } } },

  // ----- plans and checklist templates ----------------------------------------------------------
  // Described in part: the plan shape is still moving. Permissions are exact.
  { id: 'listPlans', method: 'get', path: `${W}/plans`, tags: ['plans'], summary: 'List release plans of the workspace', risk: 'read', access: { action: 'plans.read' }, partial: true, responses: { '200': { description: 'Plans.', schema: z.object({ plans: z.array(object) }) } } },
  { id: 'listAppPlans', method: 'get', path: `${W}/apps/{id}/plans`, tags: ['plans'], summary: 'List the release plans of an app', risk: 'read', access: { action: 'plans.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'Plans.', schema: z.object({ plans: z.array(object) }) } } },
  { id: 'createPlan', method: 'post', path: `${W}/apps/{id}/plans`, tags: ['plans'], summary: 'Create a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '201': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'getPlan', method: 'get', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'A release plan with its items', risk: 'read', access: { action: 'plans.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'updatePlan', method: 'patch', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'Change a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlan', method: 'delete', path: `${W}/apps/{id}/plans/{planId}`, tags: ['plans'], summary: 'Delete a release plan', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'addPlanItem', method: 'post', path: `${W}/apps/{id}/plans/{planId}/items`, tags: ['plans'], summary: 'Add an item to a release plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '201': { description: 'The plan and the new item id.', schema: z.object({ plan: object, itemId: z.string() }) } } },
  { id: 'orderPlanItems', method: 'put', path: `${W}/apps/{id}/plans/{planId}/items/order`, tags: ['plans'], summary: 'Set the order of the items of a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'updatePlanItem', method: 'patch', path: `${W}/apps/{id}/plans/{planId}/items/{itemId}`, tags: ['plans'], summary: 'Change an item of a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlanItem', method: 'delete', path: `${W}/apps/{id}/plans/{planId}/items/{itemId}`, tags: ['plans'], summary: 'Remove an item from a plan', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'applyPlanTemplate', method: 'post', path: `${W}/apps/{id}/plans/{planId}/apply-template`, tags: ['plans'], summary: 'Add the items of a checklist template to a plan', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'setPlanNotes', method: 'put', path: `${W}/apps/{id}/plans/{planId}/notes/{locale}`, tags: ['plans'], summary: 'Set the release notes of one locale', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'deletePlanNotes', method: 'delete', path: `${W}/apps/{id}/plans/{planId}/notes/{locale}`, tags: ['plans'], summary: 'Remove the release notes of one locale', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The plan.', schema: z.object({ plan: object }) } } },
  { id: 'getPlanRollout', method: 'get', path: `${W}/apps/{id}/plans/{planId}/rollout`, tags: ['plans'], summary: 'The staged rollout plan of a release plan, next to what the store last reported', risk: 'read', access: { action: 'plans.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'setPlanRollout', method: 'put', path: `${W}/apps/{id}/plans/{planId}/rollout`, tags: ['plans'], summary: 'Set the staged rollout plan (planning data only, nothing is sent to a store)', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'clearPlanRollout', method: 'delete', path: `${W}/apps/{id}/plans/{planId}/rollout`, tags: ['plans'], summary: 'Remove the staged rollout plan', risk: 'destructive', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'completePlanRolloutStep', method: 'post', path: `${W}/apps/{id}/plans/{planId}/rollout/steps/{stepId}/complete`, tags: ['plans'], summary: 'Mark a rollout step done (optionally confirmed from the store share)', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, body: object, bodyOptional: true, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'skipPlanRolloutStep', method: 'post', path: `${W}/apps/{id}/plans/{planId}/rollout/steps/{stepId}/skip`, tags: ['plans'], summary: 'Skip a rollout step', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'reopenPlanRolloutStep', method: 'post', path: `${W}/apps/{id}/plans/{planId}/rollout/steps/{stepId}/reopen`, tags: ['plans'], summary: 'Reopen a rollout step', risk: 'write', access: { action: 'plans.write' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The rollout plan, with the store share beside it.', schema: z.object({ rollout: object }) } } },
  { id: 'listChecklistTemplates', method: 'get', path: `${W}/checklist-templates`, tags: ['plans'], summary: 'List checklist templates', risk: 'read', access: { action: 'plans.read' }, partial: true, responses: { '200': { description: 'Templates.', schema: z.object({ templates: z.array(object) }) } } },
  { id: 'createChecklistTemplate', method: 'post', path: `${W}/checklist-templates`, tags: ['plans'], summary: 'Create a checklist template', risk: 'write', access: { action: 'plans.write' }, body: object, partial: true, responses: { '201': { description: 'The template.', schema: z.object({ template: object }) } } },
  { id: 'updateChecklistTemplate', method: 'patch', path: `${W}/checklist-templates/{templateId}`, tags: ['plans'], summary: 'Change a checklist template', risk: 'write', access: { action: 'plans.write' }, body: object, partial: true, responses: { '200': { description: 'The template.', schema: z.object({ template: object }) } } },
  { id: 'deleteChecklistTemplate', method: 'delete', path: `${W}/checklist-templates/{templateId}`, tags: ['plans'], summary: 'Delete a checklist template', risk: 'destructive', access: { action: 'plans.write' }, responses: { '204': none } },

  // ----- store listing: live, drift, history ----------------------------------------------------
  { id: 'getLiveListing', method: 'get', path: `${W}/apps/{id}/listing/live`, tags: ['listing'], summary: 'The listing as the store has it (from the last listing read)', description: 'Reads the database. Nothing is sent to a store. Besides the texts per channel and locale it returns `warnings` (what the connector noticed in the last read), `schedule` (the scheduled listing read, MRM_LISTING_INTERVAL_MINUTES) and, per channel, `sections` (categories, ageRating, privacy, media, details, releaseNotes): a section that is missing was not read, one that is present and empty was read and is empty. Read-only; never pulled into a repository.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: listingQuery, partial: true, responses: { '200': { description: 'The live listing.', schema: object } } },
  { id: 'getListingDrift', method: 'get', path: `${W}/apps/{id}/listing/drift`, tags: ['listing'], summary: 'How the live listing differs from the repository', description: 'Texts per locale and field, plus `sections`: the store\u2019s categories, age rating, privacy choices URL, app details and media counts against what the repository can express, each with a compare status (`identical`, `differs`, `missing-in-repo`, `missing-in-store`, `not-comparable`, `not-read`). Reads the database only.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: listingQuery, partial: true, responses: { '200': { description: 'The differences.', schema: object } } },
  { id: 'getListingHistory', method: 'get', path: `${W}/apps/{id}/listing/history`, tags: ['listing'], summary: 'How a listing field changed between syncs', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ locale: z.string().optional(), field: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }), partial: true, responses: { '200': { description: 'Changes, newest first.', schema: object } } },
  // ----- assets and icons -----------------------------------------------------------------------
  { id: 'getAppAssets', method: 'get', path: `${W}/apps/{id}/assets`, tags: ['assets'], summary: 'The screenshots, graphics and icons in the app\u2019s repository, with problems against the documented store specs', description: 'Read-only: reads the connected repository (a local clone when there is one, else GitHub) and writes nothing, not even to this server\u2019s database. Only the first bytes of each image are read to get its size; a GitHub read has a budget and says `partial` when it ran out. The index is cached per commit. `storeSide` is reserved for the store\u2019s own counts and is null. The checks are against the specs as documented in docs/api/assets.md, never against a store. Rate limited per workspace when it has to read the repository.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, partial: true, responses: { '200': { description: 'The index: assets with their facts, problems, counts per set, the source and the commit that was read.', schema: object } } },
  { id: 'getAppAssetFile', method: 'get', path: `${W}/apps/{id}/assets/file`, tags: ['assets'], summary: 'One image of the asset index', description: 'Only a path the index lists for this app. The type is sniffed from the bytes (png, jpeg, webp or gif), never svg or html; `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` and a sandboxing CSP are set. `ETag` is the git blob id and `If-None-Match` is answered with `304`. Files over 8 MB are refused (`413`). The image is not resized: the browser scales it.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ path: z.string().describe('A path from the index.'), commit: z.string().optional().describe('The commit of the index (a full hash). Without it the branch tip is read.') }), responses: { '200': { description: 'The image.', contentType: 'image/png' }, '304': { description: 'Not modified.' } } },
  { id: 'getAppIcon', method: 'get', path: `${W}/apps/{id}/icon`, tags: ['assets'], summary: 'The icon of an app', description: 'From the repository when it has one, else (iOS) from the public iTunes Lookup API; kept by the server, at most 256 KB. The first request may take a few seconds while it is looked up; `404` when there is none. Same safe image headers as the asset file route.', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ v: z.string().optional().describe('The etag from `iconUrl`: makes the answer cacheable for a year.') }), responses: { '200': { description: 'The icon.', contentType: 'image/png' }, '304': { description: 'Not modified.' } } },

  // ----- two way sync of graphics (docs/adr/0012-assets-two-way-sync.md) ----
  { id: 'getAppStoreImages', method: 'get', path: `${W}/apps/{id}/assets/store`, tags: ['assets'], summary: 'The images the store holds for the app', description: 'Reads the store through the app\u2019s credential (audited as `credential.use`, purpose `store.images_read`) and changes nothing in it. App Store: the editable version if there is one, else the live one; Google Play: the live listing. Kept for 60 seconds. Images have an opaque `ref` (never a store address) for the thumbnail route. `429 rate_limited` when the workspace reads the store too often.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ fresh: z.string().optional().describe('`1` skips the cache.') }), responses: { '200': { description: 'The store\u2019s sets and images.', schema: object } } },
  { id: 'getAppAssetDiff', method: 'get', path: `${W}/apps/{id}/assets/diff`, tags: ['assets'], summary: 'The repository\u2019s graphics against the store\u2019s, file by file', description: 'Per set and file: `identical`, `likely_same` (no checksum on the store side: compared by size), `differs`, `only_repo`, `only_store`. Reads the store (cached 60 seconds) and the repository (the asset index, and files only where the store gives a checksum, within a budget). Changes nothing.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, partial: true, query: z.object({ fresh: z.string().optional().describe('`1` skips the store cache.') }), responses: { '200': { description: 'The comparison.', schema: object } } },
  { id: 'getStoreImageThumbnail', method: 'get', path: `${W}/apps/{id}/assets/store/thumb`, tags: ['assets'], summary: 'A thumbnail of a store image (a proxy: the browser never contacts the store\u2019s CDN)', description: 'Fetches from the store\u2019s image hosts only (https, an allowlist of hosts checked again on every redirect, resolved addresses checked, a size cap, a timeout), sniffs the type from the bytes and serves it with the safe image headers. `ETag` is derived from the ref: `If-None-Match` is answered with `304`. `404 ref_expired` when the ref is not known any more (read the comparison again).', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ ref: z.string().describe('The `ref` of an image from the store view.'), size: z.string().optional().describe('160, 320 (default) or 640: the long side.') }), responses: { '200': { description: 'The image.', contentType: 'image/jpeg' }, '304': { description: 'Not modified.' } } },
  { id: 'pullStoreImages', method: 'post', path: `${W}/apps/{id}/assets/pull`, tags: ['assets'], summary: 'Pull the store\u2019s images into a draft change set for the repository', description: 'Downloads the store\u2019s images (hosts allowlisted, per-file and total caps) and drafts a change set that adds or replaces the files in the repository\u2019s own layout. Nothing is written to the repository or the store: the change set is reviewed, approved and applied like any other (a pull request, or a commit on a new branch in a local clone). Google Play images are checked against the SHA-256 the store gives (a mismatch is not taken); the App Store gives none, so they are `unverified`. Files of the repository the store does not have stay unless `prune`. Needs `changesets.write`.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, partial: true, body: z.object({ sets: z.array(z.string()).max(200).optional().describe('Set keys such as `ios/en-US/screenshot:iphone_6_9`.'), files: z.array(z.string()).max(120).optional().describe('Image keys: a set key and `#position`.'), prune: z.boolean().optional() }), bodyOptional: true, responses: { '200': { description: 'What was drafted, skipped and why. `changeSet` is null when nothing had to change.', schema: object } } },
  { id: 'inspectAssetFile', method: 'post', path: `${W}/apps/{id}/assets/inspect`, tags: ['assets'], summary: 'What an image is and what is wrong with it for a slot (nothing is stored)', description: 'The request body is the raw image bytes (at most 8 MiB). The type comes from the bytes: PNG or JPEG only. Answers the facts, the problems against the documented specs and the fixes the app can make. Needs `changesets.write`.', risk: 'read', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, bodyLimit: 8 * 1024 * 1024, query: z.object({ locale: z.string().min(2).max(35), kind: z.string().describe('screenshot, icon, feature_graphic, promo_graphic or tv_banner.'), device: z.string().max(60).optional().describe('Required for screenshot: a display id (iphone_6_9) or a Play device (phone).'), name: z.string().max(200).optional() }), responses: { '200': { description: 'The inspection.', schema: object } } },
  { id: 'uploadStagedAsset', method: 'put', path: `${W}/apps/{id}/staged/assets/upload`, tags: ['staged-changes'], summary: 'Add an uploaded image to a staged set, or replace one of its files', description: 'The request body is the raw image bytes (at most 8 MiB; PNG or JPEG by content; the kept total is capped per app). The set is composed from what is staged, else from the repository\u2019s files for the slot, and the whole set is staged (a push replaces the store\u2019s set). A file with an error against the store specs is refused with `422 spec_errors` and the fixes that apply. Bytes are kept by this server until the set is unstaged. Nothing is written to a store or a repository. Audited with blob ids only.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, bodyLimit: 8 * 1024 * 1024, query: z.object({ locale: z.string().min(2).max(35), kind: z.string().describe('screenshot, icon, feature_graphic, promo_graphic or tv_banner.'), device: z.string().max(60).optional().describe('Required for screenshot: a display id (iphone_6_9) or a Play device (phone).'), mode: z.string().optional().describe('`add` (default) or `replace`.'), position: z.string().optional().describe('1-based: the file to replace, or where to insert.'), name: z.string().max(200).optional(), fix: z.string().optional().describe('`remove_alpha`, `rename_extension` or `resize`: correct the file before it is checked and staged (send a refused file again with the fix the `spec_errors` answer offered).'), background: z.string().optional().describe('`#rrggbb` for `remove_alpha`, default white.') }), responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema, position: z.number() }) } } },
  { id: 'removeStagedAssetFile', method: 'delete', path: `${W}/apps/{id}/staged/assets/file`, tags: ['staged-changes'], summary: 'Take one file out of a staged set', description: 'The set is composed as for an upload. A push replaces the store\u2019s set with the files that remain; the last file cannot be removed (`422 empty_set`): a push cannot clear a set.', risk: 'destructive', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ locale: z.string().min(2).max(35), kind: z.string().describe('screenshot, icon, feature_graphic, promo_graphic or tv_banner.'), device: z.string().max(60).optional().describe('Required for screenshot: a display id (iphone_6_9) or a Play device (phone).'), position: z.string().describe('1-based.') }), responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'fixStagedAssetFile', method: 'post', path: `${W}/apps/{id}/staged/assets/fix`, tags: ['staged-changes'], summary: 'Stage a corrected copy of a file of a set (remove the alpha channel, rename, resize)', description: 'Never changes a file in place: the corrected bytes are kept by this server and replace the file in the staged set, to be previewed like an upload. `remove_alpha` flattens onto a background colour (default white); only 8 bit, non-interlaced PNG files are changed (`422 fix_unsupported` says why otherwise). `resize` is PNG only, to the nearest size the store requires. `422 fix_no_target_size` states what is required.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, body: z.object({ locale: z.string().min(2).max(35), kind: z.string(), device: z.string().max(60).nullable().optional(), position: z.number().int().min(1), fix: z.enum(['remove_alpha', 'rename_extension', 'resize']), background: z.string().max(9).optional().describe('`#rrggbb`, default white.') }), responses: { '200': { description: 'The staged changes and one sentence on what was done.', schema: z.object({ staged: stagedChangesSchema, summary: z.string() }) } } },
  { id: 'getStagedAssetBlob', method: 'get', path: `${W}/apps/{id}/staged/assets/blob`, tags: ['staged-changes'], summary: 'An image that was uploaded or fixed here', description: 'Only the bytes this server keeps for the app, by git blob id. Same safe image headers as the asset file route; `ETag` is the blob id.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ oid: z.string().describe('The blob id (`oid` of a staged file with `upload: true`).') }), responses: { '200': { description: 'The image.', contentType: 'image/png' }, '304': { description: 'Not modified.' } } },
  { id: 'stagedAssetsToRepo', method: 'post', path: `${W}/apps/{id}/staged/assets/to-repo`, tags: ['staged-changes'], summary: 'Draft a change set that puts staged graphics sets into the repository', description: 'Each repository set becomes exactly the staged one (files the staged set no longer holds are deleted; files already right are untouched). Nothing is applied: the draft is reviewed, approved and applied like any change set. Needs `changesets.write`.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, partial: true, body: z.object({ sets: z.array(z.string()).max(200).optional().describe('Set ids `locale/slotKey`; default every staged set.') }), bodyOptional: true, responses: { '200': { description: 'The change set (null when the repository already has the sets) and what was skipped.', schema: object } } },

  { id: 'refreshListingFromRepo', method: 'post', path: `${W}/apps/{id}/listing/repo-refresh`, tags: ['listing'], summary: 'Read the listing from the connected repository again', description: 'Reads GitHub; writes only to this server’s database.', risk: 'write', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The refreshed listing.', schema: object } } },
  { id: 'pullStoreListing', method: 'post', path: `${W}/apps/{id}/listing/pull`, tags: ['listing'], summary: 'Draft a change set from the live store listing', description: 'Applies the store\u2019s values to the repository\u2019s own listing files as a draft change set. Reads GitHub (and the store with `refresh`); writes nothing to a store or to the repository: the draft is reviewed, approved and applied like any change set. Needs `changesets.write` and `listing.read`; `refresh` also needs `apps.sync`.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: pullListingBody, partial: true, responses: { '200': { description: 'Nothing to pull: `changeSet` is null and `explanation` says why.', schema: object }, '201': { description: 'The draft, what changes, what was skipped and why.', schema: z.object({ changeSet: changeSetSchema, changes: z.array(object), skipped: z.array(object), problems: z.array(object), warnings: z.array(z.string()) }) } } },

  // ----- CI workflows and builds ----------------------------------------------------------------
  { id: 'listWorkflows', method: 'get', path: `${W}/repositories/{id}/workflows`, tags: ['ci'], summary: 'GitHub Actions workflows of a repository', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Workflows.', schema: object } } },
  { id: 'listWorkflowRuns', method: 'get', path: `${W}/repositories/{id}/workflows/runs`, tags: ['ci'], summary: 'Recent workflow runs', description: 'Each run has `appId` (the first app, kept for older clients) and `appIds` (every app the run builds; empty: it was not started for an app and counts for every app of the repository). With `appId` the list keeps the runs that count for that app.', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ limit: z.number().int().min(1).max(100).optional(), workflow: z.string().optional(), branch: z.string().optional(), refresh: z.enum(['true']).optional(), active: z.enum(['true']).optional(), appId: z.string().optional() }), partial: true, responses: { '200': { description: 'Runs.', schema: object } } },
  { id: 'getWorkflowRun', method: 'get', path: `${W}/repositories/{id}/workflows/runs/{runId}`, tags: ['ci'], summary: 'A workflow run', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ refresh: z.enum(['true']).optional() }), partial: true, responses: { '200': { description: 'The run.', schema: object } } },
  { id: 'listActiveWorkflowRuns', method: 'get', path: `${W}/ci/runs/active`, tags: ['ci'], summary: 'Workflow runs going now across the repositories, and those finished in the last 24 hours', description: 'Stored runs for everybody who may read repositories; a member or admin also refreshes them from GitHub first (conditional reads, cached for seconds, shared with the run sync). `problems` lists repositories GitHub could not be read for, with a fixed reason, so a client can show a quiet pill instead of an error. Rate limited per workspace. A token limited to some apps sees only the runs of those apps\u2019 repositories that belong to no app or to one of them (the filtering is done here, not by the app list).', risk: 'read', access: { action: 'repositories.read' }, appScope: { kind: 'list' }, rateLimited: true, query: z.object({ repositoryId: z.string().optional().describe('Only these repositories, comma separated (at most 50).'), appId: z.string().optional().describe('Only the runs that count for this app: those started for it (alone or with other apps) and those not started for an app, which count for every app of the repository.') }), responses: { '200': { description: 'Runs going, recent runs, the repositories covered and the problems.', schema: z.object({ runs: z.array(object), recent: z.array(object), repositories: z.array(z.object({ id: z.string(), owner: z.string(), repo: z.string() })), problems: z.array(z.object({ repositoryId: z.string(), reason: z.enum(['no_access', 'rate_limited', 'unavailable', 'unsupported']) })), refreshedAt: timestamp.nullable(), live: z.boolean(), cached: z.boolean() }) } } },
  { id: 'listWorkflowRunJobs', method: 'get', path: `${W}/repositories/{id}/workflows/runs/{runId}/jobs`, tags: ['ci'], summary: 'The jobs and steps of a workflow run (names, states and times; never logs)', description: 'A member or admin reads GitHub (kept 10 seconds while the run is going); a viewer sees what was read lately, possibly nothing (`live: false`).', risk: 'read', access: { action: 'repositories.read' }, responses: { '200': { description: 'The jobs with their steps.', schema: z.object({ runId: z.string(), jobs: z.array(object), truncated: z.boolean(), readAt: timestamp.nullable(), cached: z.boolean(), live: z.boolean() }) } } },
  { id: 'getWorkflowInputs', method: 'get', path: `${W}/repositories/{id}/workflows/{workflow}/inputs`, tags: ['ci'], summary: 'The inputs a workflow accepts', risk: 'read', access: { action: 'repositories.scan' }, query: z.object({ ref: z.string().optional() }), partial: true, responses: { '200': { description: 'The inputs.', schema: object } } },
  { id: 'dispatchWorkflow', method: 'post', path: `${W}/repositories/{id}/workflows/{workflow}/dispatches`, tags: ['ci'], summary: 'Start a workflow run', description: 'Runs a workflow on GitHub. It can ship a build: assistants should ask a person first. Body: `ref`, `inputs`, and the app or apps the run builds: `appId` (one) and/or `appIds` (several apps that share the repository; each must be linked to it, `422 app_not_found` / `app_repository_mismatch`).', risk: 'write', access: { action: 'ci.dispatch' }, body: object, partial: true, responses: { '202': { description: 'The dispatch was accepted.', schema: z.object({ dispatched: z.boolean(), runKnown: z.boolean(), run: object.nullable() }) } } },
  { id: 'listBuilds', method: 'get', path: `${W}/apps/{id}/builds`, tags: ['ci'], summary: 'Builds of an app and the runs linked to them', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'Builds.', schema: object } } },
  { id: 'getBuildChanges', method: 'get', path: `${W}/apps/{id}/builds/changes`, tags: ['ci'], summary: 'Commits between two builds', risk: 'read', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ platform: z.enum(PLATFORMS), build: z.string(), base: z.string().optional() }), partial: true, responses: { '200': { description: 'The changes.', schema: object } } },
  { id: 'linkBuild', method: 'put', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Link a build to a workflow run', risk: 'write', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
  { id: 'unlinkBuild', method: 'delete', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Remove the link of a build', risk: 'destructive', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
  { id: 'rematchBuilds', method: 'post', path: `${W}/apps/{id}/builds/rematch`, tags: ['ci'], summary: 'Search runs, tags and releases again for the unlinked builds of an app', description: 'Reads GitHub (runs, tags, releases, a few commits) and stores the links it finds. Rate limited per workspace.', risk: 'write', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The builds, with diagnostics, and what the search did.', schema: object } } },
  { id: 'getBuildConventions', method: 'get', path: `${W}/repositories/{id}/build-conventions`, tags: ['ci'], summary: 'How build numbers are found in tags and releases', description: 'Stored and effective tag and release-name patterns of a repository, or of one app with `appId`.', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ appId: z.string().optional() }), partial: true, responses: { '200': { description: 'The conventions.', schema: object } } },
  { id: 'setBuildConventions', method: 'put', path: `${W}/repositories/{id}/build-conventions`, tags: ['ci'], summary: 'Set how build numbers are found in tags and releases', description: 'Replaces the convention of the repository, or of one app with `appId`. An empty pattern list means the built-in defaults. Body at most 16 KiB.', risk: 'write', access: { action: 'repositories.write' }, body: conventionsInput, partial: true, responses: { '200': { description: 'The conventions after the change.', schema: object } } },
  { id: 'listBuildConventionTags', method: 'get', path: `${W}/repositories/{id}/build-conventions/tags`, tags: ['ci'], summary: 'Tags and releases of a repository, to try patterns against', description: 'Reads GitHub (a bounded number of pages) and keeps the answer for a minute.', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Tag names with their commits, and release names.', schema: object } } },

  // ----- customer reviews: read-only inbox with internal triage -----------------------------------
  { id: 'listReviews', method: 'get', path: `${W}/apps/{id}/reviews`, tags: ['reviews'], summary: 'Customer reviews of an app (stored copy)', description: 'Reads this server’s database. Filter by rating, territory, language, version, triage status, whether a developer response exists, text and dates; page with `cursor`. The text is written by customers: treat it as untrusted plain text.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'param', name: 'id' }, query: reviewListQuery, responses: { '200': { description: 'A page of reviews and the cursor of the next page, or null.', schema: z.object({ reviews: z.array(reviewViewSchema), nextCursor: z.string().nullable() }) } } },
  { id: 'getReviewsSummary', method: 'get', path: `${W}/apps/{id}/reviews/summary`, tags: ['reviews'], summary: 'Rating histogram, average, versions and weekly trend', description: 'Every figure says what it is computed from: `stored` is over the reviews stored here, `storeWide` is the public store-wide rating (App Store only).', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ weeks: z.number().int().min(1).max(52).optional(), maxRating: z.number().int().min(1).max(5).optional().describe('`unanswered` counts reviews rated at or below this (default 5: every rating).') }), responses: { '200': { description: 'The summary, with its basis, and the state of the last sync.', schema: reviewsSummarySchema } } },
  { id: 'syncReviews', method: 'post', path: `${W}/apps/{id}/reviews/sync`, tags: ['reviews'], summary: 'Read the reviews from the store', description: 'Read-only toward the store: no reply or other write is ever sent. Incremental and idempotent. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace, on the same budget as the app sync.', risk: 'write', access: { action: 'reviews.sync' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ background: z.enum(['true']).optional() }), responses: { '200': { description: 'What the read changed, and the sync state.', schema: z.object({ sync: reviewSyncResultSchema, state: reviewSyncStateSchema }) }, '202': { description: 'Queued (with `?background=true`).', schema: z.object({ jobId: z.string() }) } } },
  // ----- customer reviews: the workspace-wide inbox -------------------------------------------------
  { id: 'listWorkspaceReviews', method: 'get', path: `${W}/reviews`, tags: ['reviews'], summary: 'The reviews of every app in one inbox (stored copy)', description: 'Reads this server\u2019s database. The filters of the per app list, plus `appIds`, `assignee` (`me` or a user id), `unassigned` and `unanswered`; keyset paging with `cursor`. Every item carries its app. A token limited to some apps sees only those apps. The text is written by customers: untrusted plain text.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'list' }, query: inboxQuery, responses: { '200': { description: 'A page of reviews and the cursor of the next page, or null.', schema: z.object({ reviews: z.array(inboxReviewSchema), nextCursor: z.string().nullable() }) } } },
  { id: 'getWorkspaceReviewsSummary', method: 'get', path: `${W}/reviews/summary`, tags: ['reviews'], summary: 'Counts of new, unanswered and low rated reviews per app and in total', description: 'Over the stored reviews only, with its basis stated. No review text and no names. A token limited to some apps counts only those apps.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'list' }, query: z.object({ maxRating: z.number().int().min(1).max(5).optional().describe('`unanswered` and `unansweredOldestAt` count reviews rated at or below this (default 5: every rating, the numbers older clients know).') }), responses: { '200': { description: 'Counts per app and the totals.', schema: workspaceSummarySchema } } },

  // ----- replying to reviews (a store write; off unless MRM_REVIEW_REPLY_ENABLED=true) --------------
  { id: 'getReviewReplyConfig', method: 'get', path: `${W}/reviews/reply-config`, tags: ['reviews'], summary: 'Whether replying is switched on, and its limits', risk: 'read', access: { action: 'reviews.read' }, responses: { '200': { description: 'The switch, the limits and what is available.', schema: replyConfigSchema } } },
  { id: 'listReviewReplyTemplates', method: 'get', path: `${W}/reviews/reply-templates`, tags: ['reviews'], summary: 'Reply templates of the workspace', risk: 'read', access: { action: 'reviews.read' }, responses: { '200': { description: 'The templates.', schema: z.object({ templates: z.array(replyTemplateSchema) }) } } },
  { id: 'createReviewReplyTemplate', method: 'post', path: `${W}/reviews/reply-templates`, tags: ['reviews'], summary: 'Create a reply template', description: 'At most 50 per workspace. `409 reply_disabled` while replying is switched off.', risk: 'write', access: { action: 'reviews.triage' }, body: replyTemplateBody, responses: { '201': { description: 'The template.', schema: z.object({ template: replyTemplateSchema }) } } },
  { id: 'updateReviewReplyTemplate', method: 'put', path: `${W}/reviews/reply-templates/{templateId}`, tags: ['reviews'], summary: 'Replace a reply template', risk: 'write', access: { action: 'reviews.triage' }, body: replyTemplateBody, responses: { '200': { description: 'The template.', schema: z.object({ template: replyTemplateSchema }) } } },
  { id: 'deleteReviewReplyTemplate', method: 'delete', path: `${W}/reviews/reply-templates/{templateId}`, tags: ['reviews'], summary: 'Delete a reply template', risk: 'destructive', access: { action: 'reviews.triage' }, responses: { '204': none } },
  { id: 'getReview', method: 'get', path: `${W}/apps/{id}/reviews/{reviewId}`, tags: ['reviews'], summary: 'One review with its reply draft and reply state', description: 'Reads this server\u2019s database.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The review.', schema: z.object({ review: reviewViewSchema }) } } },
  { id: 'saveReviewReplyDraft', method: 'put', path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft`, tags: ['reviews'], summary: 'Write or replace the draft reply of a review', description: 'Nothing is sent to a store. Needs `reviews.triage`. One draft per review; saving over a sent reply makes it a draft again. Refused while a send is in progress or its outcome is unknown. `409 reply_disabled` while replying is switched off. Audited by length and hash, never by text.', risk: 'write', access: { action: 'reviews.triage' }, appScope: { kind: 'param', name: 'id' }, body: replyDraftBody, responses: { '200': { description: 'The draft.', schema: z.object({ draft: replyDraftSchema }) } } },
  { id: 'deleteReviewReplyDraft', method: 'delete', path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft`, tags: ['reviews'], summary: 'Delete the draft reply of a review', description: 'Removes only this server\u2019s draft (or its record of a sent reply); a published reply stays in the store.', risk: 'destructive', access: { action: 'reviews.triage' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'translateReviewReplyDraft', method: 'post', path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft/translate`, tags: ['reviews'], summary: 'Suggest a translation of a draft', description: 'Only when translation is set up (`translation.available` in the reply config), else `409 translation_unavailable`. Returns text; nothing is saved or sent.', risk: 'read', access: { action: 'reviews.triage' }, appScope: { kind: 'param', name: 'id' }, body: replyTranslateBody, responses: { '200': { description: 'The suggested text.', schema: z.object({ text: z.string() }) } } },
  { id: 'sendReviewReply', method: 'post', path: `${W}/apps/{id}/reviews/{reviewId}/reply`, tags: ['reviews'], summary: 'Publish the draft reply in the store (public, not recallable here)', description: 'A STORE WRITE: the text is published publicly in the App Store or Google Play in the organisation\u2019s name. Needs `reviews.reply` (owner and admin; a token only when its actions name it) and `MRM_REVIEW_REPLY_ENABLED=true`. `confirmHash` must be the hash of the current draft (`409 stale_draft` otherwise); a second send of the same text is `409 already_sent`; one send per review at a time (`409 send_in_progress`); 30 an hour per workspace (`429 rate_limited`). Never retried: a timeout is checked by reading the review back and the answer is `200` with the settled state, `409 outcome_unknown`, or `502 send_failed` with the draft kept. Audited as `review.reply_sent` / `review.reply_failed` (ids, store, length, hash: never the text) and emitted as the event `review.reply_sent`.', risk: 'destructive', access: { action: 'reviews.reply' }, appScope: { kind: 'param', name: 'id' }, body: replySendBody, responses: { '200': { description: 'The reply as settled and the refreshed review.', schema: z.object({ reply: replyDraftSchema, review: reviewViewSchema, confirmedByReread: z.boolean().describe('True when the send\u2019s outcome was unknown and reading the review back showed the reply.') }) } } },
  // ----- workspace settings -------------------------------------------------------------------------
  { id: 'getWorkspaceSettings', method: 'get', path: `${W}/settings`, tags: ['settings'], summary: 'Workspace settings: values, defaults and which keys the caller may change', description: 'A fixed list of keys (`reviews.lowRatingThreshold`, `translation.*`). Secrets are never settings: provider keys live in the credential vault. `translation` adds today\u2019s usage against the daily budget.', risk: 'read', access: { action: 'settings.read' }, responses: { '200': { description: 'The settings.', schema: settingsSchema } } },
  { id: 'updateWorkspaceSettings', method: 'put', path: `${W}/settings`, tags: ['settings'], summary: 'Change workspace settings (partial)', description: 'Admin or owner. Send only the keys to change; `null` resets a key to its default. All or nothing: one invalid value changes nothing (`400 invalid_setting`); an unknown key is `400 unknown_setting`. Audited as `settings.update` with the key names and the old and new values.', risk: 'write', access: { action: 'settings.write' }, body: settingsBody, partial: true, responses: { '200': { description: 'The keys that changed, and the settings after the change.', schema: settingsBase.extend({ changed: z.array(z.string()) }) } } },
  // ----- ASO: keyword ranks and competitors (public store data; Google Play only when switched on) ----
  { id: 'getAsoConfig', method: 'get', path: `${W}/aso/config`, tags: ['aso'], summary: 'ASO: what is switched on, the limits and the Google Play warning', description: 'Apple is read through the documented iTunes Search API. Google Play has no official API: `play.enabled` is false unless the operator set MRM_ASO_PLAY_UNOFFICIAL_ENABLED=true, and `play.notice` is the warning about its terms of service. Admins and owners hold `aso.manage`.', risk: 'read', access: { action: 'aso.read' }, responses: { '200': { description: 'The switches, the schedule, the retention and the limits.', schema: z.object({ apple: z.object({ enabled: z.boolean(), source: z.string(), documentedCallsPerMinute: z.number().int() }), play: z.object({ enabled: z.boolean(), unofficial: z.boolean(), notice: z.string(), howToEnable: z.string() }), schedule: z.object({ intervalMinutes: z.number().int().describe('0: scheduled refreshes are off.') }), retentionDays: z.number().int().describe('0: kept for ever.'), limits: z.object({ maxKeywordsPerApp: z.number().int(), maxCompetitorsPerApp: z.number().int(), maxChecksPerRun: z.number().int(), rankDepth: z.number().int(), maxKeywordsPerRequest: z.number().int() }), rankMoveThreshold: z.number().int().describe('The workspace setting `aso.rankMoveThreshold`.') }) } } },
  { id: 'getAsoSummary', method: 'get', path: `${W}/apps/{id}/aso/summary`, tags: ['aso'], summary: 'ASO overview of an app: keyword counts, biggest moves, competitors, refresh state', description: asoNote + 'The state says when the app was last refreshed and why a refresh failed.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The overview.', schema: asoSummarySchema } } },
  { id: 'listAsoKeywords', method: 'get', path: `${W}/apps/{id}/aso/keywords`, tags: ['aso'], summary: 'The tracked keywords of an app with their latest rank', description: asoNote + 'Filter by `country`, `locale` and `tag`. The same term in two storefronts is two keywords (see `getAsoMarkets` for one row per term).', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ country: z.string().optional(), locale: z.string().optional(), tag: z.string().optional() }), responses: { '200': { description: 'The keywords and the limit.', schema: z.object({ keywords: z.array(asoKeywordSchema), limits: z.object({ maxKeywordsPerApp: z.number().int() }) }) } } },
  { id: 'addAsoKeywords', method: 'post', path: `${W}/apps/{id}/aso/keywords`, tags: ['aso'], summary: 'Track keywords (up to 50 at once)', description: 'Each item is judged on its own: a bad, duplicate or over-the-limit item does not stop the others. `country` defaults to `us`, `locale` to the storefront’s main language. A keyword is never checked here (no store is contacted); the next refresh does it. Audited with ids and a count, never the terms. `201` when at least one was created, else `200`.', risk: 'write', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, body: addKeywordsBody, bodyLimit: 64 * 1024, responses: { '200': { description: 'Nothing was created: every item exists, is invalid or hit the limit.', schema: z.object({ results: z.array(asoKeywordResultSchema), summary: z.object({ created: z.number().int(), exists: z.number().int(), invalid: z.number().int(), limit: z.number().int() }) }) }, '201': { description: 'At least one keyword was created.', schema: z.object({ results: z.array(asoKeywordResultSchema), summary: z.object({ created: z.number().int(), exists: z.number().int(), invalid: z.number().int(), limit: z.number().int() }) }) } } },
  { id: 'updateAsoKeyword', method: 'patch', path: `${W}/apps/{id}/aso/keywords/{keywordId}`, tags: ['aso'], summary: 'Change the tag, notes or priority of a keyword', description: 'The term, country and locale cannot change: track a new keyword instead. Null or empty clears a tag or a note.', risk: 'write', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, body: updateKeywordBody, responses: { '200': { description: 'The keyword.', schema: z.object({ keyword: asoKeywordSchema }) } } },
  { id: 'deleteAsoKeyword', method: 'delete', path: `${W}/apps/{id}/aso/keywords/{keywordId}`, tags: ['aso'], summary: 'Stop tracking a keyword and delete its checks', risk: 'destructive', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'getAsoKeywordHistory', method: 'get', path: `${W}/apps/{id}/aso/keywords/{keywordId}/history`, tags: ['aso'], summary: 'The rank checks of a keyword over time, with the trend', description: asoNote + 'Oldest first (the newest `limit`). A check with `rank: null` means the app was not within the first `total` results. Only successful checks are stored; a failed attempt leaves no row.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ limit: z.number().int().min(1).max(1000).optional(), since: z.number().int().optional().describe('Epoch milliseconds.') }), responses: { '200': { description: 'The keyword, its checks and the trend.', schema: z.object({ keyword: asoKeywordSchema, checks: z.array(z.object({ id: z.string(), checkedAt: timestamp, rank: z.number().int().nullable(), total: z.number().int(), source: z.string() })), trend: z.object({ direction: z.enum(['up', 'down', 'flat', 'unknown']), delta: z.number().int().nullable(), latest: z.number().int().nullable(), best: z.number().int().nullable(), worst: z.number().int().nullable(), samples: z.number().int() }) }) } } },
  { id: 'listAsoCompetitors', method: 'get', path: `${W}/apps/{id}/aso/competitors`, tags: ['aso'], summary: 'The followed competitors with their latest public snapshot', description: asoNote, risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The competitors and the limit.', schema: z.object({ competitors: z.array(asoCompetitorSchema), limits: z.object({ maxCompetitorsPerApp: z.number().int() }) }) } } },
  { id: 'addAsoCompetitor', method: 'post', path: `${W}/apps/{id}/aso/competitors`, tags: ['aso'], summary: 'Follow an app of the store as a competitor', description: 'READS THE PUBLIC STORE once (a lookup) so the name is real and the first snapshot exists. `externalId` is the numeric App Store id (also `id123` or an apps.apple.com address) or the Android package name (also a play.google.com address). `409 play_unofficial_disabled` for an Android app while Google Play reading is off. Rate limited per workspace.', risk: 'write', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, body: addCompetitorBody, responses: { '201': { description: 'The competitor, with its first snapshot.', schema: z.object({ competitor: asoCompetitorSchema }) } } },
  { id: 'deleteAsoCompetitor', method: 'delete', path: `${W}/apps/{id}/aso/competitors/{competitorId}`, tags: ['aso'], summary: 'Stop following a competitor and delete its snapshots', risk: 'destructive', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '204': none } },
  { id: 'getAsoCompetitorHistory', method: 'get', path: `${W}/apps/{id}/aso/competitors/{competitorId}/history`, tags: ['aso'], summary: 'The stored snapshots of a competitor and its latest change', description: asoNote + 'Newest first. A snapshot is stored on the first look, when something changed, and as a heartbeat. `diff` is the newest snapshot that recorded changes, with the one before it.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ limit: z.number().int().min(1).max(500).optional() }), responses: { '200': { description: 'The competitor, its snapshots and the latest change.', schema: z.object({ competitor: asoCompetitorSchema, snapshots: z.array(asoSnapshotSchema), diff: z.object({ from: z.string().nullable(), to: z.string(), at: timestamp, changes: z.array(asoChangeSchema) }).nullable() }) } } },
  { id: 'getAsoCoach', method: 'get', path: `${W}/apps/{id}/aso/coach`, tags: ['aso'], summary: 'Ranked next steps for the ASO of an app', description: asoNote + 'Up to 8 steps in a fixed order of importance (track keywords, check ranks, ranks that dropped, tracked keywords missing from the listing, competitors ranking above the app, keyword field waste, unused characters, locales with no keyword text, follow a competitor). Every number is a count taken from stored data; there is no search volume or predicted gain. `link.to` names the ASO view or the listing to open. Facts about how a store indexes text are UNVERIFIED and say so in `detail`.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The steps and what they were worked out from.', schema: z.object({ actions: z.array(z.object({ id: z.string(), kind: z.enum(['track_keywords', 'check_ranks', 'rank_dropped', 'not_in_listing', 'competitor_above', 'keyword_field_waste', 'unused_characters', 'untapped_locale', 'follow_competitors']), position: z.number().int().describe('1 is first.'), title: z.string(), detail: z.string(), items: z.array(z.string()).describe('At most 5 short lines.'), more: z.number().int(), link: z.object({ to: z.enum(['keywords', 'keywords_add', 'competitors', 'fit', 'ideas', 'listing']), locale: z.string().optional(), label: z.string() }) })), basedOn: z.object({ keywords: z.number().int(), competitors: z.number().int(), listingLocales: z.number().int(), lastCheckAt: timestamp.nullable(), listingReadAt: timestamp.nullable() }) }) } } },
  { id: 'getAsoFit', method: 'get', path: `${W}/apps/{id}/aso/fit`, tags: ['aso'], summary: 'How well the live listing covers the tracked keywords', description: asoNote + 'Per locale of the tracked keywords, against the stored live listing (sync the app first). `status` is strong, covered, partial, description_only (iOS: only in the description, which the store may not search) or missing. `indexedFields` and `assumptions` say which fields count: these are UNVERIFIED against the stores’ own documentation. For iOS the hidden keyword field is measured against its 100 byte budget (`keywordField`).', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ locale: z.string().optional() }), partial: true, responses: { '200': { description: 'Fit per locale.', schema: z.object({ readAt: timestamp.nullable().describe('When the listing was last read from the store.'), error: z.string().nullable(), locales: z.array(z.object({ locale: z.string(), listingLocale: z.string().nullable(), channel: z.enum(['live', 'editable']).nullable(), keywords: z.number().int(), fit: object.nullable(), fields: object.nullable().describe('The stored listing text the fit was worked out from (title, subtitle, keywords, shortDescription, description).') })), indexedFields: z.array(z.string()), listingLocales: z.array(z.string()).describe('Every locale the stored listing has text for (not only the tracked ones).'), assumptions: z.array(z.string()) }) } } },
  { id: 'getAsoIdeas', method: 'get', path: `${W}/apps/{id}/aso/ideas`, tags: ['aso'], summary: 'Keyword ideas mined from the own listing and the followed competitors', description: asoNote + 'Phrases that occur often in those stored texts and are not tracked yet. `localScore` is a frequency in the texts, NOT a search volume or a popularity: no free store source publishes one. Suggestions only; nothing is tracked until a person adds it.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: asoLocaleQuery, partial: true, responses: { '200': { description: 'The ideas and what they are based on.', schema: z.object({ locale: z.string(), basedOn: z.object({ ownListing: z.boolean(), competitors: z.number().int() }), ideas: z.array(z.object({ term: z.string(), words: z.number().int(), occurrences: z.number().int(), sources: z.number().int(), localScore: z.number() })), notes: z.array(z.string()) }) } } },
  { id: 'getAsoGaps', method: 'get', path: `${W}/apps/{id}/aso/gaps`, tags: ['aso'], summary: 'Terms competitors use that the own listing does not have', description: asoNote + 'Tracked keywords the listing covers badly, and phrases mined from the competitors’ names and subtitles, ordered by how many competitors use them. A suggestion, not advice.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: asoLocaleQuery, partial: true, responses: { '200': { description: 'The gaps.', schema: z.object({ locale: z.string(), competitors: z.number().int(), gaps: z.array(object), notes: z.array(z.string()) }) } } },
  { id: 'getAsoSuggestions', method: 'get', path: `${W}/apps/{id}/aso/suggestions`, tags: ['aso'], summary: 'Apps that rank for several of your keywords: competitors to consider', description: asoNote + 'From the stored top results of the latest check of each keyword, per country, without the own app and the ones already followed. Nothing is followed until a person calls `addAsoCompetitor`.', risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ minKeywords: z.number().int().min(1).max(50).optional().describe('Default 2.'), limit: z.number().int().min(1).max(50).optional() }), partial: true, responses: { '200': { description: 'The suggestions.', schema: z.object({ suggestions: z.array(z.object({ externalId: z.string(), country: z.string(), name: z.string().nullable(), keywordCount: z.number().int(), bestRank: z.number().int(), averageRank: z.number(), keywordIds: z.array(z.string()) })), basedOnKeywords: z.number().int(), notes: z.array(z.string()) }) } } },
  { id: 'getAsoMarkets', method: 'get', path: `${W}/apps/{id}/aso/markets`, tags: ['aso'], summary: 'The same term in each tracked country and locale as one row', description: asoNote, risk: 'read', access: { action: 'aso.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'One row per term.', schema: z.object({ terms: z.array(z.object({ key: z.string(), term: z.string(), bestRank: z.number().int().nullable(), markets: z.array(z.object({ country: z.string(), locale: z.string(), id: z.string(), rank: z.number().int().nullable(), state: z.enum(['ranked', 'not_ranked', 'unavailable']).nullable(), checkedAt: timestamp.nullable() })) })) }) } } },
  { id: 'refreshAso', method: 'post', path: `${W}/apps/{id}/aso/refresh`, tags: ['aso'], summary: 'Check the keyword ranks and competitors of an app now', description: 'READS THE PUBLIC STORE (Apple: the iTunes Search API; Google Play: its public pages, only when switched on, `409 play_unofficial_disabled` otherwise). Read-only toward the stores. At most MRM_ASO_MAX_CHECKS_PER_RUN keywords per run, the oldest first; the rest stays due (`result.deferred`). Stops early when a store says to slow down, is unavailable or fails repeatedly; an unavailable store is never recorded as "not ranked". `429` carries `Retry-After`; `409 refresh_in_progress` while another refresh of the app holds the claim. `?background=true` queues it and answers `202` with `jobId`. Rate limited per workspace.', risk: 'write', access: { action: 'aso.write' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: asoBackgroundQuery, responses: { '200': { description: 'What the refresh did, and the state.', schema: z.object({ result: asoRefreshResultSchema, state: asoStateSchema }) }, '202': { description: 'Queued (with `?background=true`).', schema: z.object({ jobId: z.string() }) } } },
  { id: 'refreshAsoAll', method: 'post', path: `${W}/aso/refresh`, tags: ['aso'], summary: 'Queue an ASO refresh of every app that has keywords or competitors', description: 'Admin or owner: it spends the stores’ goodwill on all apps at once. Queues at most 25 jobs, spaced 20 seconds apart; apps with a refresh already queued, Google Play apps while that is switched off and iOS apps that were never synced are skipped. Always `202`. Rate limited per workspace.', risk: 'write', access: { action: 'aso.manage' }, rateLimited: true, responses: { '202': { description: 'How many were queued, and why others were not.', schema: z.object({ queued: z.number().int(), skipped: z.object({ alreadyQueued: z.number().int(), notReady: z.number().int(), playOff: z.number().int(), capped: z.number().int() }) }) } } },
  // ----- translating reviews (a text is sent to the provider the workspace chose) --------------------
  { id: 'translateReviews', method: 'post', path: `${W}/apps/{id}/reviews/translate`, tags: ['reviews'], summary: 'Translate stored reviews', description: 'Sends the text of up to 25 stored reviews to the translation provider set in the workspace settings (`translation.provider`; Google by default) and keeps the translations, so a second request is served from the cache. Needs `translation.enabled`; otherwise `422 translation_not_configured`. Errors: `422 translation_auth`, `translation_quota`, `translation_unsupported_language`, `429 translation_rate_limited` (with `Retry-After`), `429 translation_budget` (the daily character budget), `502`/`504 translation_unavailable`. Rate limited per workspace. Review text is never logged or audited; the audit entry `review.translate` has counts and the provider only.', risk: 'write', access: { action: 'reviews.translate' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, body: translateReviewsBody, responses: { '200': { description: 'One entry per found review.', schema: z.object({ provider: z.enum(translationProviders), target: z.string(), translations: z.array(reviewTranslationSchema), notFound: z.array(z.string()), cached: z.boolean().describe('Every review was served from the cache.') }) } } },
  { id: 'testTranslation', method: 'post', path: `${W}/translate/test`, tags: ['settings'], summary: 'Test the translation provider with the saved settings', description: 'Translates one fixed word (not review text) with the saved provider, credential and address. Counts nothing against the budget. The answer is `ok` or a fixed sentence; it never echoes a key or a provider message. Rate limited per workspace.', risk: 'read', access: { action: 'settings.write' }, rateLimited: true, responses: { '200': { description: 'The outcome.', schema: z.object({ ok: z.boolean(), message: z.string(), provider: z.enum(translationProviders).optional(), reason: z.string().optional() }) } } },
  { id: 'triageReview', method: 'patch', path: `${W}/apps/{id}/reviews/{reviewId}`, tags: ['reviews'], summary: 'Set the triage status, assignee or internal note of a review', description: 'Internal only: it changes this server’s database and nothing in a store (replying is `sendReviewReply`, a separate right). Audited without the note or the review text.', risk: 'write', access: { action: 'reviews.triage' }, appScope: { kind: 'param', name: 'id' }, body: triageReviewBody, responses: { '200': { description: 'The review.', schema: z.object({ review: reviewSchema }) } } },
  // ----- changing a live rollout in a store (a store write; off unless MRM_STORE_ROLLOUT_ENABLED=true) ---
  { id: 'getRolloutConfig', method: 'get', path: `${W}/rollout/config`, tags: ['rollout'], summary: 'Whether changing a store rollout is switched on, and what can be done', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch and the actions per platform.', schema: rolloutConfigSchema } } },
  { id: 'getRolloutState', method: 'get', path: `${W}/apps/{id}/rollout/state`, tags: ['rollout'], summary: 'Read where a release stands in the store, and what may be done from there', description: 'READS THE STORE (Google Play opens and deletes an edit, which invalidates other open edits of the same service account). Changes nothing. Needs `releases.rollout` and `MRM_STORE_ROLLOUT_ENABLED=true` (`409 rollout_disabled` otherwise). Google Play: `track` and `versionCodes` (comma separated); App Store: `version`.', risk: 'read', access: { action: 'releases.rollout' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ track: z.string().optional(), versionCodes: z.string().optional().describe('Comma separated version codes.'), version: z.string().optional() }), responses: { '200': { description: 'The live state and the allowed actions.', schema: rolloutStateViewSchema } } },
  { id: 'previewRollout', method: 'post', path: `${W}/apps/{id}/rollout/preview`, tags: ['rollout'], summary: 'Preview a rollout change: the live state, the proposed state and a confirmHash', description: 'READS THE STORE, writes nothing. Validates the request for the app’s platform (`422 invalid_rollout`), refuses a change the current state does not allow (`422 rollout_not_allowed`, with `current`), and returns `confirmHash`: a hash of the app, the release, the change and the state that was read. Google Play: the share only goes up (`not_an_increase` otherwise; halt is the way to stop); App Store: no un-release. Needs `releases.rollout` and `MRM_STORE_ROLLOUT_ENABLED=true`.', risk: 'read', access: { action: 'releases.rollout' }, appScope: { kind: 'param', name: 'id' }, body: rolloutPreviewBody, responses: { '200': { description: 'The preview.', schema: z.object({ preview: rolloutPreviewSchema }) } } },
  { id: 'applyRollout', method: 'post', path: `${W}/apps/{id}/rollout/apply`, tags: ['rollout'], summary: 'Change the live rollout in the store (what users receive; complete and release to all cannot be undone here)', description: 'A STORE WRITE. Needs `releases.rollout` (owner and admin; a token only when its actions name it) and `MRM_STORE_ROLLOUT_ENABLED=true`. `confirmHash` must come from a preview of exactly this request. The store is READ AGAIN right before the write: if its state is not the one previewed nothing is written (`409 state_changed`, with `current`, `proposed` and a new `confirmHash`). One write per app at a time (`409 write_in_progress`). Never retried: after a timeout or a 5xx the state is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), or `409 outcome_unknown` (then preview again). Google Play never cancels a review in progress (`409 changes_in_review`). Audited as `release.rollout_changed` / `release.rollout_failed` (ids and values, never a credential) and emitted as the event `release.rollout_changed`.', risk: 'destructive', access: { action: 'releases.rollout' }, appScope: { kind: 'param', name: 'id' }, body: rolloutApplyBody, responses: { '200': { description: 'The state before and after.', schema: z.object({ result: rolloutResultSchema }) } } },
  // ----- staged listing text and graphics, and writing them to a store as a draft ---------------------
  { id: 'getStoreDraftConfig', method: 'get', path: `${W}/store-draft/config`, tags: ['staged-changes'], summary: 'Whether writing store drafts is switched on, and the limits', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch, the limits, and that submitting is not implemented.', schema: draftConfigSchema } } },
  { id: 'getStagedChanges', method: 'get', path: `${W}/apps/{id}/staged`, tags: ['staged-changes'], summary: 'The staged listing text and graphics of an app, with limits and problems', description: 'Reads the database only: no store, no repository. Each item has `problems` from the listing limits and the asset specs and what a push needs; an item with an `error` blocks a push. `before` is the last value this tool stored from the store.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The staged changes.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'stageListingText', method: 'put', path: `${W}/apps/{id}/staged/text`, tags: ['staged-changes'], summary: 'Stage a listing text of one locale (nothing is written to a store)', description: 'Adds or replaces the staged value of one locale and field, taken from the repository snapshot (`from: repo`), the store snapshot (`from: store`) or typed (`from: local`, with `value`). The value is normalized (line breaks, trailing white space). `422 field_not_pushable` for a field a push cannot write (App Store name, subtitle and privacy policy URL), `422 empty_text`, `422 no_source_value`. Needs `changesets.write`. Audited as `staged.text_set` with a hash, never the text.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: stagedTextBody, responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'stageListingAssets', method: 'put', path: `${W}/apps/{id}/staged/assets`, tags: ['staged-changes'], summary: 'Stage a set of graphics of one locale and slot from the repository (nothing is written to a store)', description: 'Replaces the staged set of a locale and slot with files of the repository’s asset index (the Assets tab), kept by reference: path, commit and git blob id. A push makes the store’s set exactly these files, in this order. `422 slot_not_pushable` (App Store previews and app icon, Play promo graphic), `422 source_not_supported` (only `repo` here: pull store images into the repository with `pullStoreImages`, upload with `uploadStagedAsset`), `422 asset_not_pushable` (not PNG or JPEG, not opened, over 8 MiB), `422 too_many_files` / `too_many_bytes`. Needs `changesets.write`; the repository read costs like an Assets tab read (rate limited). Audited as `staged.assets_set` with blob ids.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: stagedAssetsBody, responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'unstageItem', method: 'delete', path: `${W}/apps/{id}/staged/items`, tags: ['staged-changes'], summary: 'Remove one staged text (its id) or one staged set (`locale/slotKey`)', risk: 'destructive', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ id: z.string().describe('The id of a staged text, or the `id` of a staged set (`en-US/screenshot:iphone_6_5`).') }), responses: { '200': { description: 'The staged changes after the removal.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'clearStagedChanges', method: 'delete', path: `${W}/apps/{id}/staged`, tags: ['staged-changes'], summary: 'Remove every staged item of an app', risk: 'destructive', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The (empty) staged changes.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'previewStagedPush', method: 'post', path: `${W}/apps/{id}/staged/push/preview`, tags: ['staged-changes'], summary: 'Preview pushing the staged changes to the store as a draft: per item before and after, and a confirmHash', description: 'READS THE STORE (the draft; Google Play opens and deletes an edit, which invalidates other open edits of the same service account) and the bytes of the staged files from the repository. Writes nothing. `422 nothing_staged`, `422 staged_invalid` (items with errors), `422 asset_changed`, `422 no_editable_version` (App Store: no version in Prepare for Submission). Needs `store.push_draft` and `MRM_STORE_DRAFT_WRITE_ENABLED=true` (`409 store_draft_disabled` otherwise).', risk: 'read', access: { action: 'store.push_draft' }, appScope: { kind: 'param', name: 'id' }, body: stagedPushPreviewBody, bodyOptional: true, responses: { '200': { description: 'The preview.', schema: z.object({ preview: draftPreviewSchema }) } } },
  { id: 'pushStagedDraft', method: 'post', path: `${W}/apps/{id}/staged/push`, tags: ['staged-changes'], summary: 'Write the staged changes to the store as a DRAFT (never submits, sends for review or publishes)', description: 'A STORE WRITE. Needs `store.push_draft` (owner and admin; a token only when its actions name it) and `MRM_STORE_DRAFT_WRITE_ENABLED=true`. `confirmHash` must come from a preview of the same staged items. The store’s draft is READ AGAIN right before the first write: if it is not the one previewed, or the staged items changed, nothing is written (`409 state_changed`, with a new `preview`). One write per app at a time (`409 write_in_progress`). App Store: the editable version’s localizations and screenshots change one request at a time (a refusal part way is `502 draft_partial`, with `completed` and `failed`). Google Play: one edit, committed with `changesNotSentForReview=true` (`409 draft_not_allowed` when Google refuses that, `409 changes_in_review` when changes are in review: nothing is committed). Never retried: after a timeout or a 5xx the draft is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), `409 draft_partial`, or `409 outcome_unknown` (then preview again). Audited as `listing.draft_pushed` / `listing.draft_push_failed` (ids, counts and hashes, never a text or a credential) and emitted as the event `listing.draft_pushed`.', risk: 'destructive', access: { action: 'store.push_draft' }, appScope: { kind: 'param', name: 'id' }, body: stagedPushBody, responses: { '200': { description: 'What was written.', schema: z.object({ result: draftResultSchema }) } } },
  { id: 'stageReleaseField', method: 'put', path: `${W}/apps/{id}/staged/release-fields`, tags: ['staged-changes'], summary: 'Stage one release field of the draft release; nothing is written to a store', description: 'Stages ONE field, normalized and checked on its own (`422 field_not_stageable`, `422 invalid_locale`, `422 empty_value`, `422 invalid_staged` with the first error, `422 too_many_items`). The App Store "what is new" is the listing field `release_notes` (`stageListingText`). Google Play `user_fraction` is kept here only: a draft cannot hold a share, and the release step needs an explicit one. The values reach a store only through the draft push (`pushStagedDraft`), whose preview shows each field before and after with the store’s facts (`checks`). Needs `changesets.write`. Audited as `staged.release_field_set` with a hash, never the value.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: stagedReleaseFieldBody, responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'getReleasePipeline', method: 'get', path: `${W}/apps/{id}/release/pipeline`, tags: ['releases'], summary: 'Where the release of the app is between a CI run and live, and whether it is stalled', description: 'Read-only, from the data stored here (the stored CI runs, the builds and versions of the last store sync); it calls neither GitHub nor a store. `stalled` says what is stuck in a sentence, with the ids and times it rests on. Detection is off when the workspace setting `release.stalledAfterHours` is 0. Times of store states are lower bounds (the last sync that saw the state) when the app was synced before they were recorded.', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The pipeline.', schema: pipelineResponseSchema } } },
  { id: 'getReleasePipelineSummary', method: 'get', path: `${W}/release/pipeline/summary`, tags: ['releases'], summary: 'The release pipeline of every app, stalled ones first', description: 'Same facts and rules as `getReleasePipeline`, one line per app. A token limited to some apps sees only those apps.', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'list' }, responses: { '200': { description: 'One line per app and the totals.', schema: pipelineSummarySchema } } },
  { id: 'listReleaseCandidates', method: 'get', path: `${W}/apps/{id}/release/candidates`, tags: ['releases'], summary: 'List the builds and version codes a draft release can use (processed builds, uploaded codes)', description: 'READS the store with the credential of the app (audited as `credential.use`, purpose `store.release_read`) and changes nothing; not behind a switch. App Store: the builds of the app for this platform, newest first, each with `selectable` (processed, not expired) and `attached`; `version` optionally narrows them to a marketing version. Google Play: `track` is required (`422 track_required`); the uploaded version codes with the releases of that track that hold them. Every build and code has an `eligibility` verdict (`eligible`, `severity`, a machine `code` and a plain `message`). App Store builds also carry `exportCompliance` and `testNotes` (the TestFlight "What to Test" of the newest eight processed builds, up to 40 languages and 4000 characters each; one build that cannot be read never hides the others, and the text is never logged or audited). Rate limited per workspace (`429`). Needs `listing.read`.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ track: z.string().max(100).optional().describe('Google Play: required.'), version: z.string().max(40).optional().describe('App Store: narrow the builds to this marketing version.') }), responses: { '200': { description: 'The candidates.', schema: z.object({ candidates: releaseCandidatesSchema }) } } },
  { id: 'getReleaseNotesHistory', method: 'get', path: `${W}/apps/{id}/release/notes-history`, tags: ['releases'], summary: 'The "what is new" texts earlier releases used, newest first, deduplicated, to reuse in the next one', description: 'READS the store with the credential of the app (audited as `credential.use`, purpose `store.release_read`) and changes nothing; not behind a switch. The same text used by several versions is one entry with every place in `uses` (store, version or release, track, state, date). App Store: the notes of the newest twelve versions of the platform (the order and the date come from `createdDate`, UNVERIFIED). Google Play: only the releases the tracks hold now (Google lists no replaced release), with no dates. The notes of this app’s release plans are included (`source` `plan`). The store read is cached for ten minutes per app and language; only a read that goes to the store counts against the rate limit (`store.error` `rate_limited`, with `Retry-After`). A failed store read still answers `200` with the plans’ notes and `store.read` false. The texts are never logged and never audited. Needs `listing.read`.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ platform: platform.optional().describe('Must be the platform of the app (`422 platform_mismatch`).'), locale: z.string().max(20).optional().describe('One language, for example `en-US`. Default: all.'), limit: z.number().int().min(1).max(100).optional().describe('Default 30.') }), responses: { '200': { description: 'The history.', schema: z.object({ history: notesHistorySchema }) } } },
  { id: 'getEditableRelease', method: 'get', path: `${W}/apps/{id}/release/editable`, tags: ['releases'], summary: 'The release fields the store holds: the editable App Store version, or the draft release of a Google Play track', description: 'READS the store (same rules as `listReleaseCandidates`) and changes nothing. App Store: the editable version’s release type, earliest release date, copyright, attached build, phased release and the "what is new" per locale; `422 no_editable_version` when there is none. Google Play: `track` is required; the draft release (name, version codes, notes per language) and the other releases of the track. Needs `listing.read`.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ track: z.string().max(100).optional().describe('Google Play: required.') }), responses: { '200': { description: 'The release fields.', schema: z.object({ editable: editableReleaseSchema }) } } },
  // ----- submitting the pushed draft for store review (IRREVERSIBLE; off unless MRM_STORE_SUBMIT_ENABLED=true) ----
  { id: 'getStoreSubmitConfig', method: 'get', path: `${W}/store-submit/config`, tags: ['submit'], summary: 'Whether submitting drafts for store review is switched on', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch, the action and the lowest role that can submit.', schema: submitConfigSchema } } },
  { id: 'getStoreSubmitState', method: 'get', path: `${W}/apps/{id}/store-submit`, tags: ['submit'], summary: 'Where the submit of an app stands here: push recorded, in flight (no store contacted)', description: 'Needs `store.submit`. Reads the database only: whether a successful draft push is recorded and not yet submitted, and whether a submit or push is in flight or has an unknown outcome. It works while the switch is off too (`enabled` says which), so a screen can show where things stand either way.', risk: 'read', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The state.', schema: z.object({ submit: submitStateSchema }) } } },
  { id: 'previewStoreSubmit', method: 'post', path: `${W}/apps/{id}/store-submit/preview`, tags: ['submit'], summary: 'Preview a submit for review: what goes, checks, a confirmHash and the text to type', description: 'Needs `store.submit` and `MRM_STORE_SUBMIT_ENABLED=true`. READS the store, writes nothing, and settles an earlier unknown outcome (a successful read). `409 nothing_pushed` when no successful draft push is recorded. `checks.blocking` stops a submit (the store’s draft no longer holds what was pushed, no or an expired build, a version that would release by itself, a version already in review, no locales or screenshots, a documented spec broken, an image not processed); `checks.warnings` do not. While anything blocks, `confirmHash` and `confirmation` are null.', risk: 'read', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, body: z.object({}), responses: { '200': { description: 'The preview.', schema: z.object({ preview: submitPreviewSchema }) } } },
  { id: 'applyStoreSubmit', method: 'post', path: `${W}/apps/{id}/store-submit`, tags: ['submit'], summary: 'Hand the pushed draft to store REVIEW (irreversible; never releases or changes a rollout)', description: 'A STORE WRITE THAT CANNOT BE TAKEN BACK from this server. Needs `store.submit` (owner and admin; a token only when its actions name it; `403` otherwise) and `MRM_STORE_SUBMIT_ENABLED=true` (`409 store_submit_disabled`). `confirmHash` must come from a preview of the same state and `confirmation` must be its `confirmation.phrase` (`422 confirmation_mismatch`). The store is READ AGAIN right before the write: if it is not the one previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). One submit per app and platform at a time (`409 write_in_progress`); a draft push in flight or with an unknown outcome blocks it. App Store: a review submission with the editable version as its item, then submitted; only that last request cannot be undone here; a version that would release by itself is blocked. Google Play: an edit committed without `changesNotSentForReview` and with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review` when changes are in review); no track is written. Never retried: after a timeout or a 5xx the store is read back. App Store: `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), or `409 outcome_unknown`. Google Play shows no review state, so it is `409 outcome_unknown` until the person has looked in Play Console and previews again. Audited as `listing.submitted` / `listing.submit_failed` (ids, hashes and outcomes, never a text or a credential) and emitted as the event `listing.submitted`.', risk: 'destructive', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, body: submitApplyBody, responses: { '200': { description: 'What was submitted.', schema: z.object({ result: submitResultSchema }) } } },
  // ----- releasing (IRREVERSIBLE; off unless MRM_STORE_RELEASE_ENABLED=true) ----
  { id: 'getStoreReleaseConfig', method: 'get', path: `${W}/store-release/config`, tags: ['releases'], summary: 'Whether releasing from this server is switched on', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch, the action and the lowest role that can release.', schema: releaseConfigSchema } } },
  { id: 'getStoreReleaseState', method: 'get', path: `${W}/apps/{id}/store-release`, tags: ['releases'], summary: 'Where the release of an app stands here: in flight, unknown outcomes (no store contacted)', description: 'Needs `store.release`. Reads the database only: whether a release, a draft push or a submit is in flight or has an unknown outcome. It works while the switch is off too (`enabled` says which).', risk: 'read', access: { action: 'store.release' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The state.', schema: z.object({ release: releaseStateSchema }) } } },
  { id: 'previewStoreRelease', method: 'post', path: `${W}/apps/{id}/store-release/preview`, tags: ['releases'], summary: 'Preview a release: what is released, to whom, checks, a confirmHash and the text to type', description: 'Needs `store.release` and `MRM_STORE_RELEASE_ENABLED=true`. READS the store, writes nothing, and settles an earlier unknown outcome (a successful read). App Store: the version in Pending Developer Release (name `version` when more than one waits; macOS is the macOS version). Google Play: `track` and an explicit `userFraction` are required (`422 track_required`, `422 user_fraction_required`); `versionCodes` pick the draft when the track holds several. `checks.blocking` stops a release (nothing releasable, more than one candidate, version codes not uploaded, a rollout already running in the track, a push or submit in flight); `checks.warnings` do not. While anything blocks, `confirmHash` and `confirmation` are null.', risk: 'read', access: { action: 'store.release' }, appScope: { kind: 'param', name: 'id' }, body: z.object(releaseWhat), responses: { '200': { description: 'The preview.', schema: z.object({ preview: releasePreviewSchema }) } } },
  { id: 'applyStoreRelease', method: 'post', path: `${W}/apps/{id}/store-release`, tags: ['releases'], summary: 'RELEASE the approved version, or start the Google Play draft release at the named share (irreversible)', description: 'A STORE WRITE THAT CANNOT BE TAKEN BACK from this server. Needs `store.release` (owner and admin; a token only when its actions name it; `403` otherwise) and `MRM_STORE_RELEASE_ENABLED=true` (`409 store_release_disabled`). `confirmHash` must come from a preview of the same request and state, and `confirmation` must be its `confirmation.phrase` (`422 confirmation_mismatch`). The store is READ AGAIN right before the write: if it is not the one previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). One release per app and platform at a time (`409 write_in_progress`); a draft push or a submit in flight blocks it. App Store: `POST appStoreVersionReleaseRequests` for the version in Pending Developer Release. Google Play: an edit that sets the draft release to `inProgress` with `userFraction` (or `completed` for 1), committed without `changesNotSentForReview` and with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review`). Never retried: after a timeout or a 5xx the store is read back: `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`, App Store), or `409 outcome_unknown` (preview again; Google Play can be slow to show a commit). Audited as `store.released` / `store.release_failed` (ids, a share, hashes and outcomes, never a text or a credential) and emitted as the event `release.started`.', risk: 'destructive', access: { action: 'store.release' }, appScope: { kind: 'param', name: 'id' }, body: releaseApplyBody, responses: { '200': { description: 'What was released.', schema: z.object({ result: releaseResultSchema }) } } },
  // ----- pending changes (stored state only) and publishing them in one go (off unless MRM_STORE_PUBLISH_BATCH_ENABLED=true) ----
  { id: 'getAppPending', method: 'get', path: `${W}/apps/{id}/pending`, tags: ['pending'], summary: 'Everything the app has pending in one place, with the step that publishes each item', description: 'Read-only, from the data stored here: no store and no repository is read, so it is cheap and needs no switch. One list of items per platform. Each item has a `kind`, a `state`, its `problems` (an `error` blocks the step it waits for) and the `nextStep` that publishes it (`push_draft`, `submit`, `release`, `rollout`; null for an item that only waits for the store). What is said about versions is as of the last store sync (`lastSyncedAt`). Counts and ids only: never a staged text.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The pending items.', schema: z.object({ pending: pendingViewSchema }) } } },
  { id: 'getPendingSummary', method: 'get', path: `${W}/pending/summary`, tags: ['pending'], summary: 'Which apps have pending changes, with counts and kinds', description: 'Same facts as `getAppPending`, one line per app that has something pending or in review (an app that is not listed has nothing). Stored state only. A token limited to some apps sees only those apps.', risk: 'read', access: { action: 'listing.read' }, appScope: { kind: 'list' }, responses: { '200': { description: 'One line per app and the totals.', schema: pendingSummarySchema } } },
  { id: 'getStorePublishConfig', method: 'get', path: `${W}/store-publish/config`, tags: ['pending'], summary: 'Whether publishing several steps at once is switched on, and what each step needs', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch, the action, the phrase and the switch of every step.', schema: publishConfigSchema } } },
  { id: 'previewStoreBatch', method: 'post', path: `${W}/apps/{id}/publish/preview`, tags: ['pending'], summary: 'Preview publishing several steps at once: the plan, each step’s preview, a planHash and ONE phrase', description: 'Needs `store.publish` and `MRM_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`). READS the stores through the steps’ own preview functions and writes nothing. `steps` (optional) names the steps and their input; without it every step that is available and has work is included. Each step in the plan says whether it is `available` or why not (`feature_disabled`: its own switch is off; `forbidden`: the caller or token lacks the step’s own right; `nothing_to_do`; `blocked`: errors stand in the way; `needs_input`: for example a Google Play release without a track or share). A step that needs an earlier one (submit after a push, a Play release after a push) is `deferred`: it is previewed again after the earlier step applied and runs only if it matches its promised `summary`. `planHash` covers the included steps, their input, their confirmHashes and phrases; it is null while a requested step is not available. `confirmation.phrase` (`publish <app name> <n> steps`) is the ONE phrase to type when any included step is irreversible.', risk: 'read', access: { action: 'store.publish' }, appScope: { kind: 'param', name: 'id' }, body: publishPreviewBody, responses: { '200': { description: 'The plan.', schema: z.object({ plan: publishPlanSchema }) } } },
  { id: 'publishStoreBatch', method: 'post', path: `${W}/apps/{id}/publish`, tags: ['pending'], summary: 'PUBLISH several steps at once with one confirmation (can be irreversible)', description: 'A STORE WRITE, possibly several that cannot be taken back. Needs `store.publish` AND, for every step in `steps`, that step’s right (`store.push_draft`, `store.submit`, `store.release`, `releases.rollout`): an owner or admin, or a token whose actions name the batch and every step (`403 forbidden`, listing the missing steps). Needs `MRM_STORE_PUBLISH_BATCH_ENABLED=true` (`409 publish_batch_disabled`) and each step’s own switch (`409 step_disabled`). `phrase` must be the `confirmation.phrase` of the plan when a step is irreversible (`422 confirmation_mismatch`, nothing read or written). The plan is rebuilt and must have the `planHash` previewed (`409 plan_changed`, with the new `plan`; `409 plan_blocked` when a step is no longer available). The steps then run IN ORDER through their own services, each with its own claim, its own re-read of the store and its own refusal on drift (`state_changed` is a failed step, not a retry). The batch STOPS at the first step that is not applied: the rest are `skipped` (`previous_step_not_applied`). Nothing is ever retried; an unknown outcome is read back by the step and reported (`outcome: unknown`: look at the store). A deferred step that no longer matches its promise is skipped as `plan_drifted`. One publish per app at a time (`409 publish_in_progress`). The answer is `200` with the result of every step even when a step failed: look at `completed`, `stoppedAt` and `steps`. Audited as `pending.published` (ids, hashes, per step outcomes; never a text or a credential) and emitted as the event `pending.published` when something was applied.', risk: 'destructive', access: { action: 'store.publish' }, appScope: { kind: 'param', name: 'id' }, body: publishApplyBody, responses: { '200': { description: 'What happened to every step.', schema: z.object({ result: publishResultSchema }) } } },
  // ----- AI assistance: suggestions only; accepting goes through existing services (own file) ----
  ...aiOperations,
  ...analyticsOperations,
];

export const operations: readonly Operation[] = drafts.map((d) => ({ ...d, tags: d.tags ?? [] }));
