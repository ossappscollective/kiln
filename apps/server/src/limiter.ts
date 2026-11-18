/**
 * Counts attempts per key (an email address, an address, an invitation token) and refuses
 * further ones for a while. In memory, so it resets on restart and is per instance. That is
 * enough to stop online guessing against one process; put a rate limiting proxy in front for more.
 *
 * The attempt is counted *before* the slow work (a password hash) starts, so any number of
 * concurrent requests can pass at most `max` times. Counting only after a failure would let a
 * burst of parallel guesses all slip through before the first failure is written down.
 */
export type LoginLimiter = {
  /**
   * Counts one attempt now. Returns 0 when it may go ahead, else the seconds to wait (and the
   * attempt is not counted again). Call `reset` on success, or `refund` for an attempt that
   * should not count against the key.
   */
  attempt(key: string): number;
  /** Seconds to wait, or 0 when an attempt is allowed. Does not count. */
  retryAfter(key: string): number;
  /** Counts a failure without checking first. */
  fail(key: string): void;
  /** Forgets the key (a successful login). */
  reset(key: string): void;
  /** Takes one counted attempt back, for an attempt that turned out not to be a failure. */
  refund(key: string): void;
};

/** Most keys kept in memory. When full, the oldest entries that are not locked out go first. */
export const DEFAULT_MAX_KEYS = 10_000;

export function createLoginLimiter(
  options: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {},
): LoginLimiter {
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  // A Map iterates in insertion order, so the first entries are the oldest.
  const entries = new Map<string, { count: number; first: number }>();

  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && now() - entry.first >= windowMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  const wait = (entry: { first: number }) =>
    Math.max(1, Math.ceil((entry.first + windowMs - now()) / 1000));

  /**
   * Makes room for one more key without ever clearing the whole map: expired entries first, then
   * the oldest entry that is not locked out (so a flood of new keys cannot lift a lockout), and
   * only if every entry is locked out, the oldest one.
   */
  const makeRoom = () => {
    if (entries.size < maxKeys) return;
    const at = now();
    for (const [key, entry] of entries) {
      if (at - entry.first >= windowMs) entries.delete(key);
    }
    while (entries.size >= maxKeys) {
      let victim: string | undefined;
      for (const [key, entry] of entries) {
        if (entry.count < max) {
          victim = key;
          break;
        }
      }
      victim ??= entries.keys().next().value;
      if (victim === undefined) return;
      entries.delete(victim);
    }
  };

  const add = (key: string) => {
    const entry = live(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    makeRoom();
    entries.set(key, { count: 1, first: now() });
  };

  return {
    attempt(key) {
      const entry = live(key);
      if (entry && entry.count >= max) return wait(entry);
      add(key);
      return 0;
    },
    retryAfter(key) {
      const entry = live(key);
      return !entry || entry.count < max ? 0 : wait(entry);
    },
    fail: add,
    reset(key) {
      entries.delete(key);
    },
    refund(key) {
      const entry = live(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) entries.delete(key);
    },
  };
}
