/**
 * Counts failed logins per key (the email address) and refuses further attempts for a while.
 * In memory, so it resets on restart and is per instance. That is enough to stop online
 * guessing against one process; put a rate limiting proxy in front for more.
 */
export type LoginLimiter = {
  /** Seconds to wait, or 0 when an attempt is allowed. */
  retryAfter(key: string): number;
  fail(key: string): void;
  reset(key: string): void;
};

export function createLoginLimiter(
  options: { max?: number; windowMs?: number; now?: () => number } = {},
): LoginLimiter {
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; first: number }>();

  const live = (key: string) => {
    const entry = failures.get(key);
    if (entry && now() - entry.first >= windowMs) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    retryAfter(key) {
      const entry = live(key);
      if (!entry || entry.count < max) return 0;
      return Math.max(1, Math.ceil((entry.first + windowMs - now()) / 1000));
    },
    fail(key) {
      if (failures.size > 10_000) failures.clear();
      const entry = live(key);
      if (entry) entry.count += 1;
      else failures.set(key, { count: 1, first: now() });
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
