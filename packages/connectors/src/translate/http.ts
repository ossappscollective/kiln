import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TRANSLATE_TIMEOUT_MS,
  TranslateError,
  type TranslatorOptions,
} from './types.ts';

/**
 * One JSON POST with a time limit and a size cap, for every adapter. Throws only `TranslateError`:
 * a network failure or a timeout, never the underlying error (it can contain the address or the
 * request). A non-2xx answer is returned for the adapter to classify; its body is parsed leniently
 * and is only ever read for its error code and message, never shown.
 */

export type JsonReply = {
  status: number;
  /** The parsed body, or undefined when it was empty or not JSON. */
  json: unknown;
  retryAfter: string | null;
};

export type JsonRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function postJson(request: JsonRequest, options: TranslatorOptions): Promise<JsonReply> {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string | undefined;
  try {
    response = await send(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      // A redirect would carry the key to another address.
      redirect: 'manual',
      signal,
    });
    text = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof TranslateError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') throw new TranslateError('timeout');
    throw new TranslateError('unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (text === undefined) throw new TranslateError('unavailable');
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, retryAfter: response.headers.get('retry-after') };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Seconds from a Retry-After header (a number of seconds; a date is converted), or the fallback. */
export function retryAfterSeconds(header: string | null, fallback: number, now: number = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.max(Math.ceil(seconds), 1), 3600);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(Math.ceil((date - now) / 1000), 1), 3600);
  }
  return fallback;
}

/** A string at a path of an unknown value, for classifying an error body. Never shown. */
export function textAt(value: unknown, ...path: string[]): string {
  let at: unknown = value;
  for (const key of path) {
    if (!isRecord(at)) return '';
    at = at[key];
  }
  return typeof at === 'string' ? at : typeof at === 'number' ? String(at) : '';
}
