import { ApiError } from './api.ts';
import { t } from './i18n/t.ts';

/**
 * A small cache for the reads a page makes when it opens (the version and builds of a release, the live listing, the asset
 * comparison). The server limits reads of the repository and the store per workspace, so a page must not ask again for what it
 * has just been told. Three rules:
 *  - one request at a time per key (single flight): two parts of a page that ask for the same thing share one request;
 *  - an answer is kept for `ttlMs` (default one minute), and `force` (a "read again" button) skips it;
 *  - after a 429 nothing is sent for that workspace and group until the wait is over: the same error is returned at once, with the
 *    time left, so a page that retries in a loop cannot make the limit longer.
 * Failures other than 429 are never kept. Pure apart from the clock, which can be given. Written for the ES2017 web build.
 */
export type ReadCache = {
  read<T>(args: {
    workspaceId: string;
    group: string;
    key: string;
    load: () => Promise<T>;
    force?: boolean;
    ttlMs?: number;
  }): Promise<T>;
  /** Forget what was kept for a workspace (after a change that makes it stale); all of it when `prefix` is empty. */
  forget(workspaceId: string, prefix?: string): void;
  /** Seconds left of the pause after a 429 for this workspace and group, or 0. */
  pausedFor(workspaceId: string, group: string): number;
};

export const READ_TTL_MS = 60_000;

export function createReadCache(now: () => number = Date.now): ReadCache {
  const kept = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  const pausedUntil = new Map<string, number>();

  const pauseKey = (workspaceId: string, group: string) => `${workspaceId}|${group}`;
  const cacheKey = (workspaceId: string, key: string) => `${workspaceId}|${key}`;

  const remaining = (workspaceId: string, group: string): number => {
    const until = pausedUntil.get(pauseKey(workspaceId, group)) ?? 0;
    return until > now() ? Math.ceil((until - now()) / 1000) : 0;
  };

  return {
    pausedFor: remaining,
    forget(workspaceId, prefix = '') {
      const start = cacheKey(workspaceId, prefix);
      for (const k of Array.from(kept.keys())) if (k.indexOf(start) === 0) kept.delete(k);
    },
    async read({ workspaceId, group, key, load, force = false, ttlMs = READ_TTL_MS }) {
      const wait = remaining(workspaceId, group);
      if (wait > 0) throw new ApiError(429, 'rate_limited', t('common:readCache.paused'), wait);
      const id = cacheKey(workspaceId, key);
      const hit = kept.get(id);
      if (!force && hit && now() - hit.at < ttlMs) return hit.value as never;
      // A "read again" never joins a request that started before it: that one may have been sent before the change it is asked for.
      const running = inflight.get(id);
      if (running && !force) return running as never;
      const promise: Promise<never> = load().then(
        (value) => {
          // A request that was overtaken by a forced one must not replace its newer answer.
          if (inflight.get(id) === promise) {
            kept.set(id, { at: now(), value });
            inflight.delete(id);
          }
          return value as never;
        },
        (error: unknown) => {
          if (inflight.get(id) === promise) inflight.delete(id);
          if (error instanceof ApiError && error.status === 429)
            pausedUntil.set(
              pauseKey(workspaceId, group),
              now() + (error.retryAfter && error.retryAfter > 0 ? error.retryAfter : 60) * 1000,
            );
          throw error;
        },
      );
      inflight.set(id, promise);
      return promise;
    },
  };
}

/** The cache the screens share. */
export const readCache = createReadCache();
