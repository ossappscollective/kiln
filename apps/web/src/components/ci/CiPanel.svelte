<!--
  CiPanel: the GitHub Actions side of one repository: its workflows (with a Dispatch action) and
  its recent runs. Runs are read from our own table; "Refresh" and the live follow ask GitHub, which
  needs the right of a scan. While a run is going and this page is on screen the list updates every
  few seconds; with no active run, or in a hidden tab, nothing polls.
  Props: api, workspaceId, repository, role.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { POLL_MAX_MS, POLL_MS, canDispatchWorkflow, hasActiveRun } from '../../lib/ci/ci.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { createPoller } from '../../lib/poll.ts';
  import type { CiWorkflow, RepositorySummary, WorkflowRun } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import { dispatchTarget } from '../../lib/ci/dispatch-target.ts';
  import DispatchDialog from './DispatchDialog.svelte';
  import RunDrawer from './RunDrawer.svelte';
  import RunsTable from './RunsTable.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
  }: { api: Api; workspaceId: string; repository: RepositorySummary; role: Role } = $props();

  const canScan = $derived(can(role, 'repositories.scan'));
  const canDispatch = $derived(can(role, 'ci.dispatch'));
  const repoId = $derived(repository.id);

  let workflows = $state<CiWorkflow[] | null>(null);
  let workflowsProblem = $state('');
  let runs = $state<WorkflowRun[] | null>(null);
  let runsProblem = $state('');
  /** GitHub could not be read, so the runs shown are the stored ones. */
  let runsWarning = $state('');
  let refreshedAt = $state<number | null>(null);
  let refreshing = $state(false);
  let now = $state(Date.now());
  let dispatchWorkflow = $state<CiWorkflow | null>(null);
  let announcement = $state('');
  /** The run whose panel is open (its id; the row is looked up in the list so the panel follows the list). */
  let followedId = $state<string | null>(null);
  let drawerOpen = $state(false);
  const followed = $derived(followedId === null ? null : ((runs ?? []).find((r) => r.id === followedId) ?? null));

  /** Ignores a late answer for a repository that is no longer open. */
  let generation = 0;

  const following = $derived(hasActiveRun(runs ?? []));

  /** Reads the runs; `refresh` asks GitHub first. Returns false when the read failed. */
  async function readRuns(refresh: boolean): Promise<boolean> {
    const mine = generation;
    try {
      const read = await api.workflowRuns(workspaceId, repoId, { refresh, limit: 30 });
      if (mine !== generation) return true;
      runs = read.runs;
      if (read.refreshedAt !== null) refreshedAt = read.refreshedAt;
      runsProblem = '';
      runsWarning = '';
      now = Date.now();
      return true;
    } catch (e) {
      if (mine !== generation) return true;
      const message = e instanceof ApiError ? e.message : 'Could not load the runs.';
      if (refresh && runs === null) {
        // GitHub is unreachable: show what is stored, and say so.
        const ok = await readRuns(false);
        if (ok && mine === generation) runsWarning = `Could not read GitHub: ${message} Showing the runs stored earlier.`;
        return false;
      }
      if (runs === null) runsProblem = message;
      else runsWarning = `Could not update from GitHub: ${message}`;
      return false;
    }
  }

  async function readWorkflows() {
    const mine = generation;
    workflowsProblem = '';
    try {
      const read = await api.workflows(workspaceId, repoId);
      if (mine === generation) workflows = read.workflows;
    } catch (e) {
      if (mine !== generation) return;
      workflows = null;
      workflowsProblem = e instanceof ApiError ? e.message : 'Could not load the workflows.';
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    await Promise.all([readRuns(canScan), canScan ? readWorkflows() : Promise.resolve()]);
    refreshing = false;
    announcement = 'Runs updated.';
  }

  $effect(() => {
    void repoId;
    void workspaceId;
    untrack(() => {
      generation++;
      workflows = null;
      runs = null;
      runsProblem = '';
      runsWarning = '';
      refreshedAt = null;
      dispatchWorkflow = null;
      followedId = null;
      drawerOpen = false;
      void readRuns(canScan);
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
        // A failed read is retried slower; a good one goes on while a run is still going.
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

  function dispatched(run: WorkflowRun) {
    // The new run is stored on the server already; show it without waiting for the next read.
    runs = [run, ...(runs ?? []).filter((r) => r.id !== run.id)];
    announcement = `Started ${run.workflow}.`;
    // A run GitHub already named is followed at once; a placeholder is picked up by the list when it is named.
    if (!run.id.startsWith('pending-')) follow(run);
  }

  function follow(run: WorkflowRun) {
    followedId = run.id;
    drawerOpen = true;
  }
</script>

<div class="stack loose">
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if canScan}
    <Card title="Workflows" description="GitHub Actions workflows of this repository." flush collapseKey="workflows" count={workflows?.length ?? 0}>
      {#if workflowsProblem}
        <div class="pad stack">
          <Alert tone="error" title="Could not load the workflows">{workflowsProblem}</Alert>
          <div><Button icon="refresh" onclick={readWorkflows}>Try again</Button></div>
        </div>
      {:else if workflows === null}
        <div class="pad stack" role="status" aria-label="Loading the workflows">
          <Skeleton width="60%" height="16px" />
          <Skeleton width="45%" height="16px" />
        </div>
      {:else if workflows.length === 0}
        <EmptyState
          icon="play"
          title="No workflows"
          description="This repository has no GitHub Actions workflows. Add one under .github/workflows to build from here."
        />
      {:else}
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">Workflows of {repository.owner}/{repository.repo}</caption>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">File</th>
                <th scope="col">State</th>
                {#if canDispatch}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each workflows as workflow (workflow.id)}
                <tr>
                  <td><strong>{workflow.name}</strong></td>
                  <td><code>{workflow.path}</code></td>
                  <td>
                    <Badge tone={canDispatchWorkflow(workflow) ? 'ok' : 'neutral'}>
                      {canDispatchWorkflow(workflow) ? 'Active' : workflow.state.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  {#if canDispatch}
                    <td class="actions">
                      <Button
                        size="sm"
                        icon="play"
                        disabled={!canDispatchWorkflow(workflow)}
                        label="Run {workflow.name}"
                        onclick={() => (dispatchWorkflow = workflow)}>Run</Button
                      >
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  {:else}
    <p class="muted">Listing and starting workflows asks GitHub, which needs the member or admin role. You can read the runs below.</p>
  {/if}

  <Card title="Recent runs" flush collapseKey="runs" count={runs?.length ?? 0}>
    {#snippet actions()}
      {#if following}
        <span class="muted text-sm" role="status">Following {runs?.filter((r) => r.active).length ?? 0} running</span>
      {:else if refreshedAt !== null}
        <span class="muted text-sm">Read from GitHub {timeAgo(refreshedAt, now)}</span>
      {/if}
      {#if canScan}
        <Button size="sm" icon="refresh" loading={refreshing} onclick={refresh}>Refresh</Button>
      {/if}
    {/snippet}

    {#if runsProblem}
      <div class="pad stack">
        <Alert tone="error" title="Could not load the runs">{runsProblem}</Alert>
        <div><Button icon="refresh" onclick={refresh}>Try again</Button></div>
      </div>
    {:else if runs === null}
      <div class="pad stack" role="status" aria-label="Loading the runs">
        <Skeleton width="80%" height="16px" />
        <Skeleton width="65%" height="16px" />
        <Skeleton width="72%" height="16px" />
      </div>
    {:else}
      {#if runsWarning}
        <div class="pad"><Alert tone="warn">{runsWarning}</Alert></div>
      {/if}
      {#if runs.length === 0}
        <EmptyState
          icon="play"
          title="No runs yet"
          description={canScan
            ? 'Runs appear here once this tool has read them from GitHub. Refresh to read the latest, or run a workflow.'
            : 'No runs have been read from GitHub yet. A member or admin can refresh them.'}
        />
      {:else}
        <RunsTable {runs} {now} {repository} onfollow={follow} />
      {/if}
    {/if}
  </Card>
</div>

{#if followed}
  <RunDrawer bind:open={drawerOpen} {api} {workspaceId} run={followed} {repository} {now} />
{/if}

{#if dispatchWorkflow}
  <DispatchDialog
    {api}
    {workspaceId}
    target={dispatchTarget({ repository, workflow: dispatchWorkflow })}
    onclose={() => (dispatchWorkflow = null)}
    ondispatched={dispatched}
  />
{/if}

<style>
  .pad {
    padding: var(--space-4) var(--space-5);
  }

  .actions {
    text-align: right;
  }
</style>
