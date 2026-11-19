import {
  aiLimits,
  aiProposalKinds,
  aiProviders,
  aiSentiments,
  aiSeverities,
  aiSuggestionStatuses,
  aiTaskIds,
} from '@mrm/core';
import { z } from 'zod';
import {
  acceptBody,
  appContextBody,
  listModelsBody,
  runTaskBody,
  updateConfigBody,
} from '../routes/ai.ts';
import type { Operation } from './openapi.ts';

/**
 * The operations of AI assistance (docs/api/ai.md), kept in their own file and added to the registry in api-operations.ts. Every
 * one needs `ai.use` or `ai.manage`, both EXPLICIT-ONLY for tokens (a token holds them only when its `actions` name them). None of
 * them reaches a store: they ask an AI provider for a suggestion and store it, and accepting a suggestion goes through the keyword,
 * staged text and reply draft services with their own rights. `risk: 'write'` marks the calls that send data to a provider or change state.
 */

const W = '/api/workspaces/{workspaceId}';
const timestamp = z.number().int().describe('Epoch milliseconds.');

const proposalSchema = z
  .object({ kind: z.enum(aiProposalKinds) })
  .passthrough()
  .describe(
    'The validated, post-processed answer. `keywords`: `{ store, country, locale, items: [{ term, reason, field, acceptable, flags }] }`. `listing_text`: `{ locale, fields: [{ field, text, reason, length, limit, unit, acceptable, flags }] }`. `reply_draft`: `{ reviewId, store, text, length, limit, acceptable, flags }`. `listing_variants`: `{ locale, fields: [{ field, limit, unit, variants: [{ text, reason, length, acceptable, flags }] }] }`. `insight` (a report, read and not applied; `insight` names it): `review_summary` `{ period, reviewCount, analysed, sentiment, overview, themes: [{ label, kind, summary, count, reviewIds, averageRating }], notes }`, `review_classify` `{ classified, cached, remaining, items: [{ reviewId, topics, sentiment, severity, language, needsReply }], notes }`, `fix_next` `{ period, versionStats, items: [{ title, why, area, severity, reviewIds, count, versions }], releaseNotes, releaseNotesLength, releaseNotesLimit, releaseNotesFlags, notes }`, `listing_audit` `{ locale, store, fields, coverage, findings: [{ field, problem, recommendation, impact, reasoning, keywords, flags }], notes }`, `aso_health` `{ summary, actions: [{ position, title, detail, area, flags }], basedOn, notes }`. Counts, lengths, evidence ids and ranks are worked out by the server, never taken from the model. Keyword ideas may also carry `relevance` (0 to 100) and `sources`. `reason`, `text` and every sentence are written by a model: show them as text, never as markup.',
  );

export const aiSuggestionSchema = z.object({
  id: z.string(),
  appId: z.string(),
  task: z.enum(aiTaskIds),
  taskVersion: z.number().int(),
  kind: z.enum(aiProposalKinds),
  status: z.enum(aiSuggestionStatuses),
  provider: z.enum(aiProviders),
  model: z.string(),
  proposal: proposalSchema,
  scope: z
    .record(z.unknown())
    .describe(
      'The ids and options of the run (locale, country, fields, reviewId, tone). Never text; `goal` is `true` when one was typed.',
    ),
  inputHash: z.string().describe('SHA-256 of the exact data sent: provenance without keeping it.'),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  createdBy: z.string(),
  createdAt: timestamp,
  decidedBy: z.string().nullable(),
  decidedAt: timestamp.nullable(),
  accepted: z
    .object({ kind: z.enum(aiProposalKinds) })
    .passthrough()
    .nullable()
    .describe(
      'What accepting created, as ids: `keywords` `{ keywordIds, created, existing, rejected }`, `listing_text` `{ stagedFields, locale }` (also what accepting `listing_variants` returns), `reply_draft` `{ reviewId, draftId }`, `insight` `{}` (marked reviewed; nothing was created).',
    ),
});

const configSchema = z.object({
  state: z
    .enum(['ready', 'off_server', 'off_workspace', 'not_configured'])
    .describe(
      '`ready`: a run would go to the provider now. `off_server`: MRM_AI_ENABLED is not true. `off_workspace`: an admin has not turned it on. `not_configured`: see `reason`.',
    ),
  reason: z
    .enum(['no_model', 'no_credential', 'no_url', 'credential_unreadable', 'bad_url'])
    .optional(),
  server: z.object({ enabled: z.boolean(), allowPrivateUrls: z.boolean() }),
  settings: z.object({
    enabled: z.boolean(),
    provider: z.enum(aiProviders),
    model: z.string(),
    baseUrl: z.string().nullable().describe('Only admins see the address; others get null.'),
    baseUrlSet: z.boolean(),
    monthlyTokenBudget: z.number().int().describe('0: no limit here.'),
    maxOutputTokens: z.number().int(),
    maxInputTokens: z.number().int(),
    softWarnPercent: z
      .number()
      .int()
      .describe('A warning is shown at this share of the token budget or the cost cap. 0: none.'),
    priceInputCentsPerMTok: z
      .number()
      .int()
      .describe(
        'What the provider charges per million input tokens, in whole cents. 0: free or unknown.',
      ),
    priceOutputCentsPerMTok: z.number().int(),
    monthlyCostCapCents: z
      .number()
      .int()
      .describe(
        'The most the estimated cost of a month may reach, in whole cents. 0: no cost cap.',
      ),
  }),
  defaults: z.object({
    monthlyTokenBudget: z.number().int(),
    maxOutputTokens: z.number().int(),
    maxInputTokens: z.number().int(),
    softWarnPercent: z.number().int(),
    priceInputCentsPerMTok: z.number().int(),
    priceOutputCentsPerMTok: z.number().int(),
    monthlyCostCapCents: z.number().int(),
  }),
  overridden: z.array(z.string()),
  providers: z.array(
    z.object({
      id: z.enum(aiProviders),
      label: z.string(),
      credentialKind: z.string(),
      credentialRequired: z.boolean(),
      needsUrl: z.boolean(),
      privacy: z
        .string()
        .describe(
          'Who receives the data of a task with this provider. Show it next to the choice.',
        ),
      credentialPresent: z
        .boolean()
        .describe(
          'Whether a credential of this provider’s kind exists in the workspace. The key itself is never returned.',
        ),
    }),
  ),
  usage: z.object({
    month: z.string().describe('`YYYY-MM`, UTC.'),
    used: z
      .number()
      .int()
      .describe('Input plus output tokens this month, including runs in flight.'),
    budget: z.number().int(),
    remaining: z.number().int().nullable().describe('Null when the budget is 0 (no limit).'),
    runs: z.number().int(),
    resetsAt: timestamp,
    estimatedCostCents: z
      .number()
      .int()
      .describe('Estimated from the prices an admin typed; 0 when none are set.'),
    costCapCents: z.number().int(),
    pricesSet: z.boolean(),
    byTask: z
      .array(
        z.object({
          task: z.string(),
          runs: z.number().int(),
          inputTokens: z.number().int(),
          outputTokens: z.number().int(),
          costCents: z.number().int(),
        }),
      )
      .describe('This month’s runs per task.'),
    warning: z
      .object({
        kind: z.enum(['tokens', 'cost']),
        level: z.enum(['soft', 'limit']),
        percent: z.number().int(),
        message: z.string(),
      })
      .nullable()
      .describe('`soft`: a warning only. `limit`: the next run is refused.'),
  }),
  limits: z.record(z.number().int()),
  canManage: z.boolean(),
});

const taskSchema = z.object({
  id: z.enum(aiTaskIds),
  version: z.number().int(),
  label: z.string(),
  description: z.string(),
  status: z
    .enum(['ready', 'planned'])
    .describe('`planned` tasks are registered but cannot be run yet (`409 task_not_available`).'),
  proposalKind: z.enum(aiProposalKinds).nullable(),
  acceptAction: z
    .string()
    .nullable()
    .describe('The right needed to ACCEPT its proposals. Running a task needs `ai.use`.'),
  scope: z.array(
    z.object({
      name: z.string(),
      required: z.boolean(),
      description: z.string(),
      values: z.array(z.string()).optional(),
    }),
  ),
  disclosure: z
    .object({ sends: z.array(z.string()), neverSends: z.array(z.string()) })
    .describe('What leaves the server, as sentences to show BEFORE the first use.'),
});

const appContextSchema = z.object({
  context: z.object({
    about: z.string(),
    audience: z.string(),
    tone: z.string(),
    brandVoice: z.string(),
    bannedWords: z.array(z.string()),
    brandTerms: z.array(z.string()),
    doList: z.array(z.string()),
    dontList: z.array(z.string()),
  }),
  updatedAt: timestamp.nullable(),
  updatedBy: z.string().nullable(),
  canEdit: z.boolean().describe('Whether the caller may change it (`apps.write`).'),
});

const note =
  'Needs MRM_AI_ENABLED=true on the server AND the AI setting `enabled` of the workspace; otherwise `409 ai_not_enabled`. ';

export const aiOperations: Operation[] = [
  {
    id: 'getAiConfig',
    method: 'get',
    path: `${W}/ai/config`,
    tags: ['ai'],
    summary: 'AI assistance: the state, the settings, the providers and this month’s token usage',
    description:
      'No key and no prompt is ever returned. `state` says why AI cannot be used when it cannot. Admins and owners hold `ai.manage`.',
    risk: 'read',
    access: { action: 'ai.use' },
    responses: { '200': { description: 'The configuration.', schema: configSchema } },
  },
  {
    id: 'updateAiConfig',
    method: 'put',
    path: `${W}/ai/config`,
    tags: ['ai'],
    summary: 'Change the AI settings (admins): on or off, provider, model, address, token budget',
    description:
      'Each key is optional; `null` goes back to the default. All or nothing. The address of an OpenAI compatible server must be https to a public host unless the operator set MRM_AI_ALLOW_PRIVATE_URLS=true (plain http then only to the same machine). A refused address is `400 invalid_setting` with an issue on `baseUrl` that carries a `code` (`private_address_blocked`, `plain_http_not_allowed`) and a sentence that says what to do. The key is a credential of kind `ai_anthropic`, `ai_openai` or `ai_openai_compatible`. Audited as `ai.config_update`.',
    risk: 'write',
    access: { action: 'ai.manage' },
    body: updateConfigBody,
    bodyLimit: 16 * 1024,
    responses: {
      '200': { description: 'The new configuration, as `getAiConfig`.', schema: configSchema },
    },
  },
  {
    id: 'testAiConnection',
    method: 'post',
    path: `${W}/ai/test`,
    tags: ['ai'],
    summary:
      'Send one fixed request to the configured provider to check the key, the model and the address',
    description:
      note +
      'The request holds no data of the workspace. The answer is `{ ok: true, provider, model }` or `{ ok: false, kind, message, reason?, sample? }`. `message` is a fixed sentence. `sample` is the one exception to "never provider text": for an unusable answer (`kind: invalid_output`) of an OpenAI compatible server, the first 300 characters the model wrote to this fixed request (control characters removed, plain text), so an admin can see what a small model answers. Only this route returns it; it is never stored, audited or logged. Counts a few tokens.',
    risk: 'write',
    access: { action: 'ai.manage' },
    rateLimited: true,
    responses: {
      '200': {
        description: 'The outcome of the test.',
        schema: z.object({
          ok: z.boolean(),
          provider: z.enum(aiProviders),
          model: z.string().optional(),
          kind: z.string().optional(),
          message: z.string().optional(),
          reason: z.string().optional(),
          retryAfterSeconds: z.number().int().optional(),
          sample: z.string().optional(),
        }),
      },
    },
  },
  {
    id: 'listAiModels',
    method: 'post',
    path: `${W}/ai/models`,
    tags: ['ai'],
    summary: 'List the models a provider offers (admins), so one can be picked instead of typed',
    description:
      'Sends no data of the workspace: one read (`GET /models`) to the provider, or to the OpenAI compatible server at `baseUrl` (the saved one when omitted), with the key. `apiKey` is optional: a key typed in the form and not saved yet is used for this one call and is never stored, logged or audited; without it the stored credential of the provider is used. Needs MRM_AI_ENABLED=true on the server; the workspace switch is not needed. The answer is `{ models: [{ id, label? }], source }`: `source` is `provider` when the server answered a list (ids checked, deduplicated, sorted, at most 200) and `fallback` when it could not (a 404 or an answer that is not a list, or no key yet: `reason` says which), in which case `models` is a short fixed list of well known ids (empty for an OpenAI compatible server). Errors: `ai_not_enabled` (409), `ai_not_configured` (422, `reason` `no_url`, `bad_url` with a `hint` of `private_address_blocked` or `plain_http_not_allowed`, `credential_unreadable`), `ai_auth` (422), `ai_rate_limited` (429), `ai_unavailable` (502, 504, with a `reason`). Audited as `ai.models_list` with the provider, the source and a count only.',
    risk: 'write',
    access: { action: 'ai.manage' },
    rateLimited: true,
    body: listModelsBody,
    bodyLimit: 16 * 1024,
    responses: {
      '200': {
        description: 'The models and where the list came from.',
        schema: z.object({
          models: z.array(z.object({ id: z.string(), label: z.string().optional() })),
          source: z.enum(['provider', 'fallback']),
          reason: z.enum(['no_credential', 'list_unavailable']).optional(),
        }),
      },
    },
  },
  {
    id: 'listAiTasks',
    method: 'get',
    path: `${W}/ai/tasks`,
    tags: ['ai'],
    summary: 'The AI tasks, each with the data it sends (show it before the first use)',
    description: 'Read-only. `provider.privacy` says who receives the data.',
    risk: 'read',
    access: { action: 'ai.use' },
    responses: {
      '200': {
        description: 'The tasks.',
        schema: z.object({
          tasks: z.array(taskSchema),
          state: z.enum(['ready', 'off_server', 'off_workspace', 'not_configured']),
          provider: z
            .object({ id: z.enum(aiProviders), label: z.string(), privacy: z.string() })
            .nullable(),
        }),
      },
    },
  },
  {
    id: 'runAiTask',
    method: 'post',
    path: `${W}/ai/tasks/{taskId}/run`,
    tags: ['ai'],
    summary:
      'Run an AI task for an app: sends the data the task lists to the provider and stores a SUGGESTION (a proposal)',
    description:
      note +
      'Sends data to the AI provider the workspace chose (see `listAiTasks` for exactly what). Nothing is changed in the app, a repository or a store: the answer is validated against the task’s schema, flagged where it was trimmed or cannot be accepted, and stored as a suggestion. Errors: `ai_budget_exhausted` (429, with `budget`, `used`, `resetsAt`), `ai_busy` (429), `ai_input_too_large` (422), `ai_not_configured` (422), `ai_auth` (422), `ai_rate_limited` (429), `ai_invalid_output` (502, the answer did not match the schema; tokens still count), `ai_unavailable` (502, 504), `task_not_available` (409). Audited with ids, hashes and token counts, never the data or the answer. Raises the event `ai.suggestion_created` (ids only). Closed to tokens restricted to apps.',
    risk: 'write',
    access: { action: 'ai.use' },
    rateLimited: true,
    body: runTaskBody,
    bodyLimit: 16 * 1024,
    responses: {
      '201': {
        description:
          'The suggestion, and `warning` (the soft usage warning of the month, or null).',
        schema: z.object({
          suggestion: aiSuggestionSchema,
          warning: z
            .object({
              kind: z.enum(['tokens', 'cost']),
              level: z.enum(['soft', 'limit']),
              percent: z.number().int(),
              message: z.string(),
            })
            .nullable(),
        }),
      },
    },
  },
  {
    id: 'listAppAiSuggestions',
    method: 'get',
    path: `${W}/apps/{id}/ai/suggestions`,
    tags: ['ai'],
    summary: 'The AI suggestions of an app, newest first',
    description:
      'Filter by `status` (' +
      aiSuggestionStatuses.join(', ') +
      '), `task` and `limit` (default 20, at most 100). Suggestions are kept ' +
      aiLimits.suggestionRetentionDays +
      ' days and deleted with the app.',
    risk: 'read',
    access: { action: 'ai.use' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({
      status: z.enum(aiSuggestionStatuses).optional(),
      task: z.enum(aiTaskIds).optional(),
      limit: z.string().optional(),
    }),
    responses: {
      '200': {
        description: 'The suggestions.',
        schema: z.object({ suggestions: z.array(aiSuggestionSchema) }),
      },
    },
  },
  {
    id: 'getAiSuggestion',
    method: 'get',
    path: `${W}/ai/suggestions/{suggestionId}`,
    tags: ['ai'],
    summary: 'One AI suggestion',
    risk: 'read',
    access: { action: 'ai.use' },
    responses: {
      '200': {
        description: 'The suggestion.',
        schema: z.object({ suggestion: aiSuggestionSchema }),
      },
    },
  },
  {
    id: 'acceptAiSuggestion',
    method: 'post',
    path: `${W}/ai/suggestions/{suggestionId}/accept`,
    tags: ['ai'],
    summary:
      'Accept a suggestion (all of it, or the `items` or `fields` you name) through the existing mechanism',
    description:
      'Needs the right of that mechanism as well: keywords `aso.write` (tracks them; no store is contacted), listing text `changesets.write` (STAGES the text with source `ai`; only the previewed, gated push writes it to a store), reply draft `reviews.triage` (saves a DRAFT; sending is a separate confirmed call with `reviews.reply`), `listing_variants` `changesets.write` (name one variant per field in `choices: [{ field, variant }]`; without `choices` the first acceptable variant of each field is staged), `insight` only `ai.use` (it is a report: accepting marks it reviewed and creates nothing). Items flagged as not acceptable are refused (`422 nothing_acceptable`). A different staged text or reply draft is not overwritten unless `replace` is true (`409 staged_exists`, `409 draft_exists`). One accept wins (`409 suggestion_not_proposed`). Accepting only some keyword ideas tracks them and leaves the others `proposed` (the suggestion closes with its last open idea). The body may be left out: everything acceptable is accepted.',
    risk: 'write',
    access: { action: 'ai.use' },
    body: acceptBody,
    bodyOptional: true,
    bodyLimit: 16 * 1024,
    responses: {
      '200': {
        description: 'The suggestion and what was created, as ids.',
        schema: z.object({
          suggestion: aiSuggestionSchema,
          result: z.object({ kind: z.enum(aiProposalKinds) }).passthrough(),
        }),
      },
    },
  },
  {
    id: 'dismissAiSuggestion',
    method: 'post',
    path: `${W}/ai/suggestions/{suggestionId}/dismiss`,
    tags: ['ai'],
    summary: 'Dismiss a suggestion: nothing is created',
    risk: 'write',
    access: { action: 'ai.use' },
    responses: {
      '200': {
        description: 'The suggestion.',
        schema: z.object({ suggestion: aiSuggestionSchema }),
      },
    },
  },
  {
    id: 'previewAiTask',
    method: 'post',
    path: `${W}/ai/tasks/{taskId}/preview`,
    tags: ['ai'],
    summary:
      'Preview what a run would send: the exact data and instructions, built from stored data',
    description:
      note +
      'Takes the same body as `runAiTask` and builds the input exactly as a run would (including the AI context of the app), then returns it. No provider is called, no tokens are reserved and nothing is stored. Fails the way a run fails before the call (`no_reviews`, `no_listing_text`, `ai_input_too_large`).',
    risk: 'read',
    access: { action: 'ai.use' },
    rateLimited: true,
    body: runTaskBody,
    bodyLimit: 16 * 1024,
    responses: {
      '200': {
        description: 'The preview.',
        schema: z.object({
          preview: z.object({
            task: z.object({ id: z.string(), version: z.number().int() }),
            input: z.unknown().describe('The JSON the model receives as data.'),
            system: z
              .string()
              .describe('The instruction text of the task; it holds no data of the workspace.'),
            estimatedInputTokens: z.number().int(),
            maxOutputTokens: z.number().int(),
            includesAppContext: z.boolean(),
            provider: z.enum(aiProviders),
            model: z.string(),
          }),
        }),
      },
    },
  },
  {
    id: 'getAppAiContext',
    method: 'get',
    path: `${W}/apps/{id}/ai/context`,
    tags: ['ai'],
    summary:
      'The AI context of an app: what it is, its audience, tone, words to avoid, names to keep',
    description:
      'Text a person typed for the assistant. Sent with every AI task of the app, only the parts that are filled in.',
    risk: 'read',
    access: { action: 'ai.use' },
    appScope: { kind: 'param', name: 'id' },
    responses: { '200': { description: 'The context.', schema: appContextSchema } },
  },
  {
    id: 'updateAppAiContext',
    method: 'put',
    path: `${W}/apps/{id}/ai/context`,
    tags: ['ai'],
    summary: 'Replace the AI context of an app',
    description:
      'A field you leave out is cleared; all empty deletes the context. Needs `apps.write`. Audited as `ai.app_context_update` with the names of the fields that changed, never their text.',
    risk: 'write',
    access: { action: 'apps.write' },
    appScope: { kind: 'param', name: 'id' },
    body: appContextBody,
    bodyLimit: 16 * 1024,
    responses: { '200': { description: 'The stored context.', schema: appContextSchema } },
  },
  {
    id: 'listReviewAiTags',
    method: 'get',
    path: `${W}/apps/{id}/ai/review-tags`,
    tags: ['ai'],
    summary:
      'The tags the assistant gave reviews: topics, sentiment, severity, language, needs reply',
    description:
      'Pass `ids`, a comma separated list of 1 to 100 review ids. Reviews that were never tagged are left out. The tags are advisory labels made by `review_classify`: they change nothing about a review. Contacts no provider.',
    risk: 'read',
    access: { action: 'reviews.read' },
    appScope: { kind: 'param', name: 'id' },
    query: z.object({ ids: z.string() }),
    responses: {
      '200': {
        description: 'The tags.',
        schema: z.object({
          tags: z.array(
            z.object({
              reviewId: z.string(),
              topics: z.array(z.string()),
              sentiment: z.enum(aiSentiments),
              severity: z.enum(aiSeverities),
              language: z.string().nullable(),
              needsReply: z.boolean(),
            }),
          ),
        }),
      },
    },
  },
];
