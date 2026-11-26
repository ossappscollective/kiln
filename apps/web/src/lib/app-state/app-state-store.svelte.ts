import type { Role } from '@kiln/core';
import type { Api } from '../api.ts';
import type { AttentionItem } from '../app-attention.ts';
import type { PlatformScope } from '../app-scope.ts';
import { cartSummaryStore } from '../cart-summary.svelte.ts';
import { pendingRows, type PendingRow, pendingTotals } from '../cart-summary.ts';
import { type LastPublish, type PendingLine, staleViewIds } from '../pending.ts';
import type { Publishing } from '../publishing.ts';
import type { PipelineSummary, PipelineSummaryApp } from '../release-pipeline.ts';
import { pendingStore } from '../pending-store.svelte.ts';
import { pipelineStore } from '../pipeline-store.svelte.ts';
import { publishingStore } from '../publishing-store.svelte.ts';
import { onStagedChanged } from '../staged-sync.ts';
import type { AppSummary, ReleaseSummary } from '../types.ts';
import { activeFailure, deriveAppState, deriveTopBar, promoteOfferFor } from './derive.ts';
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

/** The pending line of an app for a chip or a badge: the count, what blocks, what only waits for the store, and whether the last publish failed. */
export type AppLine = PendingLine & { failed: boolean };

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

/** A record as small screens know it (a button only has the id, the name and the platform). */
export type RecordRef = Pick<AppSummary, 'id' | 'name' | 'platform'> & Partial<AppSummary>;

function asRecord(app: RecordRef): AppSummary {
  return {
    identifier: '',
    storeAppId: null,
    credentialId: '',
    repositoryId: null,
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncAttemptAt: null,
    lastSyncError: null,
    ...app,
  };
}

/** The app that is open (AppShell registers it): the top bar button reads its state, scoped like the page. */
type OpenApp = {
  workspaceId: string;
  role: Role;
  records: readonly AppSummary[];
  scope: PlatformScope;
  /** The Pending page itself is open: it is the review, so the button does not repeat "N pending" there (a publish or a failure still shows). */
  onPendingPage: boolean;
};
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
  verdict(workspaceId: string, role: Role, app: RecordRef, action: GuardedAction): Verdict {
    const siblings =
      open !== null && open.workspaceId === workspaceId && open.records.some((r) => r.id === app.id) ? open.records : [asRecord(app)];
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

  /**
   * The pending line of an app (the chips, the badges): the same count as everywhere, and whether its last publish failed. Null when
   * the count is not read, or nothing waits and nothing failed.
   */
  lineOf(workspaceId: string, appIds: readonly string[]): AppLine | null {
    const line = lineOfRecords(sourcesOf(workspaceId), appIds);
    const failed = appIds.some((id) => activeFailure(publishingStore.failureOf(workspaceId, id), publishingStore.of(workspaceId, id)) !== null);
    if (line === null && !failed) return null;
    return { count: line?.count ?? 0, blocking: line?.blocking ?? 0, waiting: line?.waiting ?? 0, failed };
  },

  /** Whether the pending count of the workspace was read (a screen that says "nothing" asks first). */
  pendingKnown(workspaceId: string): boolean {
    return cartSummaryStore.summaryOf(workspaceId) !== null;
  },

  /** The "Pending" entry of the navigation and the Pending overview: the changes and the apps that hold them; null while not read. */
  workspaceTotals(workspaceId: string, apps: readonly AppSummary[] | null): { changes: number; apps: number } | null {
    const cart = cartSummaryStore.summaryOf(workspaceId);
    return pendingTotals(pendingRows(cart, apps), cart);
  },

  /** The rows of the Pending overview: one per product, the records merged, the most pending first. */
  workspaceRows(workspaceId: string, apps: readonly AppSummary[] | null): PendingRow[] {
    return pendingRows(cartSummaryStore.summaryOf(workspaceId), apps);
  },

  /** The apps of the workspace that publish right now (the claims), with the app they belong to. */
  workspacePublishing(workspaceId: string, apps: readonly AppSummary[] | null): { app: AppSummary; entry: Publishing }[] {
    const out: { app: AppSummary; entry: Publishing }[] = [];
    for (const id of publishingStore.ids(workspaceId)) {
      const app = (apps ?? []).find((a) => a.id === id);
      const entry = publishingStore.of(workspaceId, id);
      if (app && entry) out.push({ app, entry });
    }
    return out;
  },

  /** The apps of the workspace whose last publish failed and nobody hid it (an app that publishes again shows its progress instead). */
  workspaceFailures(workspaceId: string, apps: readonly AppSummary[] | null): { app: AppSummary; run: LastPublish }[] {
    const out: { app: AppSummary; run: LastPublish }[] = [];
    for (const id of publishingStore.failedIds(workspaceId)) {
      const app = (apps ?? []).find((a) => a.id === id);
      const run = activeFailure(publishingStore.failureOf(workspaceId, id), publishingStore.of(workspaceId, id));
      if (app && run) out.push({ app, run });
    }
    return out;
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
    const badge = deriveTopBar(state, other);
    return badge.kind === 'pending' && here?.onPendingPage === true ? { kind: 'idle' } : badge;
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

  /** The shell shows another app (or the same one again): the count and what blocks are read unless they are fresh. */
  ensure(api: Api, workspaceId: string): void {
    void cartSummaryStore.ensure(api, workspaceId);
    void pendingStore.loadSummary(api, workspaceId);
  },

  /** The workspace summary of the release pipelines (which releases are left unfinished); null until read. */
  pipelineSummary(workspaceId: string): PipelineSummary | null {
    return pipelineStore.summary(workspaceId);
  },

  /** The apps of that summary (empty until read): what the sidebar badge and the Overview count as "left unfinished". */
  stalledApps(workspaceId: string): PipelineSummaryApp[] {
    return pipelineStore.summary(workspaceId)?.apps ?? [];
  },

  /** Reads the release pipeline summary of the workspace. */
  loadPipelineSummary(api: Api, workspaceId: string): void {
    void pipelineStore.loadSummary(api, workspaceId);
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

  /**
   * The records whose detail read is older than the summary and says something else (the Pending page reads them again, so it never says
   * "Nothing pending" while the count says changes). `key` changes with each summary, so a page reads once per change.
   */
  staleViews(workspaceId: string, appIds: readonly string[]): { key: string; ids: string[] } | null {
    const summary = pendingStore.summary(workspaceId);
    const ids = staleViewIds(summary, appIds, pendingStore.viewsOf(appIds));
    if (ids.length === 0 || summary === null) return null;
    return { key: `${summary.generatedAt}/${ids.join(',')}`, ids };
  },

  /** A person hides the failure of this app (the server keeps the mark): the model returns to changes_pending at once. */
  dismissFailure(api: Api, workspaceId: string, appId: string): void {
    publishingStore.dismissFailure(api, workspaceId, appId);
  },
};
