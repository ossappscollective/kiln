<!--
  StatusPopover: the small "Status" button of the app header. It holds what used to crowd the header: where the data lives (the
  Repository and Store live chips), each store record with its full bundle id or package name (it wraps, never cut off) and when it
  was last synced, and the ONE "Sync now" action of the app. A failed sync turns the button's icon into a warning. The full store and
  credential details stay in the app settings (the link at the bottom).
  Props: members (the records in scope), chips (lib/app-chips.ts), now (epoch ms), canSync, syncing (any record is syncing),
  onsync (sync every record in scope), settingsHref (the app settings page).
-->
<script lang="ts">
  import { OPEN_STATUS_EVENT, statusDot } from '../../lib/app-page.ts';
  import type { DataChip } from '../../lib/app-chips.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import SyncStatus from '../portfolio/SyncStatus.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import DataChips from './DataChips.svelte';
import { platformMeta } from '@kiln/core';

  let {
    members,
    chips,
    now,
    canSync,
    syncing,
    onsync,
    settingsHref,
  }: {
    members: AppSummary[];
    chips: DataChip[];
    now: number;
    canSync: boolean;
    syncing: boolean;
    onsync: () => void;
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

<InfoTip label="Status: stores, bundle ids and sync" buttonText="Status" icon={dot === 'warn' ? 'alert-triangle' : 'activity'} align="end" width="26rem" bind:open>
  <div class="status">
    <DataChips {chips} />
    <ul class="records">
      {#each members as m (m.id)}
        <li>
          <div class="head">
            <StoreBadge store={storeForPlatform(m.platform).store} size="sm" />
            <code>{m.identifier}</code>
            <CopyButton value={m.identifier} iconOnly label="Copy the {platformMeta(m.platform).identifierNoun}" />
          </div>
          <SyncStatus app={m} {now} />
        </li>
      {/each}
    </ul>
    <div class="foot">
      {#if canSync}
        <Button variant="primary" size="sm" icon="refresh" loading={syncing} onclick={onsync}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
      {/if}
      <a href={settingsHref}>Store and credential details</a>
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
