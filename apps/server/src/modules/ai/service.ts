import { createHash } from 'node:crypto';
import { type AiClient, AiError, probeAiClient } from '@kiln/connectors';
import {
  type Action,
  type AiAcceptedRef,
  type AiAppContext,
  type AiProposal,
  type AiProvider,
  type AiSuggestionStatus,
  type AiSuggestionView,
  aiAcceptAction,
  aiLimits,
  aiProviderInfo,
  aiProviders,
  can,
  estimateTokens,
  type Role,
} from '@kiln/core';
import type { Database } from '@kiln/db';
import { getApp } from '../../services/apps.ts';
import { recordAudit } from '../../services/audit.ts';
import { emitEvent } from '../../services/events.ts';
import type { AsoSources } from '../aso/net.ts';
import { type AsoContext, type AsoLimits, addKeywords } from '../aso/service.ts';
import type { AssetsContext } from '../listing/asset-repo.ts';
import { normalizeListingValue } from '../listing/drift.ts';
import { type StagedContext, stageText } from '../publish/staged-changes.ts';
import { getReviewView, type ReviewReplyContext, saveReplyDraft } from '../reviews/replies.ts';
import { applyContextRules, getAppContext, withAppContext } from './ai-app-context.ts';
import {
  type AiActor,
  type AiConfigValues,
  type AiContext,
  type AiFailure,
  type Availability,
  aiAvailability,
  aiCredentialId,
  aiFail,
  buildAiClient,
  defaultAiConfig,
  failureForAiError,
  guardReason,
  newId,
  unavailableFailure,
  withGuardHint,
} from './ai-config.ts';
import {
  decideSuggestion,
  getSuggestion,
  insertSuggestion,
  listSuggestions,
  recordAccepted,
  reopenSuggestion,
  updateProposal,
} from './ai-suggestions.ts';
import type { AiTask, PreparedRun } from './ai-task-types.ts';
import { aiTasks, findAiTask } from './ai-tasks.ts';
import {
  type ConcurrencyGate,
  costOf,
  getMonthCost,
  getMonthUsage,
  type Prices,
  pricesSet,
  reserveTokens,
  settleUsage,
  type TaskUsage,
  type UsageWarning,
  usageWarning,
} from './ai-usage.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * Running AI tasks, and accepting or dismissing what they proposed (docs/adr/0016-ai-foundation.md, docs/api/ai.md).
 *
 * THE RULE: nothing in this file contacts a store, a repository or a person. A run asks ONE provider for ONE structured answer,
 * validates it, post-processes it into a proposal and stores it. Accepting calls an EXISTING service as the person who accepts:
 *   keywords      -> addKeywords        (`aso.write`):        tracks terms, contacts no store
 *   listing text  -> stageText          (`changesets.write`): STAGES a text (source `ai`); a later, previewed, gated push is the only way out
 *   reply draft   -> saveReplyDraft     (`reviews.triage`):   saves a DRAFT; sending is `reviews.reply` with a confirm hash, not reachable from here
 * The imports above are the whole list of what this module can do (a test reads them).
 */

export type AiServices = AiContext & {
  /** The limits the ASO routes run with (a keyword accepted here counts against the same limits). */
  asoLimits: AsoLimits;
  /** The repository seam staged texts need (not used to read anything for a text; the context type asks for it). */
  assets: AssetsContext;
  /** The reply context (kill switch `KILN_REVIEW_REPLY_ENABLED`, connector factory). saveReplyDraft is the only call made with it. */
  reply: ReviewReplyContext;
  gate: ConcurrencyGate;
};

export type AiOutcome<T> = ({ ok: true } & T) | AiFailure;

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------
// Configuration view

export type AiConfigView = {
  /** `ready` when a run would go to the provider now. */
  state: 'ready' | 'off_server' | 'off_workspace' | 'not_configured';
  /** Why it is `not_configured`: no_model | no_credential | no_url | credential_unreadable | bad_url. */
  reason?: string;
  server: { enabled: boolean; allowPrivateUrls: boolean };
  settings: {
    enabled: boolean;
    provider: AiProvider;
    model: string;
    /** Only managers see the address; others get null (see `baseUrlSet`). */
    baseUrl: string | null;
    baseUrlSet: boolean;
    monthlyTokenBudget: number;
    maxOutputTokens: number;
    maxInputTokens: number;
    softWarnPercent: number;
    priceInputCentsPerMTok: number;
    priceOutputCentsPerMTok: number;
    monthlyCostCapCents: number;
  };
  defaults: {
    monthlyTokenBudget: number;
    maxOutputTokens: number;
    maxInputTokens: number;
    softWarnPercent: number;
    priceInputCentsPerMTok: number;
    priceOutputCentsPerMTok: number;
    monthlyCostCapCents: number;
  };
  overridden: string[];
  providers: {
    id: AiProvider;
    label: string;
    credentialKind: string;
    credentialRequired: boolean;
    needsUrl: boolean;
    privacy: string;
    credentialPresent: boolean;
  }[];
  usage: {
    month: string;
    used: number;
    budget: number;
    remaining: number | null;
    runs: number;
    resetsAt: number;
    /** The estimated cost of the month in whole cents, from the prices an admin typed (0 when none are set). */
    estimatedCostCents: number;
    costCapCents: number;
    pricesSet: boolean;
    /** This month's runs per task, with the tokens and the estimated cost of each. */
    byTask: TaskUsage[];
    /** A soft warning (`soft`) or the limit (`limit`), or null. */
    warning: UsageWarning | null;
  };
  limits: {
    maxConcurrentPerWorkspace: number;
    runsPerMinute: number;
    maxGoalChars: number;
    suggestionRetentionDays: number;
    minMaxOutputTokens: number;
    maxMaxOutputTokens: number;
    minMaxInputTokens: number;
    maxMaxInputTokens: number;
    maxMonthlyTokenBudget: number;
  };
  canManage: boolean;
};

/** What the AI settings screen and a person about to run a task need to know. No secret, no prompt. */
export async function getAiConfigView(
  ctx: AiContext,
  workspaceId: string,
  role: Role,
): Promise<AiConfigView> {
  const availability = await aiAvailability(ctx, workspaceId);
  const { values, overridden } = availability.config;
  const canManage = can(role, 'ai.manage');
  const usage = await getMonthUsage(ctx.db, workspaceId, ctx.now());
  const prices: Prices = {
    inputCentsPerMTok: values.priceInputCentsPerMTok,
    outputCentsPerMTok: values.priceOutputCentsPerMTok,
  };
  const cost = await getMonthCost(ctx.db, workspaceId, ctx.now(), prices);
  const providers: AiConfigView['providers'] = [];
  for (const id of aiProviders) {
    const info = aiProviderInfo[id];
    providers.push({
      id,
      label: info.label,
      credentialKind: info.credentialKind,
      credentialRequired: info.credentialRequired,
      needsUrl: info.needsUrl,
      privacy: info.privacy,
      credentialPresent: (await aiCredentialId(ctx.db, workspaceId, id)) !== undefined,
    });
  }
  const defaults = defaultAiConfig();
  return {
    state: availability.state,
    ...(availability.reason ? { reason: availability.reason } : {}),
    server: { enabled: ctx.enabled, allowPrivateUrls: ctx.allowPrivateUrls === true },
    settings: {
      enabled: values.enabled,
      provider: values.provider,
      model: values.model,
      baseUrl: canManage ? values.baseUrl : null,
      baseUrlSet: values.baseUrl !== '',
      monthlyTokenBudget: values.monthlyTokenBudget,
      maxOutputTokens: values.maxOutputTokens,
      maxInputTokens: values.maxInputTokens,
      softWarnPercent: values.softWarnPercent,
      priceInputCentsPerMTok: values.priceInputCentsPerMTok,
      priceOutputCentsPerMTok: values.priceOutputCentsPerMTok,
      monthlyCostCapCents: values.monthlyCostCapCents,
    },
    defaults: {
      monthlyTokenBudget: defaults.monthlyTokenBudget,
      maxOutputTokens: defaults.maxOutputTokens,
      maxInputTokens: defaults.maxInputTokens,
      softWarnPercent: defaults.softWarnPercent,
      priceInputCentsPerMTok: defaults.priceInputCentsPerMTok,
      priceOutputCentsPerMTok: defaults.priceOutputCentsPerMTok,
      monthlyCostCapCents: defaults.monthlyCostCapCents,
    },
    overridden,
    providers,
    usage: {
      month: usage.month,
      used: usage.used,
      budget: values.monthlyTokenBudget,
      remaining:
        values.monthlyTokenBudget > 0 ? Math.max(0, values.monthlyTokenBudget - usage.used) : null,
      runs: usage.runs,
      resetsAt: usage.resetsAt,
      estimatedCostCents: cost.costCents,
      costCapCents: values.monthlyCostCapCents,
      pricesSet: pricesSet(prices),
      byTask: cost.byTask,
      warning: usageWarning({
        used: usage.used,
        budget: values.monthlyTokenBudget,
        costCents: cost.costCents,
        costCapCents: values.monthlyCostCapCents,
        softPercent: values.softWarnPercent,
        resetsAt: usage.resetsAt,
      }),
    },
    limits: {
      maxConcurrentPerWorkspace: aiLimits.maxConcurrentPerWorkspace,
      runsPerMinute: aiLimits.runsPerMinute,
      maxGoalChars: aiLimits.maxGoalChars,
      suggestionRetentionDays: aiLimits.suggestionRetentionDays,
      minMaxOutputTokens: aiLimits.minMaxOutputTokens,
      maxMaxOutputTokens: aiLimits.maxMaxOutputTokens,
      minMaxInputTokens: aiLimits.minMaxInputTokens,
      maxMaxInputTokens: aiLimits.maxMaxInputTokens,
      maxMonthlyTokenBudget: aiLimits.maxMonthlyTokenBudget,
    },
    canManage,
  };
}

/** The list of tasks with what each sends, for the screen that asks before a first use. */
export type AiTaskView = {
  id: string;
  version: number;
  label: string;
  description: string;
  status: 'ready' | 'planned';
  proposalKind: string | null;
  /** The right needed to ACCEPT its proposals (running needs `ai.use`). */
  acceptAction: string | null;
  scope: AiTask['scope'];
  disclosure: AiTask['disclosure'];
};

const CONTEXT_SENDS =
  'The AI context you wrote for this app (what it is, its audience, tone, words to avoid, names to keep), only the parts you filled in.';

/** A task that takes the app context says so in its disclosure, once, whatever its own text says. */
const disclosureOf = (t: AiTask): AiTask['disclosure'] => {
  if (
    t.status !== 'ready' ||
    t.useContext === false ||
    t.disclosure.sends.some((line) => /AI context/i.test(line))
  )
    return t.disclosure;
  return { sends: [...t.disclosure.sends, CONTEXT_SENDS], neverSends: t.disclosure.neverSends };
};

export function listAiTasks(): AiTaskView[] {
  return aiTasks.map((t) => ({
    id: t.id,
    version: t.version,
    label: t.label,
    description: t.description,
    status: t.status,
    proposalKind: t.status === 'ready' ? t.proposalKind : null,
    acceptAction: t.status === 'ready' ? aiAcceptAction[t.proposalKind] : null,
    scope: t.scope,
    disclosure: disclosureOf(t),
  }));
}

// ---------------------------------------------------------------------------------------------
// Running a task

export type RunInput = {
  workspaceId: string;
  actor: AiActor;
  taskId: string;
  appId: string;
  scope: Record<string, unknown>;
};

type Built = {
  task: Extract<AiTask, { status: 'ready' }>;
  app: NonNullable<Awaited<ReturnType<typeof getApp>>>;
  prepared: PreparedRun;
  /** What is sent: the task's input plus the app context, when there is one. */
  finalInput: unknown;
  inputText: string;
  schema: PreparedRun['schema'] & object;
  estimatedInput: number;
  maxTokens: number;
  values: AiConfigValues;
  availability: Availability;
  context: AiAppContext;
};

/**
 * Everything before the call: switches and set up -> task -> app -> the app's context -> input built from stored data -> input size.
 * Shared by a run and by the preview ("what will be sent"), so the preview is exactly what a run would send.
 */
async function buildRun(ctx: AiServices, input: RunInput): Promise<Built | AiFailure> {
  const availability = await aiAvailability(ctx, input.workspaceId);
  if (availability.state !== 'ready') return unavailableFailure(availability);
  const task = findAiTask(input.taskId);
  if (!task)
    return aiFail(404, 'unknown_task', 'There is no such AI task.', {
      taskId: input.taskId.slice(0, 60),
      ...coded('notFound.aiTask'),
    });
  if (task.status !== 'ready') {
    return aiFail(409, 'task_not_available', 'This task is registered but not built yet.', {
      task: task.id,
      ...coded('ai.taskNotBuilt'),
    });
  }
  const app = await getApp(ctx.db, input.workspaceId, input.appId);
  if (!app) return aiFail(404, 'not_found', 'There is no such app.', coded('notFound.app'));
  const context = (await getAppContext(ctx.db, input.workspaceId, app.id)).context;

  const prepared = await task.prepare(
    { db: ctx.db, now: ctx.now, workspaceId: input.workspaceId, app, context },
    input.scope,
  );
  if ('ok' in prepared) return prepared;

  const { values } = availability.config;
  const schema = prepared.schema ?? task.schema;
  const finalInput =
    task.useContext === false ? prepared.input : withAppContext(prepared.input, context);
  const inputText = JSON.stringify(finalInput);
  const estimatedInput =
    estimateTokens(task.system) +
    estimateTokens(inputText) +
    estimateTokens(JSON.stringify(schema));
  if (estimatedInput > values.maxInputTokens) {
    return aiFail(
      422,
      'ai_input_too_large',
      'The data for this run is larger than the input limit of this workspace. Nothing was sent.',
      {
        estimatedTokens: estimatedInput,
        maxInputTokens: values.maxInputTokens,
        ...coded('ai.inputTooLarge'),
      },
    );
  }
  const maxTokens = Math.min(task.maxOutputTokens, values.maxOutputTokens);
  return {
    task,
    app,
    prepared,
    finalInput,
    inputText,
    schema,
    estimatedInput,
    maxTokens,
    values,
    availability,
    context,
  };
}

export type AiPreview = {
  task: { id: string; version: number };
  /** The exact data a run would send, as the model sees it (JSON). Built from stored data only: nothing is sent to a provider. */
  input: unknown;
  /** The instruction text of the task. It holds no data of the workspace. */
  system: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  /** Whether the AI context of the app is part of the input. */
  includesAppContext: boolean;
  /** Where it would go. */
  provider: AiProvider;
  model: string;
};

/**
 * "What will be sent": builds the input of a run exactly as a run would and returns it. No provider is called, no tokens are reserved
 * and nothing is stored. It fails the way a run would before the call (no reviews, no listing text, input too large).
 */
export async function previewAiTask(
  ctx: AiServices,
  input: RunInput,
): Promise<AiOutcome<{ preview: AiPreview }>> {
  const built = await buildRun(ctx, input);
  if ('ok' in built) return built;
  return {
    ok: true,
    preview: {
      task: { id: built.task.id, version: built.task.version },
      input: built.finalInput,
      system: built.task.system,
      estimatedInputTokens: built.estimatedInput,
      maxOutputTokens: built.maxTokens,
      includesAppContext: built.finalInput !== built.prepared.input,
      provider: built.values.provider,
      model: built.values.model,
    },
  };
}

/**
 * Runs a task once and stores its PROPOSAL. Order of the checks, each before anything is sent:
 * switches and set up -> task -> app -> input built from stored data -> input size -> concurrency -> token budget and cost cap -> the call.
 */
export async function runAiTask(
  ctx: AiServices,
  input: RunInput,
): Promise<AiOutcome<{ suggestion: AiSuggestionView; warning: UsageWarning | null }>> {
  const plan = await buildRun(ctx, input);
  if ('ok' in plan) return plan;
  const {
    task,
    app,
    prepared,
    finalInput,
    inputText,
    schema,
    estimatedInput,
    maxTokens,
    values,
    availability,
    context,
  } = plan;
  const prices: Prices = {
    inputCentsPerMTok: values.priceInputCentsPerMTok,
    outputCentsPerMTok: values.priceOutputCentsPerMTok,
  };

  const release = ctx.gate.acquire(input.workspaceId);
  if (!release) {
    return aiFail(
      429,
      'ai_busy',
      'This workspace already has AI runs in progress. Try again in a few seconds.',
      { retryAfterSeconds: 5, ...coded('ai.runsInProgress') },
      { 'Retry-After': '5' },
    );
  }
  const runId = newId();
  const at = ctx.now();
  try {
    if (values.monthlyCostCapCents > 0 && pricesSet(prices)) {
      const spent = await getMonthCost(ctx.db, input.workspaceId, at, prices);
      const thisRun = Math.ceil(costOf(estimatedInput, maxTokens, prices));
      if (spent.costCents + thisRun > values.monthlyCostCapCents) {
        const month = await getMonthUsage(ctx.db, input.workspaceId, at);
        return aiFail(
          429,
          'ai_cost_cap_reached',
          'The estimated monthly cost cap of this workspace would be passed by this run. It resets at the start of next month, or an admin can raise it in the AI settings. Nothing was sent.',
          {
            capCents: values.monthlyCostCapCents,
            estimatedCents: spent.costCents,
            resetsAt: month.resetsAt,
            ...coded('ai.costCap'),
          },
        );
      }
    }
    const reserved = await reserveTokens(
      ctx.db,
      {
        id: runId,
        workspaceId: input.workspaceId,
        appId: app.id,
        task: task.id,
        taskVersion: task.version,
        provider: values.provider,
        model: values.model,
        actorId: input.actor.id,
        at,
      },
      estimatedInput + maxTokens,
      values.monthlyTokenBudget,
    );
    if (!reserved.ok) {
      const usage = await getMonthUsage(ctx.db, input.workspaceId, at);
      return aiFail(
        429,
        'ai_budget_exhausted',
        'The monthly token budget of this workspace is used up. It resets at the start of next month, or an admin can raise it in the AI settings.',
        {
          budget: reserved.budget,
          used: reserved.used,
          resetsAt: usage.resetsAt,
          ...coded('ai.tokenBudget'),
        },
      );
    }
    const inputHash = sha(inputText);
    const built = await buildAiClient(ctx, input.workspaceId, availability, input.actor);
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

    let output: unknown;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let model: string = values.model;
    try {
      const answer = await built.client.complete({
        system: task.system,
        input: finalInput,
        schema,
        schemaName: task.schemaName,
        maxTokens,
        signal: AbortSignal.timeout((ctx.timeoutMs ?? 60_000) + 5_000),
      });
      output = answer.output;
      usage = answer.usage;
      model = answer.model;
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
      await auditRunFailed(ctx, input, task, app.id, values.provider, values.model, failure, spent);
      return failure;
    }

    let proposal: AiProposal;
    try {
      proposal = applyContextRules(task.propose(output, prepared), context);
    } catch {
      // A post-processor that cannot make sense of a schema-valid answer: the answer is rejected like an invalid one. Tokens were spent.
      const failure = failureForAiError(
        new AiError('invalid_output', { detail: 'schema' }),
        values.provider,
      );
      await settleUsage(ctx.db, runId, {
        status: 'failed',
        errorCode: 'ai_invalid_output',
        ...usage,
        at: ctx.now(),
      });
      await auditRunFailed(ctx, input, task, app.id, values.provider, values.model, failure, usage);
      return failure;
    }

    const suggestionId = newId();
    const finishedAt = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await settleUsage(tx, runId, { status: 'ok', ...usage, at: finishedAt });
      await insertSuggestion(tx, {
        id: suggestionId,
        workspaceId: input.workspaceId,
        appId: app.id,
        task: task.id,
        taskVersion: task.version,
        kind: task.proposalKind,
        provider: values.provider,
        model,
        scope: prepared.scope,
        proposal,
        inputHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        createdBy: input.actor.id,
        at: finishedAt,
      });
      // A task that also keeps its result somewhere else (the review tags cache) writes it here, in the same transaction.
      await task.persist?.(
        tx,
        {
          workspaceId: input.workspaceId,
          appId: app.id,
          provider: values.provider,
          model,
          at: finishedAt,
        },
        proposal,
        prepared,
      );
      await recordAudit(tx, {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: 'ai.run',
        target: { type: 'ai_suggestion', id: suggestionId },
        // Ids, versions, counts and a hash. Never the prompt, the data sent, the answer or any review text.
        detail: {
          suggestionId,
          appId: app.id,
          task: task.id,
          taskVersion: task.version,
          provider: values.provider,
          model,
          inputHash,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          scope: prepared.scope,
        },
        at: finishedAt,
      });
      await emitEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'ai.suggestion_created',
        subject: { appId: app.id },
        // Ids only: a webhook receiver learns that a suggestion exists, not what it says.
        payload: {
          suggestionId,
          appId: app.id,
          task: task.id,
          taskVersion: task.version,
          kind: task.proposalKind,
        },
        at: finishedAt,
      });
    });
    const suggestion = (await getSuggestion(
      ctx.db,
      input.workspaceId,
      suggestionId,
    )) as AiSuggestionView;
    const month = await getMonthUsage(ctx.db, input.workspaceId, finishedAt);
    const cost = await getMonthCost(ctx.db, input.workspaceId, finishedAt, prices);
    const warning = usageWarning({
      used: month.used,
      budget: values.monthlyTokenBudget,
      costCents: cost.costCents,
      costCapCents: values.monthlyCostCapCents,
      softPercent: values.softWarnPercent,
      resetsAt: month.resetsAt,
    });
    return { ok: true, suggestion, warning };
  } finally {
    release();
  }
}

async function auditRunFailed(
  ctx: AiServices,
  input: RunInput,
  task: AiTask,
  appId: string,
  provider: AiProvider,
  model: string,
  failure: AiFailure,
  spent: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await recordAudit(ctx.db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'ai.run_failed',
    target: { type: 'app', id: appId },
    // A fixed code and counts: never provider text, never the data.
    detail: {
      appId,
      task: task.id,
      taskVersion: task.version,
      provider,
      model,
      code: failure.body.error,
      inputTokens: spent.inputTokens,
      outputTokens: spent.outputTokens,
    },
    at: ctx.now(),
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Connection test

export type AiTestOutcome =
  | { ok: true; provider: AiProvider; model: string }
  | {
      ok: false;
      provider: AiProvider;
      kind: string;
      message: string;
      reason?: string;
      retryAfterSeconds?: number;
      sample?: string;
    };

/**
 * One fixed request through the configured provider (no data of the workspace in it). Needs the same switches as a run. Counts a few
 * tokens in the usage. Answers with a fixed sentence, never provider text.
 */
export async function testAiConnection(
  ctx: AiServices,
  input: { workspaceId: string; actor: AiActor },
): Promise<AiOutcome<{ result: AiTestOutcome }>> {
  const availability = await aiAvailability(ctx, input.workspaceId);
  if (availability.state !== 'ready') return unavailableFailure(availability);
  const { values } = availability.config;
  const release = ctx.gate.acquire(input.workspaceId);
  if (!release)
    return aiFail(
      429,
      'ai_busy',
      'This workspace already has AI runs in progress. Try again in a few seconds.',
      { retryAfterSeconds: 5, ...coded('ai.runsInProgress') },
      { 'Retry-After': '5' },
    );
  const runId = newId();
  try {
    const reserved = await reserveTokens(
      ctx.db,
      {
        id: runId,
        workspaceId: input.workspaceId,
        appId: null,
        task: 'connection_test',
        taskVersion: 1,
        provider: values.provider,
        model: values.model,
        actorId: input.actor.id,
        at: ctx.now(),
      },
      300,
      values.monthlyTokenBudget,
    );
    if (!reserved.ok) {
      const usage = await getMonthUsage(ctx.db, input.workspaceId, ctx.now());
      return aiFail(
        429,
        'ai_budget_exhausted',
        'The monthly token budget of this workspace is used up.',
        {
          budget: reserved.budget,
          used: reserved.used,
          resetsAt: usage.resetsAt,
          ...coded('ai.tokenBudgetUsed'),
        },
      );
    }
    const built = await buildAiClient(ctx, input.workspaceId, availability, input.actor);
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
    const probe = await probeAiClient(
      built.client as AiClient,
      AbortSignal.timeout((ctx.timeoutMs ?? 60_000) + 5_000),
    );
    const blockedReason = probe.ok
      ? undefined
      : await guardReason(ctx, values.baseUrl, built.guard);
    const result: AiTestOutcome = probe.ok
      ? { ok: true, provider: probe.provider, model: probe.model }
      : {
          ok: false,
          provider: probe.provider,
          kind: probe.kind,
          message: probe.message,
          ...(blockedReason
            ? { reason: blockedReason }
            : probe.detail
              ? { reason: probe.detail }
              : {}),
          ...(probe.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: probe.retryAfterSeconds }
            : {}),
          // The one place a model's words leave the server: the first 300 characters it answered to this FIXED request, which holds
          // no workspace data. Returned to the admin who ran the test; never stored, audited or logged, and a task run never has it.
          ...(probe.sample ? { sample: probe.sample } : {}),
        };
    await settleUsage(ctx.db, runId, {
      status: probe.ok ? 'ok' : 'failed',
      ...(probe.ok ? {} : { errorCode: `ai_${probe.kind}` }),
      inputTokens: 0,
      outputTokens: 0,
      at: ctx.now(),
    });
    await recordAudit(ctx.db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'ai.test',
      target: { type: 'workspace', id: input.workspaceId },
      detail: {
        provider: values.provider,
        model: values.model,
        ok: probe.ok,
        ...(probe.ok ? {} : { kind: probe.kind }),
      },
      at: ctx.now(),
    });
    return { ok: true, result };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

export async function listAppSuggestions(
  db: Database,
  workspaceId: string,
  appId: string,
  filter: { status?: AiSuggestionStatus; task?: string; limit?: number },
): Promise<AiSuggestionView[]> {
  return listSuggestions(db, workspaceId, appId, filter);
}

export { getSuggestion };

// ---------------------------------------------------------------------------------------------
// Dismissing and accepting

export type Decider = {
  workspaceId: string;
  actor: AiActor;
  role: Role;
  /** Whether the caller may do this action: the role AND, for a token, its own list. */
  allowed: (action: Action) => boolean;
};

const refusedSources: AsoSources = {
  playEnabled: false,
  search: () => Promise.reject(new Error('AI never searches a store.')),
  lookup: () => Promise.reject(new Error('AI never looks a store up.')),
};

export type AcceptBody = {
  items?: number[] | undefined;
  fields?: string[] | undefined;
  /** For `listing_variants`: which variant of which field (at most one per field). */
  choices?: { field: string; variant: number }[] | undefined;
  replace?: boolean | undefined;
};

export async function dismissSuggestion(
  ctx: AiServices,
  who: Decider,
  id: string,
): Promise<AiOutcome<{ suggestion: AiSuggestionView }>> {
  const found = await getSuggestion(ctx.db, who.workspaceId, id);
  if (!found) return aiFail(
    404,
    'not_found',
    'There is no such suggestion.',
    coded('notFound.suggestion'),
  );
  if (found.status !== 'proposed') return notProposed(found);
  const at = ctx.now();
  const won = await ctx.db.transaction(async (tx) => {
    const changed = await decideSuggestion(tx, {
      workspaceId: who.workspaceId,
      id,
      status: 'dismissed',
      actorId: who.actor.id,
      at,
    });
    if (changed) {
      await recordAudit(tx, {
        workspaceId: who.workspaceId,
        actor: who.actor,
        action: 'ai.suggestion_dismissed',
        target: { type: 'ai_suggestion', id },
        detail: {
          suggestionId: id,
          appId: found.appId,
          task: found.task,
          taskVersion: found.taskVersion,
        },
        at,
      });
    }
    return changed;
  });
  const now = (await getSuggestion(ctx.db, who.workspaceId, id)) as AiSuggestionView;
  return won ? { ok: true, suggestion: now } : notProposed(now);
}

const notProposed = (s: AiSuggestionView): AiFailure =>
  aiFail(409, 'suggestion_not_proposed', `This suggestion was already ${s.status}.`, {
    status: s.status,
  });

/**
 * Accepts a proposal: the CALLER's right for the kind (`aso.write`, `changesets.write`, `reviews.triage`) is checked here, the
 * suggestion is claimed (only one accept can win), and the existing service does the work as the caller. If it refuses, the
 * suggestion goes back to `proposed` and the refusal is passed on. The result holds ids, never text.
 */
export async function acceptSuggestion(
  ctx: AiServices,
  who: Decider,
  id: string,
  body: AcceptBody,
): Promise<AiOutcome<{ suggestion: AiSuggestionView; result: AiAcceptedRef }>> {
  const found = await getSuggestion(ctx.db, who.workspaceId, id);
  if (!found) return aiFail(
    404,
    'not_found',
    'There is no such suggestion.',
    coded('notFound.suggestion'),
  );
  if (found.status !== 'proposed') return notProposed(found);
  const action = aiAcceptAction[found.kind];
  if (!who.allowed(action)) {
    return aiFail(
      403,
      'forbidden',
      `Accepting this kind of suggestion needs the right ${action}.`,
      { action, ...coded('ai.suggestionNeedsRight', { action }) },
    );
  }
  const app = await getApp(ctx.db, who.workspaceId, found.appId);
  if (!app) return aiFail(
    404,
    'not_found',
    'The app of this suggestion no longer exists.',
    coded('ai.suggestionAppGone'),
  );

  // What would be created is decided (and refused) BEFORE the claim, so a refusal changes nothing.
  const plan = planAccept(found.proposal, body);
  if ('ok' in plan) return plan;

  const at = ctx.now();

  // Some of the open keyword ideas were ticked: they are tracked and the rest STAY proposed (the suggestion closes with its last open item).
  if (plan.kind === 'keywords' && plan.remaining > 0) {
    const tracked: number[] = [];
    const outcome = await applyPlan(ctx, who, app, plan, body.replace === true, tracked);
    if ('ok' in outcome) return outcome;
    const accepted = { ...(outcome as AiAcceptedRef) } as Extract<
      AiAcceptedRef,
      { kind: 'keywords' }
    >;
    await ctx.db.transaction(async (tx) => {
      const fresh = await getSuggestion(tx, who.workspaceId, id);
      let left = plan.remaining;
      if (fresh && fresh.status === 'proposed' && fresh.proposal.kind === 'keywords') {
        const next = markTracked(fresh.proposal, tracked);
        left = next.items.filter((i) => i.acceptable).length;
        await updateProposal(tx, who.workspaceId, id, next);
        if (left === 0) {
          accepted.remaining = 0;
          if (
            await decideSuggestion(tx, {
              workspaceId: who.workspaceId,
              id,
              status: 'accepted',
              actorId: who.actor.id,
              at,
              accepted,
            })
          ) {
            await recordAccepted(tx, who.workspaceId, id, accepted);
          }
        }
      }
      accepted.remaining = left;
      await recordAudit(tx, {
        workspaceId: who.workspaceId,
        actor: who.actor,
        action: 'ai.suggestion_accepted',
        target: { type: 'ai_suggestion', id },
        detail: {
          suggestionId: id,
          appId: found.appId,
          task: found.task,
          taskVersion: found.taskVersion,
          kind: found.kind,
          partial: left > 0,
          remaining: left,
          result: summarize(accepted),
        },
        at: ctx.now(),
      });
    });
    return {
      ok: true,
      suggestion: (await getSuggestion(ctx.db, who.workspaceId, id)) as AiSuggestionView,
      result: accepted,
    };
  }

  const claimed = await ctx.db.transaction((tx) =>
    decideSuggestion(tx, {
      workspaceId: who.workspaceId,
      id,
      status: 'accepted',
      actorId: who.actor.id,
      at,
    }),
  );
  if (!claimed)
    return notProposed((await getSuggestion(ctx.db, who.workspaceId, id)) as AiSuggestionView);

  const outcome = await applyPlan(ctx, who, app, plan, body.replace === true);
  if ('ok' in outcome) {
    await reopenSuggestion(ctx.db, who.workspaceId, id);
    return outcome;
  }
  const accepted = outcome as AiAcceptedRef;
  if (accepted.kind === 'keywords') accepted.remaining = 0;
  await ctx.db.transaction(async (tx) => {
    await recordAccepted(tx, who.workspaceId, id, accepted);
    await recordAudit(tx, {
      workspaceId: who.workspaceId,
      actor: who.actor,
      action: 'ai.suggestion_accepted',
      target: { type: 'ai_suggestion', id },
      // Ids and counts only. The mechanism wrote its own audit entry (aso.keyword_add, staged.text_set, review.reply_draft).
      detail: {
        suggestionId: id,
        appId: found.appId,
        task: found.task,
        taskVersion: found.taskVersion,
        kind: found.kind,
        result: summarize(accepted),
      },
      at: ctx.now(),
    });
  });
  return {
    ok: true,
    suggestion: (await getSuggestion(ctx.db, who.workspaceId, id)) as AiSuggestionView,
    result: accepted,
  };
}

/** The items of a keyword proposal that were just tracked are now "already tracked": shown so, no longer acceptable. */
function markTracked(
  proposal: Extract<AiProposal, { kind: 'keywords' }>,
  tracked: readonly number[],
): Extract<AiProposal, { kind: 'keywords' }> {
  return {
    ...proposal,
    items: proposal.items.map((item, i) =>
      tracked.includes(i)
        ? {
            ...item,
            acceptable: false,
            flags: item.flags.includes('already_tracked')
              ? item.flags
              : [...item.flags, 'already_tracked' as const],
          }
        : item,
    ),
  };
}

const summarize = (ref: AiAcceptedRef): Record<string, unknown> => {
  switch (ref.kind) {
    case 'keywords':
      return {
        created: ref.created,
        existing: ref.existing,
        rejected: ref.rejected,
        keywordIds: ref.keywordIds.slice(0, 50),
        ...(ref.remaining !== undefined ? { remaining: ref.remaining } : {}),
      };
    case 'listing_text':
      return { fields: ref.stagedFields, locale: ref.locale };
    case 'reply_draft':
      return { reviewId: ref.reviewId, draftId: ref.draftId };
    case 'insight':
      return {};
  }
};

type Plan =
  | {
      kind: 'keywords';
      store: string;
      country: string;
      locale: string;
      items: { term: string; reason: string }[];
      chosen: number[];
      remaining: number;
    }
  | { kind: 'listing_text'; locale: string; fields: { field: string; text: string }[] }
  | { kind: 'reply_draft'; reviewId: string; text: string }
  | { kind: 'insight' };

const nothing = (message: string, extra: Record<string, unknown> = {}): AiFailure =>
  aiFail(422, 'nothing_acceptable', message, extra);

/** Which parts of the proposal are accepted: the named ones, or every acceptable one. A part that cannot be accepted is never accepted. */
function planAccept(proposal: AiProposal, body: AcceptBody): Plan | AiFailure {
  switch (proposal.kind) {
    case 'keywords': {
      const wanted = body.items ?? proposal.items.map((_, i) => i);
      const bad = wanted.filter((i) => !Number.isInteger(i) || i < 0 || i >= proposal.items.length);
      if (bad.length > 0)
        return aiFail(400, 'invalid_request', 'An item number is not in this suggestion.', {
          issues: [{ path: 'items', message: 'Item numbers start at 0.' }],
        });
      const chosen = [...new Set(wanted)].filter((i) => proposal.items[i]?.acceptable === true);
      const refused = body.items
        ? [...new Set(wanted)].filter((i) => proposal.items[i]?.acceptable !== true)
        : [];
      if (refused.length > 0)
        return nothing('An item you chose cannot be accepted (see its flags).', { items: refused });
      if (chosen.length === 0) return nothing('Nothing in this suggestion can be accepted.');
      const open = proposal.items.flatMap((it, i) =>
        it.acceptable === true && !chosen.includes(i) ? [i] : [],
      );
      return {
        kind: 'keywords',
        store: proposal.store,
        country: proposal.country,
        locale: proposal.locale,
        chosen,
        remaining: open.length,
        items: chosen.map((i) => ({
          term: (proposal.items[i] as { term: string }).term,
          reason: (proposal.items[i] as { reason: string }).reason,
        })),
      };
    }
    case 'listing_text': {
      const names = body.fields ?? proposal.fields.map((f) => f.field);
      const unknown = names.filter((n) => !proposal.fields.some((f) => f.field === n));
      if (unknown.length > 0)
        return aiFail(400, 'invalid_request', 'A field is not in this suggestion.', {
          issues: unknown.map((path) => ({
            path: `fields.${path}`,
            message: 'Not in this suggestion.',
          })),
        });
      const picked = proposal.fields.filter((f) => names.includes(f.field));
      const refused = picked.filter((f) => !f.acceptable).map((f) => f.field);
      if (body.fields && refused.length > 0)
        return nothing('A field you chose cannot be accepted (see its flags).', {
          fields: refused,
        });
      const ok = picked.filter((f) => f.acceptable);
      if (ok.length === 0) return nothing('Nothing in this suggestion can be accepted.');
      return {
        kind: 'listing_text',
        locale: proposal.locale,
        fields: ok.map((f) => ({ field: f.field, text: f.text })),
      };
    }
    case 'reply_draft':
      if (!proposal.acceptable)
        return nothing(
          'This reply cannot be accepted as a draft (see its flags). Write it by hand instead.',
        );
      return { kind: 'reply_draft', reviewId: proposal.reviewId, text: proposal.text };
    case 'insight':
      // A report is read, not applied: accepting it only marks it reviewed. Nothing is created and no other service is called.
      return { kind: 'insight' };
    case 'listing_variants': {
      const chosen: { field: string; text: string }[] = [];
      const seenFields = new Set<string>();
      // Without `choices`, the first variant of each field that can be accepted. With them, exactly what was named.
      const wanted =
        body.choices ??
        proposal.fields.flatMap((f) => {
          const first = f.variants.findIndex((v) => v.acceptable);
          return first === -1 ? [] : [{ field: f.field, variant: first }];
        });
      const issues: { path: string; message: string }[] = [];
      for (const c of wanted) {
        const field = proposal.fields.find((f) => f.field === c.field);
        const variant = field?.variants[c.variant];
        if (!field || !variant || !Number.isInteger(c.variant)) {
          issues.push({
            path: `choices.${c.field}`,
            message: 'Not a field and variant of this suggestion.',
          });
          continue;
        }
        if (seenFields.has(c.field)) {
          issues.push({ path: `choices.${c.field}`, message: 'Choose one variant per field.' });
          continue;
        }
        seenFields.add(c.field);
        if (!variant.acceptable) {
          if (body.choices)
            return nothing('A variant you chose cannot be accepted (see its flags).', {
              fields: [c.field],
            });
          continue;
        }
        chosen.push({ field: c.field, text: variant.text });
      }
      if (issues.length > 0)
        return aiFail(400, 'invalid_request', 'A choice is not valid.', { issues });
      if (chosen.length === 0) return nothing('Nothing in this suggestion can be accepted.');
      return { kind: 'listing_text', locale: proposal.locale, fields: chosen };
    }
  }
}

async function applyPlan(
  ctx: AiServices,
  who: Decider,
  app: NonNullable<Awaited<ReturnType<typeof getApp>>>,
  plan: Plan,
  replace: boolean,
  /** Keyword plans: gets the proposal item numbers that are now tracked (created, or there already). */
  tracked: number[] = [],
): Promise<AiAcceptedRef | AiFailure> {
  const workspaceId = who.workspaceId;
  const actor = who.actor;
  switch (plan.kind) {
    case 'keywords': {
      const asoCtx: AsoContext = {
        db: ctx.db,
        now: ctx.now,
        sources: refusedSources,
        limits: ctx.asoLimits,
      };
      const results = await addKeywords(asoCtx, {
        workspaceId,
        app,
        actor,
        items: plan.items.map((i) => ({
          term: i.term,
          country: plan.country,
          locale: plan.locale,
          tag: 'ai',
          notes: i.reason,
        })),
      });
      for (const r of results)
        if (r.status === 'created' || r.status === 'exists')
          tracked.push(plan.chosen[r.index] as number);
      const created = results.flatMap((r) => (r.status === 'created' ? [r.keyword.id] : []));
      const existing = results.filter((r) => r.status === 'exists').length;
      const rejected = results.filter((r) => r.status === 'invalid' || r.status === 'limit').length;
      if (created.length === 0 && existing === 0) {
        const limited = results.some((r) => r.status === 'limit');
        return aiFail(
          422,
          limited ? 'keyword_limit' : 'nothing_acceptable',
          limited
            ? 'The app already tracks the most keywords it may.'
            : 'None of the keywords could be tracked.',
          { rejected },
        );
      }
      return {
        kind: 'keywords',
        keywordIds: created,
        created: created.length,
        existing,
        rejected,
        locale: plan.locale,
        country: plan.country,
        remaining: plan.remaining,
      };
    }
    case 'listing_text': {
      const staged: StagedContext = { db: ctx.db, now: ctx.now, assets: ctx.assets };
      if (!replace) {
        const rows = await ctx.db.query(
          "SELECT target, value_text FROM staged_changes WHERE workspace_id = ? AND app_id = ? AND kind = 'listing_text' AND locale = ? AND ordinal = 0",
          [workspaceId, app.id, plan.locale],
        );
        const clash = plan.fields
          .filter((f) =>
            rows.some(
              (r) =>
                String(r.target) === f.field &&
                String(r.value_text ?? '') !== normalizeListingValue(f.text),
            ),
          )
          .map((f) => f.field);
        if (clash.length > 0) {
          return aiFail(
            409,
            'staged_exists',
            'A different text is already staged for a field. Send replace: true to overwrite it, or unstage it first.',
            { fields: clash },
          );
        }
      }
      const done: string[] = [];
      for (const f of plan.fields) {
        const staged1 = await stageText(staged, {
          workspaceId,
          appId: app.id,
          locale: plan.locale,
          field: f.field,
          from: 'ai',
          value: f.text,
          actor,
        });
        if (!staged1.ok) {
          return aiFail(
            staged1.status,
            String(staged1.body.error),
            String(staged1.body.message ?? 'The text could not be staged.'),
            { field: f.field, staged: done },
          );
        }
        done.push(f.field);
      }
      return { kind: 'listing_text', stagedFields: done, locale: plan.locale };
    }
    case 'insight':
      return { kind: 'insight' };
    case 'reply_draft': {
      const review = await getReviewView(ctx.db, workspaceId, app.id, plan.reviewId);
      if (!review)
        return aiFail(
          404,
          'not_found',
          'The review of this suggestion no longer exists.',
          coded('ai.suggestionReviewGone'),
        );
      const existing = review.replyDraft;
      if (existing && existing.status !== 'draft') {
        return aiFail(
          409,
          'reply_not_editable',
          'This review already has a reply that was sent, or is being sent. A draft cannot replace it.',
          { status: existing.status, ...coded('ai.replyExists') },
        );
      }
      if (existing && existing.text !== plan.text && !replace) {
        return aiFail(
          409,
          'draft_exists',
          'This review already has a different draft. Send replace: true to overwrite it.',
          {},
        );
      }
      const saved = await saveReplyDraft(ctx.reply, {
        workspaceId,
        appId: app.id,
        reviewId: review.id,
        text: plan.text,
        actor,
      });
      if (!saved.ok)
        return aiFail(
          saved.status as AiFailure['status'],
          String(saved.body.error),
          String(saved.body.message ?? 'The draft could not be saved.'),
          {},
        );
      return { kind: 'reply_draft', reviewId: review.id, draftId: saved.draft.id };
    }
  }
}
