import { storeMediaCache } from '../assets/store-cache.ts';
import { readCache } from '../read-cache.ts';
import { batchAppIds, onStagedChanged, type StagedChangeReason } from '../staged-sync.ts';

/**
 * The ONE place that makes what the browser kept stale (docs/state-model.md, "Caches and events"). Everything that changes a fact says
 * WHAT happened (`invalidate('sync', ...)`), never which cache to drop: this file knows which key families of the read cache, which other
 * kept reads (the Graphics tab's last read) and which model facts an event makes old, forgets them, refreshes the app-state model, and
 * tells the screens that asked to hear it (`onInvalidated`). Nothing else calls `readCache.forget` (`invalidate.test.ts` fails if it does),
 * and a key family that is not listed below fails the typecheck (`FAMILIES_FOR` is exhaustive over both unions) and the test that scans
 * the `readCache.read` calls of the app.
 *
 * Events (the server has the same list, `apps/server/src/services/cache-registry.ts`, minus `release_created`, which is its `release_changed`):
 *  - `sync`            an app was synced from the stores (the sync button, the scheduled read seen on focus, a listing sync).
 *  - `publish`         a publish or push ended, whatever the outcome (the store may hold some of it).
 *  - `staged_changed`  something was staged, unstaged or discarded.
 *  - `store_read`      the store was read again on purpose ("Read again" of the Graphics tab, "Check again").
 *  - `release_created` a release (version) was created or started, in the store or as a plan.
 *  - `build_changed`   a build was attached, uploaded, linked or its run finished.
 *
 * Plain TypeScript (no runes): the app-state model plugs its own reaction in with `bindInvalidation`, so this file is testable on its own.
 */

export const INVALIDATION_EVENTS = [
  'sync',
  'publish',
  'staged_changed',
  'store_read',
  'release_created',
  'build_changed',
] as const;
export type InvalidationEvent = (typeof INVALIDATION_EVENTS)[number];

// ---------------------------------------------------------------------------------------------
// Read cache key families

/** The read cache's keys, typed. A free string key is not allowed: build it here, so a family can be named by an event. */
export const readKeys = {
  pipeline: (appId: string) => `pipeline/${appId}`,
  storeBuilds: (appId: string) => `store-builds/${appId}`,
  /** The editable draft: App Store `''`, Google Play the track. */
  editable: (appId: string, track: string) => `editable/${appId}/${track}`,
  /** Release candidates: App Store `''`, Google Play the track or the source. */
  candidates: (appId: string, which: string) => `candidates/${appId}/${which}`,
  live: (appId: string) => `live/${appId}`,
  assetDiff: (appId: string) => `assetdiff/${appId}`,
  /** The builds Kiln linked to CI runs (`GET apps/{id}/builds`). */
  appBuilds: (appId: string) => `app-builds/${appId}`,
  /** The release plans of an app, and one plan (`sub` is the plan id, '' for the list). */
  plans: (appId: string, sub: string) => `plans/${appId}/${sub}`,
  /** "What is new" of earlier releases: `sub` names the question (platform, track, codes). */
  notesHistory: (appId: string, sub: string) => `notes-history/${appId}/${sub}`,
  /** The TestFlight read of an app: `sub` is the query. */
  testflight: (appId: string, sub: string) => `testflight/${appId}/${sub}`,
} as const;
export type KeyFamily = keyof typeof readKeys;

/** The read cache's group (the 429 pause is per group) and key prefix of each family. */
const FAMILY: Readonly<Record<KeyFamily, { group: string; prefix: string }>> = {
  pipeline: { group: 'pipeline', prefix: 'pipeline/' },
  storeBuilds: { group: 'builds', prefix: 'store-builds/' },
  editable: { group: 'store', prefix: 'editable/' },
  candidates: { group: 'store', prefix: 'candidates/' },
  live: { group: 'listing', prefix: 'live/' },
  assetDiff: { group: 'repo', prefix: 'assetdiff/' },
  appBuilds: { group: 'builds', prefix: 'app-builds/' },
  plans: { group: 'plans', prefix: 'plans/' },
  notesHistory: { group: 'store', prefix: 'notes-history/' },
  testflight: { group: 'testflight', prefix: 'testflight/' },
};
export const KEY_FAMILIES = Object.keys(FAMILY) as KeyFamily[];
/** The key prefixes, for the test that scans the app for a key of a family that is not listed. */
export const KEY_PREFIXES: readonly string[] = KEY_FAMILIES.map((f) => FAMILY[f].prefix);
export const groupOf = (family: KeyFamily): string => FAMILY[family].group;

/** Which families an event makes old. Exhaustive: a new event or a new family is a compile error until it is placed here. */
export const FAMILIES_FOR: Readonly<Record<InvalidationEvent, readonly KeyFamily[]>> = {
  sync: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  publish: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  release_created: ['pipeline', 'storeBuilds', 'editable', 'candidates', 'live', 'assetDiff', 'appBuilds', 'plans', 'notesHistory', 'testflight'],
  store_read: ['editable', 'candidates', 'live', 'assetDiff', 'notesHistory'],
  build_changed: ['pipeline', 'storeBuilds', 'candidates', 'appBuilds', 'testflight'],
  // The comparison of the repository with the store counts what is staged.
  staged_changed: ['assetDiff'],
};

/** Whether the Graphics tab's last read of the store (`storeMediaCache`) is dropped with this event. */
export const DROPS_GRAPHICS: Readonly<Record<InvalidationEvent, boolean>> = {
  sync: true,
  publish: true,
  release_created: true,
  store_read: true,
  build_changed: false,
  staged_changed: false,
};

/** Whether the app-state model reads its facts again (`appStateStore.refresh`) with this event. `staged_changed` has its own, lighter reaction. */
export const REFRESHES_MODEL: Readonly<Record<InvalidationEvent, boolean>> = {
  sync: true,
  publish: true,
  release_created: true,
  build_changed: true,
  store_read: false,
  staged_changed: false,
};

/** `readCache.read` with a typed family: the key and the group cannot drift from what `invalidate` forgets. */
export function readFact<T>(
  family: KeyFamily,
  args: {
    workspaceId: string;
    /** The key built by `readKeys`. */
    key: string;
    load: () => Promise<T>;
    force?: boolean;
    ttlMs?: number;
  },
): Promise<T> {
  return readCache.read({ ...args, group: FAMILY[family].group });
}

// ---------------------------------------------------------------------------------------------
// The event

export type Invalidation = {
  event: InvalidationEvent;
  workspaceId: string;
  /** The apps it is about (empty: the workspace). */
  appIds: readonly string[];
  /** For `staged_changed`: what exactly was done (`stage` is the one the cart already shows itself). */
  reason?: StagedChangeReason;
  /** Who raised it, when that screen must not react to its own call (the Graphics tab's "Read again" has just read the store itself). */
  origin?: string;
};

export type InvalidationScope = {
  workspaceId: string;
  appId?: string;
  appIds?: readonly string[];
  reason?: StagedChangeReason;
  origin?: string;
  /** The caller has just stored the fresh Graphics read itself: keep it (everything else is forgotten as usual). */
  keepGraphics?: boolean;
};

type Handler = (i: Invalidation) => void;
const handlers = new Set<Handler>();

/** What the app-state model does with an invalidation (it reads its facts again). Bound by `appStateStore.watch`. */
type ModelReaction = (i: Invalidation) => Promise<void> | void;
let model: { workspaceId: string; react: ModelReaction } | null = null;

/** A screen that wants to hear every invalidation (to read what it shows again). Returns the function that stops listening. */
export function onInvalidated(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

const idsOf = (scope: InvalidationScope): string[] =>
  scope.appIds !== undefined ? [...scope.appIds] : scope.appId !== undefined ? [scope.appId] : [];

/**
 * Something happened: forget what it made old, read the model's facts again, tell the screens. Resolves when the model has read again.
 * Never throws (a screen's handler that throws does not stop the others).
 */
export async function invalidate(
  event: InvalidationEvent,
  scope: InvalidationScope,
): Promise<void> {
  const appIds = idsOf(scope);
  const i: Invalidation = {
    event,
    workspaceId: scope.workspaceId,
    appIds,
    ...(scope.reason === undefined ? {} : { reason: scope.reason }),
    ...(scope.origin === undefined ? {} : { origin: scope.origin }),
  };
  for (const family of FAMILIES_FOR[event]) {
    if (appIds.length === 0) readCache.forget(scope.workspaceId, FAMILY[family].prefix);
    else for (const id of appIds) readCache.forget(scope.workspaceId, `${FAMILY[family].prefix}${id}`);
  }
  if (DROPS_GRAPHICS[event] && scope.keepGraphics !== true) {
    if (appIds.length === 0) storeMediaCache.forgetWorkspace(scope.workspaceId);
    else for (const id of appIds) storeMediaCache.forgetApp(scope.workspaceId, id);
  }
  for (const handler of Array.from(handlers)) {
    try {
      handler(i);
    } catch {
      // A broken screen must not keep the others from reading again.
    }
  }
  if (model !== null && model.workspaceId === scope.workspaceId) {
    try {
      await model.react(i);
    } catch {
      // The model keeps what it had; the next read says why.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The one subscription to the browser event (`kiln:staged-changed`)

const EVENT_OF: Readonly<Record<StagedChangeReason, InvalidationEvent>> = {
  stage: 'staged_changed',
  unstage: 'staged_changed',
  discard: 'staged_changed',
  publish: 'publish',
  store_read: 'store_read',
};

/**
 * Binds the app-state model to a workspace and listens, ONCE, to what `lib/api.ts` announces on `window` (a stage, an unstage, a discard, a
 * publish, a store read): announcements that arrive close together are collected per event and become one `invalidate`. Nothing else
 * subscribes to `kiln:staged-changed`; a screen subscribes to `onInvalidated`. Returns the function that unbinds.
 */
export function bindInvalidation(
  workspaceId: string,
  react: ModelReaction,
  target?: Parameters<typeof onStagedChanged>[1],
  schedule?: Parameters<typeof batchAppIds>[1],
): () => void {
  const mine = { workspaceId, react };
  model = mine;
  const batches = new Map<InvalidationEvent, ReturnType<typeof batchAppIds>>();
  const reasons = new Map<InvalidationEvent, StagedChangeReason>();
  const batchFor = (event: InvalidationEvent) => {
    let b = batches.get(event);
    if (b === undefined) {
      b = batchAppIds((appIds) => {
        const reason = reasons.get(event);
        reasons.delete(event);
        void invalidate(event, {
          workspaceId,
          appIds,
          ...(reason === undefined ? {} : { reason }),
        });
      }, schedule);
      batches.set(event, b);
    }
    return b;
  };
  const off = onStagedChanged((d) => {
    const event = EVENT_OF[d.reason];
    // A burst of `stage`s and one `discard` is one invalidation: the reason kept is the strongest (anything but `stage` wins).
    if (reasons.get(event) !== 'discard' && reasons.get(event) !== 'unstage') reasons.set(event, d.reason);
    batchFor(event).add(d.appId);
  }, target);
  return () => {
    off();
    for (const b of batches.values()) b.cancel();
    if (model === mine) model = null;
  };
}
