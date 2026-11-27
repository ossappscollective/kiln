import { type Api, ApiError } from '../api.ts';
import { onInvalidated } from '../facts/invalidate.ts';
import { type CartRow, toRows } from '../pending-cart.ts';

/**
 * The cart rows of an app, read ONCE for every screen that shows them (the cart drawer, the Pending page's previews, the workspace
 * Pending page's expanded product): before, each of the three fetched `GET /apps/{id}/pending/cart` by itself, on its own events, so the same
 * cart was read two or three times per change and could be shown in three states at once. The COUNT is not read here (it is the model's
 * `pendingCount`, from the cart summary); this holds the rows that explain it.
 *
 * Screens `watch` the apps they show. While at least one screen watches an app, the store reads its cart again on the same announcements the
 * model reacts to (`facts/invalidate.ts`: a discard, a publish, a store read, a sync; a plain `stage` is told by `refresh` from the screen
 * that staged, so the "added" pulse follows the data). One read at a time per app: a request that arrives while one is running makes ONE more
 * read after it, however many screens asked.
 */

type Entry = {
  rows: CartRow[] | null;
  failed: boolean;
  message: string;
  loading: boolean;
  running: Promise<void> | null;
  again: boolean;
};

let version = $state(0);
const entries = new Map<string, Entry>();
const watchers = new Map<string, { api: Api; workspaceId: string; appId: string; n: number }>();
let unsubscribe: (() => void) | null = null;

const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;
const entryOf = (key: string): Entry => {
  let e = entries.get(key);
  if (e === undefined) {
    e = { rows: null, failed: false, message: '', loading: false, running: null, again: false };
    entries.set(key, e);
  }
  return e;
};

function refreshOf(api: Api, workspaceId: string, appId: string): Promise<void> {
  const key = keyOf(workspaceId, appId);
  const e = entryOf(key);
  if (e.running !== null) {
    e.again = true;
    return e.running;
  }
  e.running = (async () => {
    try {
      do {
        e.again = false;
        e.loading = true;
        version += 1;
        try {
          e.rows = toRows(appId, (await api.appPendingCart(workspaceId, appId)).cart.items);
          e.failed = false;
          e.message = '';
        } catch (error) {
          e.failed = true;
          e.message = error instanceof ApiError ? error.message : '';
        }
        e.loading = false;
        version += 1;
      } while (e.again);
    } finally {
      e.running = null;
    }
  })();
  return e.running;
}

function bind() {
  if (unsubscribe !== null) return;
  unsubscribe = onInvalidated((i) => {
    if (i.event !== 'staged_changed' && i.event !== 'publish' && i.event !== 'store_read' && i.event !== 'sync') return;
    if (i.event === 'staged_changed' && i.reason === 'stage') return;
    for (const w of watchers.values()) {
      if (w.workspaceId !== i.workspaceId) continue;
      if (i.appIds.length === 0 || i.appIds.indexOf(w.appId) >= 0) void refreshOf(w.api, w.workspaceId, w.appId);
    }
  });
}

export const cartStore = {
  /** The rows of the app's cart; null until the first read. Reactive. */
  rows(workspaceId: string, appId: string): CartRow[] | null {
    void version;
    return entries.get(keyOf(workspaceId, appId))?.rows ?? null;
  },
  /** The last read failed (the rows of an earlier read, when there are any, stay). */
  failed(workspaceId: string, appId: string): boolean {
    void version;
    return entries.get(keyOf(workspaceId, appId))?.failed === true;
  },
  /** The server's sentence of the failure, '' when none. */
  message(workspaceId: string, appId: string): string {
    void version;
    return entries.get(keyOf(workspaceId, appId))?.message ?? '';
  },
  /** A read is running for the app. */
  loading(workspaceId: string, appId: string): boolean {
    void version;
    return entries.get(keyOf(workspaceId, appId))?.loading === true;
  },
  /**
   * A screen shows the carts of these apps: they are read now unless they are known, and read again for every change until the screen lets
   * go (the returned function). Several screens watching one app share ONE read.
   */
  watch(api: Api, workspaceId: string, appIds: readonly string[]): () => void {
    const taken = appIds.slice();
    for (const appId of taken) {
      const key = keyOf(workspaceId, appId);
      const w = watchers.get(key);
      if (w) w.n += 1;
      else watchers.set(key, { api, workspaceId, appId, n: 1 });
      if (entryOf(key).rows === null) void refreshOf(api, workspaceId, appId);
    }
    bind();
    return () => {
      for (const appId of taken) {
        const key = keyOf(workspaceId, appId);
        const w = watchers.get(key);
        if (!w) continue;
        w.n -= 1;
        if (w.n <= 0) watchers.delete(key);
      }
      if (watchers.size === 0 && unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  },
  /** Read these carts again now (after the screen's own publish or discard, a focus, an "added" announcement). One read per app at a time. */
  refresh(api: Api, workspaceId: string, appIds: readonly string[]): Promise<void> {
    return Promise.all(appIds.map((id) => refreshOf(api, workspaceId, id))).then(() => undefined);
  },
};
