<!--
  ChangeSetsPanel: the change sets of one repository, newest first, and the review of one.
  Props: api, workspaceId, repository, role, myId, names (user id to display name), openId
  (bindable: the change set under review, or null for the list), localConfig (the server's local
  clone settings, for whether a commit to the local clone is allowed; null while they load),
  ongotolisting (opens the listing tab, shown when there is nothing yet).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { actorLabel, filesChangedLabel, repositoryName } from '../../lib/repositories.ts';
  import type { ChangeSetView, LocalConfig, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import ChangeSetReview from './ChangeSetReview.svelte';
  import T from '../ui/T.svelte';
  import StatusBadge from './StatusBadge.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
    myId,
    names,
    openId = $bindable(null),
    localConfig = null,
    ongotolisting,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
    myId: string;
    names: Record<string, string>;
    openId?: string | null | undefined;
    localConfig?: LocalConfig | null | undefined;
    ongotolisting: () => void;
  } = $props();

  let items = $state<ChangeSetView[] | null>(null);
  let error = $state('');

  async function load() {
    error = '';
    try {
      items = (await api.changeSets(workspaceId, { repositoryId: repository.id })).changeSets;
    } catch (e) {
      items = null;
      error = e instanceof ApiError ? e.message : t('repositories:changes.loadFailed');
    }
  }

  async function back() {
    const id = openId;
    openId = null;
    await tick();
    if (id) document.getElementById(`cs-open-${id}`)?.focus();
  }

  const repoId = $derived(repository.id);
  $effect(() => {
    void repoId;
    void workspaceId;
    untrack(() => {
      items = null;
      void load();
    });
  });
</script>

{#if openId}
  <ChangeSetReview
    {api}
    {workspaceId}
    id={openId}
    {role}
    {myId}
    {names}
    onback={back}
    onchanged={load}
    localOnly={repository.localOnly}
    hasLocalClone={repository.local !== null}
    write={localConfig?.write ?? null}
    signing={localConfig?.signing ?? null}
  />
{:else if error}
  <div class="stack">
    <Alert tone="error">{error}</Alert>
    <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
  </div>
{:else if items === null}
  <div class="card" role="status" aria-label={t('repositories:changes.loadingAria')}>
    <div class="stack">
      {#each [0, 1, 2] as i (i)}
        <div class="skeleton-row">
          <Skeleton width="{50 - i * 8}%" height="14px" />
          <Skeleton width="64px" height="20px" />
        </div>
      {/each}
    </div>
  </div>
{:else if items.length === 0}
  <div class="card">
    <EmptyState
      icon="git-pull-request"
      title={t('repositories:changes.emptyTitle')}
      description={t('repositories:changes.emptyDescription')}
    >
      {#snippet actions()}
        {#if can(role, 'changesets.write')}
          <Button variant="primary" icon="edit" onclick={ongotolisting}>{t('repositories:changes.editListing')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="table-wrap">
    <table>
      <caption class="visually-hidden">{t('repositories:changes.caption', { name: repositoryName(repository) })}</caption>
      <thead>
        <tr>
          <th scope="col">{t('repositories:changes.summary')}</th>
          <th scope="col">{t('repositories:changes.status')}</th>
          <th scope="col">{t('repositories:changes.files')}</th>
          <th scope="col">{t('repositories:changes.created')}</th>
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          {#snippet createdTime(text: string)}
            <time datetime={new Date(item.createdAt).toISOString()} title={formatDateTime(item.createdAt)}>{text}</time>
          {/snippet}
          <tr>
            <td>
              <button type="button" id="cs-open-{item.id}" class="link summary" aria-label={t('repositories:changes.reviewAria', { summary: item.summary })} onclick={() => (openId = item.id)}>
                {item.summary}
              </button>
            </td>
            <td><StatusBadge status={item.status} /></td>
            <td>{filesChangedLabel(item.filesChanged)}</td>
            <td class="muted">
              <T key="repositories:changes.createdBy" params={{ actor: actorLabel(item.createdBy, myId, names), ago: formatRelativeTime(item.createdAt) }} tags={{ link: createdTime }} />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .skeleton-row {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    justify-content: space-between;
  }

  .summary {
    font-weight: var(--weight-medium);
    text-align: left;
  }
</style>
