<!--
  AnalyticsPlatform: one PART of the analytics of ONE app record (one platform), drawn from what the section already read for it
  (`PlatformData`, lib/analytics/platform-data.svelte.ts): one of these per platform WITH data in each section of the Insights rail (the figures and
  the platforms without data are the Overview's own block, lib/analytics/insights-view.ts). Parts (lib/analytics/sections.ts):
  - `overview`: the headline chart (downloads or installs, else the first card);
  - `acquisition`, `quality`, `revenue`: the other chart cards of that part (the Apple "Proceeds" and Google sales cards, the "Subscriptions"
    card and the monthly "Earnings (net, monthly)" card are Revenue);
  - `next`: the `extras` snippet (ASO next steps, AI suggestions) and the link to "Rank versus downloads".
  While it reloads the previous render stays at reduced opacity (no skeleton, no jump). Reading never reaches a store.
  Props: api, workspaceId, role, app (id and platform), data (PlatformData), part, range (ResolvedRange), now, showData (the table twins),
  heading (draw the platform name, when several platforms are shown), onreload, extras.
-->
<script lang="ts">
  import { type Platform, type Role, can, dateToDay } from '@kiln/core';
  import type { Snippet } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import type { ResolvedRange } from '../../lib/analytics/analytics.ts';
  import type { PlatformData } from '../../lib/analytics/platform-data.svelte.ts';
  import { type CardPart, cardsOfPart, withoutHeadline } from '../../lib/analytics/sections.ts';
  import { buildCards, noRatingHistory, splitHeadline } from '../../lib/analytics/view.ts';
  import { buildEarningsCard, buildSubscriptionsCard, earningsWaitingLine } from '../../lib/analytics/extras.ts';
  import { asoViewHref } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Alert from '../ui/Alert.svelte';
  import T from '../ui/T.svelte';
  import Button from '../ui/Button.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import ChartCard from './ChartCard.svelte';
  import EarningsCard from './EarningsCard.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    data,
    part,
    range,
    now,
    showData = false,
    heading = false,
    onreload,
    extras,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: Platform };
    data: PlatformData;
    part: 'overview' | 'acquisition' | 'quality' | 'revenue' | 'next';
    range: ResolvedRange;
    now: number;
    showData?: boolean | undefined;
    heading?: boolean | undefined;
    onreload: () => void;
    /** Drawn in the `next` part: the next steps of the app. */
    extras?: Snippet | undefined;
  } = $props();

  const today = $derived(dateToDay(now));
  const cards = $derived(buildCards(data.loaded?.current ?? null));
  const split = $derived(splitHeadline(cards));
  const subscriptionsCard = $derived(buildSubscriptionsCard(data.extra.subscriptions));
  const earningsCard = $derived(buildEarningsCard(data.extra.earnings));
  const waitingForEarnings = $derived(earningsCard === null ? earningsWaitingLine(data.status) : '');
  const partCards = $derived(
    part === 'acquisition' ? withoutHeadline(cardsOfPart(cards, 'acquisition'), split.headline?.id ?? null) : part === 'quality' || part === 'revenue' ? cardsOfPart(cards, part as CardPart) : [],
  );
</script>

<section class="platform" class:busy={data.refreshing && data.status !== null} aria-label={t('analytics:platform.ariaLabel', { platform: platformLabel(app.platform) })} aria-busy={data.refreshing}>
  {#if heading}
    <h3 class="plat"><PlatformBadge platform={app.platform} tinted /></h3>
  {/if}

  {#if data.loading && !data.status}
    <div role="status" aria-label={t('analytics:platform.loading')} class="stack">
      <Skeleton width="60%" height="20px" />
      <Skeleton width="100%" height="160px" />
    </div>
  {:else if data.statusError}
    <div class="stack">
      <Alert tone="error" title={t('analytics:platform.errorTitle')}>{data.statusError}</Alert>
      <div class="row"><Button icon="refresh" onclick={onreload}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if data.status}
    {#if !data.stored}
      {#if part === 'next'}
        {@render extras?.()}
      {:else}
        <p class="quiet">{t('analytics:rail.nothingStored')}</p>
      {/if}
    {:else if part === 'overview'}
      {#if split.headline}
        <ChartCard card={split.headline} {today} {showData} />
      {:else}
        <p class="quiet">{t('analytics:rail.nothingStored')}</p>
      {/if}
    {:else if part === 'revenue'}
      <div class="stack">
        {#each partCards as card (card.id)}
          <ChartCard {card} {today} {showData} />
        {/each}
        {#if subscriptionsCard}
          <ChartCard card={subscriptionsCard} {today} {showData} />
        {/if}
        {#if earningsCard}
          <EarningsCard card={earningsCard} {today} {showData} />
        {:else if waitingForEarnings !== ''}
          <p class="quiet" data-testid="earnings-waiting">{waitingForEarnings}</p>
        {/if}
        {#if partCards.length === 0 && !subscriptionsCard && !earningsCard && waitingForEarnings === ''}
          <p class="quiet">{t('analytics:rail.nothingStored')}</p>
        {/if}
      </div>
    {:else if part === 'acquisition' || part === 'quality'}
      <div class="stack">
        {#each partCards as card (card.id)}
          <ChartCard {card} {today} {showData} />
        {/each}
        {#if part === 'quality' && noRatingHistory(app.platform) && data.loaded}
          <p class="quiet">{t('analytics:platform.noRatingHistory')}</p>
        {/if}
        {#if partCards.length === 0}
          <p class="quiet">{t('analytics:rail.nothingStored')}</p>
        {/if}
      </div>
    {:else if part === 'next'}
      <div class="stack">
        {@render extras?.()}
        {#if can(role, 'aso.read')}
          <p class="quiet"><T key="analytics:platform.rankVsDownloads" tags={{ link: keywordsLink }} /></p>
        {/if}
      </div>
    {/if}
  {/if}
</section>

{#snippet keywordsLink(text: string)}<a href={asoViewHref(app.id, 'rank', app.platform)}>{text}</a>{/snippet}

<style>
  .platform {
    min-width: 0;
    transition: opacity var(--duration-base) var(--ease);
  }

  .platform.busy {
    opacity: 0.6;
  }

  .plat {
    margin: 0 0 var(--space-3);
    font-size: var(--text-md);
  }

  .quiet {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }
</style>
