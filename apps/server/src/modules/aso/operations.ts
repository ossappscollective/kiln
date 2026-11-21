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
      'Apple is read through the documented iTunes Search API. Google Play has no official API: `play.enabled` is false unless the operator set MRM_ASO_PLAY_UNOFFICIAL_ENABLED=true, and `play.notice` is the warning about its terms of service. Admins and owners hold `aso.manage`.',
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
      'READS THE PUBLIC STORE (Apple: the iTunes Search API; Google Play: its public pages, only when switched on, `409 play_unofficial_disabled` otherwise). Read-only toward the stores. At most MRM_ASO_MAX_CHECKS_PER_RUN keywords per run, the oldest first; the rest stays due (`result.deferred`). Stops early when a store says to slow down, is unavailable or fails repeatedly; an unavailable store is never recorded as "not ranked". `429` carries `Retry-After`; `409 refresh_in_progress` while another refresh of the app holds the claim. `?background=true` queues it and answers `202` with `jobId`. Rate limited per workspace.',
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
