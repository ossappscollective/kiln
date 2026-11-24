import { ApiError } from './api.ts';

/**
 * A read that always ends. `settle` runs a request, aborts it after `ms` and returns what happened as a value: it never throws and
 * never stays pending, so a screen that sets `loading = true` before and `loading = false` after it cannot be left loading by a
 * request that is never answered (the Assets step of Prepare release did exactly that: docs/adr/0066-assets-step-bounded-reads.md).
 * The timer starts when `settle` is called; a late answer after the limit is dropped. Written for the ES2017 web build.
 */
export const READ_TIMEOUT_MS = 30_000;

/** Staging reads the repository for every item and may take longer than a read; the server stops at 45 s (`STAGE_DEADLINE_MS`). */
export const STAGE_TIMEOUT_MS = 60_000;
/** Saving a decision (skip, later, reopen) is one small write. */
export const DECIDE_TIMEOUT_MS = 15_000;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown; timedOut: boolean };

export function settle<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { ms?: number; timeoutMessage: string },
): Promise<Settled<T>> {
  const controller = new AbortController();
  const ms = options.ms ?? READ_TIMEOUT_MS;
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    const finish = (out: Settled<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, error: new ApiError(0, 'client_timeout', options.timeoutMessage) });
      controller.abort();
    }, ms);
    let started: Promise<T>;
    try {
      started = run(controller.signal);
    } catch (error) {
      finish({ ok: false, timedOut: false, error });
      return;
    }
    started.then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, timedOut: false, error }),
    );
  });
}
