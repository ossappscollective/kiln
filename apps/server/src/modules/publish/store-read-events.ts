/**
 * Who caches a read of what a store holds for an app (the Graphics tab's store images, the current readiness) says so here, and is told
 * when that read may be stale: a draft push succeeded, a sync of the app ran, a person pressed "Read again" or "Check again". No imports:
 * anything may depend on it (the sync service, the push, the readers) without a cycle.
 */
type Listener = (workspaceId: string, appId: string) => void;
const listeners = new Set<Listener>();

/** Registers a cache to be dropped when the store's state may have changed. */
export const onStoreMayHaveChanged = (fn: Listener): void => {
  listeners.add(fn);
};

/** The store may have changed (a push, a sync, "Read again", "Check again", somebody in the store's own console): every cache of its read is dropped. */
export const dropStoreReadCaches = (workspaceId: string, appId: string): void => {
  for (const listener of listeners) listener(workspaceId, appId);
};
