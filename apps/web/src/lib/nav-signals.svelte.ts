import type { Api } from './api.ts';
import { mergeLocales } from './app-header.ts';
import type { AppSummary } from './types.ts';

/**
 * What the shell shows beside the navigation, taken from what the screens already loaded and kept for
 * the other screens to use: the app list (for the switcher and Cmd or Ctrl + 1 to 9), the number of apps
 * that need attention, the unanswered reviews, the locales a page has read, and whether the first key of
 * a `g` chord is waiting. Nothing here starts a request on its own except `ensureApps`, which reads the
 * app list once (and again only when it is older than a minute and someone asks).
 * A workspace change starts clean. A count that was never set is null: no badge.
 */

const APPS_MAX_AGE_MS = 60_000;

let workspace = $state('');
let list = $state<AppSummary[] | null>(null);
let attention = $state<number | null>(null);
let unanswered = $state<number | null>(null);
let localesByApp = $state<Record<string, string[]>>({});
let chordPending = $state(false);
let loadedAt = 0;
let inflight: { workspaceId: string; promise: Promise<void> } | null = null;

function scope(workspaceId: string): void {
  if (workspaceId === workspace) return;
  workspace = workspaceId;
  list = null;
  attention = null;
  unanswered = null;
  localesByApp = {};
  loadedAt = 0;
  inflight = null;
}

export const navSignals = {
  /** The apps of the workspace as last read, or null. */
  appsOf(workspaceId: string): AppSummary[] | null {
    return workspaceId === workspace ? list : null;
  },
  setApps(workspaceId: string, apps: AppSummary[]): void {
    scope(workspaceId);
    list = apps;
    loadedAt = Date.now();
  },
  /** Reads the app list unless it is fresh; one read at a time. A failed read leaves what there was. */
  async ensureApps(api: Api, workspaceId: string): Promise<AppSummary[] | null> {
    scope(workspaceId);
    if (list !== null && Date.now() - loadedAt < APPS_MAX_AGE_MS) return list;
    if (inflight === null || inflight.workspaceId !== workspaceId) {
      const promise = api
        .apps(workspaceId)
        .then((read) => {
          if (workspace === workspaceId) {
            list = read.apps;
            loadedAt = Date.now();
          }
        })
        .catch(() => undefined)
        .then(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { workspaceId, promise };
    }
    await inflight.promise;
    return workspace === workspaceId ? list : null;
  },

  attentionOf(workspaceId: string): number | null {
    return workspaceId === workspace ? attention : null;
  },
  setAttention(workspaceId: string, count: number | null): void {
    scope(workspaceId);
    attention = count;
  },
  unansweredOf(workspaceId: string): number | null {
    return workspaceId === workspace ? unanswered : null;
  },
  setUnanswered(workspaceId: string, count: number | null): void {
    scope(workspaceId);
    unanswered = count;
  },

  /** A page that has read the locales of an app records them, so the header picker can offer them. */
  setLocales(workspaceId: string, appId: string, locales: readonly string[]): void {
    scope(workspaceId);
    const next = [...locales];
    const before = localesByApp[appId];
    if (before && before.length === next.length && before.every((l, i) => l === next[i])) return;
    localesByApp = { ...localesByApp, [appId]: next };
  },
  localesOf(workspaceId: string, appIds: readonly string[]): string[] {
    if (workspaceId !== workspace) return [];
    return mergeLocales(appIds.map((id) => localesByApp[id] ?? []));
  },

  get chordPending(): boolean {
    return chordPending;
  },
  set chordPending(value: boolean) {
    chordPending = value;
  },
};
