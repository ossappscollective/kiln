import { PLATFORMS, translationProviders } from '@mrm/core';
import { z } from 'zod';
import { type Draft, none, reviewStore, timestamp, translationLang, W } from '../../operations/shared.ts';

const reviewStatusEnum = z.enum(['new', 'triaged', 'replied_in_console', 'ignored']);

export const reviewSchema = z.object({
  id: z.string(),
  appId: z.string(),
  store: reviewStore,
  platform: z.enum(PLATFORMS),
  storeReviewId: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z
    .string()
    .describe(
      'Plain text written by a customer. Personal data of a third party: show it as text, never as HTML.',
    ),
  authorName: z
    .string()
    .nullable()
    .describe('The public display name the customer chose. Personal data.'),
  territory: z.string().nullable(),
  language: z.string().nullable(),
  appVersion: z.string().nullable(),
  buildNumber: z.string().nullable(),
  device: z.string().nullable(),
  createdAt: timestamp.describe(
    'When the customer wrote it. For Google Play, when this server first saw it (the API has no creation time).',
  ),
  updatedAt: timestamp.describe('When the review was last edited, per the store.'),
  firstSeenAt: timestamp,
  fetchedAt: timestamp,
  developerResponse: z
    .object({ body: z.string(), at: timestamp.nullable(), state: z.string().nullable() })
    .nullable()
    .describe(
      'The reply the store shows for this review (published from this server, or from the store console).',
    ),
  status: reviewStatusEnum.describe(
    'Internal triage state. `replied_in_console` is a note by a person; nothing is sent.',
  ),
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
  responses: z
    .number()
    .int()
    .describe('Reviews whose developer response appeared, changed or went away.'),
  skipped: z.number().int().describe('Entries the store sent that could not be read.'),
  complete: z
    .boolean()
    .describe('False when the read stopped before the end (limits, rate limit reserve, page cap).'),
  gap: z
    .object({ from: timestamp, to: timestamp })
    .nullable()
    .describe(
      'Reviews may have been missed: Google Play only returns the last 7 days and the previous success is older.',
    ),
  warnings: z.array(z.string()),
  baseline: z
    .boolean()
    .describe('The first read of an app: no events are emitted for the reviews it finds.'),
  lowRatingEvents: z.number().int(),
  lowRatingThreshold: z
    .number()
    .int()
    .optional()
    .describe(
      'The threshold this read used: the workspace setting `reviews.lowRatingThreshold` at that time.',
    ),
  ratingSummary: z.enum(['stored', 'unchanged', 'unavailable', 'off']),
  translation: z
    .object({
      mode: z.literal('auto'),
      attempted: z
        .number()
        .int()
        .describe('New reviews in another language that were considered (at most 20 per sync).'),
      translated: z.number().int(),
      fromCache: z.number().int(),
      chars: z.number().int().describe('Characters sent to the provider.'),
      error: z
        .string()
        .optional()
        .describe('The translation error code when it stopped. It never fails the sync.'),
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
  backoffUntil: timestamp
    .nullable()
    .describe('The scheduler does not read again before this. A manual sync ignores it.'),
  lastGapAt: timestamp.nullable(),
  moreToRead: z.boolean(),
  lastResult: reviewSyncResultSchema.nullable(),
});

const reviewListQuery = z.object({
  rating: z
    .string()
    .optional()
    .describe('One or more ratings from 1 to 5, comma separated: `1,2`.'),
  store: reviewStore.optional(),
  platform: z.enum(PLATFORMS).optional(),
  territory: z.string().optional(),
  language: z.string().optional(),
  version: z.string().optional(),
  status: z
    .string()
    .optional()
    .describe('One or more of new, triaged, replied_in_console, ignored, comma separated.'),
  hasResponse: z.enum(['true', 'false']).optional(),
  q: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Text search in the title and body. Sent in the query string: review text itself never is.',
    ),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Epoch milliseconds; reviews created at or after.'),
  until: z.number().int().min(0).optional().describe('Epoch milliseconds; reviews created before.'),
  sort: z
    .enum(['newest', 'rating', 'updated'])
    .optional()
    .describe('`rating` is the lowest first.'),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .optional()
    .describe('The `nextCursor` of the previous page, with the same filters and sort.'),
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
    byVersion: z.array(
      z.object({ version: z.string(), count: z.number().int(), average: z.number() }),
    ),
    weeks: z
      .array(
        z.object({ weekStart: timestamp, count: z.number().int(), average: z.number().nullable() }),
      )
      .describe('Oldest first, Monday UTC, weeks without reviews included.'),
    territories: z.array(z.object({ value: z.string(), count: z.number().int() })),
    languages: z.array(z.object({ value: z.string(), count: z.number().int() })),
  }),
  storeWide: z
    .array(
      z.object({
        basis: z.literal('store_wide'),
        label: z.string(),
        source: z.literal('itunes_lookup'),
        territory: z.string(),
        average: z.number().nullable(),
        ratingCount: z.number().int().nullable(),
        currentVersionAverage: z.number().nullable(),
        currentVersionCount: z.number().int().nullable(),
        observedAt: timestamp,
      }),
    )
    .describe(
      'The public store-wide rating (App Store only), when it was read. Empty for Google Play: its API has no such number.',
    ),
  unanswered: z.object({
    count: z
      .number()
      .int()
      .describe('Reviews with no developer response, not ignored, rated at or below `maxRating`.'),
    oldestAt: timestamp.nullable().describe('When the oldest of them was written.'),
    maxRating: z
      .number()
      .int()
      .describe('The highest rating counted (the `maxRating` query, default 5: every rating).'),
  }),
  byStatus: z.object({
    new: z.number().int(),
    triaged: z.number().int(),
    replied_in_console: z.number().int(),
    ignored: z.number().int(),
  }),
  sync: reviewSyncStateSchema,
  lowRatingThreshold: z
    .number()
    .int()
    .describe('A review with this rating or lower raises `review.new_low_rating`.'),
  retentionDays: z
    .number()
    .int()
    .nullable()
    .describe('MRM_REVIEW_RETENTION_DAYS; 0 keeps every review.'),
});

// ----- replying to reviews (a store write, off by default: docs/api/reviews.md#replying-to-a-review) ----

const replyStatusEnum = z.enum(['draft', 'sending', 'sent', 'failed', 'unknown']);

export const replyDraftSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  appId: z.string(),
  store: reviewStore,
  text: z
    .string()
    .describe(
      'The plain text that would be published. Written by your team; shown to members who can read reviews.',
    ),
  textHash: z
    .string()
    .describe('SHA-256 hex of `text`. Repeat it as `confirmHash` to send exactly this text.'),
  length: z.number().int(),
  limit: z
    .number()
    .int()
    .describe(
      'What the store allows: 350 for Google Play (documented); 5000 for the App Store (this server\u2019s own cap, unverified).',
    ),
  status: replyStatusEnum.describe(
    '`draft`: not sent. `sending`: a send is in flight. `sent`: published (the App Store may show it as pending for a while). `failed`: the store refused or did not apply it; the draft is kept. `unknown`: it is not known whether it was published; send again to check.',
  ),
  errorCode: z.string().nullable(),
  evidence: z
    .record(z.unknown())
    .nullable()
    .describe('How an unknown outcome was settled by reading the review back. Never the text.'),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  sentAt: timestamp.nullable(),
  sentBy: z.string().nullable(),
  storeResponseId: z.string().nullable(),
});

const replyStateSchema = z.object({
  status: z.enum(['none', 'draft', 'sending', 'sent', 'failed', 'unknown']),
  sentAt: timestamp.nullable(),
});

export const reviewViewSchema = reviewSchema.extend({
  replyDraft: replyDraftSchema
    .nullable()
    .describe('The draft reply of this review, or the record of the last reply sent from here.'),
  reply: replyStateSchema.describe(
    'The state of the reply in one place; `none` without a draft. `developerResponse` is what the store shows.',
  ),
});

const inboxReviewSchema = reviewViewSchema.extend({
  app: z.object({ id: z.string(), name: z.string(), platform: z.enum(PLATFORMS) }),
});

const replyDraftBody = z.object({
  text: z
    .string()
    .max(20000)
    .optional()
    .describe(
      'Plain text. Line breaks are kept; HTML-looking tags, tabs and other control characters are refused. At most the store\u2019s limit.',
    ),
  templateId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Instead of `text`: fill this workspace template (`{{author}}`, `{{app}}`) for this review.',
    ),
});

const replySendBody = z.object({
  confirmHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(
      'The `textHash` of the draft as the person saw it. A draft that changed since answers `409 stale_draft`.',
    ),
});

const replyTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const replyTemplateBody = z.object({
  name: z.string().min(1).max(80),
  body: z.string().min(1).max(5000).describe('Plain text with `{{author}}` and `{{app}}`.'),
});

const replyTranslateBody = z.object({
  text: z.string().min(1).max(5000),
  target: z.string().max(20),
  source: z.string().max(20).optional(),
});

const replyConfigSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'MRM_REVIEW_REPLY_ENABLED. While false every reply route answers `409 reply_disabled`.',
    ),
  envName: z.string(),
  limits: z.object({ appstoreconnect: z.number().int(), googleplay: z.number().int() }),
  sendsPerHour: z.number().int(),
  translation: z.object({ available: z.boolean() }),
  templates: z.object({ max: z.number().int(), placeholders: z.array(z.string()) }),
});

const inboxQuery = reviewListQuery.extend({
  appIds: z
    .string()
    .optional()
    .describe(
      'Only these apps, comma separated (at most 50). A token limited to some apps sees only those.',
    ),
  assignee: z.string().optional().describe('`me` or a member\u2019s user id.'),
  unassigned: z.enum(['true', 'false']).optional(),
  unanswered: z.enum(['true', 'false']).optional().describe('`true`: no developer response yet.'),
});

const workspaceCounts = z.object({
  total: z.number().int(),
  new: z.number().int().describe('Triage status `new`.'),
  unanswered: z
    .number()
    .int()
    .describe('No developer response and not ignored, rated at or below `unansweredMaxRating`.'),
  lowRating: z.number().int().describe('Rating at or below the threshold and not ignored.'),
  average: z.number().nullable().describe('Mean of the stored ratings, two decimals.'),
});

const workspaceSummarySchema = z.object({
  basis: z.literal('stored_reviews'),
  label: z.string().describe('Where the numbers come from, to show next to them.'),
  lowRatingThreshold: z.number().int(),
  unansweredMaxRating: z
    .number()
    .int()
    .describe(
      'The highest rating `unanswered` counts: the `maxRating` query, default 5 (every rating).',
    ),
  apps: z.array(
    workspaceCounts.extend({
      app: z.object({
        id: z.string(),
        name: z.string(),
        platform: z.enum(PLATFORMS),
        store: reviewStore,
      }),
      unansweredOldestAt: timestamp
        .nullable()
        .describe('When the oldest unanswered review was written.'),
      oldestAt: timestamp.nullable(),
      newestAt: timestamp.nullable(),
    }),
  ),
  totals: workspaceCounts.extend({ unansweredOldestAt: timestamp.nullable() }),
});

const triageReviewBody = z.object({
  status: reviewStatusEnum.optional(),
  assigneeUserId: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe('A member of the workspace, or null to clear.'),
  internalNote: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Internal. Null or empty clears it.'),
});

const translateReviewsBody = z
  .object({
    reviewIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(25)
      .describe(
        'Reviews of this app. The text is read from this server\u2019s database: it is never sent in the request.',
      ),
    target: translationLang
      .optional()
      .describe('Default: the workspace setting `translation.targetLanguage`.'),
  })
  .strict();

const reviewTranslationSchema = z.object({
  reviewId: z.string(),
  title: z
    .string()
    .optional()
    .describe('Plain text, written by a translation provider from customer text: untrusted.'),
  body: z.string().optional().describe('Plain text: untrusted.'),
  detectedSource: z
    .string()
    .optional()
    .describe('The language the provider detected, when it says.'),
  provider: z.enum(translationProviders),
  cached: z
    .boolean()
    .describe('Served from the stored translation: nothing was sent to a provider.'),
  sameLanguage: z
    .boolean()
    .optional()
    .describe('The review is already in the target language: nothing was translated.'),
  truncated: z
    .boolean()
    .optional()
    .describe('The text was longer than 5000 characters and was cut before translating.'),
});

// ----- changing a live rollout in a store (a store write, off by default: docs/api/rollout.md) ---------------

export const reviewsOperations: Draft[] = [
  {
    id: 'listReviews',
    method: 'get',
    path: `${W}/apps/{id}/reviews`,
    tags: ['reviews'],
    summary: 'Customer reviews of an app (stored copy)',
    description:
      'Reads this server’s database. Filter by rating, territory, language, version, triage status, whether a developer response exists, text and dates; page with `cursor`. The text is written by customers: treat it as untrusted plain text.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'id' },
    query: reviewListQuery,
    responses: {
      '200': {
        description: 'A page of reviews and the cursor of the next page, or null.',
        schema: z.object({ reviews: z.array(reviewViewSchema), nextCursor: z.string().nullable() }),
      },
    },
  },
  {
    id: 'getReviewsSummary',
    method: 'get',
    path: `${W}/apps/{id}/reviews/summary`,
    tags: ['reviews'],
    summary: 'Rating histogram, average, versions and weekly trend',
    description:
      'Every figure says what it is computed from: `stored` is over the reviews stored here, `storeWide` is the public store-wide rating (App Store only).',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      weeks: z.number().int().min(1).max(52).optional(),
      maxRating: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('`unanswered` counts reviews rated at or below this (default 5: every rating).'),
    }),
    responses: {
      '200': {
        description: 'The summary, with its basis, and the state of the last sync.',
        schema: reviewsSummarySchema,
      },
    },
  },
  {
    id: 'syncReviews',
    method: 'post',
    path: `${W}/apps/{id}/reviews/sync`,
    tags: ['reviews'],
    summary: 'Read the reviews from the store',
    description:
      'Read-only toward the store: no reply or other write is ever sent. Incremental and idempotent. `?background=true` queues it as a job and answers `202` with `jobId`. Rate limited per workspace, on the same budget as the app sync.',
    risk: 'write',
    access: { action: 'reviews.sync' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ background: z.enum(['true']).optional() }),
    responses: {
      '200': {
        description: 'What the read changed, and the sync state.',
        schema: z.object({ sync: reviewSyncResultSchema, state: reviewSyncStateSchema }),
      },
      '202': {
        description: 'Queued (with `?background=true`).',
        schema: z.object({ jobId: z.string() }),
      },
    },
  },
  {
    id: 'listWorkspaceReviews',
    method: 'get',
    path: `${W}/reviews`,
    tags: ['reviews'],
    summary: 'The reviews of every app in one inbox (stored copy)',
    description:
      'Reads this server\u2019s database. The filters of the per app list, plus `appIds`, `assignee` (`me` or a user id), `unassigned` and `unanswered`; keyset paging with `cursor`. Every item carries its app. A token limited to some apps sees only those apps. The text is written by customers: untrusted plain text.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'list' },
    query: inboxQuery,
    responses: {
      '200': {
        description: 'A page of reviews and the cursor of the next page, or null.',
        schema: z.object({
          reviews: z.array(inboxReviewSchema),
          nextCursor: z.string().nullable(),
        }),
      },
    },
  },
  {
    id: 'getWorkspaceReviewsSummary',
    method: 'get',
    path: `${W}/reviews/summary`,
    tags: ['reviews'],
    summary: 'Counts of new, unanswered and low rated reviews per app and in total',
    description:
      'Over the stored reviews only, with its basis stated. No review text and no names. A token limited to some apps counts only those apps.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'list' },
    query: z.object({
      maxRating: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe(
          '`unanswered` and `unansweredOldestAt` count reviews rated at or below this (default 5: every rating, the numbers older clients know).',
        ),
    }),
    responses: {
      '200': { description: 'Counts per app and the totals.', schema: workspaceSummarySchema },
    },
  },
  {
    id: 'getReviewReplyConfig',
    method: 'get',
    path: `${W}/reviews/reply-config`,
    tags: ['reviews'],
    summary: 'Whether replying is switched on, and its limits',
    risk: 'read',
    access: { action: 'reviews.read' },
    responses: {
      '200': {
        description: 'The switch, the limits and what is available.',
        schema: replyConfigSchema,
      },
    },
  },
  {
    id: 'listReviewReplyTemplates',
    method: 'get',
    path: `${W}/reviews/reply-templates`,
    tags: ['reviews'],
    summary: 'Reply templates of the workspace',
    risk: 'read',
    access: { action: 'reviews.read' },
    responses: {
      '200': {
        description: 'The templates.',
        schema: z.object({ templates: z.array(replyTemplateSchema) }),
      },
    },
  },
  {
    id: 'createReviewReplyTemplate',
    method: 'post',
    path: `${W}/reviews/reply-templates`,
    tags: ['reviews'],
    summary: 'Create a reply template',
    description: 'At most 50 per workspace. `409 reply_disabled` while replying is switched off.',
    risk: 'write',
    access: { action: 'reviews.triage' },
    body: replyTemplateBody,
    responses: {
      '201': { description: 'The template.', schema: z.object({ template: replyTemplateSchema }) },
    },
  },
  {
    id: 'updateReviewReplyTemplate',
    method: 'put',
    path: `${W}/reviews/reply-templates/{templateId}`,
    tags: ['reviews'],
    summary: 'Replace a reply template',
    risk: 'write',
    access: { action: 'reviews.triage' },
    body: replyTemplateBody,
    responses: {
      '200': { description: 'The template.', schema: z.object({ template: replyTemplateSchema }) },
    },
  },
  {
    id: 'deleteReviewReplyTemplate',
    method: 'delete',
    path: `${W}/reviews/reply-templates/{templateId}`,
    tags: ['reviews'],
    summary: 'Delete a reply template',
    risk: 'destructive',
    access: { action: 'reviews.triage' },
    responses: { '204': none },
  },
  {
    id: 'getReview',
    method: 'get',
    path: `${W}/apps/{id}/reviews/{reviewId}`,
    tags: ['reviews'],
    summary: 'One review with its reply draft and reply state',
    description: 'Reads this server\u2019s database.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'The review.', schema: z.object({ review: reviewViewSchema }) },
    },
  },
  {
    id: 'saveReviewReplyDraft',
    method: 'put',
    path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft`,
    tags: ['reviews'],
    summary: 'Write or replace the draft reply of a review',
    description:
      'Nothing is sent to a store. Needs `reviews.triage`. One draft per review; saving over a sent reply makes it a draft again. Refused while a send is in progress or its outcome is unknown. `409 reply_disabled` while replying is switched off. Audited by length and hash, never by text.',
    risk: 'write',
    access: { action: 'reviews.triage' },
    appScope: { kind: 'param', name: 'id' },
    body: replyDraftBody,
    responses: {
      '200': { description: 'The draft.', schema: z.object({ draft: replyDraftSchema }) },
    },
  },
  {
    id: 'deleteReviewReplyDraft',
    method: 'delete',
    path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft`,
    tags: ['reviews'],
    summary: 'Delete the draft reply of a review',
    description:
      'Removes only this server\u2019s draft (or its record of a sent reply); a published reply stays in the store.',
    risk: 'destructive',
    access: { action: 'reviews.triage' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '204': none },
  },
  {
    id: 'translateReviewReplyDraft',
    method: 'post',
    path: `${W}/apps/{id}/reviews/{reviewId}/reply-draft/translate`,
    tags: ['reviews'],
    summary: 'Suggest a translation of a draft',
    description:
      'Only when translation is set up (`translation.available` in the reply config), else `409 translation_unavailable`. Returns text; nothing is saved or sent.',
    risk: 'read',
    access: { action: 'reviews.triage' },
    appScope: { kind: 'param', name: 'id' },
    body: replyTranslateBody,
    responses: {
      '200': { description: 'The suggested text.', schema: z.object({ text: z.string() }) },
    },
  },
  {
    id: 'sendReviewReply',
    method: 'post',
    path: `${W}/apps/{id}/reviews/{reviewId}/reply`,
    tags: ['reviews'],
    summary: 'Publish the draft reply in the store (public, not recallable here)',
    description:
      'A STORE WRITE: the text is published publicly in the App Store or Google Play in the organisation\u2019s name. Needs `reviews.reply` (owner and admin; a token only when its actions name it) and `MRM_REVIEW_REPLY_ENABLED=true`. `confirmHash` must be the hash of the current draft (`409 stale_draft` otherwise); a second send of the same text is `409 already_sent`; one send per review at a time (`409 send_in_progress`); 30 an hour per workspace (`429 rate_limited`). Never retried: a timeout is checked by reading the review back and the answer is `200` with the settled state, `409 outcome_unknown`, or `502 send_failed` with the draft kept. Audited as `review.reply_sent` / `review.reply_failed` (ids, store, length, hash: never the text) and emitted as the event `review.reply_sent`.',
    risk: 'destructive',
    access: { action: 'reviews.reply' },
    appScope: { kind: 'param', name: 'id' },
    body: replySendBody,
    responses: {
      '200': {
        description: 'The reply as settled and the refreshed review.',
        schema: z.object({
          reply: replyDraftSchema,
          review: reviewViewSchema,
          confirmedByReread: z
            .boolean()
            .describe(
              'True when the send\u2019s outcome was unknown and reading the review back showed the reply.',
            ),
        }),
      },
    },
  },
  {
    id: 'translateReviews',
    method: 'post',
    path: `${W}/apps/{id}/reviews/translate`,
    tags: ['reviews'],
    summary: 'Translate stored reviews',
    description:
      'Sends the text of up to 25 stored reviews to the translation provider set in the workspace settings (`translation.provider`; Google by default) and keeps the translations, so a second request is served from the cache. Needs `translation.enabled`; otherwise `422 translation_not_configured`. Errors: `422 translation_auth`, `translation_quota`, `translation_unsupported_language`, `429 translation_rate_limited` (with `Retry-After`), `429 translation_budget` (the daily character budget), `502`/`504 translation_unavailable`. Rate limited per workspace. Review text is never logged or audited; the audit entry `review.translate` has counts and the provider only.',
    risk: 'write',
    access: { action: 'reviews.translate' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: translateReviewsBody,
    responses: {
      '200': {
        description: 'One entry per found review.',
        schema: z.object({
          provider: z.enum(translationProviders),
          target: z.string(),
          translations: z.array(reviewTranslationSchema),
          notFound: z.array(z.string()),
          cached: z.boolean().describe('Every review was served from the cache.'),
        }),
      },
    },
  },
  {
    id: 'triageReview',
    method: 'patch',
    path: `${W}/apps/{id}/reviews/{reviewId}`,
    tags: ['reviews'],
    summary: 'Set the triage status, assignee or internal note of a review',
    description:
      'Internal only: it changes this server’s database and nothing in a store (replying is `sendReviewReply`, a separate right). Audited without the note or the review text.',
    risk: 'write',
    access: { action: 'reviews.triage' },
    appScope: { kind: 'param', name: 'id' },
    body: triageReviewBody,
    responses: {
      '200': { description: 'The review.', schema: z.object({ review: reviewSchema }) },
    },
  },
];
