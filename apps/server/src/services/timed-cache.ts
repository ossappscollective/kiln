import { type CacheDeclaration, keyInScope, registerCache } from './cache-registry.ts';

/**
 * A small in-memory cache whose entries expire, with a size cap (the oldest is dropped first). It is born on the cache list
 * (`cache-registry.ts`): the declaration names it and says which events make it stale, so nobody can add a cache that nothing
 * invalidates without writing down why.
 */
export function timedCache<T>(ttlMs: number, max: number, declaration: CacheDeclaration) {
  const entries = new Map<string, { at: number; value: T }>();
  registerCache({
    name: declaration.name,
    owner: declaration.owner,
    invalidatedBy: declaration.invalidatedBy,
    ...(declaration.why === undefined ? {} : { why: declaration.why }),
    ttlMs,
    drop(scope) {
      for (const key of Array.from(entries.keys()))
        if (keyInScope(key, scope, declaration.keys, declaration.separator)) entries.delete(key);
    },
  });
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
