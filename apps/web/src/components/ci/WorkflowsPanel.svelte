<!--
  WorkflowsPanel: the workflows of one repository for one app, and the runs: a list of the workflows
  with the state of their last run and a Run button (the dispatch dialog shows the inputs before
  anything starts, then a confirmation), and the recent runs with Follow and Jobs. Workflows that
  look like this app's build or release workflows are marked and come first. The platform scope
  (iOS, Android, Both) filters the workflows and runs by what their names say; it never hides
  everything, and one line says what it left out. Runs are read from our own table; Refresh and the
  live follow ask GitHub, which needs the right of a scan. While a run is going and the page is on
  screen the list updates every few seconds; with no active run, or in a hidden tab, nothing polls.
  A role that cannot ask GitHub sees the workflows its runs came from, and no Run button.
  Props: api, workspaceId, repository, role,
  appIds (the records in scope), appPlatforms (every platform of the app), platforms (those in scope),
  scopeLabel ("iOS"), configured (release workflows of the build conventions), showTitle (name the
  repository above, when an app has more than one).
-->
<script lang="ts">
  import { type Platform, type Role, can } from '@mrm/core';
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { POLL_MAX_MS, POLL_MS, hasActiveRun } from '../../lib/ci.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { createPoller } from '../../lib/poll.ts';
  import { repositoryName } from '../../lib/repositories.ts';
  import type { CiWorkflow, RepositorySummary, WorkflowRun } from '../../lib/types.ts';
  import {
    type WorkflowRow,
    filterByPlatform,
    rankWorkflows,
    readProblemLabel,
    rowsOf,
    runHints,
    scopeNote,
    splitRelevant,
    workflowsFromRuns,
  } from '../../lib/workflows.ts';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import { dispatchTarget } from '../../lib/dispatch-target.ts';
  import DispatchDialog from './DispatchDialog.svelte';
  import RunDrawer from './RunDrawer.svelte';
  import RunsTable from './RunsTable.svelte';
  import WorkflowsList from './WorkflowsList.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
    appIds,
    appPlatforms,
    platforms,
    scopeLabel,
    configured,
    showTitle = false,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
    appIds: string[];
    appPlatforms: Platform[];
    platforms: Platform[];
    scopeLabel: string;
    configured: string[];
    showTitle?: boolean;
  } = $props();

  const canScan = $derived(can(role, 'repositories.scan'));
  const canDispatch = $derived(can(role, 'ci.dispatch'));
  const repoId = $derived(repository.id);

  let workflows = $state<CiWorkflow[] | null>(null);
  let workflowsProblem = $state<{ label: string; message: string } | null>(null);
  let runs = $state<WorkflowRun[] | null>(null);
  let runsProblem = $state<{ label: string; message: string } | null>(null);
  let runsWarning = $state('');
  let refreshedAt = $state<number | null>(null);
  let refreshing = $state(false);
  let now = $state(Date.now());
  let dispatchRow = $state<WorkflowRow | null>(null);
  let announcement = $state('');
  let followedId = $state<string | null>(null);
  let drawerOpen = $state(false);
  let showAllPlatforms = $state(false);
  let showOthers = $state(false);
  const followed = $derived(followedId === null ? null : ((runs ?? []).find((r) => r.id === followedId) ?? null));

  /** Ignores a late answer for a repository that is no longer open. */
  let generation = 0;

  const following = $derived(hasActiveRun(runs ?? []));

  const problemOf = (e: unknown, fallback: string) =>
    e instanceof ApiError
      ? { label: readProblemLabel(e.code, e.status), message: e.message }
      : { label: 'Workflows could not be read', message: fallback };

  async function readRuns(refresh: boolean): Promise<boolean> {
    const mine = generation;
    try {
      const read = await api.workflowRuns(workspaceId, repoId, { refresh, limit: 60 });
      if (mine !== generation) return true;
      runs = read.runs;
      if (read.refreshedAt !== null) refreshedAt = read.refreshedAt;
      runsProblem = null;
      runsWarning = '';
      now = Date.now();
      return true;
    } catch (e) {
      if (mine !== generation) return true;
      const problem = problemOf(e, 'Could not load the runs.');
      if (refresh && runs === null) {
        // GitHub is unreachable: show what is stored, and say so.
        const ok = await readRuns(false);
        if (ok && mine === generation) runsWarning = `Could not read GitHub: ${problem.message} Showing the runs stored earlier.`;
        return false;
      }
      if (runs === null) runsProblem = problem;
      else runsWarning = `Could not update from GitHub: ${problem.message}`;
      return false;
    }
  }

  async function readWorkflows() {
    const mine = generation;
    workflowsProblem = null;
    try {
      const read = await api.workflows(workspaceId, repoId);
      if (mine === generation) workflows = read.workflows;
    } catch (e) {
      if (mine !== generation) return;
      workflows = null;
      workflowsProblem = problemOf(e, 'Could not load the workflows.');
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    await Promise.all([readRuns(canScan), canScan ? readWorkflows() : Promise.resolve()]);
    refreshing = false;
    announcement = 'Workflows and runs updated.';
  }

  $effect(() => {
    void repoId;
    void workspaceId;
    untrack(() => {
      const mine = ++generation;
      workflows = null;
      workflowsProblem = null;
      runs = null;
      runsProblem = null;
      runsWarning = '';
      refreshedAt = null;
      dispatchRow = null;
      followedId = null;
      drawerOpen = false;
      // The stored runs show at once; the read from GitHub (slower) follows and updates them.
      void readRuns(false).then(() => {
        if (canScan && mine === generation) void readRuns(true);
      });
      if (canScan) void readWorkflows();
    });
  });

  // Follow the runs while one is going. The poller itself waits while the tab is hidden.
  $effect(() => {
    if (!following) return;
    const poller = createPoller({
      intervalMs: POLL_MS,
      maxIntervalMs: POLL_MAX_MS,
      tick: async () => {
        const ok = await readRuns(untrack(() => canScan));
        if (!ok) throw new Error('The runs could not be read.');
        return untrack(() => hasActiveRun(runs ?? []));
      },
    });
    poller.start();
    return () => poller.stop();
  });

  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  // What is listed: GitHub's workflows, or (without the right to ask) the workflows the stored runs came from.
  const listed = $derived<CiWorkflow[]>(canScan ? (workflows ?? []) : workflowsFromRuns(runs ?? []));
  const ranked = $derived(rankWorkflows(listed, { configured, appIds, runs: runs ?? [] }));
  const scopedWorkflows = $derived(filterByPlatform(ranked, (e) => e.platforms, platforms, appPlatforms));
  const scopedRuns = $derived(filterByPlatform(runs ?? [], runHints, platforms, appPlatforms));
  /** What the scope left out; the toggle brings it back. */
  const leftOut = $derived(scopedWorkflows.hidden.length + scopedRuns.hidden.length);
  const byPlatform = $derived(showAllPlatforms ? { shown: ranked, hidden: [], fellBack: false } : scopedWorkflows);
  const runsByPlatform = $derived(showAllPlatforms ? { shown: runs ?? [], hidden: [], fellBack: false } : scopedRuns);
  const split = $derived(splitRelevant(byPlatform.shown));
  const visibleEntries = $derived(showOthers ? byPlatform.shown : split.shown);
  const rows = $derived(rowsOf(repository, visibleEntries, runs ?? []));
  const note = $derived(
    showAllPlatforms
      ? leftOut > 0
        ? 'Showing the workflows and runs of every platform.'
        : ''
      : [
          scopeNote({ noun: 'workflow', scopeLabel, hidden: scopedWorkflows.hidden.length, fellBack: scopedWorkflows.fellBack }),
          scopedWorkflows.fellBack ? '' : scopeNote({ noun: 'run', scopeLabel, hidden: scopedRuns.hidden.length, fellBack: false }),
        ]
          .filter((t) => t !== '')
          .join(' '),
  );
  const permission = $derived(
    !canScan
      ? 'Listing and starting workflows asks GitHub, which needs the member or admin role. The workflows below are the ones the stored runs came from.'
      : !canDispatch
        ? 'Starting a workflow needs the member or admin role.'
        : '',
  );

  function dispatched(run: WorkflowRun) {
    // The new run is stored on the server already; show it without waiting for the next read.
    runs = [run, ...(runs ?? []).filter((r) => r.id !== run.id)];
    announcement = `Started ${run.workflow}.`;
    if (!run.id.startsWith('pending-')) follow(run);
  }

  function follow(run: WorkflowRun) {
    followedId = run.id;
    drawerOpen = true;
  }
</script>

<div class="stack">
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if showTitle}
    <h2 class="repo">{repositoryName(repository)} <span class="muted text-sm">default branch {repository.defaultBranch}</span></h2>
  {/if}

  <Card title="Workflows" flush collapseKey="workflows" count={ranked.length}>
    {#snippet actions()}
      {#if following}
        <span class="muted text-sm" role="status">Following {runs?.filter((r) => r.active).length ?? 0} running</span>
      {:else if refreshedAt !== null}
        <span class="muted text-sm">Read from GitHub {timeAgo(refreshedAt, now)}</span>
      {/if}
      <Button size="sm" icon="refresh" loading={refreshing} onclick={refresh}>Refresh</Button>
    {/snippet}

    {#if workflowsProblem}
      <div class="pad stack">
        <StatusPill tone="warn" label={workflowsProblem.label}>{workflowsProblem.message}</StatusPill>
        <div><Button size="sm" icon="refresh" onclick={readWorkflows}>Try again</Button></div>
      </div>
    {:else if (canScan && workflows === null) || (!canScan && runs === null)}
      <div class="pad stack" role="status" aria-label="Loading the workflows">
        <Skeleton width="60%" height="16px" />
        <Skeleton width="45%" height="16px" />
      </div>
    {:else}
      {#if permission || note}
        <div class="pad notes">
          {#if permission}<p class="muted text-sm">{permission}</p>{/if}
          {#if note}
            <p class="muted text-sm">
              {note}
              {#if leftOut > 0 && !scopedWorkflows.fellBack}
                <Button size="sm" variant="link" onclick={() => (showAllPlatforms = !showAllPlatforms)}
                  >{showAllPlatforms ? `Only ${scopeLabel}` : 'Show all'}</Button
                >
              {/if}
            </p>
          {/if}
        </div>
      {/if}
      {#if byPlatform.shown.length === 0}
        <EmptyState
          icon="play"
          title="No workflows"
          description={canScan
            ? 'This repository has no GitHub Actions workflows. Add one under .github/workflows to build from here.'
            : 'No runs have been read yet, so no workflow is known. A member or admin can list them.'}
        />
      {:else}
        <WorkflowsList
          {rows}
          {now}
          {canDispatch}
          onrun={(row) => (dispatchRow = row)}
          onfollow={(run) => follow(run)}
        />
        {#if split.rest.length > 0}
          <div class="pad">
            <Button size="sm" variant="ghost" onclick={() => (showOthers = !showOthers)}
              >{showOthers ? 'Show fewer workflows' : `Show ${split.rest.length} other workflows`}</Button
            >
          </div>
        {/if}
      {/if}
    {/if}
  </Card>

  <Card title="Recent runs" flush collapseKey="runs" count={runsByPlatform.shown.length}>
    {#if runsProblem}
      <div class="pad stack">
        <StatusPill tone="warn" label={runsProblem.label}>{runsProblem.message}</StatusPill>
        <div><Button size="sm" icon="refresh" onclick={refresh}>Try again</Button></div>
      </div>
    {:else if runs === null}
      <div class="pad stack" role="status" aria-label="Loading the runs">
        <Skeleton width="80%" height="16px" />
        <Skeleton width="65%" height="16px" />
      </div>
    {:else}
      {#if runsWarning}
        <div class="pad"><StatusPill tone="info" label="Showing stored runs">{runsWarning}</StatusPill></div>
      {/if}
      {#if runsByPlatform.shown.length === 0}
        <EmptyState
          icon="play"
          title="No runs yet"
          description={canScan
            ? 'Runs appear here once this tool has read them from GitHub. Refresh to read the latest, or run a workflow.'
            : 'No runs have been read from GitHub yet. A member or admin can refresh them.'}
        />
      {:else}
        <RunsTable runs={runsByPlatform.shown} {now} {repository} onfollow={follow} />
      {/if}
    {/if}
  </Card>
</div>

{#if followed}
  <RunDrawer bind:open={drawerOpen} {api} {workspaceId} run={followed} {repository} {now} />
{/if}

{#if dispatchRow}
  <DispatchDialog
    {api}
    {workspaceId}
    target={dispatchTarget({ repository, workflow: dispatchRow.entry.workflow, platforms: dispatchRow.entry.platforms })}
    onclose={() => (dispatchRow = null)}
    ondispatched={dispatched}
  />
{/if}

<style>
  .pad {
    padding: var(--space-3) var(--space-4);
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    border-bottom: 1px solid var(--line);
  }

  .notes p {
    margin: 0;
  }

  .repo {
    font-size: var(--text-md);
  }
</style>
