<!--
  AppWorkflows: the Workflows page of an app. The GitHub Actions workflows of the app's repository,
  with a Run button, the runs going now, and the recent runs (components/ci/WorkflowsPanel.svelte). It opens with a lead (where the
  workflows stand, one primary action: open the run or start the release workflow), then the runs going now, the workflows (last run of
  each) and the recent runs, one line each, failing first.
  The platform scope of the app (iOS, Android, Both) filters them by what their names say.
  Quiet states: no repository linked is one line with a link to attach one; a repository without GitHub
  is one line; a connection that cannot read Actions is one StatusPill (inside the panel).
  Props: api, workspaceId, role, members (the records in scope), all? (every record of the app).
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
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

  let { api, workspaceId, role, members, all }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; all?: AppSummary[] | undefined } = $props();

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
        if (current) problem = e instanceof ApiError ? e.message : t('app:workflows.loadFailed');
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
  const scopeLabel = $derived(platforms.length === 1 ? platformLabel(platforms[0] as (typeof platforms)[number]) : t('app:workflows.thesePlatforms'));
  const singlePlatform = $derived(platforms.length === 1 ? platformLabel(platforms[0] as (typeof platforms)[number]) : null);
  const configuredFor = (repositoryId: string): string[] =>
    members
      .filter((m) => m.repositoryId === repositoryId)
      .map((m) => releaseWorkflows[m.id])
      .filter((w): w is string => typeof w === 'string' && w !== '');
</script>

{#if !canRead}
  <p class="muted">{t('app:workflows.noAccess')}</p>
{:else if repositoryIds.length === 0}
  <p class="muted">
    {#if singlePlatform !== null && appPlatforms.length > 1}{t('app:workflows.notLinkedPlatform', { platform: singlePlatform })}{:else}{t('app:workflows.notLinked')}{/if}
    <T key="app:workflows.attach" tags={{ link, link2 }} />
  </p>
{:else if problem}
  <StatusPill tone="warn" label={t('app:workflows.readFailed')}>{problem}</StatusPill>
{:else if repositories === null}
  <div class="stack" role="status" aria-label={t('app:workflows.loading')}>
    <Skeleton width="60%" height="16px" />
    <Skeleton width="45%" height="16px" />
  </div>
{:else}
  {#snippet running()}
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
  {/snippet}
  <!-- With one repository the lead of its panel comes first and the runs going now sit under it; with several they stay on top. -->
  {#if github.length > 1}{@render running()}{/if}

  <div class="stack loose">
    {#each github as repository (repository.id)}
      <WorkflowsPanel
        {api}
        {workspaceId}
        {repository}
        {role}
        appIds={members.map((m) => m.id)}
        {appPlatforms}
        {platforms}
        {scopeLabel}
        configured={configuredFor(repository.id)}
        showTitle={github.length > 1}
        afterLead={github.length === 1 ? running : undefined}
      />
    {/each}
    {#each localOnly as repository (repository.id)}
      <p class="muted">{t('app:workflows.localOnly', { name: repository.name })}</p>
    {/each}
    {#if github.length === 0 && localOnly.length === 0}
      <p class="muted"><T key="app:workflows.disconnected" tags={{ link: repositoriesLink }} /></p>
    {/if}
  </div>
{/if}

{#snippet link(text: string)}<a href={appAddress(openId, 'settings')}>{text}</a>{/snippet}
{#snippet link2(text: string)}<a href="#/repositories">{text}</a>{/snippet}
{#snippet repositoriesLink(text: string)}<a href="#/repositories">{text}</a>{/snippet}

