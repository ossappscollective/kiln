import { z } from 'zod';
import { type Draft, timestamp, W } from '../../operations/shared.ts';

/**
 * The operations of the keyword estimates (docs/api/aso.md#estimates, docs/adr/0057-keyword-estimates.md). Database only: the
 * signals were read by the ASO refresh. Everything here is an ESTIMATE, never Apple's or Google's popularity.
 */

const note =
  'Reads this server’s database only: no store is contacted. These are ESTIMATES worked out from public signals and the team’s own data: ' +
  'never Apple’s popularity score (which exists only inside Apple Ads) and never a Google Play number. ';

const confidence = z.enum(['low', 'medium', 'high']);
const reason = z.object({
  code: z.string().describe('The input: hints_position, hints_absent, hints_empty, results_demand, own_visitors, results_strength, results_title_match, results_crowding, rank_volatility, or why there is no estimate (no_signal, play_needs_own_data, play_no_competition_data, results_empty, too_few_results).'),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  points: z.number().nullable().describe('What this input alone suggests, 0 to 100; null: it only explains.'),
  weight: z.number().describe('Its share in the blend; 0: not part of the score.'),
});
const measure = z.object({
  score: z.number().int().min(0).max(100).nullable().describe('null: no estimate (never 0).'),
  confidence: confidence.nullable(),
  origin: z.enum(['own_data', 'public_signals']).nullable(),
  reasons: z.array(reason),
});
const estimate = z.object({
  model: z.string().describe('The formula version, `v1`.'),
  popularity: measure,
  difficulty: measure,
  opportunity: z.object({
    score: z.number().int().nullable(),
    confidence: confidence.nullable(),
    roomFactor: z.number().nullable(),
  }),
  signalsAt: timestamp.nullable(),
  hints: z.array(z.string()),
  top: z.array(z.object({ id: z.string(), name: z.string().nullable(), ratingCount: z.number().int().nullable() })),
});
const keywordRef = z.object({
  id: z.string(),
  term: z.string(),
  country: z.string(),
  locale: z.string(),
  platform: z.string(),
});
const store = z.enum(['app_store', 'google_play']);

export const estimateOperations: Draft[] = [
  {
    id: 'listAsoKeywordEstimates',
    method: 'get',
    path: `${W}/apps/{id}/aso/keyword-estimates`,
    tags: ['aso'],
    summary: 'The popularity and difficulty estimates of the tracked keywords',
    description:
      note +
      'One row per tracked keyword, in the order of the keyword list. Each estimate carries its inputs (`reasons`), a confidence and where the signal came from. A score of `null` is "no estimate" with the reason in `reasons`, never 0. Google Play keywords have an estimate only from the team’s own search terms file.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The estimates.',
        schema: z.object({
          appId: z.string(),
          model: z.string(),
          store,
          estimates: z.array(
            z.object({ keywordId: z.string(), term: z.string(), country: z.string(), locale: z.string(), platform: z.string(), estimate }),
          ),
        }),
      },
    },
  },
  {
    id: 'getAsoKeywordEstimate',
    method: 'get',
    path: `${W}/apps/{id}/aso/keywords/{keywordId}/estimate`,
    tags: ['aso'],
    summary: 'The estimate of one keyword with the hints, the competing apps and the trend',
    description:
      note +
      '`trend` has one point per stored day (oldest first, at most 90), worked out from the public signals read up to that day.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    responses: {
      '200': {
        description: 'The keyword, its estimate and the trend.',
        schema: z.object({
          model: z.string(),
          keyword: keywordRef,
          estimate,
          trend: z.array(z.object({ day: z.string(), popularity: z.number().int().nullable(), difficulty: z.number().int().nullable() })),
          retentionDays: z.number().int(),
        }),
      },
    },
  },
  {
    id: 'listAsoKeywordSuggestions',
    method: 'get',
    path: `${W}/apps/{id}/aso/keyword-suggestions`,
    tags: ['aso'],
    summary: 'Related terms from the App Store search hints of the tracked keywords',
    description:
      note +
      'The hints read by the refresh, minus the terms already tracked in that storefront; `from` lists the tracked keywords that brought each term. To track one, use `POST /apps/{id}/aso/keywords` (needs `aso.write`). Empty for Google Play apps.',
    risk: 'read',
    access: { action: 'aso.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      country: z.string().optional().describe('Two lower case letters.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    }),
    responses: {
      '200': {
        description: 'The suggestions, the ones several keywords brought first.',
        schema: z.object({
          appId: z.string(),
          store,
          suggestions: z.array(z.object({ term: z.string(), country: z.string(), locale: z.string(), from: z.array(z.string()) })),
        }),
      },
    },
  },
];
