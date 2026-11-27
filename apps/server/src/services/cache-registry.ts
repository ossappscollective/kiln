/**
 * The one place where every in-memory cache of the server says what it holds, how long it lives and WHICH EVENT makes it stale.
 *
 * Why: the same fact used to be cached in several places (the store's images, what blocks a submit, the build lists, the notes history),
 * each dropped by its own hand-written call or by none, so a sync or a push left some of them old and two screens disagreed. Now a cache
 * is created with `timedCache(ttl, max, declaration)` or `registerMapCache(...)` / `registerCache(...)`, which put it on this list, and
 * the places where something changed call `emitCacheEvent(event, scope)`, which drops everything that declared that event. A test
 * (`cache-registry.test.ts`) fails when a cache exists that is not on the list, and when an event does not drop what it should.
 *
 * Events (what happened, not which cache to drop):
 *  - `store_read`       a fresh read of the store was asked for ("Read again", "Check again", `fresh=1`).
 *  - `sync`             an app was synced from the stores (manual, scheduled, a webhook, a CI ingest that refreshed releases or listing).
 *  - `publish`          a push or a publish wrote (or may have written) to the store, whatever the outcome.
 *  - `staged_changed`   what is staged for an app changed (stage, unstage, discard, a rebase of the staged values).
 *  - `release_changed`  a release / version was created, changed or removed (in the store or in a plan).
 *  - `build_changed`    a build appeared, was attached to a release, or its CI run finished.
 * The browser has the same list (`apps/web/src/lib/facts/invalidate.ts`) plus `release_created`; the docs table is `docs/state-model.md`.
 *
 * No imports: any module may depend on it without a cycle.
 */

export const cacheEvents = [
  'store_read',
  'sync',
  'publish',
  'staged_changed',
  'release_changed',
  'build_changed',
] as const;
export type CacheEvent = (typeof cacheEvents)[number];

/** What an event is about. A cache keyed by app drops that app's entries; with no app, the workspace's; with nothing, all of it. */
export type CacheScope = { workspaceId?: string; appId?: string };

/** How the keys of a cache start, so an event for one app drops only that app's entries. */
export type KeyShape =
  /** `<workspaceId><sep><appId>` followed by the end or another separator. */
  | 'workspace_app'
  /** `<workspaceId><sep>...`: keyed by something else of the workspace (a repository): an app event drops the workspace's entries. */
  | 'workspace'
  /** Keys say nothing about a workspace or app: every event drops everything. */
  | 'all';

export type CacheDeclaration = {
  /** Unique, `module.cache` (`builds.repo_artifacts`). Registered again under the same name, a cache replaces the earlier one (a factory made twice in tests). */
  name: string;
  /** The module that holds it (a path under `apps/server/src`). */
  owner: string;
  /** The events that make it stale. Empty only with `why`. */
  invalidatedBy: readonly CacheEvent[];
  /** Required when `invalidatedBy` is empty: why no app event can make it stale (keyed by content, a public read that expires by itself...). */
  why?: string;
  keys?: KeyShape;
  /** What separates the parts of a key (default `|`). */
  separator?: string;
};

export type CacheSpec = Omit<CacheDeclaration, 'keys' | 'separator'> & {
  /** Time to live in ms; null: it does not expire by age (it is bounded by size or keyed by content). */
  ttlMs: number | null;
  /** Drops what belongs to the scope. */
  drop: (scope: CacheScope) => void;
};

export type CacheInfo = Readonly<
  Pick<CacheSpec, 'name' | 'owner' | 'ttlMs' | 'invalidatedBy' | 'why'>
>;

const caches = new Map<string, CacheSpec>();

/** Puts a cache on the list. */
export function registerCache(spec: CacheSpec): void {
  if (spec.invalidatedBy.length === 0 && (spec.why === undefined || spec.why.trim() === ''))
    throw new Error(
      `Cache ${spec.name}: no event invalidates it and no reason is given (\`why\`).`,
    );
  for (const event of spec.invalidatedBy)
    if (!(cacheEvents as readonly string[]).includes(event))
      throw new Error(`Cache ${spec.name}: unknown event ${event}.`);
  caches.set(spec.name, spec);
}

/** Whether a key belongs to the scope. */
export function keyInScope(
  key: string,
  scope: CacheScope,
  keys: KeyShape = 'workspace_app',
  separator = '|',
): boolean {
  if (keys === 'all' || scope.workspaceId === undefined) return true;
  if (!key.startsWith(scope.workspaceId + separator)) return false;
  if (keys === 'workspace' || scope.appId === undefined) return true;
  const prefix = scope.workspaceId + separator + scope.appId;
  return key === prefix || key.startsWith(prefix + separator);
}

/** Registers a cache that is a `Map` (or anything with `keys()` and `delete()`), dropping entries by key scope. */
export function registerMapCache(
  map: { keys(): Iterable<string>; delete(key: string): unknown; clear(): void },
  declaration: CacheDeclaration & { ttlMs: number | null },
): void {
  const { keys, separator, ttlMs, ...rest } = declaration;
  registerCache({
    ...rest,
    ttlMs,
    drop(scope) {
      if (keys === 'all' || scope.workspaceId === undefined) return map.clear();
      for (const key of Array.from(map.keys()))
        if (keyInScope(key, scope, keys, separator)) map.delete(key);
    },
  });
}

/** Something happened: every cache that declared the event drops what belongs to the scope. Returns the names of the caches told. */
export function emitCacheEvent(event: CacheEvent, scope: CacheScope = {}): readonly string[] {
  const told: string[] = [];
  for (const spec of caches.values()) {
    if (!spec.invalidatedBy.includes(event)) continue;
    spec.drop(scope);
    told.push(spec.name);
  }
  return told;
}

/** Every registered cache, for the docs and the tests. */
export const registeredCaches = (): CacheInfo[] =>
  Array.from(caches.values(), ({ drop: _drop, ...info }) => info);

/** For tests: every cache empty (the scope is everything). */
export function clearAllCaches(): void {
  for (const spec of caches.values()) spec.drop({});
}
