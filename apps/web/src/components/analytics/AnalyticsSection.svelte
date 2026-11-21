<!--
  AnalyticsSection: the Overview view of Insights of an app (left panel, `g i`; `g n` still lands here). One filter row on top that scopes everything below it:
  the date range (Last 7, 28 or 90 days, or custom; kept in the address) and "Show data" (every chart also as a table). The
  platform scope is the control in the app header (iOS | macOS | Android | All): each platform in scope is drawn on its own,
  because Apple downloads and Google installs, or two currencies, are different measures and are never added together.
  Reading is open to every role (`analytics.read`); turning on, syncing, enabling Apple analytics and importing a file need
  `analytics.manage` and are offered only to those who have it.
  Under the figures and the one chart of each platform: its ASO "Next steps" (two, then "Show all") and any open AI suggestions.
  Props: api, workspaceId, role, members (the app records in scope), now.
  The charts are small multiples, not a dashboard of widgets: see components/analytics/ChartCard.svelte.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import { type RangeChoice, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import AsoCoach from '../aso/AsoCoach.svelte';
  import AnalyticsPlatform from './AnalyticsPlatform.svelte';
  import SectionsToggle from '../ui/SectionsToggle.svelte';
  import RangeControl from './RangeControl.svelte';
  import VizScope from './VizScope.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  let showData = $state(false);
  /** Bumped when an AI suggestion was accepted (keywords may have been added), so the next steps read again. */
  let coachVersion = $state(0);
  // The range and the table switch only matter once something is stored; until then (off, or waiting for the first data) they are left out.
  let storedBy = $state<Record<string, boolean>>({});
  const anyStored = $derived(members.some((m) => storedBy[m.id] === true));
  const onstored = (appId: string, stored: boolean) => {
    if (storedBy[appId] !== stored) storedBy = { ...storedBy, [appId]: stored };
  };
  const choice = $derived(parseRange(address.hash));
  const range = $derived(resolveRange(choice, now));

  const setRange = (next: RangeChoice) => replaceHash(withRange(location.hash, next));
</script>

<VizScope>
  <div class="analytics stack loose">
    <div class="filters" hidden={!anyStored}>
      <RangeControl {choice} {range} {now} onchange={setRange} />
      <span class="spacer"></span>
      <SectionsToggle />
      <button type="button" class="bare toggle" aria-pressed={showData} onclick={() => (showData = !showData)}>
        {showData ? 'Hide data' : 'Show data'}
      </button>
    </div>

    {#each members as app (app.id)}
      <AnalyticsPlatform {api} {workspaceId} {role} {app} {range} {now} {showData} heading={members.length > 1} {onstored}>
        {#snippet extras()}
          {#if can(role, 'aso.read')}
            <AsoCoach {api} {workspaceId} {app} version={coachVersion} showPlatform={members.length > 1} visible={2} />
          {/if}
          <AiSuggestions {api} {workspaceId} {role} {app} platform={address.platform} showPlatform={members.length > 1} onaccepted={() => {
            coachVersion += 1;
          }} />
        {/snippet}
      </AnalyticsPlatform>
    {/each}
  </div>
</VizScope>

<style>
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
