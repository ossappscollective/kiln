import { countOf, getJson, isRecord, postJson, retryAfterSeconds, textAt } from './http.ts';
import { parseModelJson, providerSchema, validateJson } from './schema.ts';
import { AiError, type AiClient, type AiClientOptions, type AiCompleteRequest, type AiCompleteResult, type AiModelInfo, type AiUsage, normalizeModels, userMessageOf } from './types.ts';

/**
 * Anthropic Messages API, `POST /v1/messages`, one request, structured output, no tools.
 *
 * Verified from Anthropic's pages, checked 2026-11-19 (platform.claude.com/docs/en/api/overview, /errors,
 * /versioning and /build-with-claude/structured-outputs):
 * - Headers: `x-api-key` (the documented legacy form of `Authorization: Bearer`, still supported),
 *   `anthropic-version` (required; `2026-10-21` is the recommended version) and `content-type: application/json`.
 * - Body: `model`, `max_tokens`, `system` (a string), `messages: [{ role: 'user', content }]`, and
 *   `output_config: { format: { type: 'json_schema', schema } }` for structured output (no beta header; every object
 *   needs `additionalProperties: false`; `minLength`, `maxLength`, `minimum` and `maximum` are not accepted, so they are
 *   removed from the schema that is sent and checked on the answer). `temperature`, `top_p` and `top_k` are NOT sent:
 *   version 2026-10-21 refuses them with a 400.
 * - Answer: `content` is a list of blocks, the JSON is the `text` of the first `type: 'text'` block; `stop_reason` is one of
 *   `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`;
 *   `usage` has `input_tokens` and `output_tokens` (plus cache counts). A refusal is a 200.
 * - Errors: 400 invalid_request_error, 401 authentication_error, 403 permission_error, 404 not_found_error,
 *   413 request_too_large, 429 rate_limit_error (a spend cap has no `retry-after`), 500 api_error, 529 overloaded_error.
 *   The body is `{ type: 'error', error: { type, message } }`; only `error.type` is read.
 * List of models (checked 2026-11-19, platform.claude.com/docs/en/api/models-list): `GET /v1/models`, `limit` 1 to 1000 (default 20),
 * answer `{ data: [{ id, display_name, lifecycle, ... }], has_more, first_id, last_id }`, newest first. The docs show `Authorization: Bearer`;
 * `x-api-key` (used for the Messages call above) is the documented legacy form. One page of 1000 is read and capped; `retired` models are skipped.
 * UNVERIFIED against a live account: that `x-api-key` is accepted on this route, and the exact list a key sees.
 * UNVERIFIED: the exact field list of `usage` (read here: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`; the page was cut off before it), and whether the 400 for an over long prompt names it so.
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2026-10-21';

export type AnthropicOptions = AiClientOptions & { apiKey: string; model: string };

function classify(status: number, json: unknown, retryAfter: string | null): AiError {
  const type = textAt(json, 'error', 'type');
  const message = textAt(json, 'error', 'message').toLowerCase();
  if (status === 429) return new AiError('rate_limited', { retryAfterSeconds: retryAfterSeconds(retryAfter, 30), ...(retryAfter ? {} : { detail: 'no_retry_after' }) });
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return new AiError('auth');
  if (status === 413 || type === 'request_too_large') return new AiError('too_large');
  if (status === 400 && /too long|too large|context window|too many tokens/.test(message)) return new AiError('too_large');
  if (status === 404) return new AiError('unavailable', { detail: 'http_404' });
  if (status === 529 || type === 'overloaded_error') return new AiError('unavailable', { detail: 'overloaded' });
  return new AiError('unavailable', { detail: `http_${status}`.slice(0, 24) });
}

function usageOf(json: unknown): AiUsage {
  const usage = isRecord(json) && isRecord(json.usage) ? json.usage : {};
  const cached = (countOf(usage.cache_creation_input_tokens) ?? 0) + (countOf(usage.cache_read_input_tokens) ?? 0);
  return { inputTokens: (countOf(usage.input_tokens) ?? 0) + cached, outputTokens: countOf(usage.output_tokens) ?? 0 };
}

/** Used when the account's list cannot be read (a fixed list, ids from the official docs, checked 2026-11-19). */
export const ANTHROPIC_FALLBACK_MODELS: readonly AiModelInfo[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

export function createAnthropicClient(options: AnthropicOptions): AiClient {
  const key = options.apiKey.trim();
  const model = options.model.trim();
  if (!model) throw new AiError('not_configured', { detail: 'no_model' });
  if (!key) throw new AiError('not_configured', { detail: 'no_key' });
  return {
    provider: 'anthropic',
    model,
    async listModels(request = {}): Promise<AiModelInfo[]> {
      const reply = await getJson(
        { url: `${options.baseUrl ?? ANTHROPIC_URL}/v1/models?limit=1000`, headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION }, signal: request.signal },
        options,
      );
      if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
      if (!isRecord(reply.json) || !Array.isArray(reply.json.data)) throw new AiError('unavailable', { detail: 'bad_reply' });
      return normalizeModels(reply.json.data.filter((m) => isRecord(m) && m.lifecycle !== 'retired').map((m) => ({ id: (m as Record<string, unknown>).id, label: (m as Record<string, unknown>).display_name })));
    },
    async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
      const reply = await postJson(
        {
          url: `${options.baseUrl ?? ANTHROPIC_URL}/v1/messages`,
          headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION },
          body: {
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: 'user', content: userMessageOf(request) }],
            output_config: { format: { type: 'json_schema', schema: providerSchema(request.schema) } },
          },
          signal: request.signal,
        },
        options,
      );
      if (reply.status < 200 || reply.status > 299) throw classify(reply.status, reply.json, reply.retryAfter);
      const json = reply.json;
      if (!isRecord(json)) throw new AiError('unavailable', { detail: 'bad_reply' });
      const usage = usageOf(json);
      const stop = typeof json.stop_reason === 'string' ? json.stop_reason : '';
      if (stop === 'refusal') throw new AiError('invalid_output', { detail: 'refusal', usage });
      if (stop === 'max_tokens') throw new AiError('invalid_output', { detail: 'truncated', usage });
      if (stop === 'model_context_window_exceeded') throw new AiError('too_large', { usage });
      const blocks = Array.isArray(json.content) ? json.content : [];
      const block = blocks.find((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text' && typeof b.text === 'string');
      if (!block) throw new AiError('invalid_output', { detail: 'no_text', usage });
      const output = parseModelJson(String(block.text));
      if (output === undefined) throw new AiError('invalid_output', { detail: 'not_json', usage });
      if (validateJson(request.schema, output).length > 0) throw new AiError('invalid_output', { detail: 'schema', usage });
      return { output, usage, model: typeof json.model === 'string' && json.model ? json.model : model };
    },
  };
}
