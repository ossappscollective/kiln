import { type AiProvider, aiProviderInfo } from '@mrm/core';
import { ANTHROPIC_FALLBACK_MODELS, createAnthropicClient } from './anthropic.ts';
import { createOpenAiClient, OPENAI_FALLBACK_MODELS } from './openai.ts';
import { createOpenAiCompatibleClient } from './openai-compatible.ts';
import {
  type AiClient,
  type AiClientOptions,
  AiError,
  type AiErrorKind,
  type AiModelInfo,
  aiErrorMessage,
} from './types.ts';

export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_FALLBACK_MODELS,
  ANTHROPIC_URL,
  createAnthropicClient,
} from './anthropic.ts';
export {
  createFakeAiClient,
  type FakeAiClient,
  type FakeAiOptions,
  type FakeAnswer,
} from './fake.ts';
export { createOpenAiClient, NOT_CHAT, OPENAI_FALLBACK_MODELS, OPENAI_URL } from './openai.ts';
export { createOpenAiCompatibleClient } from './openai-compatible.ts';
export {
  exampleOf,
  isStrictCompatible,
  parseModelJson,
  providerSchema,
  repairModelJson,
  type SchemaIssue,
  validateJson,
} from './schema.ts';
export * from './types.ts';

/**
 * What a stored AI credential holds: `{ "apiKey": "..." }`. A bare string is accepted as the key too, so a hand-made
 * secret still works. Never log the result.
 */
export function parseAiSecret(secret: string | undefined): { apiKey: string } {
  if (!secret) return { apiKey: '' };
  try {
    const parsed: unknown = JSON.parse(secret);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const key = (parsed as Record<string, unknown>).apiKey;
      return { apiKey: typeof key === 'string' ? key.trim() : '' };
    }
  } catch {
    // Not JSON: the secret is the key itself.
  }
  return { apiKey: secret.trim() };
}

export type CreateAiClientInput = {
  provider: AiProvider;
  model: string;
  /** The decrypted credential secret, or undefined for a local server without a key. */
  secret?: string | undefined;
  /** OpenAI compatible only: the server address, ending in /v1. */
  baseUrl?: string | undefined;
  options?: AiClientOptions;
};

/** Builds the client of a provider. Throws `AiError('not_configured')` when a needed part is missing. */
export function createAiClient(input: CreateAiClientInput): AiClient {
  const options = input.options ?? {};
  const { apiKey } = parseAiSecret(input.secret);
  switch (input.provider) {
    case 'anthropic':
      return createAnthropicClient({ ...options, apiKey, model: input.model });
    case 'openai':
      return createOpenAiClient({ ...options, apiKey, model: input.model });
    case 'openai_compatible':
      return createOpenAiCompatibleClient({
        ...options,
        apiKey,
        model: input.model,
        baseUrl: input.baseUrl ?? '',
      });
  }
}

/** The fixed list a screen may offer when a provider's own list cannot be read. None for an OpenAI compatible server (it serves what its owner loaded). */
export const aiFallbackModels = (provider: AiProvider): AiModelInfo[] =>
  provider === 'anthropic'
    ? [...ANTHROPIC_FALLBACK_MODELS]
    : provider === 'openai'
      ? [...OPENAI_FALLBACK_MODELS]
      : [];

/** The name a client built only to LIST models carries: no model is needed for that, and it is never sent. */
export const LIST_ONLY_MODEL = 'list-models';

/** Whether a provider needs a key at all (a local server does not). */
export const aiNeedsKey = (provider: AiProvider): boolean =>
  aiProviderInfo[provider].credentialRequired;

export type AiProbe =
  | { ok: true; provider: AiProvider; model: string }
  | {
      ok: false;
      provider: AiProvider;
      kind: AiErrorKind;
      message: string;
      detail?: string;
      retryAfterSeconds?: number;
      sample?: string;
    };

/** The fixed request of a connection test: no data of the workspace, one boolean back. */
export const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;

/**
 * Asks the model for `{ "ok": true }`: the system text says it and the user message is the literal example (a small model follows
 * an example better than a rule). Reports ok or a fixed sentence plus, for an unusable answer of a compatible server, `sample`: the
 * first 300 characters the model wrote. The prompt is fixed and holds no workspace data, which is why this is the one place a model's
 * words are passed on. Never the key.
 */
export async function probeAiClient(client: AiClient, signal?: AbortSignal): Promise<AiProbe> {
  try {
    await client.complete({
      system: 'You are a connection test. Return the JSON object {"ok":true} and nothing else.',
      input: { test: true },
      userMessage: 'Reply with exactly this JSON and nothing else: {"ok":true}',
      schema: PROBE_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'connection_test',
      maxTokens: 300,
      signal,
    });
    return { ok: true, provider: client.provider, model: client.model };
  } catch (error) {
    const known = error instanceof AiError ? error : undefined;
    const kind = known?.kind ?? 'unavailable';
    return {
      ok: false,
      provider: client.provider,
      kind,
      message: aiErrorMessage(kind),
      ...(known?.detail ? { detail: known.detail } : {}),
      ...(known?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: known.retryAfterSeconds }
        : {}),
      ...(known?.kind === 'invalid_output' && known.sample ? { sample: known.sample } : {}),
    };
  }
}
