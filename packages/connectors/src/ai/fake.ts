import { validateJson } from './schema.ts';
import { AiError, type AiClient, type AiCompleteRequest, type AiCompleteResult, type AiProviderId, type AiUsage, guessTokens, renderUserMessage } from './types.ts';

/**
 * A scripted AI client for tests: no network, no model. It plays the answers it was given and goes through the
 * same checks as a real adapter (the output must match the schema, or the call fails as `invalid_output`), so a test
 * that feeds it a bad answer exercises the rejection path and not a shortcut. It records every request.
 */

export type FakeAnswer = {
  /** The answer the model "writes". Validated against the schema of the request. */
  output?: unknown;
  usage?: AiUsage;
  model?: string;
  /** Fails the call with this error instead (an AiError of any kind). */
  error?: AiError;
  /** The call waits for this before it answers (to hold a run in flight). */
  gate?: Promise<void>;
};

export type FakeAiClient = AiClient & {
  /** Every request made, in order. */
  calls: AiCompleteRequest[];
  /** Everything ever sent as the system text and the user message: for the "nothing leaks" assertions. */
  sent(): string[];
};

export type FakeAiOptions = {
  provider?: AiProviderId;
  model?: string;
  /** The answers in order (the last one repeats), or a function of the request. */
  answers: FakeAnswer[] | ((request: AiCompleteRequest, index: number) => FakeAnswer);
};

export function createFakeAiClient(options: FakeAiOptions): FakeAiClient {
  const calls: AiCompleteRequest[] = [];
  const model = options.model ?? 'fake-model';
  const client: FakeAiClient = {
    provider: options.provider ?? 'anthropic',
    model,
    calls,
    sent: () => calls.flatMap((c) => [c.system, renderUserMessage(c.input)]),
    async complete(request: AiCompleteRequest): Promise<AiCompleteResult> {
      const index = calls.length;
      calls.push(request);
      const answer =
        typeof options.answers === 'function'
          ? options.answers(request, index)
          : (options.answers[Math.min(index, options.answers.length - 1)] ?? { output: {} });
      if (answer.gate) await answer.gate;
      if (request.signal?.aborted) throw new AiError('unavailable', { detail: 'timeout' });
      if (answer.error) throw answer.error;
      const usage = answer.usage ?? {
        inputTokens: guessTokens(request.system) + guessTokens(renderUserMessage(request.input)),
        outputTokens: guessTokens(JSON.stringify(answer.output ?? {})),
      };
      if (validateJson(request.schema, answer.output).length > 0) throw new AiError('invalid_output', { detail: 'schema', usage });
      return { output: answer.output, usage, model: answer.model ?? model };
    },
  };
  return client;
}
