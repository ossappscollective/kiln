<!--
  RepositoryDetail: one connected repository: a Local clone card (where its files are read from),
  then four tabs: the detected project, the store listing, the change sets, and CI (workflows and
  runs). A local-only repository (a folder, no GitHub) has no CI tab and no GitHub link.
  Props: api, workspaceId, role, myId, names (user id to display name), initial (the row from the
  list, shown while the details load), initialChangeSetId? (a change set to open on the Change sets
  tab, from the link on the Listing tab), onback, onupdated (called with a fresh repository row).
-->
<script lang="ts">
  import { type Listing, type Role, can } from '@kiln/core';
  import { onMount, untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { githubUrl, hasEdits, repositoryName } from '../../lib/repositories.ts';
  import type {
    ChangeSetView,
    ProjectDetection,
    ListingSelection,
    LocalConfig,
    RepositoryDetail,
    RepositoryListing,
    RepositorySummary,
  } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import CiPanel from '../ci/CiPanel.svelte';
  import ChangeSetsPanel from './ChangeSetsPanel.svelte';
  import CloneCard from './CloneCard.svelte';
  import KindBadge from './KindBadge.svelte';
  import LocalCheckoutCard from './LocalCheckoutCard.svelte';
  import ListingPanel from './ListingPanel.svelte';
  import ProjectPanel from './ProjectPanel.svelte';

  let {
    api,
    workspaceId,
    role,
    myId,
    names,
    initial,
    initialChangeSetId = null,
    onback,
    onupdated,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    myId: string;
    names: Record<string, string>;
    initial: RepositorySummary;
    initialChangeSetId?: string | null | undefined;
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
  // Opened from a link to a change set: start on the Change sets tab, with it open.
  let tab = $state(untrack(() => (initialChangeSetId ? 'changes' : 'project')));
  let listingData = $state<RepositoryListing | null>(null);
  let listingEdited = $state<Listing | null>(null);
  // The target the person chose, kept for this repository while the page is open.
  let listingSelection = $state<ListingSelection>({});
  let openChangeSetId = $state<string | null>(untrack(() => initialChangeSetId));
  let leaveOpen = $state(false);
  /** Whether local clones are on, for the Local clone card. Null while it loads or when it cannot be read. */
  let localConfig = $state<LocalConfig | null>(null);
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
      error = e instanceof ApiError ? e.message : t('repositories:detail.loadFailed');
    }
  }

  async function loadLocalConfig() {
    try {
      localConfig = (await api.localConfig(workspaceId)).local;
    } catch {
      // The card still shows the stored folder; it only cannot say whether the feature is on.
      localConfig = null;
    }
  }

  $effect(() => {
    void repoId;
    void workspaceId;
    untrack(() => {
      loaded = false;
      void load();
      void loadLocalConfig();
    });
  });

  /** The folder was attached, changed or detached: reads now come from somewhere else. */
  function localChanged(saved: RepositorySummary) {
    repository = saved;
    onupdated(saved);
  }

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

  // CI runs on GitHub: a local-only repository has none.
  const tabs = $derived([
    { id: 'project', label: t('repositories:detail.tabProject') },
    { id: 'listing', label: t('repositories:detail.tabListing') },
    { id: 'changes', label: t('repositories:detail.tabChanges') },
    ...(repository.localOnly ? [] : [{ id: 'ci', label: t('repositories:detail.tabCi') }]),
  ]);
</script>

<div class="stack loose" bind:this={root}>
  <div>
    <Button variant="ghost" icon="chevron-left" onclick={back}>{t('repositories:detail.back')}</Button>
  </div>

  <PageHeader title={repositoryName(repository)} level={2}>
    {#snippet actions()}
      <KindBadge kind={repository.projectKind} />
      {#if repository.localOnly}
        <Badge tone="info">{t('repositories:list.localOnly')}</Badge>
      {:else}
        <Button href={githubUrl(repository.owner, repository.repo)} target="_blank" icon="external-link" label={t('repositories:detail.githubAria', { name: repositoryName(repository) })}>{t('repositories:list.github')}</Button>
      {/if}
    {/snippet}
  </PageHeader>
  <p class="meta muted">
    {#if repository.localOnly}
      <T key="repositories:detail.metaBranch" params={{ branch: repository.defaultBranch, ago: formatRelativeTime(repository.createdAt) }} tags={{ link: createdTime }} />
    {:else}
      <T key="repositories:detail.metaDefaultBranch" params={{ branch: repository.defaultBranch, ago: formatRelativeTime(repository.createdAt) }} tags={{ link: createdTime }} />
    {/if}
  </p>

  <LocalCheckoutCard {api} {workspaceId} {repository} {role} config={localConfig} onchanged={localChanged} />
  <CloneCard {api} {workspaceId} {repository} {role} />

  {#if error}
    <div class="stack">
      <Alert tone="error">{error}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if !loaded}
    <div class="card" role="status" aria-label={t('repositories:detail.loadingAria')}>
      <div class="stack">
        <Skeleton width="30%" height="20px" />
        <Skeleton width="70%" height="14px" />
        <Skeleton width="50%" height="14px" />
      </div>
    </div>
  {:else}
    <Tabs {tabs} bind:value={tab} label={t('repositories:detail.tabsLabel')}>
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
        {:else if id === 'ci'}
          <CiPanel {api} {workspaceId} {repository} {role} />
        {:else}
          <ChangeSetsPanel
            {api}
            {workspaceId}
            {repository}
            {role}
            {myId}
            {names}
            bind:openId={openChangeSetId}
            {localConfig}
            ongotolisting={() => (tab = 'listing')}
          />
        {/if}
      {/snippet}
    </Tabs>
  {/if}
</div>

{#snippet createdTime(text: string)}
  <time datetime={new Date(repository.createdAt).toISOString()} title={formatDateTime(repository.createdAt)}>{text}</time>
{/snippet}

<Modal bind:open={leaveOpen} size="sm" title={t('repositories:detail.leaveTitle')}>
  <p>{t('repositories:detail.leaveBody')}</p>
  {#snippet footer()}
    <Button onclick={() => (leaveOpen = false)}>{t('repositories:detail.keepEditing')}</Button>
    <Button
      variant="danger-solid"
      onclick={() => {
        leaveOpen = false;
        onback();
      }}>{t('repositories:detail.discardLeave')}</Button
    >
  {/snippet}
</Modal>

<style>
  .meta {
    margin: calc(-1 * var(--space-4)) 0 0;
  }
</style>
