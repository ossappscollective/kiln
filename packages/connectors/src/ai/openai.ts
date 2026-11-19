import { countOf, getJson, isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { parseModelJson, providerSchema, validateJson } from './schema.ts';
import {
  type AiClient,
  type AiClientOptions,
  type AiCompleteRequest,
  type AiCompleteResult,
  AiError,
  type AiModelInfo,
  type AiUsage,
  normalizeModels,
  userMessageOf,
} from './types.ts';

/**
 * OpenAI Responses API, `POST /v1/responses`, one request, structured output, no tools, nothing stored.
 *
 * Checked 2026-11-19 against developers.openai.com/api/docs/guides/structured-outputs and
 * developers.openai.com/api/reference/resources/responses/methods/create:
 * - `Authorization: Bearer <key>`. Body: `model`, `instructions` (the system text), `input` (the user text),
 *   `max_output_tokens`, `store: false`, and `text: { format: { type: 'json_schema', name, schema, strict: true } }`.
 *   Strict mode wants every property listed in `required` and `additionalProperties: false` on every object; the schemas of
 *   the tasks are written that way (a test checks it). `minLength` and the like are removed from the schema that is sent
 *   and checked on the answer.
 * - Answer: `status` (`completed`, `incomplete`, `failed`), `output` is a list of items; an item `type: 'message'` has
 *   `content` parts `type: 'output_text'` (`text`) or `type: 'refusal'` (`refusal`); `usage` has `input_tokens`,
 *   `output_tokens` and `total_tokens`.
 * List of models (checked 2026-11-19, developers.openai.com/api/reference/resources/models/methods/list): `GET /v1/models`, answer
 * `{ object: 'list', data: [{ id, created, owned_by }] }`. The list holds every model of the account, embeddings, speech and image
 * models included; ids that obviously are not chat models are filtered (`NOT_CHAT`), never required: when the filter would empty the list it
 * is not applied. UNVERIFIED against a live account.
 * UNVERIFIED (not visible on the pages that could be read): the request fields `instructions` and `store` (seen only in an
 * example response), the values of `incomplete_details.reason`, and the HTTP error table of this API. Errors are classified
 * by status (401 and 403 auth, 413 and 429 as usual, 400 with a context message too large, 5xx unavailable).
 */

export const OPENAI_URL = 'https://api.openai.com';

/** Used when the account's list cannot be read: the flagship text models named on developers.openai.com/api/docs/models, 2026-11-19. UNVERIFIED against a live account. */
export const OPENAI_FALLBACK_MODELS: readonly AiModelInfo[] = [
  { id: 'gpt-6.2-astra' },
  { id: 'gpt-6.2-sol' },
  { id: 'gpt-6.1-terra' },
  { id: 'gpt-6-luna' },
];

/** Ids that obviously are not chat models (embeddings, speech, images, moderation, realtime, transcription). A hint, not a rule. */
export const NOT_CHAT =
  /(embedding|whisper|tts|dall-e|moderation|image|audio|transcribe|realtime|sora|davinci|babbage)/i;

export type OpenAiOptions = AiClientOptions & { apiKey: string; model: string };

function classify(status: number, json: unknown, retryAfter: string | null): AiError {
  const code = (textAt(json, 'error', 'code') || textAt(json, 'error', 'type')).toLowerCase();
  const message = textAt(json, 'error', 'message').toLowerCase();
  if (status === 429) {
    // A spent quota is a 429 too, with a code of its own: waiting a minute will not help.
    return new AiError('rate_limited', {
      retryAfterSeconds: retryAfterSeconds(retryAfter, 30),
      ...(/quota/.test(code) ? { detail: 'quota' } : {}),
    });
  }
  if (status === 401 || status === 403) return new AiError('auth');
  if (
    status === 413 ||
    code === 'context_length_exceeded' ||
    (status === 400 && /context length|too long|maximum context/.test(message))
  )
    return new AiError('too_large');
  if (status === 404) return new AiError('unavailable', { detail: 'http_404' });
  return new AiError('unavailable', { detail: `http_${status}`.slice(0, 24) });
}

function usageOf(json: Record<string, unknown>): AiUsage {
  const usage = isRecord(json.usage) ? json.usage : {};
  return {
    inputTokens: countOf(usage.input_tokens) ?? 0,
    outputTokens: countOf(usage.output_tokens) ?? 0,
  };
}

export function createOpenAiClient(options: OpenAiOptions): AiClient {
  const key = options.apiKey.trim();
  const model = options.model.trim();
  if (!model) throw new AiError('not_configured', { detail: 'no_model' });
  if (!key) throw new AiError('not_configured', { detail: 'no_key' });
  return {
    provider: 'openai',
    model,
    async listModels(request = {}): Promise<AiModelInfo[]> {
      const reply = await getJson(
        {
          url: `${options.baseUrl ?? OPENAI_URL}/v1/models`,
          headers: { authorization: `Bearer ${key}` },
          signal: request.signal,
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299)
        throw classify(reply.status, reply.json, reply.retryAfter);
      if (!isRecord(reply.json) || !Array.isArray(reply.json.data))
        throw new AiError('unavailable', { detail: 'bad_reply' });
      const all = normalizeModels(
        reply.json.data.map((m) => ({ id: isRecord(m) ? m.id : undefined })),
      );
      const chat = all.filter((m) => !NOT_CHAT.test(m.id));
      return chat.length > 0 ? chat : all;
    },
    async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
      const reply = await postJson(
        {
          url: `${options.baseUrl ?? OPENAI_URL}/v1/responses`,
          headers: { authorization: `Bearer ${key}` },
          body: {
            model,
            instructions: request.system,
            input: userMessageOf(request),
            max_output_tokens: request.maxTokens,
            store: false,
            text: {
              format: {
                type: 'json_schema',
                name: request.schemaName ?? 'result',
                schema: providerSchema(request.schema),
                strict: true,
              },
            },
          },
          signal: request.signal,
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299)
        throw classify(reply.status, reply.json, reply.retryAfter);
      const json = reply.json;
      if (!isRecord(json)) throw new AiError('unavailable', { detail: 'bad_reply' });
      const usage = usageOf(json);
      if (json.status === 'failed') throw new AiError('unavailable', { detail: 'failed' });
      if (json.status === 'incomplete')
        throw new AiError('invalid_output', { detail: 'truncated', usage });
      const items = Array.isArray(json.output) ? json.output : [];
      let text: string | undefined;
      for (const item of items) {
        if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (!isRecord(part)) continue;
          if (part.type === 'refusal')
            throw new AiError('invalid_output', { detail: 'refusal', usage });
          if (part.type === 'output_text' && typeof part.text === 'string' && text === undefined)
            text = part.text;
        }
      }
      if (text === undefined) throw new AiError('invalid_output', { detail: 'no_text', usage });
      const output = parseModelJson(text);
      if (output === undefined) throw new AiError('invalid_output', { detail: 'not_json', usage });
      if (validateJson(request.schema, output).length > 0)
        throw new AiError('invalid_output', { detail: 'schema', usage });
      return {
        output,
        usage,
        model: typeof json.model === 'string' && json.model ? json.model : model,
      };
    },
  };
}
