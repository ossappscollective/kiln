<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import { curlExample } from '../lib/api-tokens.ts';
  import type { ApiToken, AppSummary, CreatedApiToken } from '../lib/types.ts';
  import OneTimeSecret from './automation/OneTimeSecret.svelte';
  import TokenForm from './tokens/TokenForm.svelte';
  import TokenTable from './tokens/TokenTable.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const canRead = $derived(can(role, 'tokens.read'));
  const canManage = $derived(can(role, 'tokens.manage'));

  let tokens = $state<ApiToken[] | null>(null);
  let apps = $state<AppSummary[] | null>(null);
  let error = $state('');
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();
  let adding = $state(false);
  /** The token, kept only in this component's memory until it is dismissed. */
  let created = $state<CreatedApiToken | null>(null);
  let busyId = $state('');

  async function load() {
    error = '';
    try {
      tokens = (await api.apiTokens(workspaceId)).tokens;
    } catch (e) {
      tokens = null;
      error = e instanceof ApiError ? e.message : 'Could not load API tokens.';
    }
  }

  async function loadApps() {
    try {
      apps = (await api.apps(workspaceId)).apps;
    } catch {
      apps = null;
    }
  }

  $effect(() => {
    void workspaceId;
    tokens = null;
    apps = null;
    created = null;
    adding = false;
    notice = '';
    if (canRead) {
      void load();
      if (canManage) void loadApps();
    }
  });

  async function announce(message: string) {
    notice = message;
    await tick();
    noticeEl?.focus();
  }

  async function oncreated(result: CreatedApiToken) {
    adding = false;
    created = result;
    notice = '';
    await load();
  }

  async function cancelAdd() {
    adding = false;
    await tick();
    document.getElementById('new-token')?.focus();
  }

  async function revoke(token: ApiToken) {
    busyId = token.id;
    error = '';
    try {
      await api.revokeApiToken(workspaceId, token.id);
      await load();
      await announce(`Revoked “${token.name}”. It no longer works.`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not revoke the token.';
      await load();
    } finally {
      busyId = '';
    }
  }
</script>

<section>
  <PageHeader
    title="API tokens"
    description="Let scripts, CI jobs and assistants use this workspace. A token acts for you, with the limits you give it."
  >
    {#snippet actions()}
      {#if canManage && !adding}
        <Button
          variant="primary"
          icon="plus"
          id="new-token"
          onclick={() => {
            adding = true;
            created = null;
            notice = '';
          }}>New token</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">Your role does not include API tokens. Owners and admins manage them.</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>
    {#if error}<div class="problem"><Alert tone="error">{error}</Alert></div>{/if}

    {#if created}
      <div class="block">
        <OneTimeSecret
          title="Your new token “{created.summary.name}”"
          label="API token"
          value={created.token}
          warning="Anyone with this token can act as you within its limits. Store it in your secret manager, not in code. If it leaks, revoke it here."
          ondismiss={() => (created = null)}
        >
          <details>
            <summary>Try it</summary>
            <pre class="mono text-sm">{curlExample(location.origin, workspaceId, created.token)}</pre>
          </details>
        </OneTimeSecret>
      </div>
    {/if}

    {#if adding}
      <div class="block">
        <TokenForm {api} {workspaceId} {role} {apps} {oncreated} oncancel={cancelAdd} />
      </div>
    {/if}

    {#if tokens === null && !error}
      <p class="muted">Loading…</p>
    {:else if tokens && tokens.length === 0 && !adding && !created}
      <EmptyState
        icon="shield"
        title="No API tokens yet"
        description="Make one for a script or CI job. You see the token once, so keep it somewhere safe."
      />
    {:else if tokens && tokens.length > 0}
      <TokenTable {tokens} {canManage} {busyId} onrevoke={revoke} />
    {/if}

    <p class="hint footer">Tokens cannot manage people, webhooks, credentials or other tokens. Every call is in the audit log under the token's name.</p>
  {/if}
</section>

<style>
  .block {
    margin-bottom: 20px;
  }

  .problem {
    margin-bottom: 16px;
  }

  .footer {
    margin-top: 16px;
  }

  pre {
    padding: 10px 12px;
    margin: 8px 0 0;
    overflow-x: auto;
    background: var(--surface-sunken);
    border-radius: var(--radius-sm);
  }

  .notice {
    display: none;
    padding: 10px 12px;
    margin: 0 0 16px;
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-radius: var(--radius-sm);
  }

  .notice.shown {
    display: block;
  }
</style>
