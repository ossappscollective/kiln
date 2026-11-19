<!--
  StartRelease: the "Start release" button of an app (dashboard and Releases tab). It opens the dispatch
  dialog (components/ci/DispatchDialog) on the release workflow of the app (its build conventions, else the
  one workflow whose name says release), on the repository's default branch, with the platform input filled
  in when the workflow has one. Nothing is started until the person confirms in the dialog; the dialog is
  the existing one (it stays single-app for now).
  After a dispatch the started run is followed inline (RunningNow, narrowed to that run) and, once the run
  has finished, the app's builds are read (a few times, spaced out) for a build that run made. When one
  appears the line says so and "Prepare release" leads to the Releases tab with that version selected.
  The button is hidden for a role that cannot dispatch; without a linked repository it is disabled and says why.
  Props: api, workspaceId, role, members (the records in scope), all? (every record, for the dialog),
  scopeIsBoth (the scope covers several platforms), showRunning = true (false where the screen already draws
  RunningNow: then feed its answers to `observe`).
  onstarted? (called with the started run, changed when GitHub names it, and with null when it is forgotten: a screen
  that draws its own RunningNow can then show that run too).
  Exports: observe(data) takes a RunningNow answer, so a screen with its own feed does not read twice.
-->
<script lang="ts">
  import { type Platform, type Role, can } from '@mrm/core';
  import { onDestroy } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { isFailedRun } from '../../lib/running.ts';
  import {
    type ChosenWorkflow,
    type StartedRun,
    chooseReleaseWorkflow,
    isStartedRun,
    matchingBuilds,
    prefillNote,
    prepareReleaseHref,
    startedLine,
  } from '../../lib/start-release.ts';
  import { rankWorkflows, suggestAppId } from '../../lib/workflows.ts';
  import type { ActiveRuns, AppBuild, AppSummary, CiWorkflow, RepositorySummary, WorkflowRun } from '../../lib/types.ts';
  import RunningNow from '../ci/RunningNow.svelte';
  import DispatchDialog from '../ci/DispatchDialog.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    all,
    scopeIsBoth = false,
    showRunning = true,
    onstarted,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    all?: AppSummary[];
    scopeIsBoth?: boolean;
    showRunning?: boolean;
    onstarted?: (started: StartedRun | null) => void;
  } = $props();

  const RETRY_MS = 30_000;
  const MAX_CHECKS = 4;

  const canDispatch = $derived(can(role, 'ci.dispatch') && can(role, 'repositories.read'));
  const linked = $derived(members.filter((m) => m.repositoryId !== null));
  const platforms = $derived([...new Set(members.map((m) => m.platform))] as Platform[]);

  let preparing = $state(false);
  let problem = $state('');
  let dialog = $state<{ repository: RepositorySummary; workflow: CiWorkflow; appId: string; chosen: ChosenWorkflow } | null>(null);
  let note = $state('');
  let started = $state<StartedRun | null>(null);
  let running = $state(true);
  let failed = $state(false);
  let build = $state<{ appId: string; build: AppBuild } | null>(null);
  let checks = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  onDestroy(() => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
  });

  // Another app or workspace: forget the run that was followed.
  const scopeKey = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  let shownFor = '';
  $effect(() => {
    const next = scopeKey;
    if (next !== shownFor) {
      if (shownFor !== '') reset();
      shownFor = next;
    }
  });

  function reset() {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (started !== null) onstarted?.(null);
    started = null;
    build = null;
    running = true;
    failed = false;
    checks = 0;
    dialog = null;
    problem = '';
    note = '';
  }

  /** Finds the release workflow on the first linked repository that has one, and opens the dialog on it. */
  async function begin() {
    if (preparing) return;
    preparing = true;
    problem = '';
    const mine = ++generation;
    try {
      const repositories = (await api.repositories(workspaceId)).repositories;
      const ids = [...new Set(linked.map((m) => m.repositoryId as string))];
      for (const repositoryId of ids) {
        const repository = repositories.find((r) => r.id === repositoryId);
        if (!repository || repository.localOnly || repository.owner === null) continue;
        const own = linked.filter((m) => m.repositoryId === repositoryId);
        const workflows = (await api.workflows(workspaceId, repositoryId)).workflows;
        const configured: string[] = [];
        for (const app of own) {
          try {
            const view = await api.buildConventions(workspaceId, repositoryId, app.id);
            if (view.effective.workflow) configured.push(view.effective.workflow);
          } catch {
            // No convention readable: the name of the workflow decides.
          }
        }
        if (mine !== generation) return;
        const entries = rankWorkflows(workflows, { configured, appIds: own.map((m) => m.id) });
        const chosen = chooseReleaseWorkflow(entries, own.map((m) => m.platform));
        if (!chosen) continue;
        const entry = entries.find((e) => e.workflow.id === chosen.workflow.id);
        dialog = {
          repository,
          workflow: chosen.workflow,
          appId: suggestAppId(all ?? members, repositoryId, entry?.platforms ?? []),
          chosen,
        };
        note = prefillNote(chosen, { platforms: own.map((m) => m.platform) });
        return;
      }
      problem = 'No release workflow was found for this app. Set one in its build conventions, or start a workflow from the Workflows page.';
    } catch (e) {
      if (mine !== generation) return;
      problem = e instanceof ApiError ? e.message : 'Could not read the workflows of the repository.';
    } finally {
      if (mine === generation || generation > mine) preparing = false;
    }
  }

  function dispatched(run: WorkflowRun) {
    started = { repositoryId: run.repositoryId, runId: run.id, workflow: run.workflow, startedAt: run.startedAt, platforms };
    onstarted?.(started);
    build = null;
    running = true;
    failed = false;
    checks = 0;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dialog = null;
  }

  async function checkBuilds(mine: number) {
    const current = started;
    if (!current || mine !== generation) return;
    checks += 1;
    let found: { appId: string; build: AppBuild } | null = null;
    for (const app of members) {
      try {
        const builds = (await api.appBuilds(workspaceId, app.id)).builds;
        const hit = matchingBuilds(builds, current)[0];
        if (hit) {
          found = { appId: app.id, build: hit };
          break;
        }
      } catch {
        // CI data is an extra: no build line, no alert.
      }
    }
    if (mine !== generation) return;
    if (found) {
      build = found;
      return;
    }
    if (checks < MAX_CHECKS) timer = setTimeout(() => void checkBuilds(mine), RETRY_MS);
  }

  /** Takes an answer of the running-workflows feed: finds the started run, and looks for its build once it ended. */
  export function observe(data: ActiveRuns) {
    const current = started;
    if (!current) return;
    const mine = [...data.runs, ...data.recent].find((r) => isStartedRun(r, current));
    if (mine && mine.id !== current.runId) {
      started = { ...current, runId: mine.id };
      onstarted?.(started);
    }
    const wasRunning = running;
    running = mine === undefined || mine.active;
    failed = mine !== undefined && !mine.active && isFailedRun(mine);
    if (wasRunning && !running && !failed && build === null && checks === 0) void checkBuilds(generation);
  }

  const line = $derived(started ? startedLine({ workflow: started.workflow, running, build: build?.build ?? null, failed }) : '');
</script>

<div class="start">
  {#if canDispatch}
    <div class="row head">
      <Button
        variant={started ? 'secondary' : 'primary'}
        icon="rocket"
        loading={preparing}
        disabled={linked.length === 0}
        title={linked.length === 0 ? 'Link a repository to this app in its settings to start its release workflow.' : 'Open the release workflow with the values it needs. Nothing starts until you confirm.'}
        onclick={begin}
      >Start release</Button>
      {#if build}
        <Button variant="primary" icon="arrow-right" href={prepareReleaseHref(build.appId, build.build, scopeIsBoth)}>Prepare release</Button>
      {/if}
      {#if line}<p class="line" role="status">{line}</p>{/if}
    </div>
    {#if problem}
      <p class="problem muted" role="status">{problem} <a href={appAddress(members[0]?.id ?? '', 'workflows', scopeIsBoth ? 'both' : (members[0]?.platform ?? null))}>Open the workflows</a></p>
    {/if}
  {/if}

  {#if started && showRunning}
    <RunningNow
      {api}
      {workspaceId}
      repositoryIds={[started.repositoryId]}
      apps={members}
      heading="Release run"
      stateKey="ci.running.recent.start"
      scope={(runs) => ({ runs: runs.filter((r) => started !== null && isStartedRun(r, started)), linked: true })}
      ondata={observe}
    />
  {/if}
</div>

{#if dialog}
  <DispatchDialog
    {api}
    {workspaceId}
    repository={dialog.repository}
    workflow={dialog.workflow}
    apps={all ?? members}
    initialAppId={dialog.appId}
    hint={{ platforms }}
    onclose={() => (dialog = null)}
    ondispatched={dispatched}
  />
{/if}

<style>
  .start {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .line,
  .problem {
    margin: 0;
    font-size: var(--text-sm);
  }

  .line {
    color: var(--muted);
  }
</style>
