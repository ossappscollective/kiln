<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { ApiError, type Api } from '../lib/api.ts';
  import { curlExample } from '../lib/api-tokens.ts';
  import { t } from '../lib/i18n/t.ts';
  import type { ApiToken, AppSummary, CreatedApiToken } from '../lib/types.ts';
  import OneTimeSecret from './automation/OneTimeSecret.svelte';
  import TokenForm from './tokens/TokenForm.svelte';
  import TokenTable from './tokens/TokenTable.svelte';
  import Alert from './ui/Alert.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import { readApps } from '../lib/app-state/workspace-reads.ts';

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
      error = e instanceof ApiError ? e.message : t('workspace:tokens.page.loadFailed');
    }
  }

  async function loadApps() {
    try {
      apps = (await readApps(api, workspaceId)).apps;
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
      await announce(t('workspace:tokens.page.revoked', { name: token.name }));
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('workspace:tokens.page.revokeFailed');
      await load();
    } finally {
      busyId = '';
    }
  }
</script>

<section>
  <PageHeader
    title={t('workspace:tokens.page.title')}
    description={t('workspace:tokens.page.description')}
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
          }}>{t('workspace:tokens.page.new')}</Button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if !canRead}
    <Alert tone="info">{t('workspace:tokens.page.noRead')}</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>
    {#if error}<div class="problem"><Alert tone="error">{error}</Alert></div>{/if}

    {#if created}
      <div class="block">
        <OneTimeSecret
          title={t('workspace:tokens.page.createdTitle', { name: created.summary.name })}
          label={t('workspace:tokens.page.createdLabel')}
          value={created.token}
          warning={t('workspace:tokens.page.createdWarning')}
          ondismiss={() => (created = null)}
        >
          <details>
            <summary>{t('workspace:tokens.page.tryIt')}</summary>
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
      <p class="muted">{t('workspace:tokens.page.loading')}</p>
    {:else if tokens && tokens.length === 0 && !adding && !created}
      <EmptyState
        icon="shield"
        title={t('workspace:tokens.page.emptyTitle')}
        description={t('workspace:tokens.page.emptyText')}
      />
    {:else if tokens && tokens.length > 0}
      <TokenTable {tokens} {canManage} {busyId} onrevoke={revoke} />
    {/if}

    <p class="hint footer">{t('workspace:tokens.page.footer')}</p>
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
