import type { Api } from './api.ts';
import type { PendingSummary, PendingView, PublishConfig } from './pending.ts';
import { pipelineStore } from './pipeline-store.svelte.ts';
import { stagingError } from './staged.ts';
import { stagedStore } from './staged-store.svelte.ts';
import { submitStore } from './store-submit-store.svelte.ts';

/**
 * What the screens know about what is pending (docs/api/pending.md): the workspace summary (one line per app, for the chips in the
 * overview, the app switcher, the sidebar and the app header), the pending view of each open app, and the server's switch for
 * publishing in one go. All three are reads of our own database. A read that started before a newer one arrived is dropped, so a
 * slow read never brings back something that was just published or removed. A failed or missing summary (an older server, a role
 * that may not read it) leaves what there was and draws no chip: no screen needs it to work.
 */
let summaries = $state<Record<string, PendingSummary | undefined>>({});
let views = $state<Record<string, PendingView | undefined>>({});
let configs = $state<Record<string, PublishConfig | undefined>>({});
let configFailed = $state<Record<string, boolean | undefined>>({});
const summaryGeneration: Record<string, number> = {};
const viewGeneration: Record<string, number> = {};
const configLoading: Record<string, boolean | undefined> = {};

export const pendingStore = {
  summary(workspaceId: string): PendingSummary | null {
    return summaries[workspaceId] ?? null;
  },
  /** Reads the workspace summary. Never throws; a failure keeps the last summary. */
  async loadSummary(api: Api, workspaceId: string): Promise<void> {
    const mine = (summaryGeneration[workspaceId] = (summaryGeneration[workspaceId] ?? 0) + 1);
    try {
      const out = await api.pendingSummary(workspaceId);
      if (mine === summaryGeneration[workspaceId] && out && Array.isArray(out.apps)) summaries[workspaceId] = out;
    } catch {
      // No chip: the screens work without it.
    }
  },

  view(appId: string): PendingView | null {
    return views[appId] ?? null;
  },
  /** Reads the pending view of one app record. Returns '' when it worked, else a sentence. */
  async loadView(api: Api, workspaceId: string, appId: string): Promise<string> {
    const mine = (viewGeneration[appId] = (viewGeneration[appId] ?? 0) + 1);
    try {
      const out = await api.appPending(workspaceId, appId);
      if (mine === viewGeneration[appId]) views[appId] = out.pending;
      return '';
    } catch (e) {
      return stagingError(e);
    }
  },

  config(workspaceId: string): PublishConfig | null {
    return configs[workspaceId] ?? null;
  },
  configFailed(workspaceId: string): boolean {
    return configFailed[workspaceId] === true;
  },
  /** Reads the server's switch once per workspace (a failure can be tried again by calling it again). */
  async loadConfig(api: Api, workspaceId: string, force = false): Promise<void> {
    if (configLoading[workspaceId] === true || (!force && configs[workspaceId] !== undefined)) return;
    configLoading[workspaceId] = true;
    try {
      configs[workspaceId] = await api.storePublishConfig(workspaceId);
      configFailed[workspaceId] = false;
    } catch {
      configFailed[workspaceId] = true;
    } finally {
      configLoading[workspaceId] = false;
    }
  },
  /** A publish answered that the batch is switched off. */
  markDisabled(workspaceId: string): void {
    const current = configs[workspaceId];
    if (current) configs[workspaceId] = { ...current, enabled: false };
  },

  /**
   * After something changed (a publish, a discard): read again what other screens show about these apps, so no dashboard keeps
   * a stale line. Everything is a read of our own database; nothing here touches a store.
   */
  async refresh(api: Api, workspaceId: string, appIds: readonly string[], options: { submit: boolean }): Promise<void> {
    const jobs: Promise<unknown>[] = [pendingStore.loadSummary(api, workspaceId), pipelineStore.loadSummary(api, workspaceId)];
    for (const id of appIds) {
      jobs.push(pendingStore.loadView(api, workspaceId, id));
      jobs.push(stagedStore.load(api, workspaceId, id));
      if (options.submit) jobs.push(submitStore.load(api, workspaceId, id));
    }
    await Promise.all(jobs);
  },
};
