<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import { t } from '../lib/i18n/t.ts';
  import type { CredentialSummary, LastTest } from '../lib/types.ts';
  import ConnectBanner from './connect/ConnectBanner.svelte';
  import CredentialForm from './credentials/CredentialForm.svelte';
  import CredentialTable from './credentials/CredentialTable.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import Section from './ui/Section.svelte';
  import StoreBadge from './ui/StoreBadge.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'credentials.read'));
  const canWrite = $derived(can(role, 'credentials.write'));

  let items = $state<CredentialSummary[] | null>(null);
  let loadError = $state('');
  let adding = $state(false);
  /** A short confirmation after saving, replacing or deleting. Focus moves to it. */
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();

  async function load() {
    loadError = '';
    try {
      items = (await api.credentials(workspaceId)).credentials;
    } catch (e) {
      items = null;
      loadError = e instanceof ApiError ? e.message : t('credentials:page.loadFailed');
    }
  }

  $effect(() => {
    // Reload when the workspace changes.
    void workspaceId;
    items = null;
    adding = false;
    notice = '';
    if (canRead) void load();
  });

  async function announce(message: string) {
    notice = message;
    await tick();
    noticeEl?.focus();
  }

  async function changed(message: string) {
    await load();
    await announce(message);
  }

  async function saved(label: string) {
    adding = false;
    await changed(t('credentials:page.saved', { label }));
  }

  async function cancelAdd() {
    adding = false;
    await tick();
    document.getElementById('add-credential')?.focus();
  }

  function tested(id: string, lastTest: LastTest) {
    if (items) items = items.map((item) => (item.id === id ? { ...item, lastTest } : item));
  }
</script>

<section>
  <PageHeader title={t('credentials:page.title')} description={t('credentials:page.description')}>
    {#snippet actions()}
      {#if canWrite && !adding}
        <Button
          variant="primary"
          icon="plus"
          id="add-credential"
          onclick={() => {
            adding = true;
            notice = '';
          }}>{t('credentials:page.add')}</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">{t('credentials:page.noAccess')}</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>

    <ConnectBanner {api} {workspaceId} {role} context="credentials" refreshKey={items} />

    {#if adding}
      <CredentialForm {api} {workspaceId} onSaved={saved} onCancel={cancelAdd} />
    {/if}

    {#if loadError}<Alert tone="error">{loadError}</Alert>{/if}

    {#if items === null && !loadError}
      <p class="muted">{t('credentials:page.loading')}</p>
    {:else if items && items.length === 0 && !adding}
      <div class="card empty">
        <EmptyState
          icon="key"
          title={t('credentials:empty.title')}
          description={canWrite ? t('credentials:empty.descriptionWrite') : t('credentials:empty.descriptionRead')}
        >
          {#snippet actions()}
            {#if canWrite}<Button variant="primary" icon="plus" onclick={() => (adding = true)}>{t('credentials:page.add')}</Button>{/if}
          {/snippet}
        </EmptyState>
        <p class="row stores">
          <StoreBadge store="app_store" variant="full" />
          <StoreBadge store="google_play" variant="full" />
          <StoreBadge store="github" variant="full" />
        </p>
      </div>
    {:else if items && items.length > 0}
      <Section title={t('credentials:list.title')} key="saved" count={items.length} flush>
        <CredentialTable
          {api}
          {workspaceId}
          {items}
          {canWrite}
          onChanged={changed}
          onTested={tested}
          onError={(message) => (loadError = message)}
        />
      </Section>
    {/if}
  {/if}
</section>

<style>
  .empty {
    margin-bottom: 20px;
  }

  .stores {
    justify-content: center;
    margin: 0;
  }

  .notice {
    display: none;
    margin: 0 0 16px;
    padding: 10px 12px;
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-radius: var(--radius-sm);
  }

  .notice.shown {
    display: block;
  }
</style>
