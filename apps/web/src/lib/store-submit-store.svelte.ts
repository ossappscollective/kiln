import type { Api } from './api.ts';
import { type StoreSubmitConfig, type SubmitState, classifySubmitFailure } from './store-submit.ts';

/**
 * What the screens know about submitting a pushed draft: the server's switch (once per workspace) and, per app,
 * whether a draft push is waiting to be submitted. Both are reads of our own database; the preview (a store read)
 * and the submit (the store write) are done by the dialog flow, not here. A read that started before a newer
 * state arrived is dropped, so a slow read never brings back a "ready to submit" after a successful submit.
 */
let states = $state<Record<string, SubmitState | undefined>>({});
let failed = $state<Record<string, boolean | undefined>>({});
let configs = $state<Record<string, StoreSubmitConfig | undefined>>({});
let configFailed = $state<Record<string, boolean | undefined>>({});
const generations: Record<string, number> = {};
const configLoading: Record<string, boolean | undefined> = {};

export const submitStore = {
  state(appId: string): SubmitState | null {
    return states[appId] ?? null;
  },
  stateFailed(appId: string): boolean {
    return failed[appId] === true;
  },
  /** Reads whether a pushed draft waits to be submitted. Returns '' when it worked, else a sentence. */
  async load(api: Api, workspaceId: string, appId: string): Promise<string> {
    const mine = (generations[appId] = (generations[appId] ?? 0) + 1);
    try {
      const done = await api.appStoreSubmit(workspaceId, appId);
      if (mine === generations[appId]) {
        states[appId] = done.submit;
        failed[appId] = false;
      }
      return '';
    } catch (e) {
      if (mine === generations[appId]) failed[appId] = true;
      return classifySubmitFailure(e, 'preview').message;
    }
  },
  /** The submit went through: nothing is waiting any more (the next read confirms it). */
  markSubmitted(appId: string): void {
    generations[appId] = (generations[appId] ?? 0) + 1;
    const current = states[appId];
    if (current) states[appId] = { ...current, pushed: false, push: null, unknownOutcome: { ...current.unknownOutcome, submit: false } };
  },
  /** A submit answered with an unknown outcome: the line asks for a new preview until a read says otherwise. */
  markUnknown(appId: string): void {
    const current = states[appId];
    if (current) states[appId] = { ...current, unknownOutcome: { ...current.unknownOutcome, submit: true } };
  },
  config(workspaceId: string): StoreSubmitConfig | null {
    return configs[workspaceId] ?? null;
  },
  configFailed(workspaceId: string): boolean {
    return configFailed[workspaceId] === true;
  },
  async loadConfig(api: Api, workspaceId: string, force = false): Promise<void> {
    if (configLoading[workspaceId] === true || (!force && configs[workspaceId] !== undefined)) return;
    configLoading[workspaceId] = true;
    try {
      configs[workspaceId] = await api.storeSubmitConfig(workspaceId);
      configFailed[workspaceId] = false;
    } catch {
      configFailed[workspaceId] = true;
    } finally {
      configLoading[workspaceId] = false;
    }
  },
  /** The switch is known to be off (a preview or submit answered `store_submit_disabled`). */
  markDisabled(workspaceId: string): void {
    const current = configs[workspaceId];
    if (current) configs[workspaceId] = { ...current, enabled: false };
  },
};
