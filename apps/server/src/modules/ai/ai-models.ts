import {
  type AiClient,
  AiError,
  type AiModelInfo,
  aiFallbackModels,
  type CreateAiClientInput,
  createAiClient,
  LIST_ONLY_MODEL,
} from '@kiln/connectors';
import { type AiProvider, aiProviderInfo } from '@kiln/core';
import { recordAudit } from '../../services/audit.ts';
import { useCredentialSecret } from '../../services/credentials.ts';
import { checkTranslateUrl, createGuardedFetch } from '../../services/translate-net.ts';
import {
  type AiActor,
  type AiContext,
  type AiFailure,
  addressHint,
  aiCredentialId,
  aiFail,
  aiNotConfigured,
  aiNotEnabled,
  failureForAiError,
  guardReason,
  readAiConfig,
} from './ai-config.ts';

/**
 * Model discovery for the AI settings (docs/api/ai.md, `POST /ai/models`): the models a provider says it serves, so a person picks one
 * instead of typing it. It sends no data of the workspace, only a read (`GET /models`) with the key.
 *
 * - The key comes from the body for this one call (a person who has typed it but not saved it yet), else from the stored credential. A typed key is
 *   used for this call only: never stored, logged, audited or put in an error.
 * - The address rules are the ones of a run: the guarded fetch, https to a public host unless KILN_AI_ALLOW_PRIVATE_URLS (see ai-config.ts).
 * - A server that does not answer a list (404, 405, 501, an answer that is not a list) is not an error: the answer is a FIXED list of well known
 *   ids with `source: 'fallback'` (none for an OpenAI compatible server), so the screen can say it could not read the list.
 * - Needs the server switch (KILN_AI_ENABLED) but not the workspace's: this is part of setting AI up. Audited as `ai.models_list` with the provider,
 *   the source and a count; never an address, a key or a model name list.
 */

export type ModelsSource = 'provider' | 'fallback';
export type ModelsResult = {
  models: AiModelInfo[];
  source: ModelsSource;
  /** Why the list is a fixed one, as a short code: `no_credential` (nothing to ask with yet) or `list_unavailable` (the server did not answer a list). */
  reason?: 'no_credential' | 'list_unavailable';
};

/** What the provider answered when it cannot list: these are "no such list", not a failure of the key or the network. */
const NO_LIST_DETAILS = new Set(['http_404', 'http_405', 'http_501', 'bad_reply']);

const MAX_KEY_CHARS = 500;

export type ListModelsInput = {
  workspaceId: string;
  actor: AiActor;
  provider: AiProvider;
  baseUrl?: string | undefined;
  /** A key typed in the form, for this call only. */
  apiKey?: string | undefined;
};

export async function listAiModels(
  ctx: AiContext,
  input: ListModelsInput,
): Promise<{ ok: true; result: ModelsResult } | AiFailure> {
  if (!ctx.enabled) return aiNotEnabled('server');
  const { provider } = input;
  const info = aiProviderInfo[provider];
  const config = (await readAiConfig(ctx.db, input.workspaceId)).values;
  const typedKey = (input.apiKey ?? '').trim();
  if (typedKey.length > MAX_KEY_CHARS)
    return aiFail(400, 'invalid_request', 'The key is too long.');

  // The address: only an OpenAI compatible server has one. The typed address wins over the saved one.
  let baseUrl = '';
  if (info.needsUrl) {
    const raw =
      (input.baseUrl ?? '').trim() !== ''
        ? (input.baseUrl ?? '').trim()
        : config.provider === provider
          ? config.baseUrl
          : '';
    if (raw === '') return aiNotConfigured('no_url', provider);
    const check = checkTranslateUrl(raw, ctx.allowPrivateUrls ? { allowPrivate: true } : {});
    if (!check.ok) {
      const hint = await addressHint(raw, ctx);
      return aiNotConfigured('bad_url', provider, hint ? { hint } : {});
    }
    baseUrl = check.url;
  }

  // The key: typed, else the stored one (decrypted for this call and audited as `credential.use`, purpose `ai`).
  let secret: string | undefined = typedKey !== '' ? typedKey : undefined;
  let keySource: 'typed' | 'stored' | 'none' = typedKey !== '' ? 'typed' : 'none';
  if (secret === undefined) {
    const credentialId = await aiCredentialId(ctx.db, input.workspaceId, provider);
    if (credentialId) {
      try {
        secret = await useCredentialSecret(
          ctx.db,
          ctx.masterKey,
          { workspaceId: input.workspaceId, id: credentialId, purpose: 'ai' },
          input.actor,
          ctx.now(),
        );
      } catch {
        return aiNotConfigured('credential_unreadable', provider);
      }
      if (secret !== undefined) keySource = 'stored';
    }
  }

  const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
    recordAudit(ctx.db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: 'ai.models_list',
      target: { type: 'workspace', id: input.workspaceId },
      detail: { provider, keySource, outcome, ...extra },
      at: ctx.now(),
    });
  const fallback = async (
    reason: NonNullable<ModelsResult['reason']>,
  ): Promise<{ ok: true; result: ModelsResult }> => {
    const models = aiFallbackModels(provider);
    await audit('fallback', { reason, count: models.length });
    return { ok: true, result: { models, source: 'fallback', reason } };
  };

  if (info.credentialRequired && secret === undefined) return fallback('no_credential');

  const timeoutMs = Math.min(ctx.timeoutMs ?? 20_000, 20_000);
  let guard: ReturnType<typeof createGuardedFetch> | undefined;
  let client: AiClient;
  try {
    const make = ctx.clientFactory ?? createAiClient;
    let built: CreateAiClientInput;
    if (info.needsUrl) {
      guard = createGuardedFetch({
        ...(ctx.allowPrivateUrls ? { allowPrivate: true } : {}),
        ...(ctx.resolve ? { resolve: ctx.resolve } : {}),
        ...(ctx.exchange ? { exchange: ctx.exchange } : {}),
        timeoutMs,
        maxBytes: 4 * 1024 * 1024,
      });
      built = {
        provider,
        model: LIST_ONLY_MODEL,
        secret,
        baseUrl,
        options: { fetch: guard.fetch, timeoutMs },
      };
    } else {
      built = {
        provider,
        model: LIST_ONLY_MODEL,
        secret,
        options: { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), timeoutMs },
      };
    }
    client = make(built);
  } catch (error) {
    return failureForAiError(
      error instanceof AiError ? error : new AiError('unavailable'),
      provider,
    );
  }

  try {
    const models = await client.listModels({ signal: AbortSignal.timeout(timeoutMs + 5_000) });
    if (models.length === 0 && aiFallbackModels(provider).length > 0)
      return fallback('list_unavailable');
    await audit('provider', { count: models.length });
    return { ok: true, result: { models, source: 'provider' } };
  } catch (error) {
    const known = error instanceof AiError ? error : new AiError('unavailable');
    if (
      known.kind === 'unavailable' &&
      known.detail !== undefined &&
      NO_LIST_DETAILS.has(known.detail)
    )
      return fallback('list_unavailable');
    let failure = failureForAiError(known, provider);
    const blocked = await guardReason(ctx, baseUrl, guard);
    if (blocked) failure = { ...failure, body: { ...failure.body, reason: blocked } };
    await audit('failed', {
      kind: known.kind,
      ...(blocked ? { reason: blocked } : known.detail ? { reason: known.detail } : {}),
    });
    return failure;
  }
}
