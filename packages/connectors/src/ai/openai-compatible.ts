import { countOf, getJson, isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { parseModelJson, providerSchema, validateJson } from './schema.ts';
import { AiError, type AiClient, type AiClientOptions, type AiCompleteRequest, type AiCompleteResult, type AiModelInfo, type AiUsage, guessTokens, normalizeModels, renderUserMessage } from './types.ts';

/**
 * Any OpenAI compatible server (Ollama, LM Studio, vLLM, a gateway): Chat Completions,
 * `POST <baseUrl>/chat/completions`, one request, structured output, no tools. The base URL ends in `/v1`
 * (`http://localhost:11434/v1` for Ollama, `http://localhost:1234/v1` for LM Studio). Local first: the key is optional.
 *
 * Checked 2026-11-19:
 * - Ollama (docs.ollama.com/api/openai-compatibility): `/v1/chat/completions`, `response_format` and `max_tokens` supported,
 *   the key is "required but ignored" by a local server.
 * - LM Studio (lmstudio.ai/docs/developer/openai-compat/structured-output): `response_format: { type: 'json_schema',
 *   json_schema }`, answer in `choices[0].message.content`, default `http://localhost:1234/v1`.
 * - vLLM (docs.vllm.ai/en/latest/features/structured_outputs.html): structured outputs through `response_format` with
 *   `type: 'json_schema'` and a `json_schema` object with a `name` and a `schema`.
 * Body: `model`, `messages` (`system` and `user`), `max_tokens`, `stream: false`, `response_format`. Answer:
 * `choices[0].message.content` (a string), `choices[0].finish_reason` (`length` is a cut off answer), `usage` with
 * `prompt_tokens` and `completion_tokens`.
 * Address rule: the call goes to the base URL as given (trailing slashes removed) plus the endpoint, nothing is rewritten:
 * `http://localhost:11434/v1` calls `http://localhost:11434/v1/chat/completions` and `http://localhost:11434/v1/models`; a base
 * without `/v1` calls `<base>/chat/completions` (a gateway may keep its endpoints elsewhere), so the person types the `/v1`.
 * List of models: `GET <base>/models`, answer `{ data: [{ id }] }` (Ollama, LM Studio and vLLM document it; UNVERIFIED against live servers).
 * UNVERIFIED: that every server ENFORCES the schema (Ollama's page does not mention `json_schema`); the answer is validated
 * here either way, and the schema is also written into the system message because a small model follows words better than
 * a constraint it does not support. That a server reports `usage` (when it does not, the tokens are ESTIMATED at 3 characters
 * each, which over-counts, so the budget stays safe).
 */

export type OpenAiCompatibleOptions = AiClientOptions & {
  /** The key, when the server wants one. Empty for a local server. */
  apiKey?: string | undefined;
  model: string;
  /** Required: the address ending in /v1. */
  baseUrl: string;
};

function classify(status: number, json: unknown, retryAfter: string | null): AiError {
  const code = (textAt(json, 'error', 'code') || textAt(json, 'error', 'type')).toLowerCase();
  const message = (textAt(json, 'error', 'message') || textAt(json, 'message')).toLowerCase();
  if (status === 429) return new AiError('rate_limited', { retryAfterSeconds: retryAfterSeconds(retryAfter, 30) });
  if (status === 401 || status === 403) return new AiError('auth');
  if (status === 413 || code === 'context_length_exceeded' || (status === 400 && /context|too long|too many tokens/.test(message))) return new AiError('too_large');
  if (status === 404) return new AiError('unavailable', { detail: 'http_404' });
  return new AiError('unavailable', { detail: `http_${status}`.slice(0, 24) });
}

/** A 400 or 422 that names the response format (a server without schema support), not any other bad request. */
function refusesFormat(reply: { status: number; json: unknown }): boolean {
  if (reply.status !== 400 && reply.status !== 422) return false;
  const text = `${textAt(reply.json, 'error', 'message')} ${textAt(reply.json, 'error')} ${textAt(reply.json, 'message')}`.toLowerCase();
  return /response_format|json_schema|json schema|structured|grammar/.test(text);
}

function usageOf(json: Record<string, unknown>, guess: () => AiUsage): AiUsage {
  const usage = isRecord(json.usage) ? json.usage : undefined;
  const input = usage ? countOf(usage.prompt_tokens) : undefined;
  const output = usage ? countOf(usage.completion_tokens) : undefined;
  if (input === undefined || output === undefined) return guess();
  return { inputTokens: input, outputTokens: output };
}

export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): AiClient {
  const model = options.model.trim();
  const base = options.baseUrl.trim().replace(/\/+$/, '');
  if (!model) throw new AiError('not_configured', { detail: 'no_model' });
  if (!base) throw new AiError('not_configured', { detail: 'no_url' });
  const key = (options.apiKey ?? '').trim();
  return {
    provider: 'openai_compatible',
    model,
    async listModels(request = {}): Promise<AiModelInfo[]> {
      const reply = await getJson({ url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {}, signal: request.signal }, options);
      if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
      if (!isRecord(reply.json) || !Array.isArray(reply.json.data)) throw new AiError('unavailable', { detail: 'bad_reply' });
      return normalizeModels(reply.json.data.map((m) => ({ id: isRecord(m) ? m.id : undefined })));
    },
    async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
      const schema = providerSchema(request.schema);
      const system = `${request.system}\n\nAnswer with ONE JSON object and nothing else (no Markdown, no explanation). It must match this JSON Schema:\n${JSON.stringify(schema)}`;
      const user = renderUserMessage(request.input);
      const bodyFor = (format: Record<string, unknown> | undefined): Record<string, unknown> => ({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: request.maxTokens,
        stream: false,
        ...(format ? { response_format: format } : {}),
      });
      // Servers differ in what they accept for structured output: the strict schema first, then a plain JSON mode, then
      // none (the schema is also in the system message). Only a refusal that names the format moves to the next one.
      const formats: (Record<string, unknown> | undefined)[] = [
        { type: 'json_schema', json_schema: { name: request.schemaName ?? 'result', strict: true, schema } },
        { type: 'json_object' },
        undefined,
      ];
      let reply = await postJson({ url: `${base}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {}, body: bodyFor(formats[0]), signal: request.signal }, options);
      for (let i = 1; i < formats.length && refusesFormat(reply); i += 1) {
        reply = await postJson({ url: `${base}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {}, body: bodyFor(formats[i]), signal: request.signal }, options);
      }
      if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
      const json = reply.json;
      if (!isRecord(json)) throw new AiError('unavailable', { detail: 'bad_reply' });
      const choice = Array.isArray(json.choices) && isRecord(json.choices[0]) ? json.choices[0] : undefined;
      const message = choice && isRecord(choice.message) ? choice.message : undefined;
      const content = message && typeof message.content === 'string' ? message.content : undefined;
      const usage = usageOf(json, () => ({ inputTokens: guessTokens(system) + guessTokens(user), outputTokens: guessTokens(content ?? '') }));
      if (!choice || !message) throw new AiError('unavailable', { detail: 'bad_reply' });
      if (typeof message.refusal === 'string' && message.refusal) throw new AiError('invalid_output', { detail: 'refusal', usage });
      if (choice.finish_reason === 'length') throw new AiError('invalid_output', { detail: 'truncated', usage });
      if (content === undefined) throw new AiError('invalid_output', { detail: 'no_text', usage });
      const output = parseModelJson(content);
      if (output === undefined) throw new AiError('invalid_output', { detail: 'not_json', usage });
      if (validateJson(request.schema, output).length > 0) throw new AiError('invalid_output', { detail: 'schema', usage });
      return { output, usage, model: typeof json.model === 'string' && json.model ? json.model : model };
    },
  };
}
