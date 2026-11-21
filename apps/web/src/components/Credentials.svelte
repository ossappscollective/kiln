<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { CredentialSummary, LastTest } from '../lib/types.ts';
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
      loadError = e instanceof ApiError ? e.message : 'Could not load credentials.';
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
    await changed(`Saved “${label}”. You can test it from the list.`);
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
  <PageHeader title="Credentials" description="The store and repository keys this workspace uses. They are encrypted, and a secret is never shown again after saving.">
    {#snippet actions()}
      {#if canWrite && !adding}
        <Button
          variant="primary"
          icon="plus"
          id="add-credential"
          onclick={() => {
            adding = true;
            notice = '';
          }}>Add credential</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">Your role does not include viewing credentials.</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>

    {#if adding}
      <CredentialForm {api} {workspaceId} onSaved={saved} onCancel={cancelAdd} />
    {/if}

    {#if loadError}<Alert tone="error">{loadError}</Alert>{/if}

    {#if items === null && !loadError}
      <p class="muted">Loading…</p>
    {:else if items && items.length === 0 && !adding}
      <div class="card empty">
        <EmptyState
          icon="key"
          title="No credentials yet"
          description={canWrite ? 'Add the key that connects your App Store Connect, Google Play or GitHub account. Each type has a step-by-step guide.' : 'An admin or owner adds the keys that connect the stores and repositories.'}
        >
          {#snippet actions()}
            {#if canWrite}<Button variant="primary" icon="plus" onclick={() => (adding = true)}>Add credential</Button>{/if}
          {/snippet}
        </EmptyState>
        <p class="row stores">
          <StoreBadge store="app_store" variant="full" />
          <StoreBadge store="google_play" variant="full" />
          <StoreBadge store="github" variant="full" />
        </p>
      </div>
    {:else if items && items.length > 0}
      <Section title="Saved credentials" key="saved" count={items.length} flush>
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
    border-radius: 6px;
  }

  .notice.shown {
    display: block;
  }
</style>
