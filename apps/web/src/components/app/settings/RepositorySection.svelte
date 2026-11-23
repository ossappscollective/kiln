<!--
  RepositorySection: the repository each record of the app is linked to (name, branch, project type, local
  clone), the listing targets saved for it, and where to manage it. Reads only.
  Props: api, workspaceId, role, members (the records in scope).
-->
<script lang="ts">
  import { t } from '../../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../../lib/api.ts';
  import { links, notAvailable } from '../../../lib/app-settings.ts';
  import { platformLabel } from '../../../lib/portfolio.ts';
  import type { AppSummary, RepositorySummary, SavedListingTarget } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
    import Button from '../../ui/Button.svelte';
  import PlatformBadge from '../../ui/PlatformBadge.svelte';
  import SettingsCard from './SettingsCard.svelte';

  let { api, workspaceId, role, members }: { api: Api; workspaceId: string; role: Role; members: AppSummary[] } = $props();

  const canRead = $derived(can(role, 'repositories.read'));

  let repositories = $state<RepositorySummary[]>([]);
  let targets = $state<Record<string, SavedListingTarget[] | undefined>>({});
  let problem = $state('');

  const key = $derived(`${workspaceId}/${members.map((m) => m.repositoryId ?? '-').join(',')}`);

  $effect(() => {
    const id = workspaceId;
    const repoIds = members.map((m) => m.repositoryId).filter((r): r is string => r !== null);
    void key;
    untrack(() => {
      repositories = [];
      targets = {};
      problem = '';
    });
    if (!canRead || repoIds.length === 0) return;
    let current = true;
    api
      .repositories(id)
      .then((r) => {
        if (current) repositories = r.repositories;
      })
      .catch(() => {
        if (current) problem = t('app:repository.loadFailed');
      });
    for (const repoId of repoIds.filter((r, i) => repoIds.indexOf(r) === i)) {
      api
        .listingTargets(id, repoId)
        .then((r) => {
          if (current) targets = { ...targets, [repoId]: r.targets };
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  });

  const repoOf = (app: AppSummary) => repositories.filter((r) => r.id === app.repositoryId)[0] ?? null;
  const targetsOf = (app: AppSummary) => (targets[app.repositoryId ?? ''] ?? []).filter((t) => t.appId === null || t.appId === app.id);
</script>

<SettingsCard
  title={t('app:settings.part.repository')}
  icon="git-branch"
  description={t('app:repository.description')}
  unavailable={notAvailable.changeRepository}
>
  {#if problem}<Alert tone="warn">{problem}</Alert>{/if}
  <div class="stack">
    {#each members as app (app.id)}
      {@const repo = repoOf(app)}
      <div class="record">
        <div class="row between">
          <PlatformBadge platform={app.platform} tinted />
          {#if app.repositoryId === null}<Badge tone="neutral">{t('app:chips.notLinked')}</Badge>{:else}<Badge tone="ok">{t('app:chips.linked')}</Badge>{/if}
        </div>
        {#if app.repositoryId === null}
          <p class="muted note">{t('app:repository.noRepository', { platform: platformLabel(app.platform) })}</p>
        {:else if !canRead}
          <p class="muted note">{t('app:repository.needRepos')}</p>
        {:else if repo}
          <dl class="facts">
            <div>
              <dt>{t('app:chips.repository')}</dt>
              <dd>{repo.name}</dd>
            </div>
            <div>
              <dt>{t('app:repository.defaultBranch')}</dt>
              <dd><code>{repo.defaultBranch}</code></dd>
            </div>
            <div>
              <dt>{t('app:repository.projectType')}</dt>
              <dd>{repo.projectKind ?? t('app:repository.notScanned')}</dd>
            </div>
            <div>
              <dt>{t('app:repository.connection')}</dt>
              <dd>{repo.localOnly ? t('app:repository.localOnly') : repo.local ? t('app:repository.githubLocal') : t('app:repository.github')}</dd>
            </div>
          </dl>
          <div>
            <p class="label">{t('app:repository.targets')}</p>
            {#if targets[app.repositoryId ?? ''] === undefined}
              <p class="muted note">{t('app:defaults.reading')}</p>
            {:else if targetsOf(app).length === 0}
              <p class="muted note">{t('app:repository.noTargets')}</p>
            {:else}
              <ul class="plain">
                {#each targetsOf(app) as target (target.id)}
                  <li>{target.name}{target.appStoreRoot ? t('app:repository.appStoreRoot', { root: target.appStoreRoot }) : ''}{target.googlePlayRoot ? t('app:repository.googlePlayRoot', { root: target.googlePlayRoot }) : ''}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else if !problem}
          <p class="muted note">{t('app:repository.reading')}</p>
        {/if}
      </div>
    {/each}
  </div>
  {#if canRead}<div><Button size="sm" variant="ghost" href={links.repositories}>{t('app:repository.manage')}</Button></div>{/if}
</SettingsCard>

<style>
  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    font-size: 0.9375rem;
  }

  .record + .record {
    padding-top: var(--space-5);
    border-top: 1px solid var(--line);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }

  .facts dt,
  .label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .plain {
    margin: 0;
    padding-left: var(--space-5);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font-size: 0.9375rem;
  }
</style>
