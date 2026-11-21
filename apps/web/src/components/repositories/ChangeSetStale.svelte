<!--
  ChangeSetStale: the "out of date" part of a change set's page. A "Check for updates" button (a
  read-only look at the repository), the banner "This change set is out of date" when an apply just
  failed because the repository moved on or the check found files that changed, and "Refresh…",
  which opens the refresh dialog.
  Props: api, workspaceId, changeSet, role, applyCode (the error code of the last apply on this
  page, or null), onrefreshed (called with the server's answer after a refresh), ondiscard (the
  refresh left nothing to apply and the person chose to discard).
  A change set made by pulling the store listing also has "Recompute from the live store" (draft,
  approved, or failed without a branch), for who may create change sets and read the listing.
  Shown only for a change set that can be refreshed, and the buttons only to who may use them.
-->
<script lang="ts">
  import { type Role } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { type RecomputeResult, canRecompute } from '../../lib/change-set-fixup.ts';
  import {
    type RefreshResult,
    type Staleness,
    canCheckForUpdates,
    canRefresh,
    fileStateInfo,
    looksStale,
    stalenessSummary,
  } from '../../lib/change-set-refresh.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ChangeSetRefreshDialog from './ChangeSetRefreshDialog.svelte';
  import RecomputeDialog from './RecomputeDialog.svelte';

  let {
    api,
    workspaceId,
    changeSet,
    role,
    applyCode = null,
    onrefreshed,
    onrecomputed,
    ondiscard,
  }: {
    api: Api;
    workspaceId: string;
    changeSet: ChangeSetView;
    role: Role;
    applyCode?: string | null | undefined;
    onrefreshed: (result: RefreshResult) => void;
    onrecomputed?: ((result: RecomputeResult) => void) | undefined;
    ondiscard: () => void;
  } = $props();

  let checking = $state(false);
  let checked = $state<Staleness | null>(null);
  let checkError = $state('');
  let dialogOpen = $state(false);
  let recomputeOpen = $state(false);

  const mayCheck = $derived(canCheckForUpdates(role, changeSet));
  const mayRefresh = $derived(canRefresh(role, changeSet));
  const mayRecompute = $derived(canRecompute(role, changeSet));
  const stale = $derived(looksStale(changeSet, applyCode) || checked?.stale === true);
  const changedFiles = $derived((checked?.files ?? []).filter((f) => f.state !== 'same'));

  // What was checked belongs to the change set as it was: a new version starts again.
  const version = $derived(`${changeSet.id}@${changeSet.updatedAt}`);
  $effect(() => {
    void version;
    checked = null;
    checkError = '';
  });

  async function check() {
    if (checking) return;
    checking = true;
    checkError = '';
    try {
      checked = await api.changeSetStaleness(workspaceId, changeSet.id);
    } catch (e) {
      checked = null;
      checkError = e instanceof ApiError ? e.message : t('repositories:stale.checkFailed');
    } finally {
      checking = false;
    }
  }
</script>

{#if (mayCheck || mayRefresh) && (stale || mayCheck)}
  <div class="stack">
    {#if stale}
      <Alert tone="warn" title={t('repositories:stale.title')}>
        <p class="tight">
          {#if checked?.stale}
            {stalenessSummary(checked)}
          {:else}
            {t('repositories:stale.changed')}
          {/if}
          {#if mayRefresh}
            {t('repositories:stale.refreshHint')}
          {:else}
            {t('repositories:stale.askHint')}
          {/if}
        </p>
        {#if changedFiles.length > 0}
          <ul class="files">
            {#each changedFiles as file (file.path)}
              <li><code>{file.path}</code> <Badge tone={fileStateInfo[file.state].tone}>{fileStateInfo[file.state].label}</Badge></li>
            {/each}
          </ul>
        {/if}
        {#if mayRefresh}
          <div class="row tight-row">
            <Button variant="primary" icon="refresh" onclick={() => (dialogOpen = true)}>{t('repositories:stale.refresh')}</Button>
          </div>
        {/if}
      </Alert>
    {/if}

    {#if mayCheck}
      <div class="row check-row">
        <Button size="sm" icon="refresh" loading={checking} onclick={check}>{checking ? t('repositories:stale.checking') : t('repositories:stale.check')}</Button>
        {#if checked && !checked.stale}
          <span class="muted small" role="status">{stalenessSummary(checked)}</span>
        {/if}
        {#if checkError}<span class="error small" role="alert">{checkError}</span>{/if}
      </div>
    {/if}
  </div>

  <ChangeSetRefreshDialog
    {api}
    {workspaceId}
    {changeSet}
    bind:open={dialogOpen}
    onrefreshed={(result) => {
      checked = null;
      onrefreshed(result);
    }}
    {ondiscard}
  />
{/if}

{#if mayRecompute}
  <div class="row check-row recompute">
    <Button size="sm" icon="refresh" onclick={() => (recomputeOpen = true)}>{t('repositories:stale.recompute')}</Button>
    <span class="muted small">{t('repositories:stale.recomputeHint')}</span>
  </div>
  <RecomputeDialog
    {api}
    {workspaceId}
    {changeSet}
    {role}
    bind:open={recomputeOpen}
    onrecomputed={(result) => {
      checked = null;
      onrecomputed?.(result);
    }}
    {ondiscard}
  />
{/if}

<style>
  .recompute {
    margin-top: var(--space-3);
  }

  .files {
    margin: var(--space-2) 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-1);
  }

  .files li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    overflow-wrap: anywhere;
  }

  .tight-row {
    margin-top: var(--space-3);
  }

  .check-row {
    align-items: center;
    gap: var(--space-3);
  }

  .error {
    color: var(--bad-ink);
  }
</style>
