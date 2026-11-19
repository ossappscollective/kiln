import type { Api } from './api.ts';
import {
  classifyReleaseFailure,
  type StoreReleaseConfig,
  type StoreReleaseState,
} from './store-release.ts';

/**
 * What the screens know about releasing: the server's switch (once per workspace) and, per app, whether a release,
 * a push or a submit is running or has an unknown outcome. Both are reads of our own database; the preview (a store
 * read) and the release (the store write) are done by the dialog flow, not here. A read that started before a newer
 * state arrived is dropped, so a slow read never brings back an old "unknown outcome" after a successful preview.
 */
let states = $state<Record<string, StoreReleaseState | undefined>>({});
let failed = $state<Record<string, boolean | undefined>>({});
let configs = $state<Record<string, StoreReleaseConfig | undefined>>({});
let configFailed = $state<Record<string, boolean | undefined>>({});
const generations: Record<string, number> = {};
const configLoading: Record<string, boolean | undefined> = {};

export const releaseStore = {
  state(appId: string): StoreReleaseState | null {
    return states[appId] ?? null;
  },
  stateFailed(appId: string): boolean {
    return failed[appId] === true;
  },
  /** Reads whether a release is running or unknown. Returns '' when it worked, else a sentence. */
  async load(api: Api, workspaceId: string, appId: string): Promise<string> {
    const mine = (generations[appId] = (generations[appId] ?? 0) + 1);
    try {
      const done = await api.appStoreRelease(workspaceId, appId);
      if (mine === generations[appId]) {
        states[appId] = done.release;
        failed[appId] = false;
      }
      return '';
    } catch (e) {
      if (mine === generations[appId]) failed[appId] = true;
      return classifyReleaseFailure(e, 'preview').message;
    }
  },
  /** A release answered with an unknown outcome: the line asks for a new preview until a read says otherwise. */
  markUnknown(appId: string): void {
    const current = states[appId];
    if (current)
      states[appId] = { ...current, unknownOutcome: { ...current.unknownOutcome, release: true } };
  },
  /** The release went through: nothing is unknown any more (the next read confirms it). */
  markReleased(appId: string): void {
    generations[appId] = (generations[appId] ?? 0) + 1;
    const current = states[appId];
    if (current)
      states[appId] = { ...current, unknownOutcome: { ...current.unknownOutcome, release: false } };
  },
  config(workspaceId: string): StoreReleaseConfig | null {
    return configs[workspaceId] ?? null;
  },
  configFailed(workspaceId: string): boolean {
    return configFailed[workspaceId] === true;
  },
  async loadConfig(api: Api, workspaceId: string, force = false): Promise<void> {
    if (configLoading[workspaceId] === true || (!force && configs[workspaceId] !== undefined))
      return;
    configLoading[workspaceId] = true;
    try {
      configs[workspaceId] = await api.storeReleaseConfig(workspaceId);
      configFailed[workspaceId] = false;
    } catch {
      configFailed[workspaceId] = true;
    } finally {
      configLoading[workspaceId] = false;
    }
  },
  /** The switch is known to be off (a preview or release answered `store_release_disabled`). */
  markDisabled(workspaceId: string): void {
    const current = configs[workspaceId];
    if (current) configs[workspaceId] = { ...current, enabled: false };
  },
};
