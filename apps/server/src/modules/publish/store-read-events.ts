/**
 * Superseded by the cache registry (`services/cache-registry.ts`): a cache of what a store holds registers there with the events that
 * make it stale (`store_read`, `sync`, `publish`, ...) and is dropped by `emitCacheEvent`. This file only keeps the old name of "the
 * store may have changed, from a fresh read": prefer `emitCacheEvent('store_read' | 'sync' | 'publish', { workspaceId, appId })`.
 * No imports beyond the registry: anything may depend on it without a cycle.
 */
import { emitCacheEvent } from '../../services/cache-registry.ts';

/** A fresh read of the store was asked for: every cache that declared `store_read` drops this app's entries. */
export const dropStoreReadCaches = (workspaceId: string, appId: string): void => {
  emitCacheEvent('store_read', { workspaceId, appId });
};
