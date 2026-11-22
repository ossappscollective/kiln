<!--
  AppsOverview: the apps of the workspace, one merged row per app (the iOS, macOS and Android records of one
  product together). Read left to right: the app (icon, name, bundle id, rating), its platforms with the latest version of each
  (platform name always written), the status chips (one per platform of the app, in the order iOS, macOS, Android: the platform icon and the state of its most urgent release; platformStatuses), ONE next action (rowNextAction: the most urgent thing to do, or
  nothing), and the last sync with its button. Pending changes, unfinished releases and new reviews are not extra badges: the
  most urgent of them is the next action.
  Props: rows (from buildOverviewRows), now (epoch ms), canSync (shows Sync), syncing (app ids being
  synced), locked (true while "Sync all" owns the sync buttons), onsync (called with a row's group).
-->
<script lang="ts">
  import { playLiveUnconfirmed, releaseStatusText } from '../../lib/play-live.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { formatNumber } from '../../lib/i18n/format.ts';
  import { type Platform, platformLabel } from '@kiln/core';
  import type { AppGroup } from '../../lib/app-groups.ts';
  import { type OverviewRow, type PlatformCell, platformStatuses, rowNextAction, rowStatus } from '../../lib/app-overview.ts';
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
        <span class="muted">{t('portfolio:overviewTable.loadFailed')}</span>
      {:else if c.latest}
        <strong>{c.latest.version}</strong>
      {:else}
        <span class="muted">{t('portfolio:overviewTable.none')}</span>
      {/if}
    </li>
  {/if}
{/snippet}

<div class="table-wrap">
  <table>
    <caption class="visually-hidden">{t('portfolio:table.caption')}</caption>
    <thead>
      <tr>
        <th scope="col">{t('portfolio:table.app')}</th>
        <th scope="col">{t('portfolio:overviewTable.platforms')}</th>
        <th scope="col">{t('portfolio:release.status')}</th>
        <th scope="col">{t('app:board.next')}</th>
        <th scope="col">{t('portfolio:table.lastSynced')}</th>
        {#if canSync}<th scope="col"><span class="visually-hidden">{t('portfolio:table.actions')}</span></th>{/if}
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
                    <span class="rating" title={t('portfolio:overviewTable.storedReviews', { count: row.ratingCount })}><Icon name="star-filled" size={14} /> {formatNumber(row.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                  {/if}
                </div>
              </div>
            </div>
          </td>
          <td>
            <ul class="versions" aria-label={t('portfolio:overviewTable.versions')}>
              {@render version(row.ios, 'ios')}
              {@render version(row.macos, 'macos')}
              {@render version(row.android, 'android')}
            </ul>
          </td>
          <td>
            <ul class="chips" aria-label={t('portfolio:overviewTable.statuses')}>
              {#each platformStatuses(row) as ps (ps.platform)}
                {@const text = ps.kind === 'release' && ps.release ? releaseStatusText(ps.release) : ps.kind === 'loading' ? '…' : ps.kind === 'error' ? t('portfolio:overviewTable.loadFailed') : t('portfolio:overviewTable.none')}
                <li>
                  <span class="chip" role="img" aria-label={t('portfolio:overviewTable.platformStatus', { platform: platformLabel(ps.platform), status: text })}>
                    <PlatformBadge platform={ps.platform} showLabel={false} />
                    {#if ps.kind === 'release' && ps.release}
                      <ReleaseStatus status={ps.release.status} rawState={ps.release.rawState} rolloutFraction={ps.release.rolloutFraction} sentForReviewAt={ps.release.sentForReviewAt} unconfirmed={playLiveUnconfirmed(ps.release)} />
                    {:else if ps.kind === 'loading'}
                      <Skeleton width="64px" height="20px" />
                    {:else}
                      <span class="muted">{text}</span>
                    {/if}
                  </span>
                </li>
              {/each}
              {#if status.primary.kind === 'sync-failed'}<li><Badge tone="bad" icon="alert">{t('portfolio:overviewTable.syncFailed')}</Badge></li>{/if}
              {#if status.primary.kind === 'none'}<li><span class="muted">{status.primary.text}</span></li>{/if}
            </ul>
          </td>
          <td>
            {#if next}
              <a class="next {next.tone}" href={next.href} title={next.title} aria-label={t('portfolio:overviewTable.nextFor', { label: next.label, name: g.name })}>{next.label}<Icon name="arrow-right" size={14} /></a>
            {:else}
              <span class="muted" aria-label={t('portfolio:overviewTable.nothingToDo')}>–</span>
            {/if}
          </td>
          <td>
            <SyncStatus app={syncMember(row)} {now} compact />
          </td>
          {#if canSync}
            <td class="actions">
              <Button
                size="sm"
                icon="refresh"
                loading={isSyncing(g)}
                disabled={locked && !isSyncing(g)}
                label={t('portfolio:table.syncApp', { name: g.name })}
                onclick={() => onsync(g)}>{t('app:shell.sync')}</Button
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

  .meta {
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

  /* One chip per platform: its icon and its state, side by side; the chips wrap as a whole, never inside. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    white-space: nowrap;
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
