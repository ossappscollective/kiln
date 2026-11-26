import { type Api, ApiError } from './api.ts';
import { announcePublished } from './app-page.ts';
import { cartSummaryStore } from './cart-summary.svelte.ts';
import type { LastPublish, PublishStepType } from './pending.ts';
import { pendingStore } from './pending-store.svelte.ts';
import { createPublishingLoader, disabledReason, type PublishingEntry } from './publishing.ts';

/**
 * The one answer to "is this app publishing right now?" for every screen: the pending panel and drawer, the Pending page, and the
 * buttons that would release, promote, submit or change something (docs/api/pending.md "Publishing now"). Fed by
 * `GET /pending/publishing`, read when a screen is shown, when the window comes back and every few seconds while a publish runs (never
 * when none does). When a publish ends (its claim is gone, or the dialog that started it got its answer) what it left is read again:
 * the pending views and the count, the cart of the app, and the app page.
 */
let version = $state(0);
let current: Api | null = null;
/** Runs a person hid in this browser (the server keeps the mark too; this makes it immediate and covers a person who cannot dismiss for everybody). */
let hidden = $state<Record<string, true | undefined>>({});

const loader = createPublishingLoader({
  read: (workspaceId) => {
    if (current === null) return Promise.reject(new Error('no api'));
    return current.pendingPublishing(workspaceId);
  },
  onChange: () => {
    version += 1;
  },
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onFinished: (workspaceId, appIds) => {
    const api = current;
    if (api === null) return;
    void pendingStore.refresh(api, workspaceId, appIds, { submit: true });
    void cartSummaryStore.refresh(api, workspaceId);
    for (const id of appIds) announcePublished(id);
  },
});

export const publishingStore = {
  /** The publish running for this app, or null. Reactive. */
  of(workspaceId: string, appId: string): PublishingEntry | null {
    void version;
    return loader.of(workspaceId, appId);
  },
  isPublishing(workspaceId: string, appId: string): boolean {
    return publishingStore.of(workspaceId, appId) !== null;
  },
  /** Whether any of these apps is publishing. */
  anyOf(workspaceId: string, appIds: readonly string[]): boolean {
    return appIds.some((id) => publishingStore.of(workspaceId, id) !== null);
  },
  /** The app ids of the workspace that are publishing. Reactive. */
  ids(workspaceId: string): string[] {
    void version;
    return loader.ids(workspaceId);
  },
  /** The tooltip for a button that is off because this app is publishing; '' when it is not. */
  reason(workspaceId: string, appId: string, now: number = Date.now()): string {
    const p = publishingStore.of(workspaceId, appId);
    return p === null ? '' : disabledReason(p, now);
  },
  /** A screen that needs the answer is shown: returns what to call when it goes away. */
  watch(api: Api, workspaceId: string): () => void {
    current = api;
    return loader.start(workspaceId);
  },
  /** Read once now (the window came back, a dialog closed). */
  refresh(api: Api, workspaceId: string): Promise<void> {
    current = api;
    return loader.refresh(workspaceId);
  },
  /** "Still running? Check status": read the server's claim now (a publish that is gone leaves the screens by itself). */
  recheck(workspaceId: string): Promise<void> {
    return loader.refresh(workspaceId);
  },
  /**
   * "Mark as interrupted": ask the server to end a claim that went silent or has run too long. The server decides (`still_running`
   * when the publish is alive and recent: nothing is stopped), and the screens read again whatever the answer.
   */
  async interrupt(
    workspaceId: string,
    appId: string,
  ): Promise<'ended' | 'still_running' | 'not_publishing' | 'failed'> {
    const api = current;
    if (api === null) return 'failed';
    let answer: 'ended' | 'still_running' | 'not_publishing' | 'failed' = 'ended';
    try {
      await api.interruptPublish(workspaceId, appId);
    } catch (e) {
      answer =
        e instanceof ApiError && e.status === 409 && e.code === 'still_running'
          ? 'still_running'
          : e instanceof ApiError && e.status === 404
            ? 'not_publishing'
            : 'failed';
    }
    await loader.refresh(workspaceId);
    return answer;
  },
  /** This browser sent a publish: shown at once, confirmed by the server's claim. */
  started(api: Api, workspaceId: string, appId: string, steps: readonly PublishStepType[]): void {
    current = api;
    loader.noteResult(workspaceId, appId, null);
    loader.mark(workspaceId, appId, steps);
    void loader.refresh(workspaceId);
  },
  /** The answer of that publish arrived, whatever it was: what it left is read again. `run` is the run the server kept, when it sent one. */
  answered(api: Api, workspaceId: string, appId: string, run: LastPublish | null): void {
    current = api;
    loader.noteResult(workspaceId, appId, run);
    loader.settle(workspaceId, appId);
    void loader.refresh(workspaceId);
  },
  /** The latest publish of this app that did not go through and nobody hid; its reason is in `results`. Reactive. */
  failureOf(workspaceId: string, appId: string): LastPublish | null {
    void version;
    const run = loader.failedOf(workspaceId, appId);
    return run === null || run.dismissed || hidden[run.id] ? null : run;
  },
  /** The apps of the workspace with a failure to show (not hidden, not publishing again). Reactive. */
  failedIds(workspaceId: string): string[] {
    void version;
    return loader
      .failedIds(workspaceId)
      .filter((id) => publishingStore.failureOf(workspaceId, id) !== null);
  },
  /** Hides this failure now and tells the server (so it stays hidden after a reload and in other browsers until a newer run). */
  dismissFailure(api: Api, workspaceId: string, appId: string): void {
    const run = loader.failedOf(workspaceId, appId);
    if (run === null) return;
    hidden[run.id] = true;
    void api.dismissPublishRun(workspaceId, appId, run.id).catch(() => undefined);
  },
};
