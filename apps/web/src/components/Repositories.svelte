<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import { t } from '../lib/i18n/t.ts';
  import { resolveChangeSetReview, takeChangeSetReview } from '../lib/repository-intent.ts';
  import { repositoryName } from '../lib/repositories.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import type { RepositorySummary } from '../lib/types.ts';
  import ConnectForm from './repositories/ConnectForm.svelte';
  import RepositoryDetail from './repositories/RepositoryDetail.svelte';
  import RepositoryList from './repositories/RepositoryList.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Skeleton from './ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'repositories.read'));
  const canConnect = $derived(can(role, 'repositories.write'));

  let items = $state<RepositorySummary[] | null>(null);
  let error = $state('');
  let connecting = $state(false);
  /** The repository that is open. A copy taken when it was opened; the details load their own. */
  let selected = $state<RepositorySummary | null>(null);
  /** A change set to open on the Changes tab of the selected repository (the link from the Listing tab). */
  let initialChangeSetId = $state<string | null>(null);
  let busyId = $state('');
  let myId = $state('');
  /** Display names by user id, to say who made a change set. Empty when the role cannot list members. */
  let names = $state<Record<string, string>>({});

  async function load() {
    error = '';
    try {
      items = (await api.repositories(workspaceId)).repositories;
    } catch (e) {
      items = null;
      error = e instanceof ApiError ? e.message : t('repositories:page.loadFailed');
      return;
    }
    openRequestedChangeSet(items);
  }

  /** "Review the draft" on the Listing tab left an intent: open its repository with that change set. */
  function openRequestedChangeSet(list: RepositorySummary[]) {
    const found = resolveChangeSetReview(takeChangeSetReview(), list);
    if (!found) return;
    if ('missing' in found) {
      toast.info(t('repositories:page.changeSetGone'));
      return;
    }
    initialChangeSetId = found.changeSetId;
    selected = found.repository;
  }

  async function loadPeople() {
    try {
      const me = await api.me();
      myId = me.user.id;
    } catch {
      // Without it the screen only says "A team member" where it would say "You".
    }
    if (!can(role, 'members.read')) return;
    try {
      const { members } = await api.members(workspaceId);
      const byId: Record<string, string> = {};
      for (const member of members) byId[member.userId] = member.displayName;
      names = byId;
    } catch {
      names = {};
    }
  }

  $effect(() => {
    void workspaceId;
    items = null;
    selected = null;
    initialChangeSetId = null;
    names = {};
    if (canRead) {
      void load();
      void loadPeople();
    }
  });

  function patch(repository: RepositorySummary) {
    if (items) items = items.map((item) => (item.id === repository.id ? repository : item));
  }

  async function connected(repository: RepositorySummary) {
    toast.success(t('repositories:page.connected', { name: repositoryName(repository) }));
    await load();
    selected = repository;
  }

  async function connectedLocal(done: { kind: 'attached' | 'local_only'; repository: RepositorySummary }) {
    toast.success(
      done.kind === 'attached'
        ? t('repositories:page.attached', { name: repositoryName(done.repository) })
        : t('repositories:page.connectedLocal', { name: repositoryName(done.repository) }),
    );
    await load();
    selected = done.repository;
  }

  async function disconnect(repository: RepositorySummary) {
    busyId = repository.id;
    try {
      await api.disconnectRepository(workspaceId, repository.id);
      toast.success(t('repositories:page.disconnected', { name: repositoryName(repository) }));
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('repositories:page.disconnectFailed'));
    } finally {
      busyId = '';
    }
  }

  async function back() {
    const id = selected?.id;
    selected = null;
    initialChangeSetId = null;
    await tick();
    if (id) document.getElementById(`repo-open-${id}`)?.focus();
  }
</script>

<section>
  <PageHeader
    title={t('repositories:page.title')}
    description={t('repositories:page.description')}
  >
    {#snippet actions()}
      {#if canRead && canConnect && !selected && items !== null}
        <Button variant="primary" icon="plus" onclick={() => (connecting = true)}>{t('repositories:page.connect')}</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">{t('repositories:page.noAccess')}</Alert>
  {:else if selected}
    <RepositoryDetail {api} {workspaceId} {role} {myId} {names} initial={selected} {initialChangeSetId} onback={back} onupdated={patch} />
  {:else if error}
    <div class="stack">
      <Alert tone="error">{error}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if items === null}
    <div class="card" role="status" aria-label={t('repositories:page.loadingAria')}>
      <div class="stack">
        {#each [0, 1, 2] as i (i)}
          <div class="skeleton-row">
            <Skeleton width="{40 - i * 6}%" height="16px" />
            <Skeleton width="72px" height="20px" />
          </div>
        {/each}
      </div>
    </div>
  {:else if items.length === 0}
    <div class="card">
      <EmptyState
        icon="git-branch"
        title={t('repositories:page.emptyTitle')}
        description={canConnect ? t('repositories:page.emptyWrite') : t('repositories:page.emptyRead')}
      >
        {#snippet actions()}
          {#if canConnect}
            <Button variant="primary" icon="plus" onclick={() => (connecting = true)}>{t('repositories:page.connect')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <RepositoryList
      repositories={items}
      canWrite={canConnect}
      {busyId}
      onopen={(repository) => (selected = repository)}
      ondisconnect={disconnect}
    />
  {/if}
</section>

{#if canConnect}
  <ConnectForm {api} {workspaceId} bind:open={connecting} onconnected={connected} onlocal={connectedLocal} />
{/if}

<style>
  .skeleton-row {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    justify-content: space-between;
  }
</style>
