import { type Action, aiLimits, aiProviders, aiSuggestionStatuses, can, canToken } from '@mrm/core';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type AppEnv, parseBody, queryInt } from '../../http.ts';
import { memberRole } from '../../services/accounts.ts';
import {
  type AiServices,
  acceptSuggestion,
  dismissSuggestion,
  getAiConfigView,
  getSuggestion,
  listAiTasks,
  listAppSuggestions,
  previewAiTask,
  runAiTask,
  testAiConnection,
} from './service.ts';
import { getAppContext, setAppContext } from './ai-app-context.ts';
import { type AiFailure, updateAiConfig } from './ai-config.ts';
import { listAiModels } from './ai-models.ts';
import { getReviewTags } from './ai-review-classes.ts';
import { getApp } from '../../services/apps.ts';
import type { TestLimiter } from '../../services/credential-tests.ts';

/**
 * AI assistance (docs/api/ai.md, docs/adr/0016-ai-foundation.md). Mounted under /api/workspaces.
 *
 * - Running a task and reading the configuration need `ai.use` (members and up); changing the configuration and testing the
 *   provider need `ai.manage` (admins and owners). Both are EXPLICIT-ONLY for API tokens: a token holds them only when its `actions` name them.
 * - A run answers with a SUGGESTION (a proposal). Nothing here pushes, submits, publishes, releases or sends: accepting a suggestion
 *   calls an existing service as the person who accepts, and needs that service's own right (`aso.write`, `changesets.write`, `reviews.triage`).
 * - The routes that take an app in the body or the suggestion id have no app scope in the registry, so a token restricted to apps cannot call them.
 */
export type AiRoutesContext = AiServices & {
  /** Runs and tests per workspace per minute (default `aiLimits.runsPerMinute`, built in createApp). */
  limiter: TestLimiter;
};

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');
const actor = (c: Context<AppEnv>) => ({ type: 'user' as const, id: c.get('user').id });

const respond = (c: Context<AppEnv>, f: AiFailure) => {
  for (const [name, value] of Object.entries(f.headers ?? {})) c.header(name, value);
  return c.json(f.body, f.status);
};

const goal = z.string().max(aiLimits.maxGoalChars, `At most ${aiLimits.maxGoalChars} characters.`);

/** The union of the options of every task; each task refuses the ones it does not have. */
export const runTaskBody = z
  .object({
    appId: z.string().min(1).max(100),
    locale: z.string().max(20).optional(),
    country: z.string().max(10).optional(),
    fields: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
    goal: goal.optional(),
    reviewId: z.string().min(1).max(100).optional(),
    tone: z.enum(['friendly', 'neutral', 'apologetic']).optional(),
    replyLanguage: z.string().max(20).optional(),
    /** Review tasks: how many days back, and how many reviews to send or tag; the reviews to tag (their ids in this tool). */
    days: z.number().int().min(1).max(180).optional(),
    limit: z.number().int().min(1).max(80).optional(),
    reviewIds: z.array(z.string().min(1).max(100)).min(1).max(40).optional(),
    /** Listing tasks: the language to translate from, and how many variants per field. */
    sourceLocale: z.string().max(20).optional(),
    count: z.number().int().min(2).max(5).optional(),
  })
  .strict();

/** What a person tells the assistant about an app. The lengths are checked again, with sentences, by `normalizeAiAppContext`. */
export const appContextBody = z
  .object({
    about: z.string().max(5000).optional(),
    audience: z.string().max(2000).optional(),
    tone: z.string().max(1000).optional(),
    brandVoice: z.string().max(5000).optional(),
    bannedWords: z.array(z.string().max(500)).max(200).optional(),
    brandTerms: z.array(z.string().max(500)).max(200).optional(),
    doList: z.array(z.string().max(1000)).max(50).optional(),
    dontList: z.array(z.string().max(1000)).max(50).optional(),
  })
  .strict();

export const updateConfigBody = z
  .object({
    enabled: z.boolean().nullable().optional(),
    provider: z.enum(aiProviders).nullable().optional(),
    model: z.string().max(aiLimits.maxModelChars).nullable().optional(),
    baseUrl: z.string().max(500).nullable().optional(),
    monthlyTokenBudget: z
      .number()
      .int()
      .min(0)
      .max(aiLimits.maxMonthlyTokenBudget)
      .nullable()
      .optional(),
    maxOutputTokens: z
      .number()
      .int()
      .min(aiLimits.minMaxOutputTokens)
      .max(aiLimits.maxMaxOutputTokens)
      .nullable()
      .optional(),
    maxInputTokens: z
      .number()
      .int()
      .min(aiLimits.minMaxInputTokens)
      .max(aiLimits.maxMaxInputTokens)
      .nullable()
      .optional(),
    softWarnPercent: z.number().int().min(0).max(100).nullable().optional(),
    priceInputCentsPerMTok: z.number().int().min(0).max(1_000_000).nullable().optional(),
    priceOutputCentsPerMTok: z.number().int().min(0).max(1_000_000).nullable().optional(),
    monthlyCostCapCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one setting.');

/** `apiKey` is a key typed in the form and not saved yet: it is used for this one call and never stored, logged or audited. */
export const listModelsBody = z
  .object({
    provider: z.enum(aiProviders),
    baseUrl: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
  })
  .strict();

export const acceptBody = z
  .object({
    items: z.array(z.number().int().min(0).max(1000)).min(1).max(100).optional(),
    fields: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
    /** `listing_variants`: the variant (its position in the field's list) chosen for each field. */
    choices: z
      .array(
        z
          .object({ field: z.string().min(1).max(40), variant: z.number().int().min(0).max(10) })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    replace: z.boolean().optional(),
  })
  .strict()
  .optional();

export function aiRoutes(ctx: AiRoutesContext) {
  const { db } = ctx;
  const routes = new Hono<AppEnv>();

  /** Not a member and no such workspace look the same (404). A member without the right gets 403. */
  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };
  /** What the caller may do: the role (already lowered to the token's ceiling) AND, for a token, its own list. */
  const allowedFor = (c: Context<AppEnv>) => (action: Action) => {
    const token = c.get('token');
    return (
      can(c.get('role'), action) &&
      (token === undefined || canToken(token.ceiling, token.actions as Action[] | null, action))
    );
  };
  const limited = (c: Context<AppEnv>) => {
    const wait = ctx.limiter.take(ws(c));
    if (wait <= 0) return undefined;
    c.header('Retry-After', String(wait));
    return c.json(
      {
        error: 'rate_limited',
        message: `Too many AI requests. Try again in ${wait} seconds.`,
        retryAfterSeconds: wait,
      },
      429,
    );
  };
  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', message: 'The request body is too large.' }, 413);
  const small = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge });

  // ----- configuration -----------------------------------------------------------------------------
  routes.get('/:workspaceId/ai/config', needs('ai.use'), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await getAiConfigView(ctx, ws(c), c.get('role')));
  });

  routes.put('/:workspaceId/ai/config', needs('ai.manage'), small, async (c) => {
    const body = await parseBody(c, updateConfigBody);
    if (!body.ok) return body.response;
    const done = await updateAiConfig(
      db,
      { workspaceId: ws(c), role: c.get('role'), changes: body.data as Record<string, unknown> },
      actor(c),
      ctx.now(),
      {
        ...(ctx.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
      },
    );
    if (!done.ok) return c.json(done.body, done.status);
    return c.json(await getAiConfigView(ctx, ws(c), c.get('role')));
  });

  routes.post('/:workspaceId/ai/test', needs('ai.manage'), async (c) => {
    const wait = limited(c);
    if (wait) return wait;
    const done = await testAiConnection(ctx, { workspaceId: ws(c), actor: actor(c) });
    return done.ok ? c.json(done.result) : respond(c, done);
  });

  routes.post('/:workspaceId/ai/models', needs('ai.manage'), small, async (c) => {
    const body = await parseBody(c, listModelsBody);
    if (!body.ok) return body.response;
    const wait = limited(c);
    if (wait) return wait;
    const done = await listAiModels(ctx, {
      workspaceId: ws(c),
      actor: actor(c),
      provider: body.data.provider,
      baseUrl: body.data.baseUrl,
      apiKey: body.data.apiKey,
    });
    c.header('Cache-Control', 'no-store');
    return done.ok ? c.json(done.result) : respond(c, done);
  });

  // ----- tasks -------------------------------------------------------------------------------------
  routes.get('/:workspaceId/ai/tasks', needs('ai.use'), async (c) => {
    const view = await getAiConfigView(ctx, ws(c), c.get('role'));
    const provider = view.providers.find((p) => p.id === view.settings.provider);
    return c.json({
      tasks: listAiTasks(),
      state: view.state,
      provider: provider
        ? { id: provider.id, label: provider.label, privacy: provider.privacy }
        : null,
    });
  });

  routes.post('/:workspaceId/ai/tasks/:taskId/run', needs('ai.use'), small, async (c) => {
    const body = await parseBody(c, runTaskBody);
    if (!body.ok) return body.response;
    const wait = limited(c);
    if (wait) return wait;
    const { appId, ...scope } = body.data;
    const done = await runAiTask(ctx, {
      workspaceId: ws(c),
      actor: actor(c),
      taskId: param(c, 'taskId'),
      appId,
      scope: scope as Record<string, unknown>,
    });
    if (!done.ok) return respond(c, done);
    c.header('Cache-Control', 'no-store');
    return c.json({ suggestion: done.suggestion, warning: done.warning }, 201);
  });

  /** "What will be sent": the exact input a run with the same body would send. Calls no provider, reserves nothing, stores nothing. */
  routes.post('/:workspaceId/ai/tasks/:taskId/preview', needs('ai.use'), small, async (c) => {
    const body = await parseBody(c, runTaskBody);
    if (!body.ok) return body.response;
    const wait = limited(c);
    if (wait) return wait;
    const { appId, ...scope } = body.data;
    const done = await previewAiTask(ctx, {
      workspaceId: ws(c),
      actor: actor(c),
      taskId: param(c, 'taskId'),
      appId,
      scope: scope as Record<string, unknown>,
    });
    if (!done.ok) return respond(c, done);
    c.header('Cache-Control', 'no-store');
    return c.json({ preview: done.preview });
  });

  // ----- the AI context of an app and the tags of its reviews ----------------------------------------
  routes.get('/:workspaceId/apps/:id/ai/context', needs('ai.use'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const stored = await getAppContext(db, ws(c), app.id);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...stored, canEdit: can(c.get('role'), 'apps.write') });
  });

  routes.put('/:workspaceId/apps/:id/ai/context', needs('apps.write'), small, async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const body = await parseBody(c, appContextBody);
    if (!body.ok) return body.response;
    const done = await setAppContext(db, {
      workspaceId: ws(c),
      appId: app.id,
      actor: actor(c),
      context: body.data,
      at: ctx.now(),
    });
    if (!done.ok) return respond(c, done);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...done.stored, canEdit: true });
  });

  /** The tags the assistant gave reviews (advisory labels). Reading them needs only `reviews.read`: no provider is contacted. */
  routes.get('/:workspaceId/apps/:id/ai/review-tags', needs('reviews.read'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map((i) => i.trim())
      .filter((i) => i !== '');
    if (ids.length === 0 || ids.length > 100) {
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'ids', message: 'One to 100 review ids, separated by commas.' }],
        },
        400,
      );
    }
    const found = await getReviewTags(db, ws(c), app.id, ids);
    c.header('Cache-Control', 'no-store');
    return c.json({
      tags: [...found.values()].map(
        ({ taskVersion: _v, textHash: _h, createdAt: _c, ...tags }) => tags,
      ),
    });
  });

  // ----- suggestions -------------------------------------------------------------------------------
  routes.get('/:workspaceId/apps/:id/ai/suggestions', needs('ai.use'), async (c) => {
    const app = await getApp(db, ws(c), param(c, 'id'));
    if (!app) return c.json({ error: 'not_found' }, 404);
    const status = c.req.query('status');
    if (
      status !== undefined &&
      status !== '' &&
      !(aiSuggestionStatuses as readonly string[]).includes(status)
    ) {
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'status', message: `Use one of ${aiSuggestionStatuses.join(', ')}.` }],
        },
        400,
      );
    }
    const limit = queryInt(c.req.query('limit'), { fallback: 20, max: 100 });
    if (limit === undefined)
      return c.json(
        {
          error: 'invalid_request',
          issues: [{ path: 'limit', message: 'A whole number from 1 to 100.' }],
        },
        400,
      );
    const task = c.req.query('task');
    const suggestions = await listAppSuggestions(db, ws(c), app.id, {
      ...(status ? { status: status as (typeof aiSuggestionStatuses)[number] } : {}),
      ...(task ? { task } : {}),
      limit,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ suggestions });
  });

  routes.post(
    '/:workspaceId/ai/suggestions/:suggestionId/accept',
    needs('ai.use'),
    small,
    async (c) => {
      // An empty body is allowed: everything acceptable is accepted.
      const body = await parseBody(c, acceptBody);
      if (!body.ok) return body.response;
      const done = await acceptSuggestion(
        ctx,
        { workspaceId: ws(c), actor: actor(c), role: c.get('role'), allowed: allowedFor(c) },
        param(c, 'suggestionId'),
        body.data ?? {},
      );
      return done.ok
        ? c.json({ suggestion: done.suggestion, result: done.result })
        : respond(c, done);
    },
  );

  routes.post('/:workspaceId/ai/suggestions/:suggestionId/dismiss', needs('ai.use'), async (c) => {
    const done = await dismissSuggestion(
      ctx,
      { workspaceId: ws(c), actor: actor(c), role: c.get('role'), allowed: allowedFor(c) },
      param(c, 'suggestionId'),
    );
    return done.ok ? c.json({ suggestion: done.suggestion }) : respond(c, done);
  });

  // ----- one suggestion ----------------------------------------------------------------------------
  routes.get('/:workspaceId/ai/suggestions/:suggestionId', needs('ai.use'), async (c) => {
    const found = await getSuggestion(db, ws(c), param(c, 'suggestionId'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ suggestion: found });
  });

  return routes;
}
