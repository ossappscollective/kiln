<!--
  RepositoryDetail: one connected repository in three tabs: the detected project, the store
  listing, and the change sets.
  Props: api, workspaceId, role, myId, names (user id to display name), initial (the row from the
  list, shown while the details load), onback, onupdated (called with a fresh repository row).
-->
<script lang="ts">
  import { type Listing, type Role, can } from '@mrm/core';
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { githubUrl, hasEdits, repositoryName } from '../../lib/repositories.ts';
  import type {
    ChangeSetView,
    ProjectDetection,
    ListingSelection,
    RepositoryDetail,
    RepositoryListing,
    RepositorySummary,
  } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import ChangeSetsPanel from './ChangeSetsPanel.svelte';
  import KindBadge from './KindBadge.svelte';
  import ListingPanel from './ListingPanel.svelte';
  import ProjectPanel from './ProjectPanel.svelte';

  let {
    api,
    workspaceId,
    role,
    myId,
    names,
    initial,
    onback,
    onupdated,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    myId: string;
    names: Record<string, string>;
    initial: RepositorySummary;
    onback: () => void;
    onupdated: (repository: RepositorySummary) => void;
  } = $props();

  const canScan = $derived(can(role, 'repositories.scan'));
  const canEdit = $derived(can(role, 'changesets.write'));

  // The id is a derived value, so a fresh row from the list does not reload the details.
  const repoId = $derived(initial.id);
  let repository = $state<RepositorySummary>(untrack(() => initial));
  let detection = $state<ProjectDetection | null>(null);
  let loaded = $state(false);
  let error = $state('');
  let tab = $state('project');
  let listingData = $state<RepositoryListing | null>(null);
  let listingEdited = $state<Listing | null>(null);
  // The target the person chose, kept for this repository while the page is open.
  let listingSelection = $state<ListingSelection>({});
  let openChangeSetId = $state<string | null>(null);
  let leaveOpen = $state(false);
  let root = $state<HTMLElement>();

  // The view just changed, so keyboard focus starts at its first control.
  onMount(() => root?.querySelector('button')?.focus());

  const dirty = $derived(listingData !== null && listingEdited !== null && hasEdits(listingData.listing, listingEdited));

  async function load() {
    error = '';
    try {
      const detail = await api.repository(workspaceId, repoId);
      repository = detail.repository;
      detection = detail.detection;
      loaded = true;
      onupdated(detail.repository);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not load the repository.';
    }
  }

  $effect(() => {
    void repoId;
    void workspaceId;
    untrack(() => {
      loaded = false;
      void load();
    });
  });

  function scanned(detail: RepositoryDetail) {
    repository = detail.repository;
    detection = detail.detection;
    onupdated(detail.repository);
  }

  function created(changeSet: ChangeSetView) {
    openChangeSetId = changeSet.id;
    tab = 'changes';
  }

  function back() {
    if (dirty) leaveOpen = true;
    else onback();
  }

  const tabs = [
    { id: 'project', label: 'Project' },
    { id: 'listing', label: 'Store listing' },
    { id: 'changes', label: 'Change sets' },
  ];
</script>

<div class="stack loose" bind:this={root}>
  <div>
    <Button variant="ghost" icon="chevron-left" onclick={back}>All repositories</Button>
  </div>

  <PageHeader title={repositoryName(repository)} level={2}>
    {#snippet actions()}
      <KindBadge kind={repository.projectKind} />
      <Button href={githubUrl(repository.owner, repository.repo)} target="_blank" icon="external-link" label="Open {repositoryName(repository)} on GitHub (opens in a new tab)">GitHub</Button>
    {/snippet}
  </PageHeader>
  <p class="meta muted">
    Default branch <code>{repository.defaultBranch}</code>. Connected
    <time datetime={new Date(repository.createdAt).toISOString()} title={fullTime(repository.createdAt)}>{timeAgo(repository.createdAt)}</time>.
  </p>

  {#if error}
    <div class="stack">
      <Alert tone="error">{error}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if !loaded}
    <div class="card" role="status" aria-label="Loading the repository">
      <div class="stack">
        <Skeleton width="30%" height="20px" />
        <Skeleton width="70%" height="14px" />
        <Skeleton width="50%" height="14px" />
      </div>
    </div>
  {:else}
    <Tabs {tabs} bind:value={tab} label="Repository sections">
      {#snippet panel(id)}
        {#if id === 'project'}
          <ProjectPanel {api} {workspaceId} {repository} {detection} {canScan} onscanned={scanned} />
        {:else if id === 'listing'}
          <ListingPanel
            {api}
            {workspaceId}
            {repository}
            {role}
            {canEdit}
            bind:data={listingData}
            bind:edited={listingEdited}
            bind:selection={listingSelection}
            oncreated={created}
          />
        {:else}
          <ChangeSetsPanel
            {api}
            {workspaceId}
            {repository}
            {role}
            {myId}
            {names}
            bind:openId={openChangeSetId}
            ongotolisting={() => (tab = 'listing')}
          />
        {/if}
      {/snippet}
    </Tabs>
  {/if}
</div>

<Modal bind:open={leaveOpen} size="sm" title="Leave without creating a change set?">
  <p>You have edited listing text that is not in a change set yet. Leaving discards those edits.</p>
  {#snippet footer()}
    <Button onclick={() => (leaveOpen = false)}>Keep editing</Button>
    <Button
      variant="danger-solid"
      onclick={() => {
        leaveOpen = false;
        onback();
      }}>Discard edits and leave</Button
    >
  {/snippet}
</Modal>

<style>
  .meta {
    margin: calc(-1 * var(--space-4)) 0 0;
  }
</style>
