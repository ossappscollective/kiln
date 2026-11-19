/**
 * A poller that follows something while it is going on and stops when it is not: for the CI
 * panel, runs that have not finished. It never overlaps two ticks, waits while the page is hidden
 * (and ticks at once when the page is shown again), and backs off after a failure.
 *
 * The clock and the visibility are injected, so tests drive it by hand; the defaults are
 * `setTimeout` and the page's `visibilitychange`.
 */

export type Visibility = {
  visible(): boolean;
  /** Calls `listener` when the page is shown or hidden; returns the way to stop listening. */
  subscribe(listener: () => void): () => void;
};

export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type PollerOptions = {
  /** One poll. Resolve true to be called again after the interval, false when there is nothing left to follow. */
  tick: () => Promise<boolean>;
  intervalMs: number;
  /** The interval for the next tick, asked each time (a quicker cadence while something runs, a slower one when idle). Default: `intervalMs`. */
  delayMs?: () => number;
  maxIntervalMs?: number;
  /** Called with the error of a failed tick (the poller keeps going, slower). */
  onError?: (error: unknown) => void;
  visibility?: Visibility;
  timers?: Timers;
};

export type Poller = {
  /** Begins following: the first tick comes after one interval (or at once with `immediate`). */
  start(immediate?: boolean): void;
  /** Stops for good: no timer, no listener, and a tick in flight does not schedule another. */
  stop(): void;
  readonly running: boolean;
};

export const pageVisibility = (): Visibility => ({
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
});

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createPoller(options: PollerOptions): Poller {
  const timers = options.timers ?? realTimers;
  const visibility = options.visibility ?? pageVisibility();
  const max = options.maxIntervalMs ?? options.intervalMs * 12;

  let handle: unknown;
  let unsubscribe: (() => void) | undefined;
  let active = false;
  let inFlight = false;
  let failures = 0;
  // Bumped by stop, so a tick that finishes later knows it belongs to a poller that was stopped.
  let generation = 0;

  const delay = () =>
    Math.min(max, (options.delayMs?.() ?? options.intervalMs) * 2 ** Math.min(failures, 10));

  function schedule(ms: number) {
    if (!active) return;
    if (handle !== undefined) timers.clear(handle);
    handle = timers.set(run, ms);
  }

  async function run() {
    handle = undefined;
    if (!active || inFlight) return;
    // Hidden: wait. The visibility listener ticks as soon as the page is back.
    if (!visibility.visible()) return;
    inFlight = true;
    const mine = generation;
    let more = false;
    try {
      more = await options.tick();
      failures = 0;
    } catch (error) {
      failures++;
      more = true;
      options.onError?.(error);
    } finally {
      inFlight = false;
    }
    if (mine !== generation || !active) return;
    if (more) schedule(delay());
    else stop();
  }

  function onVisibility() {
    if (!active || inFlight || !visibility.visible()) return;
    // Back on screen: do not wait out the rest of the interval.
    schedule(0);
  }

  function stop() {
    active = false;
    generation++;
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return {
    start(immediate = false) {
      if (active) return;
      active = true;
      failures = 0;
      unsubscribe = visibility.subscribe(onVisibility);
      schedule(immediate ? 0 : options.intervalMs);
    },
    stop,
    get running() {
      return active;
    },
  };
}
