<!--
  AnalyticsPlatform: one PART of the analytics of ONE app record (one platform), drawn from what the section already read for it
  (`PlatformData`, lib/analytics/platform-data.svelte.ts): the Insights overview keeps the figures above its section rail and one of these
  per section. Parts (lib/analytics/sections.ts):
  - `headline`: the row of figures (StatRow) with the notes on how to read them; analytics off: the card that says what turning it on does
    (AnalyticsOff); on with nothing stored: one quiet line; a failed read: an alert with a retry;
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
  import { buildCards, buildChips, noRatingHistory, pageNotes, platformNotes, splitHeadline } from '../../lib/analytics/view.ts';
  import { buildEarningsCard, buildSubscriptionsCard, earningsWaitingLine } from '../../lib/analytics/extras.ts';
  import { asoViewHref } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Alert from '../ui/Alert.svelte';
  import T from '../ui/T.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AnalyticsOff from './AnalyticsOff.svelte';
  import ChartCard from './ChartCard.svelte';
  import EarningsCard from './EarningsCard.svelte';
  import StatRow from './StatRow.svelte';

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
    part: 'headline' | 'overview' | 'acquisition' | 'quality' | 'revenue' | 'next';
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
  const chips = $derived(buildChips(app.platform, data.loaded?.current ?? null, data.loaded?.previous ?? null, range.days));
  const notes = $derived([...pageNotes(data.loaded?.current ?? null), ...platformNotes(data.loaded?.current ?? null)].filter((n, i, all) => all.indexOf(n) === i));
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
      <Skeleton width="60%" height={part === 'headline' ? '28px' : '20px'} />
      {#if part !== 'headline'}<Skeleton width="100%" height="160px" />{/if}
    </div>
  {:else if data.statusError}
    <div class="stack">
      <Alert tone="error" title={t('analytics:platform.errorTitle')}>{data.statusError}</Alert>
      <div class="row"><Button icon="refresh" onclick={onreload}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if data.status}
    {#if !data.stored}
      {#if part === 'headline'}
        {#if !data.status.enabled}
          <AnalyticsOff {api} {workspaceId} {app} {role} onchanged={onreload} />
        {:else}
          <p class="quiet">{t('analytics:platform.nothingYet')}</p>
        {/if}
      {:else if part === 'next'}
        {@render extras?.()}
      {:else}
        <p class="quiet">{t('analytics:rail.nothingStored')}</p>
      {/if}
    {:else if part === 'headline'}
      <div class="stack">
        {#if !data.status.enabled}
          <Alert tone="info">{t('analytics:platform.offAlert')}</Alert>
        {/if}
        <div class="figures">
          <StatRow {chips} days={range.days} />
          {#if notes.length > 0}
            <InfoTip label={t('analytics:platform.howToRead')} buttonText={t('analytics:platform.howToRead')} align="start" width="26rem">
              <ul class="notes">
                {#each notes as n (n)}<li>{n}</li>{/each}
              </ul>
            </InfoTip>
          {/if}
        </div>
        {#if data.overviewError}
          <Alert tone="error" title={t('analytics:platform.numbersErrorTitle')}>{data.overviewError}</Alert>
          <div class="row"><Button icon="refresh" onclick={onreload}>{t('common:action.tryAgain')}</Button></div>
        {:else if data.loaded && cards.length === 0}
          <p class="quiet">{t('analytics:platform.noNumbers')}</p>
        {/if}
      </div>
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

  .figures {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-4);
    align-items: flex-start;
    justify-content: space-between;
  }

  .quiet {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .notes {
    padding-left: var(--space-4);
    margin: 0;
  }

  .notes li + li {
    margin-top: var(--space-1);
  }
</style>
