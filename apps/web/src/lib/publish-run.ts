/**
 * The waiting part of "Publish": a publish is ONE request that runs every step on the server and answers when the last one is done,
 * so a store that is slow or an answer that is lost looks like a dialog that loads for ever. This is the pure side of ending that:
 * a limit on how long the dialog waits (`withWaitLimit`), the time shown while it waits, and the technical detail of an error.
 * Nothing here sends the publish again: when the limit is reached the request is dropped and the person is told to look.
 */
import { ApiError } from './api.ts';

/**
 * The longest the dialog waits for the answer. The server gives up on a step after 8 minutes (store-publish.ts,
 * DEFAULT_PUBLISH_STEP_TIMEOUT_MS) and a batch has up to four steps; a push and a submit are well inside this.
 */
export const PUBLISH_WAIT_LIMIT_MS = 20 * 60_000;

/** After this long the dialog says it is slower than usual, so the person knows it is not frozen. */
export const PUBLISH_SLOW_AFTER_MS = 90_000;

/** The dialog stopped waiting. What the server did is not known: it may still be running or may have finished. */
export class PublishWaitError extends Error {
  readonly limitMs: number;
  constructor(limitMs: number) {
    super('The publish did not answer in time');
    this.name = 'PublishWaitError';
    this.limitMs = limitMs;
  }
}

/**
 * Runs `send` and settles with its answer, or rejects with `PublishWaitError` after `limitMs` (and aborts the request, so the browser
 * lets go of it). Called once per attempt: a confirmation prompt happens outside it, so the time a person takes to type a password
 * does not count.
 */
export async function withWaitLimit<T>(
  send: (signal: AbortSignal) => Promise<T>,
  limitMs: number = PUBLISH_WAIT_LIMIT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PublishWaitError(limitMs));
      controller.abort();
    }, limitMs);
  });
  const work = send(controller.signal);
  work.catch(() => undefined);
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** `2:05` for 125 seconds (minutes can pass 59: `75:00`). Never negative. */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** Whole minutes of a limit, at least 1: the number the messages say. */
export const minutesOf = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/**
 * The technical detail of a failed call: the HTTP status and the server's error code (`HTTP 502 draft_partial`). Fixed tokens, never
 * the server's sentence, which may quote a store. Null when the error is not an answer of the server (nothing to add).
 */
export function failureDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = /^[a-z0-9_.-]{1,60}$/i.test(error.code) ? error.code : '';
  return `HTTP ${error.status}${code ? ` ${code}` : ''}`.trim();
}
