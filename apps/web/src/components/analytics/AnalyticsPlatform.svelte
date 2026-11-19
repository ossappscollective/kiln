<!--
  AnalyticsPlatform: the analytics of ONE app record (one platform), for the date range chosen above it. It reads the status of
  the app and, only when something is stored, the overview of this period (with the app-version breakdown) and of the previous
  period (for the comparison). Four states, in this order:
  - analytics off and nothing stored: one card that says what turning it on does (AnalyticsOff);
  - on, nothing stored yet: one quiet line, and the sources with their next steps, open;
  - data: the row of figures, the small-multiple charts, the notes on how to read them, "Rank versus downloads" (collapsed; it reads
    only when opened) and the sources under a disclosure;
  - a failed read: an alert with a retry. A failed previous-period read only drops the comparison.
  While it reloads the previous render stays at reduced opacity (no skeleton, no jump). Reading never reaches a store.
  Props: api, workspaceId, role, app (id and platform), range (ResolvedRange), now, showData (the table twins), heading (draw the
  platform name, when several platforms are shown), onstored (told whether something is stored for the app).
-->
<script lang="ts">
  import { type Platform, type Role, can, dateToDay } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type AnalyticsStatus, type ResolvedRange, analyticsErrorText, stateInfo } from '../../lib/analytics.ts';
  import { type Loaded, loadOverviews } from '../../lib/analytics-load.ts';
  import { buildCards, buildChips, hasStoredData, lastReadAt, noRatingHistory, overallState, pageNotes, platformNotes } from '../../lib/analytics-view.ts';
  import { asoViewHref } from '../../lib/aso.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import RankVsDownloads from '../aso/RankVsDownloads.svelte';
  import AnalyticsOff from './AnalyticsOff.svelte';
  import ChartCard from './ChartCard.svelte';
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
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: Platform };
    range: ResolvedRange;
    now: number;
    showData?: boolean;
    heading?: boolean;
    /** Told whether something is stored for this app, so the section can leave out the date range and the table switch when nothing could use them. */
    onstored?: (appId: string, stored: boolean) => void;
  } = $props();

  let status = $state<AnalyticsStatus | null>(null);
  let loaded = $state<Loaded | null>(null);
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
  const chips = $derived(buildChips(app.platform, loaded?.current ?? null, loaded?.previous ?? null, range.days));
  const notes = $derived([...pageNotes(loaded?.current ?? null), ...platformNotes(loaded?.current ?? null)].filter((n, i, all) => all.indexOf(n) === i));
  const overall = $derived(status ? overallState(status) : 'ready');
  const lastRead = $derived(status ? lastReadAt(status) : null);

  async function load(keepFrame: boolean) {
    const mine = ++generation;
    if (!keepFrame) {
      status = null;
      loaded = null;
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
        } catch (e) {
          if (mine !== generation) return;
          overviewError = analyticsErrorText(e);
        }
      } else {
        loaded = null;
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

<section class="platform" class:busy={refreshing && status !== null} aria-label="{platformLabel(app.platform)} analytics" aria-busy={refreshing}>
  {#if heading}
    <h2 class="plat"><PlatformBadge platform={app.platform} tinted /></h2>
  {/if}

  {#if loading && !status}
    <div role="status" aria-label="Loading analytics" class="stack">
      <Skeleton width="60%" height="28px" />
      <Skeleton width="100%" height="160px" />
    </div>
  {:else if statusError}
    <div class="stack">
      <Alert tone="error" title="Could not read analytics">{statusError}</Alert>
      <div class="row"><Button icon="refresh" onclick={() => void load(false)}>Try again</Button></div>
    </div>
  {:else if status}
    {#if !stored}
      {#if !status.enabled}
        <AnalyticsOff {api} {workspaceId} {app} {role} onchanged={reload} />
      {:else}
        <div class="stack">
          <p class="quiet">No analytics data has been read for this app yet. Here is what is set up and what is next.</p>
          <div class="card pad"><SourcesPanel {api} {workspaceId} {app} {status} {role} {now} onchanged={reload} /></div>
        </div>
      {/if}
    {:else}
      <div class="stack loose">
        {#if !status.enabled}
          <Alert tone="info">Analytics is off for this workspace, so nothing new is read. You are looking at what was stored.</Alert>
        {/if}

        <div class="figures">
          <StatRow {chips} days={range.days} />
          {#if notes.length > 0}
            <InfoTip label="How to read these numbers" buttonText="How to read these numbers" align="start" width="26rem">
              <ul class="notes">
                {#each notes as n (n)}<li>{n}</li>{/each}
              </ul>
            </InfoTip>
          {/if}
        </div>

        {#if overviewError}
          <Alert tone="error" title="Could not read the numbers">{overviewError}</Alert>
          <div class="row"><Button icon="refresh" onclick={() => void load(false)}>Try again</Button></div>
        {/if}

        {#if loaded && cards.length === 0}
          <p class="quiet">No numbers in this date range. Try a longer range.</p>
        {/if}
        {#if cards.length > 0}
          <div class="grid">
            {#each cards as card (card.id)}
              <ChartCard {card} {today} {showData} />
            {/each}
          </div>
        {/if}

        {#if noRatingHistory(app.platform) && loaded}
          <p class="quiet">Ratings over time: Apple does not provide rating history.</p>
        {/if}

        {#if can(role, 'aso.read')}
          <Disclosure summary="Rank versus downloads" stateKey="analytics.rank.{app.id}">
            {#snippet meta()}tracked keywords, a correlation view{/snippet}
            <RankVsDownloads {api} {workspaceId} {app} {now} keywordsHref={asoViewHref(app.id, 'keywords')} />
          </Disclosure>
        {/if}

        <Disclosure summary="Sources and sync" stateKey="analytics.sources.{app.id}">
          {#snippet meta()}{stateInfo[overall].label}{lastRead === null ? '' : `, last read ${timeAgo(lastRead, now)}`}{/snippet}
          <SourcesPanel {api} {workspaceId} {app} {status} {role} {now} onchanged={reload} />
        </Disclosure>
      </div>
    {/if}
  {/if}
</section>

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
    font-size: var(--text-sm);
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
