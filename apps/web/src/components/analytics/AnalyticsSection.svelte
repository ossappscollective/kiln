<!--
  AnalyticsSection: the Overview view of Insights of an app (left panel, `g i`; `g n` still lands here). Not one long column: from the top,
  1. one filter row that scopes everything below it: the date range (Last 7, 28 or 90 days, or custom; kept in the address) and "Show data"
     (every chart also as a table);
  2. the HEADLINE: the RevenueCat figures ONCE for the whole scope (they are all-stores figures; RevenueBlock), then the row of store figures of
     each platform, side by side when iOS and Android are both in scope;
  3. a section rail (components/ui/SectionRail.svelte, `?section=`, lib/analytics/sections.ts): Overview (the headline chart), Acquisition,
     Quality, Revenue, Next steps (ASO and AI suggestions) and Data sources (ONE panel for the whole scope, SourcesPanel). Each section draws the
     platforms side by side on a wide screen and stacked on a narrow one. Every chart card is in exactly one section: nothing was dropped.
  The platform scope is the control in the app header (iOS | macOS | Android | All): each platform in scope is drawn on its own, because Apple
  downloads and Google installs, or two currencies, are different measures and are never added together.
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
  import { t } from '../../lib/i18n/t.ts';
  import { type RangeChoice, type AnalyticsStatus, needsPlayBucket, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import { PlatformData } from '../../lib/analytics/platform-data.svelte.ts';
  import { cardsOfPart, failedSourceCount, insightsGroups, platformColumns, withoutHeadline, type InsightsPart } from '../../lib/analytics/sections.ts';
  import { buildCards, splitHeadline } from '../../lib/analytics/view.ts';
  import { railEntries, resolveRailSection, withRailSection } from '../../lib/section-rail.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import AsoCoach from '../aso/AsoCoach.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import SectionRail from '../ui/SectionRail.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import AnalyticsPlatform from './AnalyticsPlatform.svelte';
  import PlayReportsSetup from './PlayReportsSetup.svelte';
  import RangeControl from './RangeControl.svelte';
  import RevenueBlock from './RevenueBlock.svelte';
  import SourcesPanel from './SourcesPanel.svelte';
  import VizScope from './VizScope.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  let showData = $state(false);
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

  const several = $derived(members.length > 1);
  const columns = $derived(platformColumns(members.length));
  const anyStored = $derived(rows.some((r) => r.data.stored));

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
  const groups = $derived(insightsGroups(counts, true));
  const part = $derived(resolveRailSection(address.hash, railEntries(groups).map((e) => e.id)) as InsightsPart);
  const sourceItems = $derived(rows.flatMap((r) => (r.data.status ? [{ app: r.app, status: r.data.status }] : [])));
</script>

<VizScope>
  <div class="analytics stack loose">
    <div class="filters" hidden={!anyStored}>
      <RangeControl {choice} {range} {now} onchange={setRange} />
      <span class="spacer"></span>
      <SectionsToggle />
      <button type="button" class="bare toggle" aria-pressed={showData} onclick={() => (showData = !showData)}>
        {showData ? t('analytics:section.hideData') : t('analytics:section.showData')}
      </button>
    </div>

    <div class="headline stack loose" data-testid="insights-headline">
      <!-- RevenueCat figures are all-stores figures: one block for the whole scope, never one per platform. -->
      <RevenueBlock {api} {workspaceId} appIds={members.map((m) => m.id)} {now} />
      <div class="platforms cols-{columns}">
        {#each rows as r (r.app.id)}
          <AnalyticsPlatform {api} {workspaceId} {role} app={r.app} data={r.data} part="headline" {range} {now} {showData} heading={several} onreload={reloadAll} />
        {/each}
      </div>
    </div>

    <SectionRail {groups} value={part} hrefFor={(id) => withRailSection(address.hash, id)} label={t('analytics:rail.label')}>
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
      {:else}
        <div class="platforms cols-{columns}">
          {#each rows as r (r.app.id)}
            <AnalyticsPlatform {api} {workspaceId} {role} app={r.app} data={r.data} {part} {range} {now} {showData} heading={several} onreload={reloadAll}>
              {#snippet extras()}
                {#if can(role, 'aso.read')}
                  <AsoCoach {api} {workspaceId} app={r.app} version={coachVersion} showPlatform={several} visible={2} />
                {/if}
                <AiSuggestions {api} {workspaceId} {role} app={r.app} platform={address.platform} showPlatform={several} onaccepted={() => {
                  coachVersion += 1;
                }} />
              {/snippet}
            </AnalyticsPlatform>
          {/each}
        </div>
      {/if}
    </SectionRail>
  </div>
</VizScope>

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
