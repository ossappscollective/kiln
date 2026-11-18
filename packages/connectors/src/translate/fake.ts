/** A fake fetch for the translation tests: records the requests and plays queued answers. Test helper only. */
export type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
export type Answer = { status?: number; json?: unknown; text?: string; headers?: Record<string, string>; throws?: Error };

export function fakeFetch(...answers: Answer[]) {
  const requests: Recorded[] = [];
  let index = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    });
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 200, json: {} };
    index += 1;
    if (answer.throws) throw answer.throws;
    return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
    });
  }) as typeof fetch;
  return { fetch: fn, requests };
}
