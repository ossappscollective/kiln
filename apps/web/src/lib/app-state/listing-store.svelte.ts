import { can, type Platform, type Role, supports } from '@kiln/core';
import type { Api } from '../api.ts';
import { ApiError } from '../api.ts';
import { type Invalidation, onInvalidated, readFact, readKeys } from '../facts/invalidate.ts';
import type { ListingChecksView } from '../insights/insights.ts';
import type { ListingFixesView } from '../listing/fixes.ts';
import type {
  ListingHistoryPage,
  StoreCopyViewJson,
  StoreDefaultLocale,
  StoreListingView,
} from '../types.ts';
import type { ReadinessFact } from './blockers.ts';
import {
  type CopyIntentName,
  copyOf,
  defaultLocaleOf,
  localesOf,
  noteLocalesOf,
} from './listing-view.ts';
import { readinessStore } from './readiness-store.svelte.ts';

/**
 * THE store of the listing's store side (docs/state-model.md, "Single owners (core)"): one read per app (`GET /apps/:id/listing/store`:
 * the locales, the copy of each intent, the base locale, the read time and error, the drift), and next to it the checks and the fixes
 * computed from it. The Listing page (grid, tab, matrix), the Checks and the fix bar, Insights, ASO, the release stepper's notes, the
 * publish summary's default language and Pending read THIS, never `appListingLive`/`appListingDrift`/`appListingChecks`/`listingFixes`.
 *
 * Freshness is `invalidate()`'s (`lib/facts/invalidate.ts`): the view lives in the read cache family `live`, which a sync, a publish, a
 * release creation and a store read forget; this store reads again (for the apps it holds) on those events and on `staged_changed`, which
 * changes what the fixes and the checks-after-pending say. A screen that wants the newest asks with `fresh`. A failed read keeps the last
 * good one and says why. One request per app at a time.
 *
 * The selectors are in `listing-view.ts` (plain TypeScript, tested); this file is the runes wrapper.
 */

type Entry = {
  view: StoreListingView | null;
  error: string | null;
  loading: number;
  checks: ListingChecksView | null;
  fixes: ListingFixesView | null;
  checksError: string | null;
  checksLoading: number;
};

let version = $state(0);
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const checksInFlight = new Map<string, Promise<void>>();
const generation = new Map<string, number>();
const keyOf = (workspaceId: string, appId: string) => `${workspaceId}|${appId}`;
let apiOf: Api | null = null;
let listening = false;

const entryOf = (key: string): Entry => {
  let e = entries.get(key);
  if (e === undefined) {
    e = {
      view: null,
      error: null,
      loading: 0,
      checks: null,
      fixes: null,
      checksError: null,
      checksLoading: 0,
    };
    entries.set(key, e);
  }
  return e;
};

const messageOf = (e: unknown): string =>
  e instanceof ApiError || e instanceof Error ? e.message : String(e);

function react(i: Invalidation): void {
  if (i.event === 'build_changed' || apiOf === null) return;
  const api = apiOf;
  for (const [key, entry] of entries) {
    const [workspaceId, appId] = key.split('|') as [string, string];
    if (workspaceId !== i.workspaceId) continue;
    if (i.appIds.length > 0 && i.appIds.indexOf(appId) < 0) continue;
    if (entry.view !== null) void listingStore.load(api, workspaceId, appId, { quiet: true });
    // What is staged is part of the fixes and of the checks after the cart: a stage, an unstage or a discard changes them.
    if (entry.checks !== null || entry.fixes !== null)
      void listingStore.loadChecks(api, workspaceId, appId, { fresh: true });
  }
}

export const listingStore = {
  /** The last read of an app's store listing; null until it is read. Reactive. */
  of(workspaceId: string, appId: string): StoreListingView | null {
    void version;
    return entries.get(keyOf(workspaceId, appId))?.view ?? null;
  },

  /** The copy of an intent (see `listing-view.ts`), or null. Reactive. */
  copy(workspaceId: string, appId: string, intent: CopyIntentName): StoreCopyViewJson | null {
    return copyOf(this.of(workspaceId, appId), intent);
  },

  /** The locale codes of an intent (`shown` by default). Reactive. */
  locales(workspaceId: string, appId: string, intent: CopyIntentName = 'shown'): string[] {
    return localesOf(this.of(workspaceId, appId), intent);
  },

  /** The locales the notes of a release are written for. Reactive. */
  noteLocales(workspaceId: string, appId: string): string[] {
    return noteLocalesOf(this.of(workspaceId, appId));
  },

  /** The base language and how it was decided. Reactive. */
  defaultLocale(workspaceId: string, appId: string): StoreDefaultLocale | null {
    return defaultLocaleOf(this.of(workspaceId, appId));
  },

  /** Whether a read is running, and (separately) whether it is the first one (`!reloading`), and why the last one failed. Reactive. */
  status(
    workspaceId: string,
    appId: string,
  ): { loading: boolean; reloading: boolean; error: string | null } {
    void version;
    const e = entries.get(keyOf(workspaceId, appId));
    return {
      loading: (e?.loading ?? 0) > 0,
      reloading: (e?.loading ?? 0) > 0 && e?.view != null,
      error: e?.error ?? null,
    };
  },

  /**
   * Reads the store listing of an app (the read cache keeps it for a minute; `fresh` asks again). Never throws: a failure keeps the last
   * good view and is in `status().error`. `quiet` does not raise the loading flag (a re-read after an event keeps the page as it is).
   */
  load(
    api: Api,
    workspaceId: string,
    appId: string,
    options: { fresh?: boolean; quiet?: boolean } = {},
  ): Promise<void> {
    apiOf = api;
    if (!listening) {
      listening = true;
      onInvalidated(react);
    }
    const key = keyOf(workspaceId, appId);
    const running = inFlight.get(key);
    if (running !== undefined && options.fresh !== true) return running;
    const entry = entryOf(key);
    const mine = (generation.get(key) ?? 0) + 1;
    generation.set(key, mine);
    if (options.quiet !== true) entry.loading += 1;
    version += 1;
    const work = (async () => {
      try {
        const view = await readFact('live', {
          workspaceId,
          key: readKeys.live(appId),
          force: options.fresh === true,
          load: () => api.appListingStore(workspaceId, appId),
        });
        // Only the newest request of an app writes (a slow older answer must not overwrite a newer one).
        if (generation.get(key) === mine) {
          entry.view = view;
          entry.error = null;
        }
      } catch (e) {
        if (generation.get(key) === mine) entry.error = messageOf(e);
      } finally {
        if (options.quiet !== true) entry.loading -= 1;
        version += 1;
      }
    })();
    inFlight.set(key, work);
    const done = () => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    };
    void work.then(done, done);
    return work;
  },

  /** The checks of the shown copy and the fixes of the editable one (the page-level "Checks" and the fix bar); null until read. Reactive. */
  checks(
    workspaceId: string,
    appId: string,
  ): {
    checks: ListingChecksView | null;
    fixes: ListingFixesView | null;
    error: string | null;
    loading: boolean;
  } {
    void version;
    const e = entries.get(keyOf(workspaceId, appId));
    return {
      checks: e?.checks ?? null,
      fixes: e?.fixes ?? null,
      error: e?.checksError ?? null,
      loading: (e?.checksLoading ?? 0) > 0,
    };
  },

  /** Reads the checks and the fixes together (a fix bar shows rows from both: they are one answer). The fixes are optional: their failure is not the checks'. */
  loadChecks(
    api: Api,
    workspaceId: string,
    appId: string,
    options: { fresh?: boolean } = {},
  ): Promise<void> {
    apiOf = api;
    if (!listening) {
      listening = true;
      onInvalidated(react);
    }
    const key = keyOf(workspaceId, appId);
    const running = checksInFlight.get(key);
    if (running !== undefined && options.fresh !== true) return running;
    const entry = entryOf(key);
    entry.checksLoading += 1;
    version += 1;
    const work = (async () => {
      try {
        const [checks, fixes] = await Promise.all([
          api.appListingChecks(workspaceId, appId),
          api.listingFixes(workspaceId, appId).catch(() => null),
        ]);
        entry.checks = checks;
        entry.fixes = fixes;
        entry.checksError = null;
      } catch (e) {
        entry.checksError = messageOf(e);
      } finally {
        entry.checksLoading -= 1;
        version += 1;
      }
    })();
    checksInFlight.set(key, work);
    const done = () => {
      if (checksInFlight.get(key) === work) checksInFlight.delete(key);
    };
    void work.then(done, done);
    return work;
  },

  /** The changes of a field (or of every field), newest first, in pages: a pass-through (history is not a fact the pages share). */
  history(
    api: Api,
    workspaceId: string,
    appId: string,
    filter: { locale?: string; field?: string; cursor?: string; limit?: number } = {},
  ): Promise<ListingHistoryPage> {
    return api.appListingHistory(workspaceId, appId, filter);
  },

  /**
   * The App Review Information check, early: the current readiness (the server judges the store's draft with the ONE core rule of the submit);
   * the reading is kept 30 seconds like every other. A role that may not submit, and Google Play (no review information), are not asked.
   */
  review(workspaceId: string, appId: string): ReadinessFact | null {
    return readinessStore.of(workspaceId, appId);
  },
  loadReview(
    api: Api,
    workspaceId: string,
    role: Role,
    app: { id: string; platform: Platform },
  ): Promise<void> {
    if (!can(role, 'store.submit') || supports(app.platform, 'releaseTracks'))
      return Promise.resolve();
    return readinessStore.load(api, workspaceId, app.id);
  },

  /** Forgets an app (it left the workspace). */
  forget(workspaceId: string, appId: string): void {
    entries.delete(keyOf(workspaceId, appId));
    version += 1;
  },

  /** For tests. */
  clear(): void {
    entries.clear();
    inFlight.clear();
    checksInFlight.clear();
    generation.clear();
    version += 1;
  },
};
