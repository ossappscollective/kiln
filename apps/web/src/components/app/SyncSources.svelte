<!--
  SyncSources: the list of everything the app is synced from, inside the Status popover: per source (and per platform when several are in
  scope) its name, its state (words, never colour alone), when it was last read and, when it failed or was never read, what to try. This is the ONE
  place for sync details; the header's Sync runs all of it and pages only say "Updated X ago". Readings are the sources' own stored status (no store
  is called). While a run is going each source shows its own progress (lib/sync-run.svelte.ts).
  Props: api, workspaceId, role, members (the records in scope), now, refreshKey (changes when a sync ended, so the list reads again).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { formatRelativeTime } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { loadReadings } from '../../lib/sync-readings.ts';
  import { syncRun } from '../../lib/sync-run.svelte.ts';
  import { SYNC_KINDS, type SourceInput, buildSourceRows } from '../../lib/sync-sources.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, role, members, now, refreshKey = 0 }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined } = $props();

  let inputs = $state<SourceInput[] | null>(null);
  let generation = 0;
  $effect(() => {
    void refreshKey;
    void syncRun.active;
    const ids = members.map((m) => m.id).join(',');
    void ids;
    untrack(() => {
      const mine = ++generation;
      void loadReadings(api, workspaceId, role, members, SYNC_KINDS).then((read) => {
        if (mine === generation) inputs = read;
      });
    });
  });

  const rows = $derived(buildSourceRows(inputs ?? [], syncRun.runs));
  const several = $derived(members.length > 1);
  const stateKey = { ok: k('app:sync.state.ok'), failed: k('app:sync.state.failed'), never: k('app:sync.state.never'), running: k('app:sync.state.running') } as const;
  const tone = { ok: 'ok', failed: 'bad', never: 'warn', running: 'info' } as const;
</script>

<section class="sources" aria-label={t('app:sync.sourcesLabel')} data-testid="sync-sources">
  <h3>{t('app:sync.sourcesTitle')}</h3>
  {#if inputs === null}
    <Skeleton width="100%" height="64px" />
  {:else if rows.length === 0}
    <p class="muted">{t('app:sync.none')}</p>
  {:else}
    <ul>
      {#each rows as r (r.key)}
        <li data-state={r.state}>
          <div class="line">
            <strong>{r.label}</strong>
            {#if several}<span class="muted">{platformLabel(r.platform as never)}</span>{/if}
            <Badge tone={tone[r.state]} dot>{t(stateKey[r.state])}</Badge>
            <span class="muted when">{r.lastReadAt === null ? t('app:sync.neverRead') : t('app:sync.lastRead', { ago: formatRelativeTime(r.lastReadAt, { now }) })}</span>
          </div>
          {#if r.hint}<p class="hint">{r.hint}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .sources {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  ul {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) 0;
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .when {
    margin-left: auto;
  }

  .hint {
    margin: 0;
    color: var(--muted);
  }

  .muted {
    color: var(--muted);
  }
</style>
