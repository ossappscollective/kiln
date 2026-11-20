<!--
  AnalyticsStrip: the compact "Last 28 days" line of the app dashboard: downloads, conversion and crash rate, each with a small
  trend. It draws NOTHING while analytics is off, has no stored data or a read fails (a quiet dashboard stays quiet), and one
  line per platform in scope otherwise. Two reads per platform record, only when analytics is on and has data: the status, then
  one overview. It links to the Analytics section, where the comparison, the sources and the limits are.
  Props: api, workspaceId, members (the app records in scope), now, refreshKey? (changes after a sync, so it reads again).
  The word of the figures is the same as in the Analytics section (First-time downloads, Installs; Crash rate is derived or as sent).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { loadStrip } from '../../lib/analytics/load.ts';
  import type { Strip } from '../../lib/analytics/view.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';
  import TrendSpark from './TrendSpark.svelte';
  import VizScope from './VizScope.svelte';

  let { api, workspaceId, members, now, refreshKey = 0 }: { api: Api; workspaceId: string; members: AppSummary[]; now: number; refreshKey?: number } = $props();

  let strips = $state<Record<string, Strip | null | undefined>>({});
  let generation = 0;

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);
  $effect(() => {
    void key;
    void refreshKey;
    untrack(() => {
      const mine = ++generation;
      for (const app of members) {
        void loadStrip(api, workspaceId, app, now).then((s) => {
          if (mine === generation) strips[app.id] = s;
        });
      }
    });
  });

  const shown = $derived(members.filter((m) => !!strips[m.id]));
</script>

{#if shown.length > 0}
  <VizScope>
    <section class="strip card" aria-label="Last 28 days">
      <div class="row between head">
        <h2>Last 28 days</h2>
        <a href={appAddress(members[0]?.id ?? '', 'analytics', members.length > 1 ? null : (members[0]?.platform ?? null))}>Analytics<Icon name="chevron-right" size={14} /></a>
      </div>
      {#each shown as app (app.id)}
        {@const strip = strips[app.id]}
        {#if strip}
          <div class="platform">
            {#if members.length > 1}<span class="plat muted">{platformLabel(app.platform)}</span>{/if}
            <ul class="items">
              {#each strip.items as item (item.id)}
                <li>
                  <span class="label muted">{item.label}</span>
                  <span class="line">
                    <strong class="value" title={item.title}>{item.value}</strong>
                    <TrendSpark points={item.points} label="{item.label}, last 28 days: {item.value}. {item.title}" />
                  </span>
                </li>
              {/each}
            </ul>
            <p class="fresh muted">{strip.freshness}</p>
          </div>
        {/if}
      {/each}
    </section>
  </VizScope>
{/if}

<style>
  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
  }

  .head {
    align-items: baseline;
  }

  h2 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .head a {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    font-size: var(--text-sm);
  }

  .platform {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
    align-items: center;
  }

  .plat {
    min-width: 4rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .items {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-8);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .label {
    font-size: var(--text-xs);
  }

  .line {
    display: inline-flex;
    gap: var(--space-3);
    align-items: center;
  }

  .value {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .fresh {
    margin: 0;
    font-size: var(--text-xs);
  }
</style>
