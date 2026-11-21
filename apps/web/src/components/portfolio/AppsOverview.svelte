<!--
  AppsOverview: the apps of the workspace, one merged row per app (the iOS, macOS and Android records of one
  product together). Read left to right: the app (icon, name, bundle id, rating), its platforms with the latest version of each
  (platform name always written), the status pill (rowStatus; one per platform that is in review, rolling out, halted or rejected, each named), ONE next action (rowNextAction: the most urgent thing to do, or
  nothing), and the last sync with its button. Pending changes, unfinished releases and new reviews are not extra badges: the
  most urgent of them is the next action.
  Props: rows (from buildOverviewRows), now (epoch ms), canSync (shows Sync), syncing (app ids being
  synced), locked (true while "Sync all" owns the sync buttons), onsync (called with a row's group).
-->
<script lang="ts">
  import { type Platform, platformLabel } from '@kiln/core';
  import type { AppGroup } from '../../lib/app-groups.ts';
  import { type OverviewRow, type PlatformCell, rowNextAction, rowStatus } from '../../lib/app-overview.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import SyncStatus from './SyncStatus.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

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
      <PlatformBadge {platform} />
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
        <th scope="col">Platforms</th>
        <th scope="col">Status</th>
        <th scope="col">Next</th>
        <th scope="col">Last synced</th>
        {#if canSync}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.group.key)}
        {@const g = row.group}
        {@const loading = [row.ios, row.macos, row.android].some((c) => c !== null && c.state === 'loading')}
        {@const status = rowStatus(row, loading)}
        {@const next = rowNextAction(row, status)}
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
                  <code class="identifier">{g.members[0]?.identifier}</code>
                  {#if row.rating !== null}
                    <span class="rating" title="{row.ratingCount} stored {row.ratingCount === 1 ? 'review' : 'reviews'}"><Icon name="star-filled" size={14} /> {row.rating.toFixed(1)}</span>
                  {/if}
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
                {#each [status.primary.release, ...status.more] as r (r.id)}
                  <span class="pill">
                    <ReleaseStatus status={r.status} rawState={r.rawState} rolloutFraction={r.rolloutFraction} sentForReviewAt={r.sentForReviewAt} />
                    {#if g.members.length > 1}<span class="muted on">{platformLabel(r.platform)}</span>{/if}
                  </span>
                {/each}
              {:else if status.primary.kind === 'sync-failed'}
                <Badge tone="bad" icon="alert">Sync failed</Badge>
              {:else if status.primary.kind === 'loading'}
                <Skeleton width="80px" height="20px" />
              {:else}
                <span class="muted">{status.primary.text}</span>
              {/if}
            </div>
          </td>
          <td>
            {#if next}
              <a class="next {next.tone}" href={next.href} title={next.title}>{next.label}<Icon name="arrow-right" size={14} /><span class="visually-hidden"> for {g.name}</span></a>
            {:else}
              <span class="muted" aria-label="Nothing to do">–</span>
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
    min-width: 0;
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .app-name {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    overflow-wrap: break-word;
  }

  /* The rows read at the body size of the redesign (15px), not the dense table size. */
  table {
    font-size: 0.9375rem;
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

  .pill {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .on {
    font-size: var(--text-sm);
  }

  /* The next action is the one thing in the row that reads as a call to act; its tone says how urgent. */
  .next {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: var(--space-1) var(--space-3);
    font-weight: var(--weight-semibold);
    text-decoration: none;
    white-space: nowrap;
    background: var(--accent-bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .next:hover {
    filter: brightness(1.12);
  }

  .next.bad {
    color: var(--bad-ink);
    background: var(--bad-bg);
  }

  .next.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
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
