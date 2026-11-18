<!--
  AppReleases: the releases the store reports for each platform in scope, grouped by track.
  Props: members (the records in scope), releases (by app id), now, canSync, syncing (by app id), onsync.
-->
<script lang="ts">
  import { groupReleases } from '../../lib/portfolio.ts';
  import type { AppSummary, ReleaseSummary } from '../../lib/types.ts';
  import ReleaseGroupCard from '../portfolio/ReleaseGroupCard.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    members,
    releases,
    now,
    canSync,
    syncing,
    onsync,
  }: {
    members: AppSummary[];
    releases: Record<string, ReleaseSummary[]>;
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    onsync: (app: AppSummary) => void;
  } = $props();
</script>

<div class="stack loose">
  {#each members as app (app.id)}
    {@const groups = groupReleases(releases[app.id] ?? [])}
    <section class="stack loose" aria-label="{app.platform === 'ios' ? 'iOS' : 'Android'} releases">
      {#if members.length > 1}<h2 class="plat"><PlatformBadge platform={app.platform} tinted /></h2>{/if}
      {#if groups.length === 0}
        <div class="card">
          <EmptyState
            icon="box"
            title={app.lastSyncedAt === null ? 'Not synced yet' : 'No releases reported'}
            description={app.lastSyncedAt === null
              ? 'Adding an app does not contact the store. A sync reads its versions and tracks.'
              : 'The last sync found no versions or tracks for this app.'}
          >
            {#snippet actions()}
              {#if canSync}
                <Button variant="primary" icon="refresh" loading={syncing[app.id] === true} onclick={() => onsync(app)}>Sync now</Button>
              {:else}
                <span class="muted">A member or admin can run the first sync.</span>
              {/if}
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        {#each groups as group (group.key)}
          <ReleaseGroupCard {group} {now} />
        {/each}
      {/if}
    </section>
  {/each}
  <p class="muted snapshot">
    This is a snapshot of the store, not a history. Each sync replaces it, and a version the store no longer reports disappears.
  </p>
</div>

<style>
  .plat {
    margin: 0;
    font-size: var(--text-base);
  }

  .snapshot {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
