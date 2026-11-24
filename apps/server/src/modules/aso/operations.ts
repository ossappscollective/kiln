import { PLATFORMS } from '@kiln/core';
import { z } from 'zod';
import { type Draft, none, object, timestamp, W } from '../../operations/shared.ts';
import { addCompetitorBody, addKeywordsBody, updateKeywordBody } from './routes.ts';

// ----- ASO: keyword ranks and competitors from public store data ---------------------------------------
const asoPlatform = z.enum(PLATFORMS);

const asoStore = z.enum(['app_store', 'google_play']);

const asoRankChangeSchema = z.object({
  kind: z.enum(['first', 'same', 'up', 'down', 'entered', 'dropped', 'still_unranked']),
  delta: z
    .number()
    .int()
    .optional()
    .describe('Places gained (positive) or lost (negative) when both checks ranked.'),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
});

const reviewScheduleShape = z.object({
  mode: z.enum(['off', 'daily', 'weekly']),
  weekday: z.number().int().nullable(),
  timezone: z.string().nullable(),
});
const reviewScheduleSchema = z.object({
  schedule: reviewScheduleShape,
  paused: z.boolean(),
  maxCompetitors: z.number().int(),
  maxReviews: z.number().int(),
  updatedAt: timestamp.nullable(),
  updatedBy: z.string().nullable(),
  nextRunAt: timestamp.nullable(),
  limits: z.object({ maxCompetitors: z.number().int(), maxReviews: z.number().int() }),
  competitors: z.array(
    z.object({
      competitorId: z.string(),
      name: z.string(),
      store: z.string(),
      supported: z
        .boolean()
        .describe('false: Google Play, which has no official API for the reviews of another app.'),
      override: z
        .object({ mode: z.enum(['off', 'daily', 'weekly']), weekday: z.number().int().nullable() })
        .nullable(),
      effective: reviewScheduleShape,
      lastReadAt: timestamp.nullable(),
      newCount: z.number().int(),
      failures: z.number().int(),
      lastError: z
        .string()
        .nullable()
        .describe('A code of the last failed read, such as timeout, rate_limited or failed.'),
      backoffUntil: timestamp.nullable(),
      nextRunAt: timestamp.nullable(),
    }),
  ),
  canEdit: z.boolean(),
  notice: z.string(),
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
  state: z
    .enum(['ranked', 'not_ranked'])
    .nullable()
    .describe(
      'Result of the last successful check. `not_ranked` means the app is not within the first `total` results; it never means the store could not be read.',
    ),
  rank: z.number().int().nullable().describe('1 is the first result.'),
  total: z.number().int().nullable().describe('How many results that check looked at.'),
  previous: z
    .object({ state: z.enum(['ranked', 'not_ranked']), rank: z.number().int().nullable() })
    .nullable(),
  change: asoRankChangeSchema.nullable().describe('How the last two successful checks compare.'),
  error: z
    .string()
    .nullable()
    .describe('Why the latest attempt failed (a short code); cleared by the next success.'),
});

const asoKeywordResultSchema = z.object({
  index: z.number().int().describe('The position of the item in the request.'),
  status: z.enum(['created', 'exists', 'invalid', 'limit']),
  keyword: asoKeywordSchema.optional().describe('For created and exists.'),
  message: z.string().optional().describe('For invalid and limit.'),
});

const asoChangeSchema = z.object({
  field: z
    .string()
    .describe(
      'version, rating, rating_count, price, title, subtitle, description, screenshots or media.',
    ),
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
  descriptionExcerpt: z
    .string()
    .nullable()
    .describe(
      'The first 1000 characters. Written by the developer of that app: untrusted plain text.',
    ),
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
  keywords: z.object({
    due: z.number().int(),
    checked: z.number().int(),
    ranked: z.number().int(),
    notRanked: z.number().int(),
    failed: z.number().int(),
    cached: z.number().int(),
    moved: z.number().int(),
  }),
  competitors: z.object({
    due: z.number().int(),
    checked: z.number().int(),
    changed: z.number().int(),
    notFound: z.number().int(),
    failed: z.number().int(),
  }),
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
  keywords: z.object({
    total: z.number().int(),
    ranked: z.number().int(),
    notRanked: z.number().int(),
    unchecked: z.number().int(),
    failing: z.number().int(),
    top3: z.number().int(),
    top10: z.number().int(),
  }),
  movers: z.array(
    z.object({
      keywordId: z.string(),
      term: z.string(),
      country: z.string(),
      locale: z.string(),
      kind: z.string(),
      from: z.number().int().nullable(),
      to: z.number().int().nullable(),
      delta: z.number().int().nullable(),
    }),
  ),
  competitors: z.object({
    total: z.number().int(),
    notFound: z.number().int(),
    changedRecently: z.number().int(),
  }),
  state: asoStateSchema,
});

const asoLocaleQuery = z.object({
  locale: z
    .string()
    .optional()
    .describe('A language tag such as en-US. Default: the locale most tracked keywords use.'),
  limit: z.number().int().min(1).max(100).optional(),
});

const asoBackgroundQuery = z.object({
  background: z.enum(['true']).optional(),
  scope: z.enum(['all', 'keywords', 'competitors']).optional().describe('Default all.'),
});

const asoNote = 'Reads this server’s database only: no store is contacted. ';

export const asoOperations: Draft[] = [
  {
    id: 'getAsoConfig',
    method: 'get',
    path: `${W}/aso/config`,
    tags: ['aso'],
    summary: 'ASO: what is switched on, the limits and the Google Play warning',
    description:
      'Apple is read through the documented iTunes Search API. Google Play has no official API: `play.enabled` is false unless the operator set KILN_ASO_PLAY_UNOFFICIAL_ENABLED=true, and `play.notice` is the warning about its terms of service. Admins and owners hold `aso.manage`.',
    risk: 'read',
    access: { action: 'aso.read' },
    responses: {
      '200': {
        description: 'The switches, the schedule, the retention and the limits.',
        schema: z.object({
          apple: z.object({
            enabled: z.boolean(),
            source: z.string(),
            documentedCallsPerMinute: z.number().int(),
          }),
          play: z.object({
            enabled: z.boolean(),
            unofficial: z.boolean(),
            notice: z.string(),
            howToEnable: z.string(),
          }),
          schedule: z.object({
            intervalMinutes: z.number().int().describe('0: scheduled refreshes are off.'),
          }),
          retentionDays: z.number().int().describe('0: kept for ever.'),
          limits: z.object({
            maxKeywordsPerApp: z.number().int(),
            maxCompetitorsPerApp: z.number().int(),
            maxChecksPerRun: z.number().int(),
            rankDepth: z.number().int(),
            maxKeywordsPerRequest: z.number().int(),
          }),
          rankMoveThreshold: z
            .number()
            .int()
            .describe('The workspace setting `aso.rankMoveThreshold`.'),
        }),
      },
    },
  },
  {
    id: 'getAsoSummary',
    method: 'get',
    path: `${W}/apps/{id}/aso/summary`,
    tags: ['aso'],
    summary: 'ASO overview of an app: keyword counts, biggest moves, competitors, refresh state',
    description: `${asoNote}The state says when the app was last refreshed and why a refresh failed.`,
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '200': { description: 'The overview.', schema: asoSummarySchema } },
  },
  {
    id: 'listAsoKeywords',
    method: 'get',
    path: `${W}/apps/{id}/aso/keywords`,
    tags: ['aso'],
    summary: 'The tracked keywords of an app with their latest rank',
    description:
      asoNote +
      'Filter by `country`, `locale` and `tag`. The same term in two storefronts is two keywords (see `getAsoMarkets` for one row per term).',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      country: z.string().optional(),
      locale: z.string().optional(),
      tag: z.string().optional(),
    }),
    responses: {
      '200': {
        description: 'The keywords and the limit.',
        schema: z.object({
          keywords: z.array(asoKeywordSchema),
          limits: z.object({ maxKeywordsPerApp: z.number().int() }),
        }),
      },
    },
  },
  {
    id: 'addAsoKeywords',
    method: 'post',
    path: `${W}/apps/{id}/aso/keywords`,
    tags: ['aso'],
    summary: 'Track keywords (up to 50 at once)',
    description:
      'Each item is judged on its own: a bad, duplicate or over-the-limit item does not stop the others. `country` defaults to `us`, `locale` to the storefront’s main language. A keyword is never checked here (no store is contacted); the next refresh does it. Audited with ids and a count, never the terms. `201` when at least one was created, else `200`.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    body: addKeywordsBody,
    bodyLimit: 64 * 1024,
    responses: {
      '200': {
        description: 'Nothing was created: every item exists, is invalid or hit the limit.',
        schema: z.object({
          results: z.array(asoKeywordResultSchema),
          summary: z.object({
            created: z.number().int(),
            exists: z.number().int(),
            invalid: z.number().int(),
            limit: z.number().int(),
          }),
        }),
      },
      '201': {
        description: 'At least one keyword was created.',
        schema: z.object({
          results: z.array(asoKeywordResultSchema),
          summary: z.object({
            created: z.number().int(),
            exists: z.number().int(),
            invalid: z.number().int(),
            limit: z.number().int(),
          }),
        }),
      },
    },
  },
  {
    id: 'updateAsoKeyword',
    method: 'patch',
    path: `${W}/apps/{id}/aso/keywords/{keywordId}`,
    tags: ['aso'],
    summary: 'Change the tag, notes or priority of a keyword',
    description:
      'The term, country and locale cannot change: track a new keyword instead. Null or empty clears a tag or a note.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    body: updateKeywordBody,
    responses: {
      '200': { description: 'The keyword.', schema: z.object({ keyword: asoKeywordSchema }) },
    },
  },
  {
    id: 'deleteAsoKeyword',
    method: 'delete',
    path: `${W}/apps/{id}/aso/keywords/{keywordId}`,
    tags: ['aso'],
    summary: 'Stop tracking a keyword and delete its checks',
    risk: 'destructive',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '204': none },
  },
  {
    id: 'getAsoKeywordHistory',
    method: 'get',
    path: `${W}/apps/{id}/aso/keywords/{keywordId}/history`,
    tags: ['aso'],
    summary: 'The rank checks of a keyword over time, with the trend',
    description:
      asoNote +
      'Oldest first (the newest `limit`). A check with `rank: null` means the app was not within the first `total` results. Only successful checks are stored; a failed attempt leaves no row.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      limit: z.number().int().min(1).max(1000).optional(),
      since: z.number().int().optional().describe('Epoch milliseconds.'),
    }),
    responses: {
      '200': {
        description: 'The keyword, its checks and the trend.',
        schema: z.object({
          keyword: asoKeywordSchema,
          checks: z.array(
            z.object({
              id: z.string(),
              checkedAt: timestamp,
              rank: z.number().int().nullable(),
              total: z.number().int(),
              source: z.string(),
            }),
          ),
          trend: z.object({
            direction: z.enum(['up', 'down', 'flat', 'unknown']),
            delta: z.number().int().nullable(),
            latest: z.number().int().nullable(),
            best: z.number().int().nullable(),
            worst: z.number().int().nullable(),
            samples: z.number().int(),
          }),
        }),
      },
    },
  },
  {
    id: 'listAsoCompetitors',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors`,
    tags: ['aso'],
    summary: 'The followed competitors with their latest public snapshot',
    description: asoNote,
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The competitors and the limit.',
        schema: z.object({
          competitors: z.array(asoCompetitorSchema),
          limits: z.object({ maxCompetitorsPerApp: z.number().int() }),
        }),
      },
    },
  },
  {
    id: 'listAsoCompetitorReviews',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitor-reviews`,
    tags: ['aso'],
    summary:
      'Reviews of the followed App Store competitors: average, trend, latest, and our own app beside them',
    description:
      "Reads what Kiln stored from Apple's public customer-reviews feed (no store is called). `days` 1 to 90, default 28. A Google Play competitor is listed with `state: unavailable`: Google Play has no official way to read the reviews of an app you do not own, and Kiln does not scrape it. `own` (the same figures for this app, from its stored reviews) is null without `reviews.read`. Docs: docs/api/competitor-reviews.md.",
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'Per competitor figures, our own figures, the retention and the source.',
        schema: z.object({
          days: z.number().int(),
          competitors: z.array(
            z.object({
              competitorId: z.string(),
              name: z.string(),
              store: asoStore,
              country: z.string(),
              state: z.enum(['ok', 'unavailable']),
              reason: z.enum(['play_has_no_review_api']).optional(),
              checkedAt: timestamp.nullable(),
              count: z.number().int(),
              average: z.number().nullable(),
              trend: z.object({ earlier: z.number().nullable(), recent: z.number().nullable() }),
              stars: z.array(z.number().int()).describe('Reviews with 1, 2, 3, 4 and 5 stars.'),
              latest: z.array(
                z.object({
                  id: z.string(),
                  rating: z.number().int(),
                  title: z.string(),
                  text: z.string().describe('Cut to 300 characters. The author is not kept.'),
                  version: z.string().nullable(),
                  at: timestamp,
                }),
              ),
            }),
          ),
          own: z
            .object({
              count: z.number().int(),
              average: z.number().nullable(),
              trend: z.object({ earlier: z.number().nullable(), recent: z.number().nullable() }),
            })
            .nullable(),
          retentionDays: z.number().int(),
          source: z.string(),
          notice: z.string(),
        }),
      },
    },
  },
  {
    id: 'refreshAsoCompetitorReviews',
    method: 'post',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/reviews/refresh`,
    tags: ['aso'],
    summary: 'Read the newest public reviews of an App Store competitor',
    description:
      "READS APPLE'S PUBLIC CUSTOMER-REVIEWS FEED once for the competitor and its storefront (SSRF-safe, rate limited, at most once per 15 minutes per competitor: a read inside that window returns `state: recent` and calls nothing). Stores what the feed gives (id, stars, title, text, version, day; never the author), keeps 90 days and 200 reviews per competitor. `409 play_reviews_not_available` for a Google Play competitor. Audited with counts, never text.",
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What was read.',
        schema: z.object({
          competitorId: z.string(),
          state: z.enum(['read', 'recent']),
          fetched: z.number().int(),
          stored: z.number().int(),
          checkedAt: timestamp,
          newCount: z.number().int().describe('Reviews of this read that were not stored before.'),
        }),
      },
    },
  },
  {
    id: 'getAsoCompetitorReviewSchedule',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitor-review-schedule`,
    tags: ['aso'],
    summary: 'The schedule of the reads of competitor reviews, and the state of each competitor',
    description:
      'Off by default. `schedule` is `{ mode: off | daily | weekly, weekday (0 = Sunday), timezone (IANA name, null = UTC) }`; `paused`, `maxCompetitors` and `maxReviews` are the cost guards. Each competitor has its `override` (null follows the app), the `effective` schedule, `lastReadAt`, `newCount` (new reviews in the last read), `failures`, `lastError` (a code such as `timeout`), `backoffUntil` and `nextRunAt`. Apple only: a Google Play competitor has `supported: false`. Reads the database only.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': { description: 'The schedule and the state.', schema: reviewScheduleSchema },
    },
  },
  {
    id: 'updateAsoCompetitorReviewSchedule',
    method: 'put',
    path: `${W}/apps/{id}/aso/competitor-review-schedule`,
    tags: ['aso'],
    summary: 'Change the schedule of the reads of competitor reviews (including pause and resume)',
    description:
      'A field you leave out keeps its value. `weekly` needs a `weekday`. `paused: true` stops the reads without losing the schedule; `false` resumes. A new schedule waits for its next run instead of reading at once. Needs `aso.write`. Audited as `aso.competitor_review_schedule_update` with each field from and to. The reads themselves go through the job queue with the same limits as the other store reads.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    body: z
      .object({
        mode: z.enum(['off', 'daily', 'weekly']).optional(),
        weekday: z.number().int().min(0).max(6).nullable().optional(),
        timezone: z.string().max(64).nullable().optional(),
        paused: z.boolean().optional(),
        maxCompetitors: z.number().int().min(1).max(10).optional(),
        maxReviews: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    responses: { '200': { description: 'The schedule now.', schema: reviewScheduleSchema } },
  },
  {
    id: 'updateAsoCompetitorReviewOverride',
    method: 'put',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/review-schedule`,
    tags: ['aso'],
    summary: 'Give one competitor its own schedule for reading reviews (or follow the app again)',
    description:
      '`mode` is `off`, `daily`, `weekly` (with `weekday`) or `null` to follow the app. A Google Play competitor is refused with `409 play_reviews_not_available`. Needs `aso.write`. Audited.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    body: z
      .object({
        mode: z.enum(['off', 'daily', 'weekly']).nullable(),
        weekday: z.number().int().min(0).max(6).nullable().optional(),
      })
      .strict(),
    responses: { '200': { description: 'The schedule now.', schema: reviewScheduleSchema } },
  },
  {
    id: 'searchAsoCompetitors',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors/search`,
    tags: ['aso'],
    summary: 'Search the App Store by name for an app to follow as a competitor',
    description:
      "READS THE PUBLIC STORE (Apple's public search, through the shared cache, rate limit and cool-down); nothing is stored. `q` is 2 to 100 characters, `country` two letters (default us). At most 10 results with plain, capped text and an https icon; `state` says whether the app is this app itself (`own`) or already followed in that storefront (`followed`). `409 search_app_store_only` for an Android app: Google Play has no official search and Kiln does not scrape it, so paste the package name or the play.google.com address to `addAsoCompetitor`. Rate limited per workspace.",
    risk: 'read',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ q: z.string().min(2).max(100), country: z.string().optional() }),
    responses: {
      '200': {
        description: 'The storefront searched and the matching apps.',
        schema: z.object({
          country: z.string(),
          cached: z.boolean(),
          results: z.array(
            z.object({
              externalId: z.string().describe('The numeric App Store id.'),
              name: z.string(),
              developer: z.string().nullable(),
              category: z.string().nullable(),
              iconUrl: z.string().nullable().describe('An https address.'),
              iconRef: z
                .string()
                .nullable()
                .describe(
                  "An opaque ref for `GET .../competitors/search-image` (the browser cannot load Apple's image CDN itself).",
                ),
              ratingAverage: z.number().nullable(),
              ratingCount: z.number().int().nullable(),
              price: z.string().nullable(),
              state: z.enum(['available', 'followed', 'own']),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'addAsoCompetitor',
    method: 'post',
    path: `${W}/apps/{id}/aso/competitors`,
    tags: ['aso'],
    summary: 'Follow an app of the store as a competitor',
    description:
      'READS THE PUBLIC STORE once (a lookup) so the name is real and the first snapshot exists. `externalId` is the numeric App Store id (also `id123` or an apps.apple.com address) or the Android package name (also a play.google.com address). `409 play_unofficial_disabled` for an Android app while Google Play reading is off. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    body: addCompetitorBody,
    responses: {
      '201': {
        description: 'The competitor, with its first snapshot.',
        schema: z.object({ competitor: asoCompetitorSchema }),
      },
    },
  },
  {
    id: 'deleteAsoCompetitor',
    method: 'delete',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}`,
    tags: ['aso'],
    summary: 'Stop following a competitor and delete its snapshots',
    risk: 'destructive',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '204': none },
  },
  {
    id: 'listAsoCompetitorChanges',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/changes`,
    tags: ['aso'],
    summary: 'The listing changes Kiln found on an App Store competitor, newest first',
    description:
      asoNote +
      "Newest first, paged with `before` (the `detectedAt` of the last change you have) and `limit` (1 to 50, default 10). Reads what Kiln stored: no store is called. History starts when the competitor was followed (`watching.since`); a Google Play competitor is `watching.state: not_watched` because Kiln does not read Google Play pages. Kept 180 days and 200 changes per competitor. Each change has `before` and `after` (image addresses of Apple's CDN and short texts, all public); show images through `getAsoCompetitorImage` with the refs `c.<id>.<b|a>.<icon|p|i>.<n>`. Docs: docs/api/aso.md.",
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      before: z.number().int().optional(),
    }),
    responses: {
      '200': {
        description: 'The changes, newest first.',
        schema: z.object({
          competitorId: z.string(),
          watching: z.object({
            state: z.enum(['watched', 'not_watched']),
            since: timestamp.optional(),
            reason: z.literal('play_pages_not_read').optional(),
          }),
          lastCheckedAt: timestamp.nullable(),
          retentionDays: z.number().int(),
          hasMore: z.boolean(),
          changes: z.array(
            z.object({
              id: z.string(),
              competitorId: z.string(),
              detectedAt: timestamp,
              kinds: z.array(z.string()),
              changes: z
                .array(z.record(z.string(), z.unknown()))
                .describe(
                  '`kind` screenshots (`device` iphone or ipad, `added`, `removed`, `replaced`, `reordered`, `before[]`, `after[]`), icon, name, description, releaseNotes, version, price, category (`before`, `after` text) and rating, ratingCount (thousandths of a star, a count).',
                ),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'checkAsoCompetitor',
    method: 'post',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/check`,
    tags: ['aso'],
    summary: 'Check an App Store competitor now (Check now)',
    description:
      "READS APPLE'S PUBLIC LOOKUP once for the competitor (the shared cache, rate limit and cool-down of the refresh; the same recording, so a change is in the list, the Timeline and the alerts). A competitor read in the last 5 minutes returns `state: recent` and calls nothing. `409 play_listing_not_watched` for a Google Play competitor: Kiln does not read Google Play pages. `429` with `Retry-After` when limited.",
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'What was read.',
        schema: z.object({
          competitorId: z.string(),
          state: z.enum(['checked', 'recent', 'not_found']),
          changes: z.number().int(),
          checkedAt: timestamp,
        }),
      },
    },
  },
  {
    id: 'getAsoCompetitorImage',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/image`,
    tags: ['aso'],
    summary:
      "A thumbnail of a stored competitor screenshot or icon (a proxy: the browser never contacts Apple's CDN)",
    description:
      'The client sends a `ref` into what Kiln stored (`icon`, `s.p.<n>` iPhone and `s.i.<n>` iPad of the latest read, `c.<changeId>.<b|a>.<icon|p|i>.<n>` of a change), never an address. Fetches from `mzstatic.com` only (https, redirects checked, resolved addresses checked, 2 MiB cap, type sniffed from the bytes, per workspace limit) and serves it with the safe image headers, `Cache-Control: private` with `ETag` and stale-while-revalidate. `404` for a ref that names nothing stored.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({
      ref: z.string(),
      size: z.string().optional().describe('96, 160 (default), 320 or 640: the long side.'),
    }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/jpeg' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'getAsoCompetitorSearchImage',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors/search-image`,
    tags: ['aso'],
    summary: 'The icon of a competitor search result (the same proxy)',
    description:
      'The `iconRef` of a result of `searchAsoCompetitors` (kept in memory for 15 minutes); `404` when it is not known any more. Same host allowlist, caps and headers as `getAsoCompetitorImage`. Needs `aso.write` like the search.',
    risk: 'read',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: z.object({ ref: z.string(), size: z.string().optional() }),
    responses: {
      '200': { description: 'The image.', contentType: 'image/jpeg' },
      '304': { description: 'Not modified.' },
    },
  },
  {
    id: 'getAsoCompetitorHistory',
    method: 'get',
    path: `${W}/apps/{id}/aso/competitors/{competitorId}/history`,
    tags: ['aso'],
    summary: 'The stored snapshots of a competitor and its latest change',
    description:
      asoNote +
      'Newest first. A snapshot is stored on the first look, when something changed, and as a heartbeat. `diff` is the newest snapshot that recorded changes, with the one before it.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    responses: {
      '200': {
        description: 'The competitor, its snapshots and the latest change.',
        schema: z.object({
          competitor: asoCompetitorSchema,
          snapshots: z.array(asoSnapshotSchema),
          diff: z
            .object({
              from: z.string().nullable(),
              to: z.string(),
              at: timestamp,
              changes: z.array(asoChangeSchema),
            })
            .nullable(),
        }),
      },
    },
  },
  {
    id: 'getAsoCoach',
    method: 'get',
    path: `${W}/apps/{id}/aso/coach`,
    tags: ['aso'],
    summary: 'Ranked next steps for the ASO of an app',
    description:
      asoNote +
      'Up to 8 steps in a fixed order of importance (track keywords, check ranks, ranks that dropped, tracked keywords missing from the listing, keywords set in the App Store keyword field that are not tracked, competitors ranking above the app, keyword field waste, unused characters, locales with no keyword text, follow a competitor). Every number is a count taken from stored data; there is no search volume or predicted gain. `link.to` names the ASO view or the listing to open. Facts about how a store indexes text are UNVERIFIED and say so in `detail`.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The steps and what they were worked out from.',
        schema: z.object({
          actions: z.array(
            z.object({
              id: z.string(),
              kind: z.enum([
                'track_keywords',
                'check_ranks',
                'rank_dropped',
                'not_in_listing',
                'untracked_set_keywords',
                'competitor_above',
                'keyword_field_waste',
                'unused_characters',
                'untapped_locale',
                'follow_competitors',
              ]),
              position: z.number().int().describe('1 is first.'),
              title: z.string(),
              detail: z.string(),
              items: z.array(z.string()).describe('At most 5 short lines.'),
              more: z.number().int(),
              link: z.object({
                to: z.enum([
                  'keywords',
                  'keywords_add',
                  'listing_keywords',
                  'competitors',
                  'fit',
                  'ideas',
                  'listing',
                ]),
                locale: z.string().optional(),
                label: z.string(),
              }),
            }),
          ),
          basedOn: z.object({
            keywords: z.number().int(),
            competitors: z.number().int(),
            listingLocales: z.number().int(),
            lastCheckAt: timestamp.nullable(),
            listingReadAt: timestamp.nullable(),
          }),
        }),
      },
    },
  },
  {
    id: 'getAsoFit',
    method: 'get',
    path: `${W}/apps/{id}/aso/fit`,
    tags: ['aso'],
    summary: 'How well the live listing covers the tracked keywords',
    description:
      asoNote +
      'Per locale of the tracked keywords, against the stored live listing (sync the app first). `status` is strong, covered, partial, description_only (iOS: only in the description, which the store may not search) or missing. `indexedFields` and `assumptions` say which fields count: these are UNVERIFIED against the stores’ own documentation. For iOS the hidden keyword field is measured against its 100 byte budget (`keywordField`).',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({ locale: z.string().optional() }),
    partial: true,
    responses: {
      '200': {
        description: 'Fit per locale.',
        schema: z.object({
          readAt: timestamp.nullable().describe('When the listing was last read from the store.'),
          error: z.string().nullable(),
          locales: z.array(
            z.object({
              locale: z.string(),
              listingLocale: z.string().nullable(),
              channel: z.enum(['live', 'editable']).nullable(),
              keywords: z.number().int(),
              fit: object.nullable(),
              fields: object
                .nullable()
                .describe(
                  'The stored listing text the fit was worked out from (title, subtitle, keywords, shortDescription, description).',
                ),
            }),
          ),
          indexedFields: z.array(z.string()),
          listingLocales: z
            .array(z.string())
            .describe('Every locale the stored listing has text for (not only the tracked ones).'),
          assumptions: z.array(z.string()),
        }),
      },
    },
  },
  {
    id: 'getAsoIdeas',
    method: 'get',
    path: `${W}/apps/{id}/aso/ideas`,
    tags: ['aso'],
    summary: 'Keyword ideas mined from the own listing and the followed competitors',
    description:
      asoNote +
      'Phrases that occur often in those stored texts and are not tracked yet. `localScore` is a frequency in the texts, NOT a search volume or a popularity: no free store source publishes one. Suggestions only; nothing is tracked until a person adds it.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: asoLocaleQuery,
    partial: true,
    responses: {
      '200': {
        description: 'The ideas and what they are based on.',
        schema: z.object({
          locale: z.string(),
          basedOn: z.object({ ownListing: z.boolean(), competitors: z.number().int() }),
          ideas: z.array(
            z.object({
              term: z.string(),
              words: z.number().int(),
              occurrences: z.number().int(),
              sources: z.number().int(),
              localScore: z.number(),
            }),
          ),
          notes: z.array(z.string()),
        }),
      },
    },
  },
  {
    id: 'getAsoGaps',
    method: 'get',
    path: `${W}/apps/{id}/aso/gaps`,
    tags: ['aso'],
    summary: 'Terms competitors use that the own listing does not have',
    description:
      asoNote +
      'Tracked keywords the listing covers badly, and phrases mined from the competitors’ names and subtitles, ordered by how many competitors use them. A suggestion, not advice.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: asoLocaleQuery,
    partial: true,
    responses: {
      '200': {
        description: 'The gaps.',
        schema: z.object({
          locale: z.string(),
          competitors: z.number().int(),
          gaps: z.array(object),
          notes: z.array(z.string()),
        }),
      },
    },
  },
  {
    id: 'getAsoSuggestions',
    method: 'get',
    path: `${W}/apps/{id}/aso/suggestions`,
    tags: ['aso'],
    summary: 'Apps that rank for several of your keywords: competitors to consider',
    description:
      asoNote +
      'From the stored top results of the latest check of each keyword, per country, without the own app and the ones already followed. Nothing is followed until a person calls `addAsoCompetitor`.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      minKeywords: z.number().int().min(1).max(50).optional().describe('Default 2.'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    partial: true,
    responses: {
      '200': {
        description: 'The suggestions.',
        schema: z.object({
          suggestions: z.array(
            z.object({
              externalId: z.string(),
              country: z.string(),
              name: z.string().nullable(),
              keywordCount: z.number().int(),
              bestRank: z.number().int(),
              averageRank: z.number(),
              keywordIds: z.array(z.string()),
            }),
          ),
          basedOnKeywords: z.number().int(),
          notes: z.array(z.string()),
        }),
      },
    },
  },
  {
    id: 'getAsoListingKeywords',
    method: 'get',
    path: `${W}/apps/{id}/aso/listing-keywords`,
    tags: ['aso'],
    summary: 'The stored listing text of every locale, to read the keywords it sets',
    description:
      asoNote +
      'The copy of the listing the last sync stored, per locale (the live copy when there is one): App Store name, subtitle and keyword field, or Google Play title, short and full description (`title`, `subtitle`, `keywords`, `shortDescription`, `description`; the App Store description is left out because the store does not search it). No store is contacted. `readAt` is when the listing was last read from the store. Google Play has no hidden keyword field: the web extracts terms from the text and says so.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: {
      '200': {
        description: 'The stored text per locale.',
        schema: z.object({
          readAt: timestamp.nullable(),
          error: z.string().nullable(),
          locales: z.array(z.object({ locale: z.string(), fields: object })),
          indexedFields: z.array(z.string()),
        }),
      },
    },
  },
  {
    id: 'getAsoMarkets',
    method: 'get',
    path: `${W}/apps/{id}/aso/markets`,
    tags: ['aso'],
    summary: 'The same term in each tracked country and locale as one row',
    description: asoNote,
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    partial: true,
    responses: {
      '200': {
        description: 'One row per term.',
        schema: z.object({
          terms: z.array(
            z.object({
              key: z.string(),
              term: z.string(),
              bestRank: z.number().int().nullable(),
              markets: z.array(
                z.object({
                  country: z.string(),
                  locale: z.string(),
                  id: z.string(),
                  rank: z.number().int().nullable(),
                  state: z.enum(['ranked', 'not_ranked', 'unavailable']).nullable(),
                  checkedAt: timestamp.nullable(),
                }),
              ),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'refreshAso',
    method: 'post',
    path: `${W}/apps/{id}/aso/refresh`,
    tags: ['aso'],
    summary: 'Check the keyword ranks and competitors of an app now',
    description:
      'READS THE PUBLIC STORE (Apple: the iTunes Search API; Google Play: its public pages, only when switched on, `409 play_unofficial_disabled` otherwise). Read-only toward the stores. At most KILN_ASO_MAX_CHECKS_PER_RUN keywords per run, the oldest first; the rest stays due (`result.deferred`). Stops early when a store says to slow down, is unavailable or fails repeatedly; an unavailable store is never recorded as "not ranked". `429` carries `Retry-After`; `409 refresh_in_progress` while another refresh of the app holds the claim. `?background=true` queues it and answers `202` with `jobId`. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'id' },
    rateLimited: true,
    query: asoBackgroundQuery,
    responses: {
      '200': {
        description: 'What the refresh did, and the state.',
        schema: z.object({ result: asoRefreshResultSchema, state: asoStateSchema }),
      },
      '202': {
        description: 'Queued (with `?background=true`).',
        schema: z.object({ jobId: z.string() }),
      },
    },
  },
  {
    id: 'refreshAsoAll',
    method: 'post',
    path: `${W}/aso/refresh`,
    tags: ['aso'],
    summary: 'Queue an ASO refresh of every app that has keywords or competitors',
    description:
      'Admin or owner: it spends the stores’ goodwill on all apps at once. Queues at most 25 jobs, spaced 20 seconds apart; apps with a refresh already queued, Google Play apps while that is switched off and iOS apps that were never synced are skipped. Always `202`. Rate limited per workspace.',
    risk: 'write',
    access: { action: 'aso.manage' },
    rateLimited: true,
    responses: {
      '202': {
        description: 'How many were queued, and why others were not.',
        schema: z.object({
          queued: z.number().int(),
          skipped: z.object({
            alreadyQueued: z.number().int(),
            notReady: z.number().int(),
            playOff: z.number().int(),
            capped: z.number().int(),
          }),
        }),
      },
    },
  },
];
