import type { StoreImagesView } from '@kiln/core';

/**
 * The last store graphics read of an app, kept for the whole session so that coming back to the Graphics tab shows them at once and
 * asks the server again in the background (stale while revalidate). Keyed by workspace, app and platform. Pure apart from the clock,
 * which can be given; written for the ES2017 web build.
 *
 * Rules: an entry is never dropped because it is old (a stale picture is better than an empty page), only because a publish changed
 * the store, or because the cache holds more than `MAX_ENTRIES` apps (the least recently used goes). A read that failed keeps what
 * was there. `plan` says what a page should do with an entry.
 */
export const MAX_ENTRIES = 24;
/** Younger than this, a page that comes back does not ask again (the server reuses a read for a minute anyway). */
export const FRESH_MS = 20_000;

export type StoreCacheEntry = { view: StoreImagesView; at: number };

export type StoreCachePlan =
  /** Nothing kept: show the loading state and read. */
  | 'load'
  /** Kept and recent: show it, do not ask again. */
  | 'show'
  /** Kept but old: show it now and read again in the background. */
  | 'show_and_refresh';

export const storeCacheKey = (workspaceId: string, appId: string, platform: string): string =>
  `${workspaceId}|${appId}|${platform}`;

export function planFor(entry: StoreCacheEntry | undefined, now: number, freshMs: number = FRESH_MS): StoreCachePlan {
  if (!entry) return 'load';
  return now - entry.at < freshMs ? 'show' : 'show_and_refresh';
}

export type StoreCache = {
  get(key: string): StoreCacheEntry | undefined;
  /** Keeps a read. `at` is when the server read the store (the view's `readAt`), else now. */
  set(key: string, view: StoreImagesView, at?: number): void;
  /** Drops the entries of an app (any platform) of a workspace: the store changed. */
  forgetApp(workspaceId: string, appId: string): void;
  clear(): void;
  size(): number;
};

export function createStoreCache(now: () => number = Date.now, max: number = MAX_ENTRIES): StoreCache {
  const kept = new Map<string, StoreCacheEntry>();
  return {
    get(key) {
      const hit = kept.get(key);
      if (hit) {
        kept.delete(key);
        kept.set(key, hit);
      }
      return hit;
    },
    set(key, view, at) {
      kept.delete(key);
      kept.set(key, { view, at: at ?? now() });
      while (kept.size > max) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
    },
    forgetApp(workspaceId, appId) {
      const prefix = `${workspaceId}|${appId}|`;
      for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key);
    },
    clear: () => kept.clear(),
    size: () => kept.size,
  };
}

/** The cache of the session. */
export const storeMediaCache: StoreCache = createStoreCache();
