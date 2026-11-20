import { type AiClient, AiError, type JsonSchema } from '@mrm/connectors';
import { type AiProvider, estimateTokens } from '@mrm/core';
import {
  type AiActor,
  type AiConfigValues,
  type AiContext,
  type AiFailure,
  aiAvailability,
  aiFail,
  type BuiltClient,
  buildAiClient,
  failureForAiError,
  newId,
  unavailableFailure,
  withGuardHint,
} from './ai-config.ts';
import {
  costOf,
  getMonthCost,
  getMonthUsage,
  type Prices,
  pricesSet,
  reserveTokens,
  settleUsage,
  type UsageWarning,
  usageWarning,
} from './ai-usage.ts';

/**
 * ONE answer from the workspace's AI provider, returned to the caller and stored nowhere (docs/adr/0028-release-notes-translation.md).
 *
 * `runAiTask` (services/ai.ts) turns an answer into a stored PROPOSAL that a person accepts from the tray. Some features want the
 * text itself, to put in an editor that stays unsaved (the translation of release notes). They use this: the same checks in the same
 * order as a run (switches and set up -> input size -> cost cap -> token budget), the same usage rows (`ai_usage`, so the month's
 * budget, the cost estimate and the warning count these calls too), the same fixed failure sentences, and no suggestion, no event.
 * The caller holds the concurrency gate and writes the audit entry (ids and counts, never the data or the answer).
 */

export type DirectTask = {
  /** Shown in the usage table of the month. */
  id: string;
  version: number;
  /** The instructions. They hold no data of the workspace. */
  system: string;
  schemaName: string;
};

export type DirectRun = {
  workspaceId: string;
  appId: string;
  actor: AiActor;
  task: DirectTask;
  /** The data, as the model sees it. */
  input: unknown;
  schema: JsonSchema;
  /** At most this many tokens are written; the workspace's own limit applies too. */
  maxOutputTokens: number;
};

export type DirectAnswer = {
  ok: true;
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: AiProvider;
};

export async function runAiDirect(ctx: AiContext, run: DirectRun): Promise<DirectAnswer | AiFailure> {
  const availability = await aiAvailability(ctx, run.workspaceId);
  if (availability.state !== 'ready') return unavailableFailure(availability);
  const { values } = availability.config;
  const inputText = JSON.stringify(run.input);
  const estimatedInput =
    estimateTokens(run.task.system) + estimateTokens(inputText) + estimateTokens(JSON.stringify(run.schema));
  if (estimatedInput > values.maxInputTokens) {
    return aiFail(
      422,
      'ai_input_too_large',
      'The data for this run is larger than the input limit of this workspace. Nothing was sent.',
      { estimatedTokens: estimatedInput, maxInputTokens: values.maxInputTokens },
    );
  }
  const maxTokens = Math.min(run.maxOutputTokens, values.maxOutputTokens);
  const prices: Prices = {
    inputCentsPerMTok: values.priceInputCentsPerMTok,
    outputCentsPerMTok: values.priceOutputCentsPerMTok,
  };
  const at = ctx.now();
  if (values.monthlyCostCapCents > 0 && pricesSet(prices)) {
    const spent = await getMonthCost(ctx.db, run.workspaceId, at, prices);
    const thisRun = Math.ceil(costOf(estimatedInput, maxTokens, prices));
    if (spent.costCents + thisRun > values.monthlyCostCapCents) {
      const month = await getMonthUsage(ctx.db, run.workspaceId, at);
      return aiFail(
        429,
        'ai_cost_cap_reached',
        'The estimated monthly cost cap of this workspace would be passed by this run. It resets at the start of next month, or an admin can raise it in the AI settings. Nothing was sent.',
        {
          capCents: values.monthlyCostCapCents,
          estimatedCents: spent.costCents,
          resetsAt: month.resetsAt,
        },
      );
    }
  }
  const runId = newId();
  const reserved = await reserveTokens(
    ctx.db,
    {
      id: runId,
      workspaceId: run.workspaceId,
      appId: run.appId,
      task: run.task.id,
      taskVersion: run.task.version,
      provider: values.provider,
      model: values.model,
      actorId: run.actor.id,
      at,
    },
    estimatedInput + maxTokens,
    values.monthlyTokenBudget,
  );
  if (!reserved.ok) {
    const usage = await getMonthUsage(ctx.db, run.workspaceId, at);
    return aiFail(
      429,
      'ai_budget_exhausted',
      'The monthly token budget of this workspace is used up. It resets at the start of next month, or an admin can raise it in the AI settings.',
      { budget: reserved.budget, used: reserved.used, resetsAt: usage.resetsAt },
    );
  }
  const built: BuiltClient | AiFailure = await buildAiClient(ctx, run.workspaceId, availability, run.actor);
  if ('ok' in built) {
    await settleUsage(ctx.db, runId, {
      status: 'failed',
      errorCode: String(built.body.error),
      inputTokens: 0,
      outputTokens: 0,
      at: ctx.now(),
    });
    return built;
  }
  const client: AiClient = built.client;
  try {
    const answer = await client.complete({
      system: run.task.system,
      input: run.input,
      schema: run.schema,
      schemaName: run.task.schemaName,
      maxTokens,
      signal: AbortSignal.timeout((ctx.timeoutMs ?? 60_000) + 5_000),
    });
    await settleUsage(ctx.db, runId, { status: 'ok', ...answer.usage, at: ctx.now() });
    return {
      ok: true,
      output: answer.output,
      usage: answer.usage,
      model: answer.model,
      provider: values.provider,
    };
  } catch (error) {
    const known = error instanceof AiError ? error : new AiError('unavailable');
    const failure = await withGuardHint(
      failureForAiError(known, values.provider),
      built.guard,
      ctx,
      values.baseUrl,
    );
    const spent = known.usage ?? { inputTokens: 0, outputTokens: 0 };
    await settleUsage(ctx.db, runId, {
      status: 'failed',
      errorCode: String(failure.body.error),
      ...spent,
      at: ctx.now(),
    });
    return failure;
  }
}

/** The soft warning or the limit message for this month, as a run of a task answers with, or null. */
export async function currentAiWarning(
  ctx: Pick<AiContext, 'db' | 'now'>,
  workspaceId: string,
  values: AiConfigValues,
): Promise<UsageWarning | null> {
  const at = ctx.now();
  const prices: Prices = {
    inputCentsPerMTok: values.priceInputCentsPerMTok,
    outputCentsPerMTok: values.priceOutputCentsPerMTok,
  };
  const month = await getMonthUsage(ctx.db, workspaceId, at);
  const cost = await getMonthCost(ctx.db, workspaceId, at, prices);
  return usageWarning({
    used: month.used,
    budget: values.monthlyTokenBudget,
    costCents: cost.costCents,
    costCapCents: values.monthlyCostCapCents,
    softPercent: values.softWarnPercent,
    resetsAt: month.resetsAt,
  });
}
