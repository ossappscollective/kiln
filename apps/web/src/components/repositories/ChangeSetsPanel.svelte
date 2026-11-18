<!--
  ChangeSetsPanel: the change sets of one repository, newest first, and the review of one.
  Props: api, workspaceId, repository, role, myId, names (user id to display name), openId
  (bindable: the change set under review, or null for the list), ongotolisting (opens the listing
  tab, shown when there is nothing yet).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { tick, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { actorLabel, filesChangedLabel } from '../../lib/repositories.ts';
  import type { ChangeSetView, RepositorySummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import ChangeSetReview from './ChangeSetReview.svelte';
  import StatusBadge from './StatusBadge.svelte';

  let {
    api,
    workspaceId,
    repository,
    role,
    myId,
    names,
    openId = $bindable(null),
    ongotolisting,
  }: {
    api: Api;
    workspaceId: string;
    repository: RepositorySummary;
    role: Role;
    myId: string;
    names: Record<string, string>;
    openId?: string | null;
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
      error = e instanceof ApiError ? e.message : 'Could not load the change sets.';
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
  />
{:else if error}
  <div class="stack">
    <Alert tone="error">{error}</Alert>
    <div><Button icon="refresh" onclick={load}>Try again</Button></div>
  </div>
{:else if items === null}
  <div class="card" role="status" aria-label="Loading change sets">
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
      title="No change sets yet"
      description="A change set is the only way text reaches this repository. Edit the listing to create a draft; an admin or owner approves it, then it opens as a pull request."
    >
      {#snippet actions()}
        {#if can(role, 'changesets.write')}
          <Button variant="primary" icon="edit" onclick={ongotolisting}>Edit the listing</Button>
        {/if}
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="table-wrap">
    <table>
      <caption class="visually-hidden">Change sets of {repository.owner}/{repository.repo}</caption>
      <thead>
        <tr>
          <th scope="col">Summary</th>
          <th scope="col">Status</th>
          <th scope="col">Files</th>
          <th scope="col">Created</th>
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td>
              <button type="button" id="cs-open-{item.id}" class="link summary" aria-label="Review {item.summary}" onclick={() => (openId = item.id)}>
                {item.summary}
              </button>
            </td>
            <td><StatusBadge status={item.status} /></td>
            <td>{filesChangedLabel(item.filesChanged)}</td>
            <td class="muted">
              {actorLabel(item.createdBy, myId, names)},
              <time datetime={new Date(item.createdAt).toISOString()} title={fullTime(item.createdAt)}>{timeAgo(item.createdAt)}</time>
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
