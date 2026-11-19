<!--
  Workflows: the workspace view of GitHub Actions. Every connected repository's workflows in one dense
  list (the workflows that look like build or release workflows first inside each repository) with the
  state of their last run and a Run button, the runs going now on top, and filters for the repository
  and for the state of the last run. It uses the same pieces as the Workflows page of an app:
  WorkflowsList, RunningNow, RunDrawer and the DispatchDialog (inputs first, then a confirmation).
  Runs are read from our own table; "Running now" asks GitHub and tells this list when a run starts or
  ends, so the list re-reads then. A repository that cannot be read is one quiet pill, not an error.
  At most 25 repositories are read, four at a time.
  Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
    import { repositoryName } from '../lib/repositories.ts';
  import type { ActiveRuns, AppSummary, CiWorkflow, RepositorySummary, WorkflowRun } from '../lib/types.ts';
  import {
    type RepoRef,
    type StatusFilter,
    filterRows,
    isStatusFilter,
    rankWorkflows,
    readProblemLabel,
    rowsOf,
    sortRows,
    statusFilters,
    workflowsFromRuns,
  } from '../lib/workflows.ts';
  import type { WorkflowRow } from '../lib/workflows.ts';
  import { dispatchTarget } from '../lib/dispatch-target.ts';
  import DispatchDialog from './ci/DispatchDialog.svelte';
  import RunDrawer from './ci/RunDrawer.svelte';
  import RunningNow from './ci/RunningNow.svelte';
  import WorkflowsList from './ci/WorkflowsList.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Skeleton from './ui/Skeleton.svelte';
  import StatusPill from './ui/StatusPill.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'repositories.read'));
  const canScan = $derived(can(role, 'repositories.scan'));
  const canDispatch = $derived(can(role, 'ci.dispatch'));

  const MAX_REPOSITORIES = 25;
  const CONCURRENCY = 4;

  type RepoData = {
    repository: RepositorySummary;
    workflows: CiWorkflow[] | null;
    runs: WorkflowRun[];
    configured: string[];
    appIds: string[];
    problem: string | null;
  };

  let loading = $state(true);
  let loadError = $state('');
  let repositories = $state<RepositorySummary[]>([]);
  let data = $state<Record<string, RepoData | undefined>>({});
  let apps = $state<AppSummary[]>([]);
  let actors = $state<Record<string, string | null | undefined>>({});
  let repositoryId = $state('');
  let status = $state<StatusFilter>('all');
  let now = $state(Date.now());
  let refreshing = $state(false);
  let announcement = $state('');
  let dispatchRow = $state<WorkflowRow | null>(null);
  let followed = $state<{ id: string; repositoryId: string } | null>(null);
  let drawerOpen = $state(false);
  let generation = 0;
  let lastSignature: string | null = null;

  const github = $derived(repositories.filter((r) => !r.localOnly && r.owner !== null && r.repo !== null));
  const shown = $derived(repositoryId === '' ? github : github.filter((r) => r.id === repositoryId));

  /** Runs `work` for every item, `CONCURRENCY` at a time. */
  async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await work(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
  }

  async function readRepository(mine: number, repository: RepositorySummary, all: AppSummary[]): Promise<void> {
    const ws = workspaceId;
    let problem: string | null = null;
    const note = (e: unknown) => {
      if (problem === null) problem = e instanceof ApiError ? `${readProblemLabel(e.code, e.status)}: ${e.message}` : 'Could not be read.';
    };
    const [workflows, runs, configured] = await Promise.all([
      canScan
        ? api
            .workflows(ws, repository.id)
            .then((r) => r.workflows)
            .catch((e: unknown) => {
              note(e);
              return null;
            })
        : Promise.resolve<CiWorkflow[] | null>(null),
      api
        .workflowRuns(ws, repository.id, { limit: 100 })
        .then((r) => r.runs)
        .catch((e: unknown) => {
          note(e);
          return null;
        }),
      api
        .buildConventions(ws, repository.id)
        .then((v) => (v.effective.workflow ? [v.effective.workflow] : []))
        .catch(() => [] as string[]),
    ]);
    if (mine !== generation) return;
    const previous = untrack(() => data[repository.id]);
    data[repository.id] = {
      repository,
      workflows: workflows ?? previous?.workflows ?? null,
      runs: runs ?? previous?.runs ?? [],
      configured,
      appIds: all.filter((a) => a.repositoryId === repository.id).map((a) => a.id),
      problem,
    };
  }

  async function load() {
    const mine = ++generation;
    loading = true;
    loadError = '';
    try {
      const list = (await api.repositories(workspaceId)).repositories;
      if (mine !== generation) return;
      repositories = list;
      const readable = list.filter((r) => !r.localOnly && r.owner !== null && r.repo !== null).slice(0, MAX_REPOSITORIES);
      let all: AppSummary[] = [];
      if (can(role, 'apps.read')) {
        try {
          all = (await api.apps(workspaceId)).apps;
        } catch {
          all = [];
        }
        if (mine !== generation) return;
      }
      apps = all;
      await inBatches(readable, (r) => readRepository(mine, r, all));
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      loadError = e instanceof ApiError ? e.message : 'Could not load the workflows.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  /** Reads only the stored runs again (no GitHub call from here): after the live feed saw a run start or end. */
  async function rereadRuns() {
    const mine = generation;
    await inBatches(github.slice(0, MAX_REPOSITORIES), async (r) => {
      try {
        const read = await api.workflowRuns(workspaceId, r.id, { limit: 100 });
        const current = untrack(() => data[r.id]);
        if (mine === generation && current) data[r.id] = { ...current, runs: read.runs };
      } catch {
        // The next change tries again.
      }
    });
    if (mine === generation) now = Date.now();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    await load();
    refreshing = false;
    announcement = 'Workflows updated.';
  }

  $effect(() => {
    void workspaceId;
    untrack(() => {
      generation++;
      repositories = [];
      data = {};
      actors = {};
      repositoryId = '';
      dispatchRow = null;
      followed = null;
      drawerOpen = false;
      lastSignature = null;
      if (canRead) void load();
      else loading = false;
    });
  });

  // The "x ago" times move on without a read.
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  function liveData(d: ActiveRuns) {
    const next: Record<string, string | null> = {};
    for (const r of [...d.runs, ...d.recent]) next[`${r.repositoryId}/${r.id}`] = r.actor;
    actors = { ...actors, ...next };
    const signature = [...d.runs.map((r) => `${r.repositoryId}/${r.id}:${r.status}`), '|', ...d.recent.map((r) => `${r.repositoryId}/${r.id}`)].join(',');
    const changed = lastSignature !== null && signature !== lastSignature;
    lastSignature = signature;
    if (changed) void rereadRuns();
  }

  const rows = $derived.by<WorkflowRow[]>(() => {
    const out: WorkflowRow[] = [];
    for (const repository of shown) {
      const d = data[repository.id];
      if (!d) continue;
      const listed = canScan ? (d.workflows ?? []) : workflowsFromRuns(d.runs);
      const ref: RepoRef = {
        id: repository.id,
        owner: repository.owner,
        repo: repository.repo,
        name: repositoryName(repository),
        defaultBranch: repository.defaultBranch,
      };
      out.push(...rowsOf(ref, rankWorkflows(listed, { configured: d.configured, appIds: d.appIds, runs: d.runs }), d.runs));
    }
    return sortRows(out);
  });
  const filtered = $derived(filterRows(rows, { repositoryId: '', status }));
  const problems = $derived(
    shown
      .map((r) => ({ name: repositoryName(r), problem: data[r.id]?.problem ?? null }))
      .filter((p): p is { name: string; problem: string } => p.problem !== null),
  );

  const followedRun = $derived.by<WorkflowRun | null>(() => {
    if (!followed) return null;
    const d = data[followed.repositoryId];
    return d?.runs.find((r) => r.id === followed?.id) ?? null;
  });
  const followedRepository = $derived(followed ? (github.find((r) => r.id === followed?.repositoryId) ?? null) : null);

  function follow(run: WorkflowRun, row: WorkflowRow) {
    followed = { id: run.id, repositoryId: row.repository.id };
    drawerOpen = true;
  }

  function dispatched(run: WorkflowRun) {
    const d = data[run.repositoryId];
    if (d) data[run.repositoryId] = { ...d, runs: [run, ...d.runs.filter((r) => r.id !== run.id)] };
    announcement = `Started ${run.workflow}.`;
    if (!run.id.startsWith('pending-')) {
      followed = { id: run.id, repositoryId: run.repositoryId };
      drawerOpen = true;
    }
  }

  const dispatchRepository = $derived(dispatchRow ? (github.find((r) => r.id === dispatchRow?.repository.id) ?? null) : null);
</script>

<section>
  <PageHeader title="Workflows" description="The GitHub Actions workflows of every connected repository, and the runs going now.">
    {#snippet actions()}
      {#if canRead && github.length > 0}
        <Button icon="refresh" loading={refreshing} onclick={refresh}>Refresh</Button>
      {/if}
    {/snippet}
  </PageHeader>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if !canRead}
    <Alert tone="info">Your role does not include repositories.</Alert>
  {:else if loadError}
    <div class="stack">
      <Alert tone="error" title="Could not load the workflows">{loadError}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if loading && repositories.length === 0}
    <div class="card" role="status" aria-label="Loading the workflows">
      <div class="stack">
        <Skeleton width="60%" height="16px" />
        <Skeleton width="45%" height="16px" />
        <Skeleton width="52%" height="16px" />
      </div>
    </div>
  {:else if github.length === 0}
    <div class="card">
      <EmptyState
        icon="play"
        title="No GitHub repositories"
        description="Workflows come from the GitHub repositories connected to this workspace. A local folder has no GitHub Actions."
      >
        {#snippet actions()}<Button href="#/repositories" variant="primary">Open repositories</Button>{/snippet}
      </EmptyState>
    </div>
  {:else}
    <RunningNow
      {api}
      {workspaceId}
      repositoryIds={shown.slice(0, MAX_REPOSITORIES).map((r) => r.id)}
      {apps}
      stateKey="ci.running.recent.workspace"
      ondata={liveData}
    />

    <div class="stack">
      <div class="row filters">
        <div class="field">
          <label for="wf-repo">Repository</label>
          <select id="wf-repo" bind:value={repositoryId}>
            <option value="">All repositories ({github.length})</option>
            {#each github as r (r.id)}<option value={r.id}>{repositoryName(r)}</option>{/each}
          </select>
        </div>
        <div class="field">
          <label for="wf-status">Status</label>
          <select
            id="wf-status"
            value={status}
            onchange={(e) => {
              const v = e.currentTarget.value;
              if (isStatusFilter(v)) status = v;
            }}
          >
            {#each statusFilters as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
          </select>
        </div>
        <p class="muted text-sm count" role="status">
          {filtered.length === rows.length
            ? `${rows.length} workflow${rows.length === 1 ? '' : 's'}`
            : `${filtered.length} of ${rows.length} workflows`}
        </p>
      </div>

      {#if problems.length > 0}
        <StatusPill
          tone="warn"
          label={problems.length === 1 ? `Workflows of ${problems[0]?.name} cannot be read` : `Workflows of ${problems.length} repositories cannot be read`}
        >
          <ul class="plain">{#each problems as p (p.name)}<li>{p.name}: {p.problem}</li>{/each}</ul>
        </StatusPill>
      {/if}
      {#if !canScan}
        <p class="muted text-sm">Listing and starting workflows asks GitHub, which needs the member or admin role. The workflows below are the ones the stored runs came from.</p>
      {:else if !canDispatch}
        <p class="muted text-sm">Starting a workflow needs the member or admin role.</p>
      {/if}

      <div class="card flush">
        {#if filtered.length === 0}
          <EmptyState
            icon="play"
            title={rows.length === 0 ? (loading ? 'Reading the workflows' : 'No workflows') : 'No workflow matches'}
            description={rows.length === 0
              ? 'The selected repositories have no GitHub Actions workflows that could be read.'
              : 'Change the repository or the status to see more.'}
          />
        {:else}
          <WorkflowsList
            rows={filtered}
            {now}
            {canDispatch}
            showRepository
            {actors}
            onrun={(row) => (dispatchRow = row)}
            onfollow={follow}
          />
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if followedRun && followedRepository}
  <RunDrawer
    bind:open={drawerOpen}
    {api}
    {workspaceId}
    run={followedRun}
    repository={followedRepository}
    actor={actors[`${followedRun.repositoryId}/${followedRun.id}`] ?? null}
    {now}
  />
{/if}

{#if dispatchRow && dispatchRepository}
  <DispatchDialog
    {api}
    {workspaceId}
    target={dispatchTarget({ repository: dispatchRepository, workflow: dispatchRow.entry.workflow, platforms: dispatchRow.entry.platforms })}
    onclose={() => (dispatchRow = null)}
    ondispatched={dispatched}
  />
{/if}

<style>
  .filters {
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .filters .field {
    min-width: 200px;
  }

  .count {
    margin: 0 0 var(--space-2);
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }
</style>
