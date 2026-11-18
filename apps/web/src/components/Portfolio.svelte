<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { tick, untrack } from 'svelte';
  import type { Api } from '../lib/api.ts';
  import {
    type BatchResult,
    type ReleaseLoad,
    batchSummary,
    describeError,
    notRunMessage,
    parseRoute,
    runLimited,
    sortApps,
    syncApp,
    syncDetail,
    syncSummaryText,
  } from '../lib/portfolio.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import type { AppSummary } from '../lib/types.ts';
  import AddAppModal from './portfolio/AddAppModal.svelte';
  import AppDetail from './portfolio/AppDetail.svelte';
  import AppTable from './portfolio/AppTable.svelte';
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

  /** How many apps load their releases at once for the list. */
  const LOAD_PARALLEL = 4;

  // `#/portfolio` is the list, `#/portfolio/<id>` an app. The shell keeps this screen mounted for both.
  let route = $state(parseRoute(location.hash));
  let apps = $state<AppSummary[] | null>(null);
  let error = $state('');
  let releases = $state<Record<string, ReleaseLoad | undefined>>({});
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
  const batchRunning = $derived(batch?.running === true);
  const busy = $derived(batchRunning || Object.values(syncing).some(Boolean));

  $effect(() => {
    const onhash = () => {
      const next = parseRoute(location.hash);
      if (route.name === 'app' && next.name === 'list') returnTo = route.id;
      route = next;
    };
    window.addEventListener('hashchange', onhash);
    return () => window.removeEventListener('hashchange', onhash);
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

  async function load() {
    const mine = ++generation;
    error = '';
    try {
      const list = (await api.apps(workspaceId)).apps;
      if (mine !== generation) return;
      apps = list;
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
      batch = null;
      syncing = {};
      error = '';
    });
  });

  // Load when the workspace changes, and again whenever the list comes back into view, because
  // an app screen may have synced or deleted something.
  $effect(() => {
    void workspaceId;
    const onList = route.name === 'list';
    if (!canRead || !onList) return;
    untrack(() => {
      void load();
    });
  });

  // Back from an app: put focus on its link in the list.
  $effect(() => {
    if (route.name !== 'list' || !returnTo || apps === null) return;
    const id = returnTo;
    returnTo = '';
    void tick().then(() => document.getElementById(`app-open-${id}`)?.focus());
  });

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
      toast.success(syncSummaryText(outcome.app.name, outcome.sync));
    } else {
      // The failure is stored on the app, and the server sends the app back with it.
      if (outcome.app) patch(outcome.app);
      toast.error(`${app.name}: ${outcome.failure.message}`);
    }
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
      results: targets.map((a) => ({ appId: a.id, name: a.name, status: 'pending', message: '' })),
    };
    batch = run;
    // The reactive copy of `run`: changes made through it show on screen.
    const state = batch as Batch;
    const workspace = workspaceId;

    /** Marks every result from `from` on as not run, with the reason. */
    const skipRest = (from: number, message: string) => {
      for (let j = from; j < state.results.length; j++) {
        const result = state.results[j] as BatchResult;
        result.status = 'skipped';
        result.message = message;
      }
      state.done = state.total;
    };

    for (let i = 0; i < targets.length; i++) {
      const app = targets[i] as AppSummary;
      const result = state.results[i] as BatchResult;
      if (state.stopRequested) {
        skipRest(i, notRunMessage(null));
        break;
      }
      state.current = app.name;
      result.status = 'running';
      const outcome = await syncApp(api, workspace, app.id);
      // The workspace changed or the screen was reset meanwhile: this run is over.
      if (batch !== state) return;
      if (outcome.ok) {
        patch(outcome.app);
        releases[app.id] = { state: 'ready', releases: outcome.releases };
        result.status = 'ok';
        result.message = syncDetail(outcome.sync);
        state.done = i + 1;
        continue;
      }
      if (outcome.app) patch(outcome.app);
      const { failure } = outcome;
      result.status = failure.kind === 'busy' ? 'busy' : 'failed';
      result.message = failure.message;
      state.done = i + 1;
      // Every further request would be refused for the same reason, so stop here.
      if (failure.kind === 'limited' || failure.kind === 'abort') {
        skipRest(i + 1, notRunMessage(failure));
        break;
      }
    }
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
    toast.success(`Added ${app.name}. Reading its releases from the store.`);
    await load();
    if (canSync) await syncOne(app);
  }
</script>

{#if route.name === 'app' && canRead}
  <AppDetail {api} {workspaceId} {role} id={route.id} />
{:else}
  <section>
    <PageHeader
      title="Portfolio"
      description="The apps of this workspace as the stores report them: the latest release of each and where it is in review or rollout. Everything here is read from the stores; nothing is written to them."
    >
      {#snippet actions()}
        {#if canRead && apps !== null && apps.length > 0}
          {#if canSync}
            <Button icon="refresh" loading={batchRunning} disabled={busy && !batchRunning} onclick={() => syncAll(sorted)}>Sync all</Button>
          {/if}
          {#if canWrite}
            <Button variant="primary" icon="plus" onclick={() => (adding = true)}>Add app</Button>
          {/if}
        {/if}
      {/snippet}
    </PageHeader>

    {#if !canRead}
      <Alert tone="info">Your role does not include apps.</Alert>
    {:else if error}
      <div class="stack">
        <Alert tone="error" title="Could not load the apps">{error}</Alert>
        <div><Button icon="refresh" onclick={load}>Try again</Button></div>
      </div>
    {:else if apps === null}
      <div class="card" role="status" aria-label="Loading apps">
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
            title="No apps yet"
            description={canWrite
              ? 'Add an iOS or Android app with a stored App Store Connect or Google Play credential. Adding it does not contact the store; the first sync does.'
              : 'An admin or owner adds apps. Once one is added it appears here, with its latest release.'}
          >
            {#snippet actions()}
              {#if canWrite}
                <Button variant="primary" icon="plus" onclick={() => (adding = true)}>Add app</Button>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        <AppTable apps={sorted} {releases} {now} {canSync} {syncing} locked={busy} onsync={syncOne} />
      {/if}
    {/if}
  </section>

  {#if canWrite}
    <AddAppModal {api} {workspaceId} bind:open={adding} onadded={added} />
  {/if}
{/if}

<style>
  .skeleton-row {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }
</style>
