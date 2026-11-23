<!--
  AnalyticsSection: the Overview view of Insights of an app (left panel, `g i`; `g n` still lands here). ONE hierarchy, top to bottom: the page
  header (app, platform scope, Sync) and the tabs above are the shell's; here, 1. the range bar (the date range, kept in the address, and "Show
  data": every chart also as a table); 2. [the section rail | the content]. The rail (components/ui/SectionRail.svelte, `?section=`,
  lib/analytics/sections.ts) is sticky and drawn only with two or more sections: Overview, Acquisition, Quality, Revenue (only when something is
  stored), Next steps and Data sources.
  The Overview section is the headline, as its first blocks: the figures (a table across platforms when two have data, a uniform grid for one:
  lib/analytics/insights-view.ts), a platform with NO data as one compact line (why, and how to fix it) instead of an empty column, the RevenueCat
  figures once, then the headline chart of each platform with data. The other sections draw only the platforms that have data, side by side
  when two do and stacked otherwise; every chart card is in exactly one section.
  Apple downloads and Google installs, or two currencies, are different measures and are never added together.
  Reading is open to every role (`analytics.read`); turning on, syncing, enabling Apple analytics and importing a file need `analytics.manage`.
  What is read for a platform lives here (`PlatformData`), once, and is shared by the figures and the sections.
  Props: api, workspaceId, role, members (the app records in scope), now.
  The charts are small multiples, not a dashboard of widgets: see components/analytics/ChartCard.svelte.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { type RangeChoice, type AnalyticsStatus, needsPlayBucket, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import { PlatformData } from '../../lib/analytics/platform-data.svelte.ts';
  import { buildOverview, chartColumns, emptyReason, platformShape, type PlatformView } from '../../lib/analytics/insights-view.ts';
  import { cardsOfPart, failedSourceCount, insightsGroups, railWorthDrawing, withoutHeadline, type InsightsPart } from '../../lib/analytics/sections.ts';
  import { buildCards, buildChips, pageNotes, platformNotes, splitHeadline } from '../../lib/analytics/view.ts';
  import { railEntries, resolveRailSection, withRailSection } from '../../lib/section-rail.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import AsoCoach from '../aso/AsoCoach.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import SectionRail from '../ui/SectionRail.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import { sectionHost } from '../../lib/section-host.svelte.ts';
  import { EventLayer } from '../../lib/timeline/layer.svelte.ts';
  import AnalyticsPlatform from './AnalyticsPlatform.svelte';
  import CompareTable from './CompareTable.svelte';
  import StatRow from './StatRow.svelte';
  import PlayReportsSetup from './PlayReportsSetup.svelte';
  import RangeControl from './RangeControl.svelte';
  import RevenueBlock from './RevenueBlock.svelte';
  import SourcesPanel from './SourcesPanel.svelte';
  import VizScope from './VizScope.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  let showData = $state(false);
  // "Show events": the timeline's events as markers on the charts (docs/adr/0053-timeline-and-reports.md), remembered per person in this browser.
  const layer = new EventLayer(sectionHost()?.scope().userId ?? 'anonymous');
  $effect(() => {
    if (!layer.show) return;
    const key = `${workspaceId}/${members.map((m) => m.id).join(',')}/${range.from}/${range.to}`;
    untrack(() => void layer.load(api, workspaceId, members, range.from, range.to));
    void key;
  });
  /** Bumped when an AI suggestion was accepted (keywords may have been added), so the next steps read again. */
  let coachVersion = $state(0);

  const choice = $derived(parseRange(address.hash));
  const range = $derived(resolveRange(choice, now));
  const setRange = (next: RangeChoice) => replaceHash(withRange(location.hash, next));

  // One read per platform record, shared by the figures above the rail and every section of it.
  const reads = new Map<string, PlatformData>();
  const dataFor = (id: string): PlatformData => {
    let d = reads.get(id);
    if (!d) {
      d = new PlatformData();
      reads.set(id, d);
    }
    return d;
  };
  const rows = $derived(members.map((app) => ({ app, data: dataFor(app.id) })));
  const readKey = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}/${range.from}/${range.to}`);
  $effect(() => {
    void readKey;
    untrack(() => {
      for (const r of rows) void r.data.ensure(api, workspaceId, r.app, range, now);
    });
  });
  const reloadAll = () => {
    for (const r of rows) void r.data.load(api, workspaceId, r.app, range, now, true);
  };

  const anyStored = $derived(rows.some((r) => r.data.stored));
  /** What each platform is (loading, failed, off, nothing stored, data) and its figures; the Overview and the sections are drawn from it. */
  const views = $derived(
    rows.map((r): PlatformView => {
      const shape = platformShape({ statusError: r.data.statusError !== null && r.data.statusError !== '', enabled: r.data.status ? r.data.status.enabled : null, stored: r.data.stored });
      return { id: r.app.id, platform: r.app.platform, shape, chips: shape === 'data' ? buildChips(r.app.platform, r.data.loaded?.current ?? null, r.data.loaded?.previous ?? null, range.days) : [] };
    }),
  );
  const overview = $derived(buildOverview(views));
  const dataRows = $derived(rows.filter((r) => overview.withData.some((v) => v.id === r.app.id)));
  const columns = $derived(chartColumns(dataRows.length));
  const several = $derived(dataRows.length > 1);
  const notes = $derived(
    dataRows
      .flatMap((r) => [...pageNotes(r.data.loaded?.current ?? null), ...platformNotes(r.data.loaded?.current ?? null)])
      .filter((n, i, all) => all.indexOf(n) === i),
  );
  const emptyKey = {
    off: k('analytics:overview.empty.off'),
    never: k('analytics:overview.empty.never'),
    error: k('analytics:overview.empty.error'),
    loading: k('analytics:overview.empty.loading'),
  } as const;
  const sourcesHref = $derived(withRailSection(address.hash, 'sources'));

  // The counts beside the rail entries: how many cards each section holds, and the sources that could not be read.
  const counts = $derived.by(() => {
    let acquisition = 0;
    let quality = 0;
    let revenue = 0;
    for (const r of rows) {
      const cards = buildCards(r.data.loaded?.current ?? null);
      const head = splitHeadline(cards).headline?.id ?? null;
      acquisition += withoutHeadline(cardsOfPart(cards, 'acquisition'), head).length;
      quality += cardsOfPart(cards, 'quality').length;
      revenue += cardsOfPart(cards, 'revenue').length + (r.data.extra.subscriptions ? 1 : 0) + (r.data.extra.earnings ? 1 : 0);
    }
    const statuses = rows.map((r) => r.data.status).filter((s): s is AnalyticsStatus => s !== null);
    return { acquisition, quality, revenue, failedSources: statuses.length === rows.length ? failedSourceCount(statuses) : null };
  });
  const groups = $derived(insightsGroups(counts, true, anyStored));
  const railShown = $derived(railWorthDrawing(groups));
  const part = $derived(resolveRailSection(address.hash, railEntries(groups).map((e) => e.id)) as InsightsPart);
  const sourceItems = $derived(rows.flatMap((r) => (r.data.status ? [{ app: r.app, status: r.data.status }] : [])));
</script>

<VizScope>
  <div class="analytics stack loose">
    <div class="filters" hidden={!anyStored}>
      <RangeControl {choice} {range} {now} onchange={setRange} />
      <span class="spacer"></span>
      <SectionsToggle />
      <button type="button" class="bare toggle" aria-pressed={layer.show} onclick={() => layer.set(!layer.show)} data-testid="toggle-events">
        {layer.show ? t('timeline:marker.hide') : t('timeline:marker.show')}
      </button>
      <button type="button" class="bare toggle" aria-pressed={showData} onclick={() => (showData = !showData)}>
        {showData ? t('analytics:section.hideData') : t('analytics:section.showData')}
      </button>
    </div>

    {#if layer.show && layer.failed}<p class="quiet" role="status">{t('timeline:marker.failed')}</p>{/if}

    {#if railShown}
      <SectionRail {groups} value={part} hrefFor={(id) => withRailSection(address.hash, id)} label={t('analytics:rail.label')}>
        {@render content()}
      </SectionRail>
    {:else}
      {@render content()}
    {/if}
  </div>
</VizScope>

{#snippet content()}
  {#if part === 'sources'}
    {#if sourceItems.length === 0}
      <Skeleton width="100%" height="120px" />
    {:else}
      <div class="stack loose">
        <div class="card pad"><SourcesPanel {api} {workspaceId} items={sourceItems} {role} {now} onchanged={reloadAll} /></div>
        {#each sourceItems as it (it.app.id)}
          {#if needsPlayBucket(it.status)}<PlayReportsSetup {api} {workspaceId} {role} app={it.app} status={it.status} onchanged={reloadAll} />{/if}
        {/each}
      </div>
    {/if}
  {:else if part === 'next'}
    <div class="platforms cols-{chartColumns(rows.length)}">
      {#each rows as r (r.app.id)}
        <AnalyticsPlatform {api} {workspaceId} {role} app={r.app} data={r.data} part="next" {range} {now} {showData} heading={rows.length > 1} onreload={reloadAll}>
          {#snippet extras()}
            {#if can(role, 'aso.read')}
              <AsoCoach {api} {workspaceId} app={r.app} version={coachVersion} showPlatform={rows.length > 1} visible={2} />
            {/if}
            <AiSuggestions {api} {workspaceId} {role} app={r.app} platform={address.platform} showPlatform={rows.length > 1} onaccepted={() => {
              coachVersion += 1;
            }} />
          {/snippet}
        </AnalyticsPlatform>
      {/each}
    </div>
  {:else}
    {#if part === 'overview'}
      <div class="stack" data-testid="insights-headline">
        <!-- A platform with no data is ONE line (why, how to fix), never an empty column. -->
        {#each overview.without as v (v.id)}
          {@const reason = emptyReason(v.shape)}
          <p class="empty-line" data-testid="no-data-{v.platform}" data-reason={reason}>
            <PlatformBadge platform={v.platform as never} tinted />
            <span>{t(emptyKey[reason], { platform: platformLabel(v.platform as never) })}</span>
            {#if reason === 'error'}
              <Button size="sm" icon="refresh" onclick={reloadAll}>{t('common:action.tryAgain')}</Button>
            {:else if reason !== 'loading'}
              <a href={sourcesHref}>{t('analytics:overview.openSources')}</a>
            {/if}
          </p>
        {/each}
        {#if overview.loading}<Skeleton width="100%" height="72px" />{/if}
        {#if overview.kpis !== 'none'}
          <div class="figures">
            {#if overview.kpis === 'compare'}
              <CompareTable columns={overview.columns} rows={overview.rows} days={range.days} />
            {:else}
              <StatRow chips={overview.gridChips} days={range.days} />
            {/if}
            {#if notes.length > 0}
              <InfoTip label={t('analytics:platform.howToRead')} buttonText={t('analytics:platform.howToRead')} align="start" width="26rem">
                <ul class="notes">
                  {#each notes as n (n)}<li>{n}</li>{/each}
                </ul>
              </InfoTip>
            {/if}
          </div>
        {:else if overview.noNumbers}
          <p class="quiet">{t('analytics:platform.noNumbers')}</p>
        {/if}
        {#each dataRows as r (r.app.id)}
          {#if r.data.overviewError}
            <Alert tone="error" title={t('analytics:platform.numbersErrorTitle')}>{r.data.overviewError}</Alert>
            <div class="row"><Button icon="refresh" onclick={reloadAll}>{t('common:action.tryAgain')}</Button></div>
          {/if}
        {/each}
        <!-- RevenueCat figures are all-stores figures: one block for the whole scope, never one per platform. -->
        <RevenueBlock {api} {workspaceId} appIds={members.map((m) => m.id)} {now} />
      </div>
    {/if}
    {#if dataRows.length === 0}
      {#if part !== 'overview'}<p class="quiet">{t('analytics:rail.nothingStored')}</p>{/if}
    {:else}
      <div class="platforms cols-{columns}">
        {#each dataRows as r (r.app.id)}
          <AnalyticsPlatform {api} {workspaceId} {role} app={r.app} data={r.data} {part} {range} {now} {showData} events={layer.show ? layer.for(r.app.id) : undefined} heading={several} onreload={reloadAll} />
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}


<style>
  .platforms {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-6) var(--space-5);
    align-items: start;
  }

  /* Both platforms side by side on a wide screen; stacked below it. */
  @media (min-width: 72rem) {
    .platforms.cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .pad {
    padding: var(--space-4);
  }

  .figures {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .figures > :global(:first-child) {
    align-self: stretch;
  }

  .empty-line,
  .quiet {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--muted);
  }

  .empty-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .notes {
    padding-left: var(--space-4);
    margin: 0;
  }

  .notes li + li {
    margin-top: var(--space-1);
  }

  .filters[hidden] {
    display: none;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: flex-start;
  }

  .filters :global(.range) {
    flex: 0 1 auto;
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .toggle:hover {
    color: var(--ink);
    border-color: var(--line-hover);
  }

  .toggle[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .toggle:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }
</style>
