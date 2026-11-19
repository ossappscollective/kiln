<!--
  AppsOverview: the apps of the workspace, one merged row per app (the iOS, macOS and Android records of one
  product together): icon, stores, latest version per platform, status, rating, new reviews and the
  last sync.
  Props: rows (from buildOverviewRows), now (epoch ms), canSync (shows Sync), syncing (app ids being
  synced), locked (true while "Sync all" owns the sync buttons), onsync (called with a row's group).
-->
<script lang="ts">
  import type { AppGroup } from '../../lib/app-groups.ts';
  import { type OverviewRow, type PlatformCell } from '../../lib/app-overview.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { unfinishedItem } from '../../lib/release-pipeline.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import PendingChip from '../publish/PendingChip.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';

  let {
    rows,
    now,
    canSync,
    syncing,
    locked,
    onsync,
  }: {
    rows: OverviewRow[];
    now: number;
    canSync: boolean;
    syncing: Record<string, boolean | undefined>;
    locked: boolean;
    onsync: (group: AppGroup) => void;
  } = $props();

  /** The record whose sync says the most: one that failed, else the one synced longest ago. */
  const syncMember = (row: OverviewRow): AppSummary =>
    row.group.members.find((m) => (m.lastSyncError ?? '').trim() !== '') ??
    ([...row.group.members].sort((a, b) => (a.lastSyncedAt ?? -1) - (b.lastSyncedAt ?? -1))[0] as AppSummary);

  /** The macOS column only exists when some app has a Mac record (quiet by default). */
  const hasMac = $derived(rows.some((r) => r.macos !== null));

  const isSyncing = (group: AppGroup) => group.members.some((m) => syncing[m.id] === true);
</script>

{#snippet version(c: PlatformCell | null, platform: string)}
  {#if c === null}
    <span class="muted">Not on {platform}</span>
  {:else if c.state === 'loading'}
    <Skeleton width="56px" height="14px" />
  {:else if c.state === 'error'}
    <span class="muted">Could not load</span>
  {:else if c.latest}
    <strong>{c.latest.version}</strong>
  {:else}
    <span class="muted">None</span>
  {/if}
{/snippet}

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Apps in this workspace</caption>
    <thead>
      <tr>
        <th scope="col">App</th>
        <th scope="col">iOS</th>
        {#if hasMac}<th scope="col">macOS</th>{/if}
        <th scope="col">Android</th>
        <th scope="col">Status</th>
        <th scope="col">Rating</th>
        <th scope="col">New reviews</th>
        <th scope="col">Last synced</th>
        {#if canSync}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.group.key)}
        {@const g = row.group}
        {@const loading = [row.ios, row.macos, row.android].some((c) => c !== null && c.state === 'loading')}
        <tr>
          <td>
            <div class="app">
              <AppIcon
                name={g.name}
                url={g.members.map((m) => m.iconUrl ?? null).find((u) => u) ?? null}
                platform={g.members.length === 1 ? g.members[0]?.platform : undefined}
                seed={g.key}
                size="md"
              />
              <div class="names">
                <a id="app-open-{g.key}" class="app-name" href={appAddress(g.key)}>{g.name}</a>
                <div class="meta">
                  {#each g.members as m (m.id)}<StoreBadge store={storeForPlatform(m.platform).store} variant="icon" size="sm" />{/each}
                  <code class="identifier">{g.members[0]?.identifier}</code>
                </div>
              </div>
            </div>
          </td>
          <td>{@render version(row.ios, 'iOS')}</td>
          {#if hasMac}<td>{@render version(row.macos, 'macOS')}</td>{/if}
          <td>{@render version(row.android, 'Android')}</td>
          <td>
            <div class="status">
              {#if row.attention}
                {#if g.members.length > 1}<PlatformBadge platform={row.attention.platform} showLabel={false} />{/if}
                <ReleaseStatus status={row.attention.status} rawState={row.attention.rawState} rolloutFraction={row.attention.rolloutFraction} />
              {:else if loading}
                <Skeleton width="80px" height="20px" />
              {:else}
                <span class="muted">{g.members.every((m) => m.lastSyncedAt === null) ? 'Not synced yet' : 'No releases'}</span>
              {/if}
              {#if row.syncFailed}<Badge tone="bad" icon="alert">Sync failed</Badge>{/if}
              <PendingChip line={row.pending} href={appAddress(g.key, 'pending')} />
              {#each row.unfinished as left (left.app.id)}
                {@const item = unfinishedItem({ appId: left.app.id, platform: left.app.platform, scope: left.app.platform, several: false, stalled: left.stalled })}
                {#if item}
                  <a class="unfinished" href={item.href ?? undefined} title={item.detail ?? undefined}>
                    <Badge tone="warn" icon="clock">Release left unfinished{g.members.length > 1 ? `: ${left.app.platform === 'android' ? 'Android' : left.app.platform === 'macos' ? 'macOS' : 'iOS'}` : ''}</Badge>
                  </a>
                {/if}
              {/each}
            </div>
          </td>
          <td>
            {#if row.rating !== null}
              <span class="rating" title="{row.ratingCount} stored {row.ratingCount === 1 ? 'review' : 'reviews'}"><Icon name="star-filled" size={14} /> {row.rating.toFixed(1)}</span>
            {:else}
              <span class="muted" aria-label="No rating">–</span>
            {/if}
          </td>
          <td>
            {#if row.newReviews === null}
              <span class="muted" aria-label="Not available">–</span>
            {:else if row.newReviews > 0}
              <a href="{appAddress(g.key, 'reviews')}"><Badge tone="accent">{row.newReviews}</Badge><span class="visually-hidden"> new reviews of {g.name}</span></a>
            {:else}
              <span class="muted">0</span>
            {/if}
          </td>
          <td>
            <SyncStatus app={syncMember(row)} {now} />
          </td>
          {#if canSync}
            <td class="actions">
              <Button
                size="sm"
                icon="refresh"
                loading={isSyncing(g)}
                disabled={locked && !isSyncing(g)}
                label="Sync {g.name}"
                onclick={() => onsync(g)}>Sync</Button
              >
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .app {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-width: 200px;
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .app-name {
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .meta,
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .identifier {
    width: fit-content;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .rating {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    font-weight: var(--weight-medium);
  }

  td.actions {
    white-space: nowrap;
  }
</style>
