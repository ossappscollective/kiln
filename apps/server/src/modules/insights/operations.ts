import { z } from 'zod';
import { type Draft, timestamp, W } from '../../operations/shared.ts';

/** The operations of Insights (docs/api/insights.md). The registry (operations/registry.ts) lists them. */

const target = z.object({
  section: z.enum(['insights', 'listing', 'reviews']),
  view: z.string().optional(),
  locale: z.string().optional(),
  country: z.string().optional(),
  term: z.string().optional(),
});

const card = z.object({
  id: z.string().describe('The rule and its subject: `visibility`, `localize:de`, `complaints:crash`. Stable.'),
  fingerprint: z.string().describe('The finding (direction and size band, the items in it). A dismissed card shows again when this changes.'),
  category: z.enum(['visibility', 'conversion', 'downloads', 'markets', 'reviews', 'keywords', 'listing']),
  severity: z.enum(['problem', 'warning', 'good', 'info']),
  code: z.string().describe('Names the sentence (`insights:card.<code>.headline`); `params` fill it.'),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  evidence: z.array(z.object({ key: z.string(), value: z.union([z.number(), z.string()]), format: z.string() })),
  actions: z.array(z.object({ code: z.string(), target })),
  weight: z.number(),
});

const skipped = z.array(z.object({ rule: z.string(), reason: z.string().describe('`no_data`, `too_little_data`, `no_countries`, `no_listing`, `no_reviews`, `no_keywords`, `not_for_store` or `no_access`.') }));

const appId = z.string().describe('Kiln\u2019s id of the app.');

export const insightsOperations: Draft[] = [
  {
    id: 'getAppInsights',
    method: 'get',
    path: `${W}/apps/{appId}/insights`,
    tags: ['insights'],
    summary: 'The Insights cards of an app: what changed, what is wrong, what to do',
    description:
      'Computed on read from stored analytics, reviews, keyword ranks and the live store page; asks no store and uses no AI. Cards are sorted problems first. `skipped` lists the rules that could not run and why (data absent or the role may not read it). Dismissed cards are left out and counted in `hiddenCount`; `includeHidden=1` returns them too. A role sees only the rules whose data it may read.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'appId' },
    query: z.object({ includeHidden: z.enum(['1']).optional() }),
    responses: {
      '200': {
        description: 'The cards, the counts per category and what was skipped.',
        schema: z.object({
          appId,
          generatedAt: timestamp,
          cards: z.array(card),
          hiddenCount: z.number().int(),
          counts: z.record(z.string(), z.number().int()),
          skipped,
        }),
      },
    },
  },
  {
    id: 'getAppInsightsCount',
    method: 'get',
    path: `${W}/apps/{appId}/insights/count`,
    tags: ['insights'],
    summary: 'How many Insights cards of an app are not dismissed (the badge of the Insights entry)',
    description: 'The same computation as `getAppInsights`, answering the number only.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'The number.', schema: z.object({ count: z.number().int() }) } },
  },
  {
    id: 'getAppInsightsCountries',
    method: 'get',
    path: `${W}/apps/{appId}/insights/countries`,
    tags: ['insights'],
    summary: 'New downloads by country with the main language of each country, against the languages of the live store page',
    description:
      'Downloads of the last 28 days by country (App Store only: Google Play reports Kiln reads carry no country split), joined with a maintained table of the main language per country, and the locales of the live store page. `unavailable` says why there is no table: `no_countries`, `no_listing` (the live page was never read) or `no_access`.',
    risk: 'read',
    access: { action: 'analytics.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The coverage, or why there is none.',
        schema: z.object({
          appId,
          store: z.enum(['app_store', 'google_play']),
          unavailable: z.enum(['no_countries', 'no_listing', 'no_access']).nullable(),
          storeLocales: z.array(z.string()),
          coverage: z
            .object({
              total: z.number(),
              uncoveredShare: z.number(),
              unknownCount: z.number(),
              languages: z.array(z.object({ language: z.string(), count: z.number(), share: z.number(), coveredBy: z.string().nullable(), countries: z.array(z.object({ country: z.string(), count: z.number(), share: z.number(), language: z.string().nullable(), coveredBy: z.string().nullable() })) })),
              countries: z.array(z.object({ country: z.string(), count: z.number(), share: z.number(), language: z.string().nullable(), coveredBy: z.string().nullable() })),
            })
            .nullable(),
        }),
      },
    },
  },
  {
    id: 'getAppListingChecks',
    method: 'get',
    path: `${W}/apps/{appId}/insights/listing-checks`,
    tags: ['insights'],
    summary: 'Checks of the live store page of an app, per locale: a score, the findings and a rewritten text where one is safe',
    description:
      'Computed on read from the stored copy of the live store page (field lengths against the store limits, wasted keyword space, a subtitle that repeats the name, untranslated text, missing screenshots). `unavailable` is `no_listing` when the live page was never read. A finding has `code` and `params` for the sentence, a `severity` (`problem`, `warning`, `tip`) and, only for some, `fix` (the field and the rewritten text). Nothing is sent to a store.',
    risk: 'read',
    access: { action: 'listing.read' },
    appScope: { kind: 'param', name: 'appId' },
    responses: {
      '200': {
        description: 'The score and the findings per locale.',
        schema: z.object({
          appId,
          store: z.enum(['app_store', 'google_play']),
          unavailable: z.enum(['no_listing']).nullable(),
          score: z.number().nullable(),
          issueCount: z.number().int(),
          counts: z.object({ problems: z.number().int(), warnings: z.number().int(), tips: z.number().int() }),
          locales: z.array(
            z.object({
              locale: z.string(),
              score: z.number(),
              issues: z.array(
                z.object({
                  id: z.string(),
                  code: z.string(),
                  field: z.string().nullable(),
                  severity: z.enum(['problem', 'warning', 'tip']),
                  params: z.record(z.string(), z.union([z.string(), z.number()])),
                  fix: z.object({ field: z.string(), value: z.string() }).nullable(),
                }),
              ),
            }),
          ),
        }),
      },
    },
  },
  {
    id: 'dismissAppInsight',
    method: 'post',
    path: `${W}/apps/{appId}/insights/cards/{cardId}/dismiss`,
    tags: ['insights'],
    summary: 'Hide an Insights card until its finding changes',
    description:
      'Stores the card\u2019s current fingerprint; the card stays hidden while the computed fingerprint is the same. `404` when the card is not one of the current cards. Kiln\u2019s own data: nothing reaches a store. Audited as `insights.dismissed` (ids only).',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'appId' },
    responses: { '200': { description: 'Done.', schema: z.object({ ok: z.literal(true) }) } },
  },
  {
    id: 'restoreAppInsights',
    method: 'post',
    path: `${W}/apps/{appId}/insights/restore`,
    tags: ['insights'],
    summary: 'Show dismissed Insights cards again',
    description: 'Body `{ cardId }` restores one card; no body or `{}` restores all of the app. Audited as `insights.restored` (a count).',
    risk: 'write',
    access: { action: 'aso.write' },
    appScope: { kind: 'param', name: 'appId' },
    body: z.object({ cardId: z.string().min(1).max(200).optional() }),
    bodyOptional: true,
    bodyLimit: 1024,
    responses: { '200': { description: 'How many dismissals were removed.', schema: z.object({ restored: z.number().int() }) } },
  },
];
