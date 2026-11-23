<!--
  UpdatedLine: the quiet line that replaced the sync buttons of a page: "Updated 5 minutes ago" for the sources this page shows, or, when one could
  not be read, "Could not read reviews" with a button to the Status popover (the one place for sync details and the header Sync that runs it). Never
  a sync button of its own. Readings are stored status; no store is called.
  Props: api, workspaceId, role, apps (the records the page shows), kinds (the sources the page shows), now, refreshKey (changes when a sync ended).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { openStatusPopover } from '../../lib/app-page.ts';
  import { formatRelativeTime } from '../../lib/i18n/format.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { loadReadings } from '../../lib/sync-readings.ts';
  import { syncRun } from '../../lib/sync-run.svelte.ts';
  import { type SourceInput, type SyncKind, buildSourceRows, kindLabel, pageStatus } from '../../lib/sync-sources.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  let {
    api,
    workspaceId,
    role,
    apps,
    kinds,
    now = undefined,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; apps: AppSummary[]; kinds: SyncKind[]; now?: number | undefined; refreshKey?: number | undefined } = $props();

  /** The page's clock when it has one, else the time of the last read. */
  let readAt = $state(Date.now());
  const clock = $derived(now ?? readAt);

  let inputs = $state<SourceInput[] | null>(null);
  let generation = 0;
  $effect(() => {
    void refreshKey;
    void syncRun.active;
    void apps.map((a) => a.id).join(',');
    untrack(() => {
      const mine = ++generation;
      void loadReadings(api, workspaceId, role, apps, kinds).then((read) => {
        if (mine !== generation) return;
        inputs = read;
        readAt = Date.now();
      });
    });
  });

  const status = $derived(pageStatus(buildSourceRows(inputs ?? [], syncRun.runs), kinds));
</script>

{#if inputs !== null}
  <p class="updated text-sm" data-testid="updated-line" class:bad={status.failed.length > 0}>
    {#if syncRun.active}
      {t('app:sync.running')}
    {:else if status.failed.length > 0}
      <Icon name="alert-triangle" size={14} />
      <span>{t('app:sync.couldNotRead', { what: formatList(status.failed.map(kindLabel)) })}</span>
      <Button size="sm" variant="link" onclick={() => openStatusPopover()}>{t('app:sync.seeStatus')}</Button>
    {:else if status.newest === null}
      <span class="muted">{t('app:sync.notReadYet')}</span>
      <Button size="sm" variant="link" onclick={() => openStatusPopover()}>{t('app:sync.seeStatus')}</Button>
    {:else}
      <button type="button" class="link" onclick={() => openStatusPopover()}>{t('app:sync.updated', { ago: formatRelativeTime(status.newest, { now: clock }) })}</button>
    {/if}
  </p>
{/if}

<style>
  .updated {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
    color: var(--muted);
  }

  .updated.bad {
    color: var(--bad-ink);
  }

  .link {
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    background: none;
    border: 0;
    border-bottom: 1px dotted currentcolor;
  }

  .link:hover {
    color: var(--ink);
  }

  .link:focus-visible {
    outline: var(--ring);
    outline-offset: 2px;
  }
</style>
