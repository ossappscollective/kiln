<script lang="ts">
  import { t } from '../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { tick, untrack } from 'svelte';
  import type { Api } from '../lib/api.ts';
  import { address } from '../lib/address.svelte.ts';
  import { type AppGroup, groupApps, groupOf } from '../lib/app-groups.ts';
  import { buildOverviewRows, overviewStats } from '../lib/app-overview.ts';
  import { attentionCount, unansweredCount } from '../lib/nav-badges.ts';
  import { navSignals } from '../lib/nav-signals.svelte.ts';
  import { appStateStore } from '../lib/app-state/app-state-store.svelte.ts';
  import { type ViewMode, readViewMode, saveViewMode } from '../lib/dashboard.ts';
  import {
    type BatchResult,
    type ReleaseLoad,
    appLabel,
    batchSummary,
    describeError,
    notRunMessage,
    runLimited,
    sortApps,
    syncApp,
    syncDetail,
    syncSummaryText,
  } from '../lib/portfolio.ts';
  import type { WorkspaceReviewsSummary } from '../lib/reviews/reviews.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import type { AppSummary, ReleaseSummary } from '../lib/types.ts';
  import RunningNow from './ci/RunningNow.svelte';
  import Board from './dashboard/Board.svelte';
  import ViewToggle from './dashboard/ViewToggle.svelte';
  import AppShell from './app/AppShell.svelte';
  import ConnectBanner from './connect/ConnectBanner.svelte';
  import AddAppModal from './portfolio/AddAppModal.svelte';
  import AppsOverview from './portfolio/AppsOverview.svelte';
  import OverviewStats from './portfolio/OverviewStats.svelte';
  import SyncActivity from './portfolio/SyncActivity.svelte';
  import SyncAllPanel from './portfolio/SyncAllPanel.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Skeleton from './ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'apps.read'));
  const canWrite = $derived(can(role, 'apps.write'));
  const canSync = $derived(can(role, 'apps.sync'));
  /** Running workflows of every connected repository: stored runs for everybody who may read repositories. */
  const canSeeRuns = $derived(can(role, 'repositories.read'));

  /** How many apps load their releases at once for the list. */
  const LOAD_PARALLEL = 4;
  /** Apps synced at once by Sync all. */
  const SYNC_PARALLEL = 3;

  // `#/portfolio` is the overview of all apps, `#/portfolio/<id>/...` one app (components/app/). The
  // shell keeps this screen mounted for both; the address says which.
  const open = $derived(address.app);
  /** List or board, remembered in this browser. */
  let viewMode = $state<ViewMode>(readViewMode());
  let apps = $state<AppSummary[] | null>(null);
  let error = $state('');
  let releases = $state<Record<string, ReleaseLoad | undefined>>({});
  /** Review counts per app for the overview, or null when not loaded or not allowed. */
  let reviewSummary = $state<WorkspaceReviewsSummary | null>(null);
  let syncing = $state<Record<string, boolean | undefined>>({});
  let adding = $state(false);
  let now = $state(Date.now());
  /** The app that was open before going back to the list, so focus can return to its link. */
  let returnTo = '';

  type Batch = {
    running: boolean;
    stopRequested: boolean;
    total: number;
    done: number;
    current: string;
    results: BatchResult[];
  };
  let batch = $state<Batch | null>(null);

  const sorted = $derived(apps ? sortApps(apps) : []);
  const groups = $derived(groupApps(apps ?? []));
  const releaseLists = $derived(
    Object.keys(releases).reduce<Record<string, ReleaseSummary[]>>((acc, id) => {
      const load = releases[id];
      if (load?.state === 'ready') acc[id] = load.releases;
      return acc;
    }, {}),
  );
  // A release left unfinished that is only a version or a build left behind by what is live is not news (the model decides, from the same facts).
  const pipelineApps = $derived(appStateStore.pipelineSummary(workspaceId) === null ? null : appStateStore.stalledApps(workspaceId, releaseLists));
  const rows = $derived(buildOverviewRows(groups, releases, reviewSummary?.apps ?? null, pipelineApps, (appIds) => appStateStore.lineOf(workspaceId, appIds)));
  const stats = $derived(overviewStats(rows));
  const batchRunning = $derived(batch?.running === true);
  const busy = $derived(batchRunning || Object.values(syncing).some(Boolean));

  // What the sidebar counts: apps that need attention (once every release of the list has loaded) and the
  // unanswered reviews (when the summary has the field). Nothing is read for this.
  $effect(() => {
    const space = workspaceId;
    const settled = apps !== null && rows.every((r) => [r.ios, r.macos, r.android].every((c) => c === null || c.state !== 'loading'));
    if (settled) navSignals.setAttention(space, attentionCount(rows));
  });
  $effect(() => {
    if (reviewSummary) {
      navSignals.setUnanswered(workspaceId, unansweredCount(reviewSummary));
      // The per-app counts for the sidebar of an open app.
      const counts: Record<string, number> = {};
      for (const a of reviewSummary.apps) counts[a.app.id] = a.unanswered;
      navSignals.setUnansweredByApp(workspaceId, counts);
    }
  });

  // Going back from an app to the overview remembers the app, so focus can return to its link.
  let wasOpen = '';
  $effect(() => {
    const id = open?.id ?? '';
    if (wasOpen && !id) returnTo = wasOpen;
    wasOpen = id;
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  /** Ignores answers that arrive after the workspace changed or a newer load began. */
  let generation = 0;

  async function loadReleases(list: AppSummary[], mine: number) {
    // Rows that already have releases keep them while they refresh, so the list does not flicker.
    for (const app of list) {
      const known = releases[app.id];
      if (!known || known.state === 'error') releases[app.id] = { state: 'loading' };
    }
    await runLimited(list, LOAD_PARALLEL, async (app) => {
      try {
        const detail = await api.app(workspaceId, app.id);
        if (mine !== generation) return;
        releases[app.id] = { state: 'ready', releases: detail.releases };
        patch(detail.app);
      } catch {
        if (mine === generation) releases[app.id] = { state: 'error' };
      }
    });
  }

  /** The counts are a bonus for the overview: when they cannot be read the columns show a dash. */
  async function loadReviewSummary(mine: number) {
    if (!can(role, 'reviews.read')) return;
    try {
      const summary = await api.workspaceReviewsSummary(workspaceId);
      if (mine === generation) reviewSummary = summary;
    } catch {
      if (mine === generation) reviewSummary = null;
    }
  }

  async function load() {
    const mine = ++generation;
    error = '';
    try {
      const list = (await api.apps(workspaceId)).apps;
      if (mine !== generation) return;
      apps = list;
      navSignals.setApps(workspaceId, list);
      void loadReviewSummary(mine);
      if (canRead) appStateStore.loadPipelineSummary(api, workspaceId);
      if (can(role, 'listing.read')) appStateStore.ensure(api, workspaceId);
      await loadReleases(list, mine);
    } catch (e) {
      if (mine !== generation) return;
      error = describeError(e, 'load');
    }
  }

  // A different workspace starts from nothing. This runs before the load below.
  $effect(() => {
    void workspaceId;
    untrack(() => {
      apps = null;
      releases = {};
      reviewSummary = null;
      batch = null;
      syncing = {};
      error = '';
    });
  });

  // Load when the workspace changes, and again whenever the list comes back into view, because
  // an app screen may have synced or deleted something.
  $effect(() => {
    void workspaceId;
    const onList = open === null;
    if (!canRead || !onList) return;
    untrack(() => {
      void load();
    });
  });

  // Back from an app: put focus on its link in the list.
  $effect(() => {
    if (open !== null || !returnTo || apps === null) return;
    const id = groupOf(groups, returnTo)?.key ?? returnTo;
    returnTo = '';
    void tick().then(() => document.getElementById(`app-open-${id}`)?.focus());
  });

  function setView(mode: ViewMode) {
    viewMode = mode;
    saveViewMode(mode);
  }

  function patch(app: AppSummary) {
    if (apps) apps = apps.map((a) => (a.id === app.id ? app : a));
  }

  async function syncOne(app: AppSummary) {
    if (busy) return;
    syncing[app.id] = true;
    const outcome = await syncApp(api, workspaceId, app.id);
    syncing[app.id] = false;
    now = Date.now();
    if (outcome.ok) {
      patch(outcome.app);
      releases[app.id] = { state: 'ready', releases: outcome.releases };
      void appStateStore.storeRead(api, workspaceId, outcome.app, { announce: true, role });
      toast.success(syncSummaryText(outcome.app.name, outcome.sync));
    } else {
      // The failure is stored on the app, and the server sends the app back with it.
      if (outcome.app) patch(outcome.app);
      toast.error(t('portfolio:page.syncFailed', { name: app.name, message: outcome.failure.message }));
    }
  }

  /** Syncs both records of a merged row, one after the other. */
  async function syncGroup(group: AppGroup) {
    for (const app of group.members) await syncOne(app);
  }

  /** Syncs the apps one after another, so the store sees no burst and the person sees progress. */
  async function syncAll(targets: AppSummary[]) {
    if (busy || targets.length === 0) return;
    const run: Batch = {
      running: true,
      stopRequested: false,
      total: targets.length,
      done: 0,
      current: '',
      results: targets.map((a) => ({ appId: a.id, name: appLabel(a), status: 'pending', message: '' })),
    };
    batch = run;
    // The reactive copy of `run`: changes made through it show on screen.
    const state = batch as Batch;
    const workspace = workspaceId;

    // A few apps at once (the server holds the store requests to its per-host limits and the workspace budget still
    // counts every sync), so a long list is not a queue of one. A refused budget or a lost connection ends the run.
    const running = new Set<string>();
    let stopAll = false;
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const i = next++;
        const app = targets[i] as AppSummary;
        const result = state.results[i] as BatchResult;
        if (state.stopRequested || stopAll) {
          result.status = 'skipped';
          result.message = notRunMessage(null);
          state.done += 1;
          continue;
        }
        running.add(app.name);
        state.current = [...running].join(', ');
        result.status = 'running';
        const outcome = await syncApp(api, workspace, app.id);
        running.delete(app.name);
        state.current = [...running].join(', ');
        // The workspace changed or the screen was reset meanwhile: this run is over.
        if (batch !== state) return;
        if (outcome.ok) {
          patch(outcome.app);
          releases[app.id] = { state: 'ready', releases: outcome.releases };
          void appStateStore.storeRead(api, workspace, outcome.app, { announce: true, role });
          result.status = 'ok';
          result.message = syncDetail(outcome.sync);
          state.done += 1;
          continue;
        }
        if (outcome.app) patch(outcome.app);
        const { failure } = outcome;
        result.status = failure.kind === 'busy' ? 'busy' : 'failed';
        result.message = failure.message;
        state.done += 1;
        // Every further request would be refused for the same reason, so the rest is not run.
        if (failure.kind === 'limited' || failure.kind === 'abort') {
          stopAll = true;
          for (let j = next; j < targets.length; j++) {
            const rest = state.results[j] as BatchResult;
            rest.status = 'skipped';
            rest.message = notRunMessage(failure);
          }
          state.done += targets.length - next;
          next = targets.length;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SYNC_PARALLEL, targets.length) }, worker));
    if (batch !== state) return;
    state.running = false;
    state.current = '';
    now = Date.now();
    const failed = state.results.filter((r) => r.status === 'failed' || r.status === 'skipped' || r.status === 'busy').length;
    const text = batchSummary(state.results);
    if (failed > 0) toast.warning(text);
    else toast.success(text);
  }

  const retryable = $derived(
    batch && !batch.running
      ? sorted.filter((a) => batch?.results.some((r) => r.appId === a.id && (r.status === 'failed' || r.status === 'skipped' || r.status === 'busy')))
      : [],
  );

  async function added(app: AppSummary) {
    toast.success(t('portfolio:page.added', { name: app.name }));
    await load();
    if (canSync) await syncOne(app);
  }
</script>

{#if open && canRead}
  <AppShell {api} {workspaceId} {role} id={open.id} />
{:else}
  <section>
    <PageHeader
      title={t('portfolio:page.title')}
      description={t('portfolio:page.description')}
    >
      {#snippet actions()}
        {#if canRead && apps !== null && apps.length > 0}
          <ViewToggle mode={viewMode} onchange={setView} />
          {#if canSync}
            <Button icon="refresh" loading={batchRunning} disabled={busy && !batchRunning} onclick={() => syncAll(sorted)}>{t('portfolio:batch.title')}</Button>
          {/if}
          {#if canWrite}
            <Button variant="primary" icon="plus" onclick={() => (adding = true)}>{t('portfolio:page.addApp')}</Button>
          {/if}
        {/if}
      {/snippet}
    </PageHeader>
    {#if canRead && apps !== null && apps.length > 0}
      <div class="stats"><OverviewStats {stats} /></div>
    {/if}

    {#if canRead && canWrite && apps !== null && apps.length > 0}
      <div class="stack"><ConnectBanner {api} {workspaceId} {role} {apps} context="portfolio" /></div>
    {/if}

    {#if !canRead}
      <Alert tone="info">{t('portfolio:page.noAccess')}</Alert>
    {:else if error}
      <div class="stack">
        <Alert tone="error" title={t('portfolio:page.loadFailed')}>{error}</Alert>
        <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else if apps === null}
      <div class="card" role="status" aria-label={t('portfolio:page.loading')}>
        <div class="stack">
          {#each [0, 1, 2] as i (i)}
            <div class="skeleton-row">
              <Skeleton width="28px" height="28px" />
              <Skeleton width="{36 - i * 6}%" height="16px" />
              <Skeleton width="96px" height="20px" />
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <SyncActivity {api} {workspaceId} names={Object.fromEntries(apps.map((a) => [a.id, appLabel(a)]))} hint={busy} />

      {#if batch}
        <SyncAllPanel
          running={batch.running}
          total={batch.total}
          done={batch.done}
          current={batch.current}
          results={batch.results}
          summary={batchSummary(batch.results)}
          canRetry={canSync && retryable.length > 0}
          onstop={() => batch && (batch.stopRequested = true)}
          onretry={() => syncAll(retryable)}
          ondismiss={() => (batch = null)}
        />
      {/if}

      {#if apps.length === 0}
        <div class="card">
          <EmptyState
            icon="smartphone"
            title={t('portfolio:page.emptyTitle')}
            description={canWrite
              ? t('portfolio:page.emptyWrite')
              : t('portfolio:page.emptyRead')}
          >
            {#snippet actions()}
              {#if canWrite}
                <Button variant="primary" icon="plus" onclick={() => (adding = true)}>{t('portfolio:page.addApp')}</Button>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        {#if canSeeRuns}
          <RunningNow {api} {workspaceId} {apps} />
        {/if}
        {#if viewMode === 'board'}
          <Board {api} {workspaceId} {role} apps={sorted} {releases} {now} />
        {:else}
          <AppsOverview {rows} {now} {canSync} {syncing} locked={busy} onsync={syncGroup} />
        {/if}
      {/if}
    {/if}
  </section>

  {#if canWrite}
    <AddAppModal {api} {workspaceId} {canSync} bind:open={adding} onadded={added} onchanged={load} />
  {/if}
{/if}

<style>
  .stats {
    margin-bottom: var(--space-5);
  }

  .skeleton-row {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }
</style>
