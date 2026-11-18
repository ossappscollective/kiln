/** A small in-memory cache whose entries expire, with a size cap (the oldest is dropped first). */
export function timedCache<T>(ttlMs: number, max: number) {
  const entries = new Map<string, { at: number; value: T }>();
  return {
    get(key: string, now: number): T | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now - hit.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T, now: number) {
      entries.set(key, { at: now, value });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear: () => entries.clear(),
  };
}
