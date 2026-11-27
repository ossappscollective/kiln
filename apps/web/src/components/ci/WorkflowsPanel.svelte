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
  repository above, when an app has more than one), afterLead? (a snippet drawn under the lead).
  The page opens with a PageLead (lib/workflow-lead.ts): where the workflows stand ("Last run failed 2 hours ago on main", "3 workflows,
  1 failing") and ONE primary action: open the run that failed or is going, or start the release workflow. The runs are listed one line
  each, failing first; what is only sometimes needed is behind "Details" on the row.
-->
<script lang="ts">
  import { type Platform, type Role, can } from '@kiln/core';
  import { type Snippet, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { POLL_MAX_MS, POLL_MS, hasActiveRun } from '../../lib/ci/ci.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
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
  } from '../../lib/ci/workflows.ts';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatusPill from '../ui/StatusPill.svelte';
  import { dispatchTarget } from '../../lib/ci/dispatch-target.ts';
  import { workflowsLead } from '../../lib/ci/lead.ts';
  import PageLead from '../ui/PageLead.svelte';
  import DispatchDialog from './DispatchDialog.svelte';
  import RunDrawer from './RunDrawer.svelte';
  import RunsTable from './RunsTable.svelte';
  import WorkflowsList from './WorkflowsList.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

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
    afterLead,
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
    showTitle?: boolean | undefined;
    /** Drawn right under the lead (the runs going now), so the headline stays first. */
    afterLead?: Snippet | undefined;
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
  const clock = useNow({ everyMs: 30_000 });
  const now = $derived(clock.value);
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
      : { label: t('builds:workflows.problem.unreadable'), message: fallback };

  async function readRuns(refresh: boolean): Promise<boolean> {
    const mine = generation;
    try {
      const read = await api.workflowRuns(workspaceId, repoId, { refresh, limit: 60 });
      if (mine !== generation) return true;
      runs = read.runs;
      if (read.refreshedAt !== null) refreshedAt = read.refreshedAt;
      runsProblem = null;
      runsWarning = '';
      clock.touch();
      return true;
    } catch (e) {
      if (mine !== generation) return true;
      const problem = problemOf(e, t('builds:panel.runsLoadFailed'));
      if (refresh && runs === null) {
        // GitHub is unreachable: show what is stored, and say so.
        const ok = await readRuns(false);
        if (ok && mine === generation) runsWarning = t('builds:panel.githubUnreadable', { message: problem.message });
        return false;
      }
      if (runs === null) runsProblem = problem;
      else runsWarning = t('builds:panel.updateFailed', { message: problem.message });
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
      workflowsProblem = problemOf(e, t('builds:panel.workflowsLoadFailed'));
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    await Promise.all([readRuns(canScan), canScan ? readWorkflows() : Promise.resolve()]);
    refreshing = false;
    announcement = t('builds:panel.bothUpdated');
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
        ? t('builds:panel.showingAll')
        : ''
      : [
          scopeNote({ noun: 'workflow', scopeLabel, hidden: scopedWorkflows.hidden.length, fellBack: scopedWorkflows.fellBack }),
          scopedWorkflows.fellBack ? '' : scopeNote({ noun: 'run', scopeLabel, hidden: scopedRuns.hidden.length, fellBack: false }),
        ]
          .filter((part) => part !== '')
          .join(' '),
  );
  /** The lead waits for what it reads: the runs, and the workflows when this role can list them. */
  const leadReady = $derived(runs !== null && !runsProblem && !workflowsProblem && (!canScan || workflows !== null));
  const lead = $derived(workflowsLead({ rows, runs: runsByPlatform.shown, now, canDispatch }));
  const primaryName = $derived.by(() => {
    const primary = lead.primary;
    if (primary?.kind !== 'start') return '';
    return rows.find((r) => r.entry.workflow.id === primary.workflowId)?.entry.workflow.name ?? '';
  });

  function leadAction() {
    const primary = lead.primary;
    if (!primary) return;
    if (primary.kind === 'open') {
      const run = (runs ?? []).find((r) => r.id === primary.runId);
      if (run) follow(run);
    } else {
      const row = rows.find((r) => r.entry.workflow.id === primary.workflowId);
      if (row) dispatchRow = row;
    }
  }

  const permission = $derived(
    !canScan
      ? t('builds:panel.needMemberStored')
      : !canDispatch
        ? t('builds:workflows.blocked.role')
        : '',
  );

  function dispatched(run: WorkflowRun) {
    // The new run is stored on the server already; show it without waiting for the next read.
    runs = [run, ...(runs ?? []).filter((r) => r.id !== run.id)];
    announcement = t('builds:panel.started', { name: run.workflow });
    if (!run.id.startsWith('pending-')) follow(run);
  }

  function follow(run: WorkflowRun) {
    followedId = run.id;
    drawerOpen = true;
  }
</script>

<div class="stack">
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if leadReady}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="workflows-lead">
      {#snippet actions()}
        {#if lead.primary?.kind === 'start'}
          <Button variant="primary" icon="play" label={lead.primary.label === t('builds:lead.startRelease') ? t('builds:panel.startReleaseLabel', { name: primaryName }) : lead.primary.label} onclick={leadAction}
            >{lead.primary.label}</Button
          >
        {:else if lead.primary}
          <Button variant="primary" onclick={leadAction}>{lead.primary.label}</Button>
        {/if}
      {/snippet}
    </PageLead>
  {/if}
  {#if afterLead}{@render afterLead()}{/if}

  {#if showTitle}
    <h2 class="repo">{repositoryName(repository)} <span class="muted text-sm">{t('builds:panel.defaultBranch', { branch: repository.defaultBranch })}</span></h2>
  {/if}

  <Card title={t('builds:wfl.caption')} flush collapseKey="workflows" count={ranked.length}>
    {#snippet actions()}
      {#if following}
        <span class="muted text-sm" role="status">{t('builds:panel.following', { count: runs?.filter((r) => r.active).length ?? 0 })}</span>
      {:else if refreshedAt !== null}
        <span class="muted text-sm">{t('builds:panel.readFromGithub', { ago: timeAgo(refreshedAt, now) })}</span>
      {/if}
      <Button size="sm" icon="refresh" loading={refreshing} onclick={refresh}>{t('builds:panel.refresh')}</Button>
    {/snippet}

    {#if workflowsProblem}
      <div class="pad stack">
        <StatusPill tone="warn" label={workflowsProblem.label}>{workflowsProblem.message}</StatusPill>
        <div><Button size="sm" icon="refresh" onclick={readWorkflows}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else if (canScan && workflows === null) || (!canScan && runs === null)}
      <div class="pad stack" role="status" aria-label={t('builds:panel.loadingWorkflows')}>
        <Skeleton width="60%" height="16px" />
        <Skeleton width="45%" height="16px" />
      </div>
    {:else}
      {#if permission || note}
        <div class="pad notes">
          {#if permission}<p class="muted">{permission}</p>{/if}
          {#if note}
            <p class="muted">
              {note}
              {#if leftOut > 0 && !scopedWorkflows.fellBack}
                <Button size="sm" variant="link" onclick={() => (showAllPlatforms = !showAllPlatforms)}
                  >{showAllPlatforms ? t('builds:panel.onlyScope', { scope: scopeLabel }) : t('builds:panel.showAll')}</Button
                >
              {/if}
            </p>
          {/if}
        </div>
      {/if}
      {#if byPlatform.shown.length === 0}
        <EmptyState
          icon="play"
          title={t('builds:panel.noWorkflowsTitle')}
          description={canScan ? t('builds:panel.noWorkflowsBody') : t('builds:panel.noWorkflowsBodyStored')}
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
              >{showOthers ? t('builds:panel.showFewer') : t('builds:panel.showOthers', { count: split.rest.length })}</Button
            >
          </div>
        {/if}
      {/if}
    {/if}
  </Card>

  <Card title={t('builds:panel.recentRuns')} flush collapseKey="runs" count={runsByPlatform.shown.length}>
    {#if runsProblem}
      <div class="pad stack">
        <StatusPill tone="warn" label={runsProblem.label}>{runsProblem.message}</StatusPill>
        <div><Button size="sm" icon="refresh" onclick={refresh}>{t('common:action.tryAgain')}</Button></div>
      </div>
    {:else if runs === null}
      <div class="pad stack" role="status" aria-label={t('builds:panel.loadingRuns')}>
        <Skeleton width="80%" height="16px" />
        <Skeleton width="65%" height="16px" />
      </div>
    {:else}
      {#if runsWarning}
        <div class="pad"><StatusPill tone="info" label={t('builds:panel.storedRuns')}>{runsWarning}</StatusPill></div>
      {/if}
      {#if runsByPlatform.shown.length === 0}
        <EmptyState
          icon="play"
          title={t('builds:wfl.noRuns')}
          description={canScan ? t('builds:panel.noRunsBody') : t('builds:panel.noRunsBodyRead')}
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
    font-size: 0.9375rem;
  }

  .repo {
    font-size: var(--text-md);
  }
</style>
