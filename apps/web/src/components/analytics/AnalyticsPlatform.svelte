<!--
  AnalyticsPlatform: the analytics of ONE app record (one platform), for the date range chosen above it. It reads the status of
  the app and, only when something is stored, the overview of this period (with the app-version breakdown) and of the previous
  period (for the comparison). Four states, in this order:
  - analytics off and nothing stored: one card that says what turning it on does (AnalyticsOff);
  - on, nothing stored yet: one quiet line, and the sources with their next steps, open;
  - data: the row of figures, the small-multiple charts, the "Subscriptions" card and (Android) the monthly "Earnings (net, monthly)" card when those sources have stored data (lib/analytics/extras.ts; each has its own read), for an Android app without a reports bucket the "Downloads need your Play reports bucket" section (PlayReportsSetup), the notes on how to read them, "Rank versus downloads" (collapsed; it reads
    only when opened) and the sources under a disclosure;
  - a failed read: an alert with a retry. A failed previous-period read only drops the comparison.
  While it reloads the previous render stays at reduced opacity (no skeleton, no jump). Reading never reaches a store.
  Props: api, workspaceId, role, app (id and platform), range (ResolvedRange), now, showData (the table twins), heading (draw the
  platform name, when several platforms are shown), onstored (told whether something is stored for the app).
-->
<script lang="ts">
  import { type Platform, type Role, can, dateToDay } from '@kiln/core';
  import { type Snippet, untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, type ResolvedRange, analyticsErrorText, needsPlayBucket, stateLabel } from '../../lib/analytics/analytics.ts';
  import { type Loaded, loadOverviews } from '../../lib/analytics/load.ts';
  import { buildCards, buildChips, hasStoredData, lastReadAt, noRatingHistory, overallState, pageNotes, platformNotes, splitHeadline } from '../../lib/analytics/view.ts';
  import { buildEarningsCard, buildSubscriptionsCard, earningsWaitingLine, type Extras, loadExtras } from '../../lib/analytics/extras.ts';
  import { asoViewHref } from '../../lib/aso/aso.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Alert from '../ui/Alert.svelte';
  import T from '../ui/T.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AnalyticsOff from './AnalyticsOff.svelte';
  import ChartCard from './ChartCard.svelte';
  import EarningsCard from './EarningsCard.svelte';
  import RevenueBlock from './RevenueBlock.svelte';
  import PlayReportsSetup from './PlayReportsSetup.svelte';
  import SourcesPanel from './SourcesPanel.svelte';
  import StatRow from './StatRow.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    range,
    now,
    showData = false,
    heading = false,
    onstored,
    extras,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: Platform };
    range: ResolvedRange;
    now: number;
    showData?: boolean | undefined;
    heading?: boolean | undefined;
    /** Told whether something is stored for this app, so the section can leave out the date range and the table switch when nothing could use them. */
    onstored?: ((appId: string, stored: boolean) => void) | undefined;
    /** Drawn under the figures and the chart (or under the first-run content when nothing is stored): the next steps of the app. */
    extras?: Snippet | undefined;
  } = $props();

  let status = $state<AnalyticsStatus | null>(null);
  let loaded = $state<Loaded | null>(null);
  /** The monthly earnings and the subscriptions, read only when those sources have stored data (lib/analytics/extras.ts). */
  let extra = $state<Extras>({ earnings: null, subscriptions: null });
  let statusError = $state('');
  let overviewError = $state('');
  let loading = $state(true);
  let refreshing = $state(false);
  let generation = 0;

  const today = $derived(dateToDay(now));
  const stored = $derived(hasStoredData(status));
  $effect(() => {
    const isStored = stored;
    untrack(() => onstored?.(app.id, isStored));
  });
  const cards = $derived(buildCards(loaded?.current ?? null));
  const split = $derived(splitHeadline(cards));
  const earningsCard = $derived(buildEarningsCard(extra.earnings));
  const subscriptionsCard = $derived(buildSubscriptionsCard(extra.subscriptions));
  const waitingForEarnings = $derived(earningsCard === null ? earningsWaitingLine(status) : '');
  const chips = $derived(buildChips(app.platform, loaded?.current ?? null, loaded?.previous ?? null, range.days));
  const notes = $derived([...pageNotes(loaded?.current ?? null), ...platformNotes(loaded?.current ?? null)].filter((n, i, all) => all.indexOf(n) === i));
  const overall = $derived(status ? overallState(status) : 'ready');
  const lastRead = $derived(status ? lastReadAt(status) : null);

  async function load(keepFrame: boolean) {
    const mine = ++generation;
    if (!keepFrame) {
      status = null;
      loaded = null;
      extra = { earnings: null, subscriptions: null };
    }
    loading = !keepFrame;
    refreshing = true;
    statusError = '';
    overviewError = '';
    try {
      const next = await api.analyticsStatus(workspaceId, app.id);
      if (mine !== generation) return;
      status = next;
      if (hasStoredData(next)) {
        try {
          const both = await loadOverviews(api, workspaceId, app, range);
          if (mine !== generation) return;
          loaded = both;
          // The two extra cards have their own reads; a failed one only drops its card.
          const more = await loadExtras(api, workspaceId, app, next, range, now);
          if (mine !== generation) return;
          extra = more;
        } catch (e) {
          if (mine !== generation) return;
          overviewError = analyticsErrorText(e);
        }
      } else {
        loaded = null;
        extra = { earnings: null, subscriptions: null };
      }
    } catch (e) {
      if (mine !== generation) return;
      statusError = analyticsErrorText(e);
    } finally {
      if (mine === generation) {
        loading = false;
        refreshing = false;
      }
    }
  }

  // A new app, workspace or range reads again; a range change keeps what is drawn at reduced opacity meanwhile.
  const key = $derived(`${workspaceId}/${app.id}/${range.from}/${range.to}`);
  const appKey = $derived(`${workspaceId}/${app.id}`);
  let shownApp = '';
  $effect(() => {
    void key;
    const mine = appKey;
    untrack(() => {
      const keep = shownApp === mine && status !== null;
      shownApp = mine;
      void load(keep);
    });
  });

  const reload = () => void load(true);
</script>

<section class="platform" class:busy={refreshing && status !== null} aria-label={t('analytics:platform.ariaLabel', { platform: platformLabel(app.platform) })} aria-busy={refreshing}>
  {#if heading}
    <h2 class="plat"><PlatformBadge platform={app.platform} tinted /></h2>
  {/if}

  <!-- Revenue (RevenueCat figures): only for an app linked to RevenueCat; reads the stored copy itself. -->
  <RevenueBlock {api} {workspaceId} appId={app.id} {now} />

  {#if loading && !status}
    <div role="status" aria-label={t('analytics:platform.loading')} class="stack">
      <Skeleton width="60%" height="28px" />
      <Skeleton width="100%" height="160px" />
    </div>
  {:else if statusError}
    <div class="stack">
      <Alert tone="error" title={t('analytics:platform.errorTitle')}>{statusError}</Alert>
      <div class="row"><Button icon="refresh" onclick={() => void load(false)}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if status}
    {#if !stored}
      {#if !status.enabled}
        <AnalyticsOff {api} {workspaceId} {app} {role} onchanged={reload} />
        {@render extras?.()}
      {:else}
        <div class="stack">
          <p class="quiet">{t('analytics:platform.nothingYet')}</p>
          <div class="card pad"><SourcesPanel {api} {workspaceId} {app} {status} {role} {now} onchanged={reload} /></div>
          {#if needsPlayBucket(status)}<PlayReportsSetup {api} {workspaceId} {role} {app} {status} onchanged={reload} />{/if}
          {@render extras?.()}
        </div>
      {/if}
    {:else}
      <div class="stack loose">
        {#if !status.enabled}
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

        {#if overviewError}
          <Alert tone="error" title={t('analytics:platform.numbersErrorTitle')}>{overviewError}</Alert>
          <div class="row"><Button icon="refresh" onclick={() => void load(false)}>{t('common:action.tryAgain')}</Button></div>
        {/if}

        {#if loaded && cards.length === 0}
          <p class="quiet">{t('analytics:platform.noNumbers')}</p>
        {/if}
        {#if split.headline}
          <ChartCard card={split.headline} {today} {showData} />
        {/if}
        {#if split.rest.length > 0}
          <Section title={t('analytics:platform.moreCharts')} key="more-charts.{app.platform}" variant="plain" count={split.rest.length} defaultOpen={false} summary={split.rest.map((c) => c.title).join(', ')}>
            <div class="grid">
              {#each split.rest as card (card.id)}
                <ChartCard {card} {today} {showData} />
              {/each}
            </div>
          </Section>
        {/if}

        {#if subscriptionsCard}
          <ChartCard card={subscriptionsCard} {today} {showData} />
        {/if}
        {#if earningsCard}
          <EarningsCard card={earningsCard} {today} {showData} />
        {:else if waitingForEarnings !== ''}
          <p class="quiet" data-testid="earnings-waiting">{waitingForEarnings}</p>
        {/if}

        {#if needsPlayBucket(status)}<PlayReportsSetup {api} {workspaceId} {role} {app} {status} onchanged={reload} />{/if}

        {#if noRatingHistory(app.platform) && loaded}
          <p class="quiet">{t('analytics:platform.noRatingHistory')}</p>
        {/if}

        {@render extras?.()}

        {#if can(role, 'aso.read')}
          <p class="quiet"><T key="analytics:platform.rankVsDownloads" tags={{ link: keywordsLink }} /></p>
        {/if}

        <Section title={t('analytics:platform.sourcesTitle')} key="sources.{app.platform}" defaultOpen={false} summary={lastRead === null ? stateLabel(overall) : t('analytics:platform.sourcesSummary', { state: stateLabel(overall), ago: timeAgo(lastRead, now) })}>
          <SourcesPanel {api} {workspaceId} {app} {status} {role} {now} onchanged={reload} />
        </Section>
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

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
    gap: var(--space-4);
    align-items: start;
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

  .pad {
    padding: var(--space-4);
  }

  .notes {
    padding-left: var(--space-4);
    margin: 0;
  }

  .notes li + li {
    margin-top: var(--space-1);
  }
</style>
