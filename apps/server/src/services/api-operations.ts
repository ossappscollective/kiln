import { credentialKinds, invitableRoles, roles, translationModes, translationProviders } from '@mrm/core';
import { z } from 'zod';
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
  platform: z.enum(['ios', 'android']),
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
  platform: z.enum(['ios', 'android']),
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
const platform = z.enum(['ios', 'android']);
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
  platform: z.enum(['ios', 'android']),
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
  platform: z.enum(['ios', 'android']).optional(),
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
  app: z.object({ id: z.string(), platform: z.enum(['ios', 'android']), store: reviewStore }),
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
  app: z.object({ id: z.string(), name: z.string(), platform: z.enum(['ios', 'android']) }),
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
  unanswered: z.number().int().describe('No developer response and not ignored.'),
  lowRating: z.number().int().describe('Rating at or below the threshold and not ignored.'),
  average: z.number().nullable().describe('Mean of the stored ratings, two decimals.'),
});
const workspaceSummarySchema = z.object({
  basis: z.literal('stored_reviews'),
  label: z.string().describe('Where the numbers come from, to show next to them.'),
  lowRatingThreshold: z.number().int(),
  apps: z.array(workspaceCounts.extend({ app: z.object({ id: z.string(), name: z.string(), platform: z.enum(['ios', 'android']), store: reviewStore }), oldestAt: timestamp.nullable(), newestAt: timestamp.nullable() })),
  totals: workspaceCounts,
});

const triageReviewBody = z.object({
  status: reviewStatusEnum.optional(),
  assigneeUserId: z.string().min(1).max(100).nullable().optional().describe('A member of the workspace, or null to clear.'),
  internalNote: z.string().max(2000).nullable().optional().describe('Internal. Null or empty clears it.'),
});

// ----- workspace settings and review translation ----------------------------------------------------
const translationLang = z.string().regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/).max(35).describe('A BCP-47 language tag such as en, pt-BR or zh-Hant.');
const settingValueSchema = z.union([z.number(), z.boolean(), z.string()]);
const settingsBody = z.object({
  'reviews.lowRatingThreshold': z.number().int().min(1).max(4).nullable().optional().describe('Ratings at or below this raise `review.new_low_rating`. Default 2. Raising it never re-sends events for reviews already read.'),
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
    platform: z.enum(['android', 'ios']),
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
const rolloutAppSchema = z.object({ id: z.string(), name: z.string(), platform: z.enum(['ios', 'android']), store: reviewStore });
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
const stagedAppSchema = z.object({ id: z.string(), name: z.string(), platform: z.enum(['ios', 'android']), store: reviewStore });
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
const stagedLimitsSchema = z.object({ maxItems: z.number().int(), maxTextChars: z.number().int(), maxLocaleChars: z.number().int(), maxAssetFilesPerPush: z.number().int(), maxAssetBytesPerPush: z.number().int(), maxAssetFileBytes: z.number().int() });
const stagedChangesSchema = z.object({
  app: stagedAppSchema,
  text: z.array(stagedTextSchema),
  assets: z.array(stagedAssetSchema),
  totals: z.object({ text: z.number().int(), assetSets: z.number().int(), assetFiles: z.number().int(), errors: z.number().int(), warnings: z.number().int(), changed: z.number().int() }),
  valid: z.boolean().describe('False when any item has an error: a push is refused while there are some.'),
  pushable: z.object({ textFields: z.array(z.string()) }),
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
  from: stagedSource.optional().describe('Only `repo` is supported (default). Graphics are not downloaded from the store, and files cannot be uploaded here.'),
  paths: z.array(z.string().max(1024)).min(1).max(100).optional().describe('The files of the set, in order, as the asset index lists them. Default: every file of the slot in index order.'),
  commit: z.string().max(64).optional().describe('Read this commit of the repository (a full hash). Default: the branch tip.'),
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
  summary: z.object({ textChanged: z.number().int(), textUnchanged: z.number().int(), assetSetsChanged: z.number().int(), assetSetsUnchanged: z.number().int(), filesToUpload: z.number().int(), filesToRemove: z.number().int(), nothingToDo: z.boolean() }),
  submits: z.literal(false).describe('Always false: a push writes a draft and never submits or publishes.'),
  confirmHash: z.string().describe('Send it back to push. Valid only while the staged items and the store’s draft are as previewed.'),
  warnings: z.array(z.string()),
  readAt: timestamp,
});
const draftResultSchema = z.object({
  app: stagedAppSchema,
  version: draftStateVersion,
  steps: z.array(z.object({ type: z.enum(['text', 'asset', 'locale']), locale: z.string(), target: z.string(), outcome: z.enum(['applied', 'already_same']), uploaded: z.number().int().optional(), removed: z.number().int().optional() })),
  counts: z.object({ applied: z.number().int(), alreadySame: z.number().int(), filesUploaded: z.number().int(), filesRemoved: z.number().int() }),
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

  { id: 'refreshListingFromRepo', method: 'post', path: `${W}/apps/{id}/listing/repo-refresh`, tags: ['listing'], summary: 'Read the listing from the connected repository again', description: 'Reads GitHub; writes only to this server’s database.', risk: 'write', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The refreshed listing.', schema: object } } },
  { id: 'pullStoreListing', method: 'post', path: `${W}/apps/{id}/listing/pull`, tags: ['listing'], summary: 'Draft a change set from the live store listing', description: 'Applies the store\u2019s values to the repository\u2019s own listing files as a draft change set. Reads GitHub (and the store with `refresh`); writes nothing to a store or to the repository: the draft is reviewed, approved and applied like any change set. Needs `changesets.write` and `listing.read`; `refresh` also needs `apps.sync`.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: pullListingBody, partial: true, responses: { '200': { description: 'Nothing to pull: `changeSet` is null and `explanation` says why.', schema: object }, '201': { description: 'The draft, what changes, what was skipped and why.', schema: z.object({ changeSet: changeSetSchema, changes: z.array(object), skipped: z.array(object), problems: z.array(object), warnings: z.array(z.string()) }) } } },

  // ----- CI workflows and builds ----------------------------------------------------------------
  { id: 'listWorkflows', method: 'get', path: `${W}/repositories/{id}/workflows`, tags: ['ci'], summary: 'GitHub Actions workflows of a repository', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Workflows.', schema: object } } },
  { id: 'listWorkflowRuns', method: 'get', path: `${W}/repositories/{id}/workflows/runs`, tags: ['ci'], summary: 'Recent workflow runs', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ limit: z.number().int().min(1).max(100).optional(), workflow: z.string().optional(), branch: z.string().optional(), refresh: z.enum(['true']).optional(), active: z.enum(['true']).optional(), appId: z.string().optional() }), partial: true, responses: { '200': { description: 'Runs.', schema: object } } },
  { id: 'getWorkflowRun', method: 'get', path: `${W}/repositories/{id}/workflows/runs/{runId}`, tags: ['ci'], summary: 'A workflow run', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ refresh: z.enum(['true']).optional() }), partial: true, responses: { '200': { description: 'The run.', schema: object } } },
  { id: 'getWorkflowInputs', method: 'get', path: `${W}/repositories/{id}/workflows/{workflow}/inputs`, tags: ['ci'], summary: 'The inputs a workflow accepts', risk: 'read', access: { action: 'repositories.scan' }, query: z.object({ ref: z.string().optional() }), partial: true, responses: { '200': { description: 'The inputs.', schema: object } } },
  { id: 'dispatchWorkflow', method: 'post', path: `${W}/repositories/{id}/workflows/{workflow}/dispatches`, tags: ['ci'], summary: 'Start a workflow run', description: 'Runs a workflow on GitHub. It can ship a build: assistants should ask a person first.', risk: 'write', access: { action: 'ci.dispatch' }, body: object, partial: true, responses: { '202': { description: 'The dispatch was accepted.', schema: z.object({ dispatched: z.boolean(), runKnown: z.boolean(), run: object.nullable() }) } } },
  { id: 'listBuilds', method: 'get', path: `${W}/apps/{id}/builds`, tags: ['ci'], summary: 'Builds of an app and the runs linked to them', risk: 'read', access: { action: 'apps.read' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'Builds.', schema: object } } },
  { id: 'getBuildChanges', method: 'get', path: `${W}/apps/{id}/builds/changes`, tags: ['ci'], summary: 'Commits between two builds', risk: 'read', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ platform: z.enum(['ios', 'android']), build: z.string(), base: z.string().optional() }), partial: true, responses: { '200': { description: 'The changes.', schema: object } } },
  { id: 'linkBuild', method: 'put', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Link a build to a workflow run', risk: 'write', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, body: object, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
  { id: 'unlinkBuild', method: 'delete', path: `${W}/apps/{id}/builds/{platform}/{buildNumber}/link`, tags: ['ci'], summary: 'Remove the link of a build', risk: 'destructive', access: { action: 'apps.sync' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The build.', schema: z.object({ build: object }) } } },
  { id: 'rematchBuilds', method: 'post', path: `${W}/apps/{id}/builds/rematch`, tags: ['ci'], summary: 'Search runs, tags and releases again for the unlinked builds of an app', description: 'Reads GitHub (runs, tags, releases, a few commits) and stores the links it finds. Rate limited per workspace.', risk: 'write', access: { action: 'repositories.scan' }, appScope: { kind: 'param', name: 'id' }, partial: true, responses: { '200': { description: 'The builds, with diagnostics, and what the search did.', schema: object } } },
  { id: 'getBuildConventions', method: 'get', path: `${W}/repositories/{id}/build-conventions`, tags: ['ci'], summary: 'How build numbers are found in tags and releases', description: 'Stored and effective tag and release-name patterns of a repository, or of one app with `appId`.', risk: 'read', access: { action: 'repositories.read' }, query: z.object({ appId: z.string().optional() }), partial: true, responses: { '200': { description: 'The conventions.', schema: object } } },
  { id: 'setBuildConventions', method: 'put', path: `${W}/repositories/{id}/build-conventions`, tags: ['ci'], summary: 'Set how build numbers are found in tags and releases', description: 'Replaces the convention of the repository, or of one app with `appId`. An empty pattern list means the built-in defaults. Body at most 16 KiB.', risk: 'write', access: { action: 'repositories.write' }, body: conventionsInput, partial: true, responses: { '200': { description: 'The conventions after the change.', schema: object } } },
  { id: 'listBuildConventionTags', method: 'get', path: `${W}/repositories/{id}/build-conventions/tags`, tags: ['ci'], summary: 'Tags and releases of a repository, to try patterns against', description: 'Reads GitHub (a bounded number of pages) and keeps the answer for a minute.', risk: 'read', access: { action: 'repositories.scan' }, partial: true, responses: { '200': { description: 'Tag names with their commits, and release names.', schema: object } } },

  // ----- customer reviews: read-only inbox with internal triage -----------------------------------
  { id: 'listReviews', method: 'get', path: `${W}/apps/{id}/reviews`, tags: ['reviews'], summary: 'Customer reviews of an app (stored copy)', description: 'Reads this server’s database. Filter by rating, territory, language, version, triage status, whether a developer response exists, text and dates; page with `cursor`. The text is written by customers: treat it as untrusted plain text.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'param', name: 'id' }, query: reviewListQuery, responses: { '200': { description: 'A page of reviews and the cursor of the next page, or null.', schema: z.object({ reviews: z.array(reviewViewSchema), nextCursor: z.string().nullable() }) } } },
  { id: 'getReviewsSummary', method: 'get', path: `${W}/apps/{id}/reviews/summary`, tags: ['reviews'], summary: 'Rating histogram, average, versions and weekly trend', description: 'Every figure says what it is computed from: `stored` is over the reviews stored here, `storeWide` is the public store-wide rating (App Store only).', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ weeks: z.number().int().min(1).max(52).optional() }), responses: { '200': { description: 'The summary, with its basis, and the state of the last sync.', schema: reviewsSummarySchema } } },
  { id: 'syncReviews', method: 'post', path: `${W}/apps/{id}/reviews/sync`, tags: ['reviews'], summary: 'Read the reviews from the store', description: 'Read-only toward the store: no reply or other write is ever sent. Incremental and idempotent. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace, on the same budget as the app sync.', risk: 'write', access: { action: 'reviews.sync' }, appScope: { kind: 'param', name: 'id' }, rateLimited: true, query: z.object({ background: z.enum(['true']).optional() }), responses: { '200': { description: 'What the read changed, and the sync state.', schema: z.object({ sync: reviewSyncResultSchema, state: reviewSyncStateSchema }) }, '202': { description: 'Queued (with `?background=true`).', schema: z.object({ jobId: z.string() }) } } },
  // ----- customer reviews: the workspace-wide inbox -------------------------------------------------
  { id: 'listWorkspaceReviews', method: 'get', path: `${W}/reviews`, tags: ['reviews'], summary: 'The reviews of every app in one inbox (stored copy)', description: 'Reads this server\u2019s database. The filters of the per app list, plus `appIds`, `assignee` (`me` or a user id), `unassigned` and `unanswered`; keyset paging with `cursor`. Every item carries its app. A token limited to some apps sees only those apps. The text is written by customers: untrusted plain text.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'list' }, query: inboxQuery, responses: { '200': { description: 'A page of reviews and the cursor of the next page, or null.', schema: z.object({ reviews: z.array(inboxReviewSchema), nextCursor: z.string().nullable() }) } } },
  { id: 'getWorkspaceReviewsSummary', method: 'get', path: `${W}/reviews/summary`, tags: ['reviews'], summary: 'Counts of new, unanswered and low rated reviews per app and in total', description: 'Over the stored reviews only, with its basis stated. No review text and no names. A token limited to some apps counts only those apps.', risk: 'read', access: { action: 'reviews.read' }, appScope: { kind: 'list' }, responses: { '200': { description: 'Counts per app and the totals.', schema: workspaceSummarySchema } } },

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
  { id: 'stageListingAssets', method: 'put', path: `${W}/apps/{id}/staged/assets`, tags: ['staged-changes'], summary: 'Stage a set of graphics of one locale and slot from the repository (nothing is written to a store)', description: 'Replaces the staged set of a locale and slot with files of the repository’s asset index (the Assets tab), kept by reference: path, commit and git blob id. A push makes the store’s set exactly these files, in this order. `422 slot_not_pushable` (App Store previews and app icon, Play promo graphic), `422 source_not_supported` (graphics cannot come from the store or be uploaded), `422 asset_not_pushable` (not PNG or JPEG, not opened, over 8 MiB), `422 too_many_files` / `too_many_bytes`. Needs `changesets.write`; the repository read costs like an Assets tab read (rate limited). Audited as `staged.assets_set` with blob ids.', risk: 'write', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, body: stagedAssetsBody, responses: { '200': { description: 'The staged changes after the change.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'unstageItem', method: 'delete', path: `${W}/apps/{id}/staged/items`, tags: ['staged-changes'], summary: 'Remove one staged text (its id) or one staged set (`locale/slotKey`)', risk: 'destructive', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, query: z.object({ id: z.string().describe('The id of a staged text, or the `id` of a staged set (`en-US/screenshot:iphone_6_5`).') }), responses: { '200': { description: 'The staged changes after the removal.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'clearStagedChanges', method: 'delete', path: `${W}/apps/{id}/staged`, tags: ['staged-changes'], summary: 'Remove every staged item of an app', risk: 'destructive', access: { action: 'changesets.write' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The (empty) staged changes.', schema: z.object({ staged: stagedChangesSchema }) } } },
  { id: 'previewStagedPush', method: 'post', path: `${W}/apps/{id}/staged/push/preview`, tags: ['staged-changes'], summary: 'Preview pushing the staged changes to the store as a draft: per item before and after, and a confirmHash', description: 'READS THE STORE (the draft; Google Play opens and deletes an edit, which invalidates other open edits of the same service account) and the bytes of the staged files from the repository. Writes nothing. `422 nothing_staged`, `422 staged_invalid` (items with errors), `422 asset_changed`, `422 no_editable_version` (App Store: no version in Prepare for Submission). Needs `store.push_draft` and `MRM_STORE_DRAFT_WRITE_ENABLED=true` (`409 store_draft_disabled` otherwise).', risk: 'read', access: { action: 'store.push_draft' }, appScope: { kind: 'param', name: 'id' }, body: stagedPushPreviewBody, bodyOptional: true, responses: { '200': { description: 'The preview.', schema: z.object({ preview: draftPreviewSchema }) } } },
  { id: 'pushStagedDraft', method: 'post', path: `${W}/apps/{id}/staged/push`, tags: ['staged-changes'], summary: 'Write the staged changes to the store as a DRAFT (never submits, sends for review or publishes)', description: 'A STORE WRITE. Needs `store.push_draft` (owner and admin; a token only when its actions name it) and `MRM_STORE_DRAFT_WRITE_ENABLED=true`. `confirmHash` must come from a preview of the same staged items. The store’s draft is READ AGAIN right before the first write: if it is not the one previewed, or the staged items changed, nothing is written (`409 state_changed`, with a new `preview`). One write per app at a time (`409 write_in_progress`). App Store: the editable version’s localizations and screenshots change one request at a time (a refusal part way is `502 draft_partial`, with `completed` and `failed`). Google Play: one edit, committed with `changesNotSentForReview=true` (`409 draft_not_allowed` when Google refuses that, `409 changes_in_review` when changes are in review: nothing is committed). Never retried: after a timeout or a 5xx the draft is read back and the answer is `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), `409 draft_partial`, or `409 outcome_unknown` (then preview again). Audited as `listing.draft_pushed` / `listing.draft_push_failed` (ids, counts and hashes, never a text or a credential) and emitted as the event `listing.draft_pushed`.', risk: 'destructive', access: { action: 'store.push_draft' }, appScope: { kind: 'param', name: 'id' }, body: stagedPushBody, responses: { '200': { description: 'What was written.', schema: z.object({ result: draftResultSchema }) } } },
  // ----- submitting the pushed draft for store review (IRREVERSIBLE; off unless MRM_STORE_SUBMIT_ENABLED=true) ----
  { id: 'getStoreSubmitConfig', method: 'get', path: `${W}/store-submit/config`, tags: ['submit'], summary: 'Whether submitting drafts for store review is switched on', risk: 'read', access: { action: 'apps.read' }, responses: { '200': { description: 'The switch, the action and the lowest role that can submit.', schema: submitConfigSchema } } },
  { id: 'getStoreSubmitState', method: 'get', path: `${W}/apps/{id}/store-submit`, tags: ['submit'], summary: 'Where the submit of an app stands here: push recorded, in flight (no store contacted)', description: 'Needs `store.submit`. Reads the database only: whether a successful draft push is recorded and not yet submitted, and whether a submit or push is in flight or has an unknown outcome. It works while the switch is off too (`enabled` says which), so a screen can show where things stand either way.', risk: 'read', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, responses: { '200': { description: 'The state.', schema: z.object({ submit: submitStateSchema }) } } },
  { id: 'previewStoreSubmit', method: 'post', path: `${W}/apps/{id}/store-submit/preview`, tags: ['submit'], summary: 'Preview a submit for review: what goes, checks, a confirmHash and the text to type', description: 'Needs `store.submit` and `MRM_STORE_SUBMIT_ENABLED=true`. READS the store, writes nothing, and settles an earlier unknown outcome (a successful read). `409 nothing_pushed` when no successful draft push is recorded. `checks.blocking` stops a submit (the store’s draft no longer holds what was pushed, no or an expired build, a version that would release by itself, a version already in review, no locales or screenshots, a documented spec broken, an image not processed); `checks.warnings` do not. While anything blocks, `confirmHash` and `confirmation` are null.', risk: 'read', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, body: z.object({}), responses: { '200': { description: 'The preview.', schema: z.object({ preview: submitPreviewSchema }) } } },
  { id: 'applyStoreSubmit', method: 'post', path: `${W}/apps/{id}/store-submit`, tags: ['submit'], summary: 'Hand the pushed draft to store REVIEW (irreversible; never releases or changes a rollout)', description: 'A STORE WRITE THAT CANNOT BE TAKEN BACK from this server. Needs `store.submit` (owner and admin; a token only when its actions name it; `403` otherwise) and `MRM_STORE_SUBMIT_ENABLED=true` (`409 store_submit_disabled`). `confirmHash` must come from a preview of the same state and `confirmation` must be its `confirmation.phrase` (`422 confirmation_mismatch`). The store is READ AGAIN right before the write: if it is not the one previewed nothing is written (`409 state_changed`, with a new `preview`); if a check blocks, nothing is written (`409 blocked`, with `checks`). One submit per app and platform at a time (`409 write_in_progress`); a draft push in flight or with an unknown outcome blocks it. App Store: a review submission with the editable version as its item, then submitted; only that last request cannot be undone here; a version that would release by itself is blocked. Google Play: an edit committed without `changesNotSentForReview` and with `changesInReviewBehavior=ERROR_IF_IN_REVIEW` (`409 changes_in_review` when changes are in review); no track is written. Never retried: after a timeout or a 5xx the store is read back. App Store: `200` with `confirmedByReread: true`, `502 write_failed` (`outcome: not_applied`), or `409 outcome_unknown`. Google Play shows no review state, so it is `409 outcome_unknown` until the person has looked in Play Console and previews again. Audited as `listing.submitted` / `listing.submit_failed` (ids, hashes and outcomes, never a text or a credential) and emitted as the event `listing.submitted`.', risk: 'destructive', access: { action: 'store.submit' }, appScope: { kind: 'param', name: 'id' }, body: submitApplyBody, responses: { '200': { description: 'What was submitted.', schema: z.object({ result: submitResultSchema }) } } },
];

export const operations: readonly Operation[] = drafts.map((d) => ({ ...d, tags: d.tags ?? [] }));
