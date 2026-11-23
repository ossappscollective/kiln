<!--
  TimelineTab: the Timeline tab of Insights (`?view=timeline`, docs/adr/0053-timeline-and-reports.md). The hierarchy is the one of every page
  (docs/ux-ia.md 0e): the header holds scope and Sync (this page syncs the app, reviews and analytics), then [the section rail | the content].
  Sections (`?section=`): Timeline (the default: the range bar, the events) and Reports (its own period bar, because a report is a calendar
  week, month or year, not a free range). Both are always listed: with no data each says so in a line. Reads stored data only.
  Props: api, workspaceId, role, members (records in scope), now, refreshKey (changes when a sync ended).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { type RangeChoice, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { type RailGroup, resolveRailSection } from '../../lib/section-rail.ts';
  import { withTimelineSection } from '../../lib/timeline/timeline.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import RangeControl from '../analytics/RangeControl.svelte';
  import UpdatedLine from '../app/UpdatedLine.svelte';
  import type { Api } from '../../lib/api.ts';
  import SectionRail from '../ui/SectionRail.svelte';
  import ReportsSection from './ReportsSection.svelte';
  import TimelineEvents from './TimelineEvents.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined } = $props();

  const choice = $derived(parseRange(address.hash));
  const range = $derived(resolveRange(choice, now));
  const setRange = (next: RangeChoice) => replaceHash(withRange(location.hash, next));

  const groups = $derived<RailGroup[]>([
    {
      id: 'timeline',
      label: t('timeline:rail.group'),
      entries: [
        { id: 'events', label: t('timeline:rail.events') },
        { id: 'reports', label: t('timeline:rail.reports') },
      ],
    },
  ]);
  const part = $derived(resolveRailSection(address.hash, ['events', 'reports']));
</script>

<div class="timeline stack loose" data-testid="timeline-tab">
  {#if part === 'events'}
    <div class="filters no-print">
      <RangeControl {choice} {range} {now} onchange={setRange} />
      <span class="spacer"></span>
      {@render updated()}
    </div>
  {/if}

  <SectionRail {groups} value={part} hrefFor={(id) => withTimelineSection(address.hash, id)} label={t('timeline:rail.label')}>
    {#if part === 'reports'}
      <ReportsSection {api} {workspaceId} {role} {members} {now} {refreshKey}>
        {#snippet trailing()}{@render updated()}{/snippet}
      </ReportsSection>
    {:else}
      <TimelineEvents {api} {workspaceId} {role} {members} {range} {now} {refreshKey} />
    {/if}
  </SectionRail>
</div>

{#snippet updated()}
  <UpdatedLine {api} {workspaceId} {role} apps={members} kinds={['app', 'reviews', 'analytics']} {refreshKey} />
{/snippet}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }
</style>
