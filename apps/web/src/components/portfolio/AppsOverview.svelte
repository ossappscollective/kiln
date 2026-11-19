<!--
  AppsOverview: the apps of the workspace, one merged row per app (the iOS, macOS and Android records of one
  product together): icon, the bundle id (a wrapping mono chip), the latest version of each platform in ONE column, ONE status pill
  with an "N pending" badge and one count for releases left unfinished (rowStatus), the rating with the new reviews, and the last
  sync. Five columns, so the table stays readable at 800 px.
  Props: rows (from buildOverviewRows), now (epoch ms), canSync (shows Sync), syncing (app ids being
  synced), locked (true while "Sync all" owns the sync buttons), onsync (called with a row's group).
-->
<script lang="ts">
  import type { Platform } from '@mrm/core';
  import type { AppGroup } from '../../lib/app-groups.ts';
  import { type OverviewRow, type PlatformCell, rowStatus } from '../../lib/app-overview.ts';
  import { appAddress } from '../../lib/app-scope.ts';
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

  const isSyncing = (group: AppGroup) => group.members.some((m) => syncing[m.id] === true);
</script>

{#snippet version(c: PlatformCell | null, platform: Platform)}
  {#if c !== null}
    <li class="ver">
      <PlatformBadge {platform} showLabel={false} />
      {#if c.state === 'loading'}
        <Skeleton width="56px" height="14px" />
      {:else if c.state === 'error'}
        <span class="muted">Could not load</span>
      {:else if c.latest}
        <strong>{c.latest.version}</strong>
      {:else}
        <span class="muted">None</span>
      {/if}
    </li>
  {/if}
{/snippet}

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">Apps in this workspace</caption>
    <thead>
      <tr>
        <th scope="col">App</th>
        <th scope="col">Latest version</th>
        <th scope="col">Status</th>
        <th scope="col">Reviews</th>
        <th scope="col">Last synced</th>
        {#if canSync}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.group.key)}
        {@const g = row.group}
        {@const loading = [row.ios, row.macos, row.android].some((c) => c !== null && c.state === 'loading')}
        {@const status = rowStatus(row, loading)}
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
          <td>
            <ul class="versions" aria-label="Latest version per platform">
              {@render version(row.ios, 'ios')}
              {@render version(row.macos, 'macos')}
              {@render version(row.android, 'android')}
            </ul>
          </td>
          <td>
            <div class="status">
              {#if status.primary.kind === 'release'}
                {#if g.members.length > 1}<PlatformBadge platform={status.primary.release.platform} showLabel={false} />{/if}
                <ReleaseStatus status={status.primary.release.status} rawState={status.primary.release.rawState} rolloutFraction={status.primary.release.rolloutFraction} />
              {:else if status.primary.kind === 'sync-failed'}
                <Badge tone="bad" icon="alert">Sync failed</Badge>
              {:else if status.primary.kind === 'loading'}
                <Skeleton width="80px" height="20px" />
              {:else}
                <span class="muted">{status.primary.text}</span>
              {/if}
              <PendingChip line={status.pending} href={appAddress(g.key, 'pending')} />
              {#if status.unfinished}
                <a class="unfinished" href={status.unfinished.href ?? undefined} title={status.unfinished.title}>
                  <Badge tone="warn" icon="clock">{status.unfinished.text}</Badge>
                </a>
              {/if}
            </div>
          </td>
          <td>
            <div class="reviews">
              {#if row.rating !== null}
                <span class="rating" title="{row.ratingCount} stored {row.ratingCount === 1 ? 'review' : 'reviews'}"><Icon name="star-filled" size={14} /> {row.rating.toFixed(1)}</span>
              {:else}
                <span class="muted" aria-label="No rating">–</span>
              {/if}
              {#if row.newReviews !== null && row.newReviews > 0}
                <a href={appAddress(g.key, 'reviews')}><Badge tone="accent">{row.newReviews} new</Badge><span class="visually-hidden"> reviews of {g.name}</span></a>
              {/if}
            </div>
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
    min-width: 0;
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .app-name {
    font-weight: var(--weight-medium);
    overflow-wrap: break-word;
  }

  /* The table sizes columns from their content: without a floor the App column collapses to one character wide. */
  .app {
    min-width: 13rem;
  }

  .meta,
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  /* The bundle id is a mono chip that wraps instead of widening the table. */
  .identifier {
    width: fit-content;
    max-width: 100%;
    overflow-wrap: break-word;
    white-space: normal;
  }

  .versions {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .ver {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    white-space: nowrap;
  }

  .reviews {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }

  .unfinished {
    text-decoration: none;
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
