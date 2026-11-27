import { APP_LIST_MAX_AGE_MS } from '@kiln/core';
import { untrack } from 'svelte';
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

const APPS_MAX_AGE_MS = APP_LIST_MAX_AGE_MS;

let workspace = $state('');
let list = $state<AppSummary[] | null>(null);
let attention = $state<number | null>(null);
let unanswered = $state<number | null>(null);
let unansweredByApp = $state<Record<string, number | undefined>>({});
let insightsByApp = $state<Record<string, number | undefined>>({});
const insightsReadAt = new Map<string, number>();
const insightsInflight = new Set<string>();
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
  unansweredByApp = {};
  insightsByApp = {};
  insightsReadAt.clear();
  insightsInflight.clear();
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

  /** The unanswered reviews of each app record, as the workspace summary or a fresher per-app summary said. */
  unansweredByAppOf(workspaceId: string): Record<string, number | undefined> {
    return workspaceId === workspace ? unansweredByApp : {};
  },
  setUnansweredByApp(workspaceId: string, counts: Record<string, number>): void {
    scope(workspaceId);
    // Read without tracking: this is called from effects, and must not make them depend on what they write.
    const before = untrack(() => unansweredByApp);
    if (Object.keys(counts).every((id) => before[id] === counts[id])) return;
    unansweredByApp = { ...before, ...counts };
  },

  /** The Insights cards of each app record that are not dismissed (the badge of the Insights entry). */
  insightsByAppOf(workspaceId: string): Record<string, number | undefined> {
    return workspaceId === workspace ? insightsByApp : {};
  },
  /** The Insights page knows the number (after a read, a dismissal or an undo): it replaces what the badge had. */
  setInsightsCount(workspaceId: string, appId: string, count: number, now = Date.now()): void {
    scope(workspaceId);
    const before = untrack(() => insightsByApp);
    insightsReadAt.set(appId, now);
    if (before[appId] !== count) insightsByApp = { ...before, [appId]: count };
  },
  /**
   * Reads the number for each record that has none or an old one (older than `maxAgeMs`), one request per record at a time. There is no timer:
   * this runs when an app is opened, so the cost is one cheap request per record per few minutes. A failed read leaves what there was.
   */
  async ensureInsightsCounts(
    api: Api,
    workspaceId: string,
    appIds: readonly string[],
    maxAgeMs = 5 * 60_000,
  ): Promise<void> {
    scope(workspaceId);
    const now = Date.now();
    const due = appIds.filter((id) => {
      const at = insightsReadAt.get(id);
      return !insightsInflight.has(id) && (at === undefined || now - at >= maxAgeMs || now < at);
    });
    for (const id of due) insightsInflight.add(id);
    await Promise.all(
      due.map(async (id) => {
        try {
          const read = await api.appInsightsCount(workspaceId, id);
          if (workspace === workspaceId) navSignals.setInsightsCount(workspaceId, id, read.count);
        } catch {
          // No badge is better than a wrong one: a failed read changes nothing.
        } finally {
          insightsInflight.delete(id);
        }
      }),
    );
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
