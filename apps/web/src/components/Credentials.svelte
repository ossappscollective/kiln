<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import type { CredentialSummary, LastTest } from '../lib/types.ts';
  import CredentialForm from './credentials/CredentialForm.svelte';
  import CredentialTable from './credentials/CredentialTable.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'credentials.read'));
  const canWrite = $derived(can(role, 'credentials.write'));

  let items = $state<CredentialSummary[] | null>(null);
  let loadError = $state('');
  let adding = $state(false);
  /** A short confirmation after saving, replacing or deleting. Focus moves to it. */
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();
  let addButton = $state<HTMLButtonElement>();

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
    addButton?.focus();
  }

  function tested(id: string, lastTest: LastTest) {
    if (items) items = items.map((item) => (item.id === id ? { ...item, lastTest } : item));
  }
</script>

<section>
  <header>
    <div>
      <h2>Credentials</h2>
      <p class="muted">
        Store and repository keys, encrypted at rest. Secrets are never shown again after saving.
      </p>
    </div>
    {#if canWrite && !adding}
      <button
        class="primary"
        bind:this={addButton}
        onclick={() => {
          adding = true;
          notice = '';
        }}>Add credential</button
      >
    {/if}
  </header>

  {#if !canRead}
    <p class="alert info">Your role does not include viewing credentials.</p>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>

    {#if adding}
      <CredentialForm {api} {workspaceId} onSaved={saved} onCancel={cancelAdd} />
    {/if}

    {#if loadError}<p class="alert error" role="alert">{loadError}</p>{/if}

    {#if items === null && !loadError}
      <p class="muted">Loading…</p>
    {:else if items && items.length === 0 && !adding}
      <div class="card empty">
        <p><strong>No credentials yet.</strong></p>
        <p class="muted">
          Add an App Store Connect key, a Google Play service account and a GitHub App to connect your
          stores and repositories. Each type comes with a step-by-step guide, and you can test a
          credential before you save it.
        </p>
      </div>
    {:else if items && items.length > 0}
      <CredentialTable
        {api}
        {workspaceId}
        {items}
        {canWrite}
        onChanged={changed}
        onTested={tested}
        onError={(message) => (loadError = message)}
      />
    {/if}
  {/if}
</section>

<style>
  header {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  header p {
    margin: 4px 0 0;
  }

  .empty {
    margin-bottom: 20px;
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
