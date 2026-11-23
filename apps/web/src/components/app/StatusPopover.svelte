<!--
  StatusPopover: the small "Status" button of the app header. It holds what used to crowd the header: where the data lives (the
  Repository and Store live chips), each store record with its full bundle id or package name (it wraps, never cut off) and when it
  was last synced, and THE place for sync details: every source the app is synced from (SyncSources: state, last read, what to try, and the progress
  of a run). There is no Sync button here: the one Sync is in the header and runs all of it. A failed sync turns the button's icon into a warning.
  The full store and credential details stay in the app settings (the link at the bottom).
  Props: api, workspaceId, role, members (the records in scope), chips (lib/app-chips.ts), now (epoch ms), syncing (a run is going), syncRuns
  (changes when a run ended, so the sources are read again), settingsHref (the app settings page).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { OPEN_STATUS_EVENT, statusDot } from '../../lib/app-page.ts';
  import type { DataChip } from '../../lib/app-chips.ts';
  import { copyIdentifierLabel } from '../../lib/portfolio.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import SyncStatus from '../portfolio/SyncStatus.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import DataChips from './DataChips.svelte';
  import SyncSources from './SyncSources.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    chips,
    now,
    syncing,
    syncRuns = 0,
    settingsHref,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    chips: DataChip[];
    now: number;
    syncing: boolean;
    syncRuns?: number | undefined;
    settingsHref: string;
  } = $props();

  const dot = $derived(statusDot(members));
  let open = $state(false);

  // A page that points to "Sync now" (the store listing) opens this popover instead of carrying a second Sync button.
  $effect(() => {
    const show = (event: Event) => {
      event.preventDefault();
      open = true;
    };
    window.addEventListener(OPEN_STATUS_EVENT, show);
    return () => window.removeEventListener(OPEN_STATUS_EVENT, show);
  });
</script>

<InfoTip label={t('app:statusPopover.label')} buttonText={t('app:statusPopover.button')} icon={dot === 'warn' ? 'alert-triangle' : 'activity'} align="end" width="26rem" bind:open>
  <div class="status">
    <DataChips {chips} />
    <ul class="records">
      {#each members as m (m.id)}
        <li>
          <div class="head">
            <StoreBadge store={storeForPlatform(m.platform).store} size="sm" />
            <code>{m.identifier}</code>
            <CopyButton value={m.identifier} iconOnly label={copyIdentifierLabel(m.platform)} />
          </div>
          <SyncStatus app={m} {now} />
        </li>
      {/each}
    </ul>
    {#if open}<SyncSources {api} {workspaceId} {role} {members} {now} refreshKey={syncRuns} />{/if}
    <div class="foot">
      {#if syncing}<span class="muted" role="status">{t('app:statusPopover.syncing')}</span>{/if}
      <a href={settingsHref}>{t('app:statusPopover.details')}</a>
    </div>
  </div>
</InfoTip>

<style>
  .status {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  .records {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  /* The bundle id wraps, so a narrow window never cuts it off. */
  code {
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
  }
</style>
