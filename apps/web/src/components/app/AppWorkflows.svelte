<!--
  AppWorkflows: the Workflows page of an app. The GitHub Actions workflows of the app's repository,
  with a Run button, the runs going now, and the recent runs (components/ci/WorkflowsPanel.svelte).
  The platform scope of the app (iOS, Android, Both) filters them by what their names say.
  Quiet states: no repository linked is one line with a link to attach one; a repository without GitHub
  is one line; a connection that cannot read Actions is one StatusPill (inside the panel).
  Props: api, workspaceId, role, members (the records in scope), all? (every record of the app).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { scopeRunsToApps } from '../../lib/running.ts';
  import type { AppSummary, RepositorySummary } from '../../lib/types.ts';
  import RunningNow from '../ci/RunningNow.svelte';
  import WorkflowsPanel from '../ci/WorkflowsPanel.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatusPill from '../ui/StatusPill.svelte';

  let { api, workspaceId, role, members, all }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; all?: AppSummary[] } = $props();

  const records = $derived(all ?? members);
  const canRead = $derived(can(role, 'repositories.read'));
  const repositoryIds = $derived([...new Set(members.map((m) => m.repositoryId).filter((id): id is string => id !== null))]);
  const key = $derived(`${workspaceId}/${repositoryIds.join(',')}`);
  const openId = $derived((records[0] ?? members[0])?.id ?? '');

  let repositories = $state<RepositorySummary[] | null>(null);
  let problem = $state('');
  let releaseWorkflows = $state<Record<string, string | null>>({});

  $effect(() => {
    const ws = workspaceId;
    const ids = repositoryIds;
    void key;
    let current = true;
    untrack(() => {
      repositories = null;
      problem = '';
      releaseWorkflows = {};
    });
    if (!canRead || ids.length === 0) return;
    api
      .repositories(ws)
      .then((read) => {
        if (current) repositories = read.repositories.filter((r) => ids.indexOf(r.id) >= 0);
      })
      .catch((e) => {
        if (current) problem = e instanceof ApiError ? e.message : 'Could not load the repository.';
      });
    for (const app of members) {
      if (app.repositoryId === null) continue;
      api
        .buildConventions(ws, app.repositoryId, app.id)
        .then((view) => {
          if (current) releaseWorkflows[app.id] = view.effective.workflow ?? null;
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  });

  /** Repositories with a GitHub to ask; a local-only one has no workflows. */
  const github = $derived((repositories ?? []).filter((r) => !r.localOnly && r.owner !== null && r.repo !== null));
  const localOnly = $derived((repositories ?? []).filter((r) => r.localOnly || r.owner === null));
  const appPlatforms = $derived([...new Set(records.map((m) => m.platform))]);
  const platforms = $derived([...new Set(members.map((m) => m.platform))]);
  const scopeLabel = $derived(platforms.length === 1 ? platformLabel(platforms[0] as (typeof platforms)[number]) : 'these platforms');
  const configuredFor = (repositoryId: string): string[] =>
    members
      .filter((m) => m.repositoryId === repositoryId)
      .map((m) => releaseWorkflows[m.id])
      .filter((w): w is string => typeof w === 'string' && w !== '');
</script>

{#if !canRead}
  <p class="muted">Your role cannot read repositories, so the workflows of this app are not shown.</p>
{:else if repositoryIds.length === 0}
  <p class="muted">
    {platforms.length === 1 && appPlatforms.length > 1 ? `The ${scopeLabel} record of this app` : 'This app'} is not linked to a repository, so there are no
    workflows to run.
    <a href={appAddress(openId, 'settings')}>Attach a repository in the app settings</a>, or connect one under
    <a href="#/repositories">Repositories</a>.
  </p>
{:else if problem}
  <StatusPill tone="warn" label="The repository could not be read">{problem}</StatusPill>
{:else if repositories === null}
  <div class="stack" role="status" aria-label="Loading the workflows">
    <Skeleton width="60%" height="16px" />
    <Skeleton width="45%" height="16px" />
  </div>
{:else}
  {#if github.length > 0}
    <RunningNow
      {api}
      {workspaceId}
      repositoryIds={github.map((r) => r.id)}
      apps={members}
      stateKey="ci.running.recent.workflows"
      scope={(runs) =>
        scopeRunsToApps(
          runs,
          members.map((m) => ({ id: m.id, repositoryId: m.repositoryId, workflow: releaseWorkflows[m.id] ?? null })),
        )}
    />
  {/if}

  <div class="stack loose">
    {#each github as repository (repository.id)}
      <WorkflowsPanel
        {api}
        {workspaceId}
        {repository}
        {role}
        apps={records}
        appIds={members.map((m) => m.id)}
        {appPlatforms}
        {platforms}
        {scopeLabel}
        configured={configuredFor(repository.id)}
        showTitle={github.length > 1}
      />
    {/each}
    {#each localOnly as repository (repository.id)}
      <p class="muted">{repository.name} is a local folder without GitHub, so it has no workflows to run.</p>
    {/each}
    {#if github.length === 0 && localOnly.length === 0}
      <p class="muted">The linked repository is no longer connected. <a href="#/repositories">Connect it again under Repositories</a>.</p>
    {/if}
  </div>
{/if}
