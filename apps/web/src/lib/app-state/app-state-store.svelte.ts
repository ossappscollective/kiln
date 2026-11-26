import type { Role } from '@kiln/core';
import type { Api } from '../api.ts';
import type { AttentionItem } from '../app-attention.ts';
import type { PlatformScope } from '../app-scope.ts';
import { cartSummaryStore } from '../cart-summary.svelte.ts';
import type { PendingLine } from '../pending.ts';
import { pendingStore } from '../pending-store.svelte.ts';
import { pipelineStore } from '../pipeline-store.svelte.ts';
import { publishingStore } from '../publishing-store.svelte.ts';
import { onStagedChanged } from '../staged-sync.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import { deriveAppState, deriveTopBar, promoteOfferFor } from './derive.ts';
import { assembleFacts, type FactSources, lineOfRecords } from './facts.ts';
import type { AppFacts, AppState, GuardedAction, Promotion, TopBarBadge, Verdict } from './types.ts';

/**
 * The ONE store of what is true about an app (docs/state-model.md). It reads the facts once per workspace (the cart summary for the count,
 * the pending summary for what blocks, the publishing claims and the last run that did not complete, the release pipelines, the batch
 * switch) through the stores that already know how to read them, and exposes `of(...)`: the state derived by `deriveAppState`.
 * Every screen asks this and nothing else: no component computes a pending count, a "publishing" flag, the next step or the enabled
 * state of an action that depends on them (`wiring.test.ts` fails the build when one does).
 *
 * Refreshed on the same triggers as before: the window comes back, something was staged, discarded or published (`kiln:staged-changed`),
 * every few seconds while a publish runs (the claims' own poll), and when a mutation says it is done (`refresh`).
 */

/** What `of` needs from the screen: who is asking, for which records, in which platform scope, and what only the page has loaded. */
export type StateInput = {
  workspaceId: string;
  role: Role;
  /** Every platform record of the app. */
  records: readonly AppSummary[];
  scope?: PlatformScope | undefined;
  /** The releases the page loaded, by record id (what can be promoted). */
  releases?: Readonly<Record<string, readonly ReleaseSummary[] | undefined>> | undefined;
  /** The rest of "Needs attention" (the Overview builds it from its own reads). */
  attention?: readonly AttentionItem[] | undefined;
  now?: number | undefined;
};

/** The app that is open (AppShell registers it): the top bar button reads its state, scoped like the page. */
type OpenApp = { workspaceId: string; role: Role; records: readonly AppSummary[]; scope: PlatformScope };
let open = $state<OpenApp | null>(null);

function sourcesOf(workspaceId: string): FactSources {
  return {
    cart: cartSummaryStore.summaryOf(workspaceId),
    pendingSummary: pendingStore.summary(workspaceId),
    publishing: (appId) => publishingStore.of(workspaceId, appId),
    failure: (appId) => publishingStore.failureOf(workspaceId, appId),
    pipeline: (appId) => pipelineStore.app(appId),
    publishBatchEnabled: pendingStore.config(workspaceId)?.enabled ?? null,
  };
}

function factsOf(input: StateInput): AppFacts {
  return assembleFacts(
    { role: input.role, records: input.records, releases: input.releases, attention: input.attention, now: input.now ?? Date.now() },
    sourcesOf(input.workspaceId),
  );
}

export const appStateStore = {
  /** The state of the app, derived from the facts. Reactive: it changes when any fact the stores hold changes. */
  of(input: StateInput): AppState {
    return deriveAppState(factsOf(input), input.scope ?? 'both');
  },

  /**
   * The verdict of one action for ONE record (a button of a release step, the submit control, the rollout buttons asks this and nothing
   * else). The siblings of the record come from the open app, so a publish on another platform of the app holds the button back too.
   */
  verdict(workspaceId: string, role: Role, app: AppSummary, action: GuardedAction): Verdict {
    const siblings = open !== null && open.workspaceId === workspaceId && open.records.some((r) => r.id === app.id) ? open.records : [app];
    return appStateStore.of({ workspaceId, role, records: siblings, scope: app.platform }).canDo(action, app.platform);
  },

  /** What a release of a table row offers: "Promote to production" with its verdict, or null (not promotable, or no right). */
  promoteFor(
    workspaceId: string,
    role: Role,
    app: AppSummary,
    release: ReleaseSummary,
    siblings: readonly ReleaseSummary[],
  ): Promotion | null {
    const records = open !== null && open.workspaceId === workspaceId && open.records.some((r) => r.id === app.id) ? open.records : [app];
    return promoteOfferFor(appStateStore.of({ workspaceId, role, records, scope: app.platform }), role, release, siblings);
  },

  /** The pending line of an app (the chips, the badges): the same count as everywhere. Null when not read or nothing waits. */
  lineOf(workspaceId: string, appIds: readonly string[]): PendingLine | null {
    return lineOfRecords(sourcesOf(workspaceId), appIds);
  },

  /** The pending changes of the whole workspace, as the "Pending" entry of the navigation counts them; null while not read. */
  workspaceChanges(workspaceId: string): number | null {
    const cart = cartSummaryStore.summaryOf(workspaceId);
    return cart === null ? null : cart.apps.reduce((n, line) => n + (Number.isFinite(line.count) && line.count > 0 ? Math.floor(line.count) : 0), 0);
  },

  /** The apps of the workspace that publish right now (the claims). */
  publishingIds(workspaceId: string): string[] {
    return publishingStore.ids(workspaceId);
  },

  // ---- The top bar --------------------------------------------------------------------------

  /** The app that is open, as the page shows it (AppShell registers it and clears it when it goes away). */
  setOpenApp(app: OpenApp | null): void {
    open = app;
  },

  /** What the top bar shows: the open app's state (in the page's scope), or a publish that runs anywhere in the workspace. */
  topBar(workspaceId: string): TopBarBadge {
    const here = open !== null && open.workspaceId === workspaceId ? open : null;
    const state = here === null ? null : appStateStore.of({ workspaceId, role: here.role, records: here.records, scope: here.scope });
    const mine = here === null ? [] : here.records.map((r) => r.id);
    const other = publishingStore.ids(workspaceId).find((id) => mine.indexOf(id) < 0) ?? null;
    return deriveTopBar(state, other);
  },

  // ---- Reading ------------------------------------------------------------------------------

  /**
   * A screen that needs the facts is shown (the shell): reads them and keeps them true. Returns what to call when it goes away.
   */
  watch(api: Api, workspaceId: string): () => void {
    void cartSummaryStore.ensure(api, workspaceId);
    void pendingStore.loadSummary(api, workspaceId);
    void pendingStore.loadConfig(api, workspaceId);
    const releaseClaims = publishingStore.watch(api, workspaceId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offStaged = onStagedChanged(() => {
      cartSummaryStore.request(api, workspaceId);
      // What blocks is read once for a burst of changes, a little after the count.
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void pendingStore.loadSummary(api, workspaceId);
      }, 600);
    });
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      void cartSummaryStore.ensure(api, workspaceId);
      void publishingStore.refresh(api, workspaceId);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      releaseClaims();
      offStaged();
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  },

  /** The release pipelines of these records (the next step is built from them). A finished sync passes `force`. */
  loadPipelines(api: Api, workspaceId: string, appIds: readonly string[], force = false): void {
    for (const id of appIds) void pipelineStore.loadApp(api, workspaceId, id, force);
  },

  /** A mutation is done (published, discarded, a sync ended): every fact is read again, once. */
  async refresh(api: Api, workspaceId: string, appIds: readonly string[] = []): Promise<void> {
    await Promise.all([
      cartSummaryStore.refresh(api, workspaceId),
      pendingStore.loadSummary(api, workspaceId),
      publishingStore.refresh(api, workspaceId),
      ...appIds.map((id) => pipelineStore.loadApp(api, workspaceId, id, true)),
    ]);
  },

  // ---- Writing the one thing screens may tell the store ------------------------------------

  /** A person hides the failure of this app (the server keeps the mark): the model returns to changes_pending at once. */
  dismissFailure(api: Api, workspaceId: string, appId: string): void {
    publishingStore.dismissFailure(api, workspaceId, appId);
  },
};
