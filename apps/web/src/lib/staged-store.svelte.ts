import type { StagedChangesView } from '@kiln/core';
import type { Api } from './api.ts';
import { type StoreDraftConfig, stagingError } from './staged.ts';

/**
 * The staged changes of the apps on screen, shared by the tray, the listing grid, the locale drawer and the
 * Assets tab, so that staging a field in one place shows in all of them. It holds what the server last said
 * (the server is the source of truth) and nothing else. Reads and staging only touch our own database; the
 * push (a store write) is done by the tray, not here.
 *
 * A load that was started before a newer view arrived (a stage, an unstage, a clear) is dropped when it ends,
 * so a slow read never brings back an item that was just removed.
 */
let views = $state<Record<string, StagedChangesView | undefined>>({});
let configs = $state<Record<string, StoreDraftConfig | undefined>>({});
let configFailed = $state<Record<string, boolean | undefined>>({});
const generations: Record<string, number> = {};
const configLoading: Record<string, boolean | undefined> = {};

export const stagedStore = {
  /** The staged changes of an app, or null before the first load. */
  view(appId: string): StagedChangesView | null {
    return views[appId] ?? null;
  },
  /** Takes a view the server just sent (the answer of a stage, unstage or clear). */
  set(view: StagedChangesView): void {
    generations[view.app.id] = (generations[view.app.id] ?? 0) + 1;
    views[view.app.id] = view;
  },
  /** Reads the staged changes. Returns '' when it worked, else a sentence. */
  async load(api: Api, workspaceId: string, appId: string): Promise<string> {
    const mine = (generations[appId] = (generations[appId] ?? 0) + 1);
    try {
      const done = await api.appStaged(workspaceId, appId);
      if (mine === generations[appId]) views[appId] = done.staged;
      return '';
    } catch (e) {
      return stagingError(e);
    }
  },
  config(workspaceId: string): StoreDraftConfig | null {
    return configs[workspaceId] ?? null;
  },
  configFailed(workspaceId: string): boolean {
    return configFailed[workspaceId] === true;
  },
  /** Reads the server's switch once per workspace (a failure can be tried again by calling it again). */
  async loadConfig(api: Api, workspaceId: string, force = false): Promise<void> {
    if (configLoading[workspaceId] === true || (!force && configs[workspaceId] !== undefined))
      return;
    configLoading[workspaceId] = true;
    try {
      configs[workspaceId] = await api.storeDraftConfig(workspaceId);
      configFailed[workspaceId] = false;
    } catch {
      configFailed[workspaceId] = true;
    } finally {
      configLoading[workspaceId] = false;
    }
  },
  /** The switch is known to be off (a push answered `store_draft_disabled`). */
  markDisabled(workspaceId: string): void {
    const current = configs[workspaceId];
    if (current) configs[workspaceId] = { ...current, enabled: false };
  },
};
