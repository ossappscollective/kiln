<!--
  Board: the apps of the workspace as cards in four columns by where the newest version is in the
  lifecycle (preparing, in review, ready to release, live). Blocked is a flag on a card with its
  reason, not a column. iOS and Android of one identifier are two cards. Plans (blocked flags,
  deadlines, readiness) are loaded here from our own API; without them the board still shows the
  stores' state. Read only: nothing on the board changes a store.
  Props: api, workspaceId, role, apps (sorted), releases (loaded releases by app id), now (epoch ms).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { type Role, can } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { attentionItems, blockedCount, buildBoard } from '../../lib/dashboard.ts';
  import { lineFor } from '../../lib/pending.ts';
  import { pendingStore } from '../../lib/pending-store.svelte.ts';
  import { appLabel, type ReleaseLoad } from '../../lib/portfolio.ts';
  import type { AppSummary, PlanSummary } from '../../lib/types.ts';
  import Skeleton from '../ui/Skeleton.svelte';
  import AttentionStrip from './AttentionStrip.svelte';
  import BoardCard from './BoardCard.svelte';

  let {
    api,
    workspaceId,
    role,
    apps,
    releases,
    now,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    apps: AppSummary[];
    releases: Record<string, ReleaseLoad | undefined>;
    now: number;
  } = $props();

  const uid = $props.id();
  const canReadPlans = $derived(can(role, 'plans.read'));

  let plans = $state<PlanSummary[] | null>(null);
  let plansFailed = $state(false);
  let generation = 0;

  $effect(() => {
    void workspaceId;
    if (!canReadPlans) {
      plans = null;
      return;
    }
    const mine = ++generation;
    plansFailed = false;
    api
      .plans(workspaceId)
      .then((result) => {
        if (mine === generation) plans = result.plans;
      })
      .catch(() => {
        if (mine === generation) {
          plans = null;
          plansFailed = true;
        }
      });
  });

  const board = $derived(buildBoard({ apps, releases, plans }));
  const placed = $derived(board.columns.reduce((n, c) => n + c.cards.length, 0));
  const blocked = $derived(blockedCount(board));
  const attention = $derived(attentionItems(plans ?? []));
  const everyoneLoading = $derived(apps.length > 0 && board.unplaced.length === apps.length && board.unplaced.every((u) => u.reason === 'loading'));
  const waiting = $derived(board.unplaced.filter((u) => u.reason === 'loading').length);

  const reasonText = (reason: string, raw: string | null) => {
    if (reason === 'error') return t('app:board.reasonError');
    if (reason === 'no_releases') return t('app:board.reasonNone');
    if (reason === 'unmapped') return t('app:board.reasonUnmapped', { raw: raw ?? '' });
    return t('app:board.reasonLoading');
  };
</script>

<div class="board-wrap">
  {#if everyoneLoading}
    <div class="board" role="status" aria-label={t('app:board.loading')}>
      {#each [0, 1, 2, 3] as i (i)}
        <div class="column">
          <Skeleton width="50%" height="18px" />
          <div class="skeleton-card"><Skeleton width="70%" height="16px" /><Skeleton width="40%" height="14px" /><Skeleton width="90%" height="14px" /></div>
          {#if i < 2}<div class="skeleton-card"><Skeleton width="60%" height="16px" /><Skeleton width="50%" height="14px" /><Skeleton width="80%" height="14px" /></div>{/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="summary muted">
      {blocked > 0 ? t('app:board.byStageBlocked', { count: placed, blocked }) : t('app:board.byStage', { count: placed })}
      {#if canReadPlans && plans === null && !plansFailed}{t('app:board.loadingPlans')}{/if}
      {#if plansFailed}{t('app:board.plansFailed')}{/if}
    </p>

    <AttentionStrip items={attention} />

    <div class="board" role="group" aria-label={t('app:board.label')}>
      {#each board.columns as column (column.bucket)}
        <section class="column" aria-labelledby="{uid}-{column.bucket}">
          <header class="column-head">
            <h2 id="{uid}-{column.bucket}">{column.label}</h2>
            <span class="count" aria-label={t('app:board.releaseCount', { count: column.cards.length })}>{column.cards.length}</span>
          </header>
          <p class="description muted">{column.description}</p>
          {#if column.cards.length === 0}
            <p class="empty muted">{t('app:board.empty')}</p>
          {:else}
            <ul class="cards">
              {#each column.cards as card (card.key)}
                <li><BoardCard {card} {now} pending={lineFor(pendingStore.summary(workspaceId), [card.appId])} /></li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    </div>

    {#if board.unplaced.length > 0}
      <section class="unplaced" aria-labelledby="{uid}-unplaced">
        <h2 id="{uid}-unplaced">{t('app:board.noStage')}</h2>
        <ul class="plain">
          {#each board.unplaced as item (item.app.id)}
            <li class="unplaced-row">
              <a href={item.href}>{appLabel(item.app)}</a>
              {#if item.reason === 'loading'}
                <span class="muted" role="status"><Skeleton width="160px" height="14px" /><span class="visually-hidden">{t('app:board.loadingReleasesOf', { name: appLabel(item.app) })}</span></span>
              {:else}
                <span class="muted">{reasonText(item.reason, item.rawState)}</span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if waiting > 0}<p class="muted small">{t('app:board.waiting', { count: waiting })}</p>{/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .board-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .summary {
    margin: 0;
    font-size: var(--text-sm);
  }

  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-4);
    align-items: start;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .column-head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    justify-content: space-between;
  }

  .column-head h2 {
    margin: 0;
    font-size: var(--text-md);
  }

  .count {
    min-width: var(--space-6);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .description {
    margin: calc(-1 * var(--space-1)) 0 0;
    font-size: var(--text-xs);
  }

  .empty {
    padding: var(--space-4) 0;
    margin: 0;
    font-size: var(--text-sm);
    text-align: center;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-md);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .unplaced {
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .unplaced h2 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .plain {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .unplaced-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: baseline;
    font-size: var(--text-sm);
  }

  .small {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
  }

  @media (max-width: 1100px) {
    .board {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .board {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
