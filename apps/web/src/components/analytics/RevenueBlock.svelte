<!--
  RevenueBlock: the "Revenue" block of the Insights overview (docs/adr/0043-revenuecat-metrics.md, docs/ux-ia.md): RevenueCat's own overview figures of the
  linked project (active subscriptions, active trials, MRR, revenue over 28 days), the time they were read ("As of ...") and, always, whose numbers they
  are ("RevenueCat figures, all stores": every app and store of the RevenueCat project, not this app alone, not the store consoles).
  Drawn only for an app linked to RevenueCat. From the STORED copy (`GET .../revenuecat/metrics`); it loads it itself and never calls RevenueCat.
  Money carries RevenueCat's currency and is never converted; a figure RevenueCat did not report is not drawn (never a zero). A failed read says
  why beside the older figures (for a key without the Charts & Metrics permission the sentence names the permission and says to sync again),
  with a link to Products where "Sync products" reads them. Every member who can read the app sees it, revenue included.
  ONE block for the whole scope: the figures are all-stores figures, so with iOS and Android in scope they are read from the first record that is
  linked and drawn once (never once per platform).
  Props: api, workspaceId, appIds (the app records in scope), now (epoch ms, for "As of").
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    asOf,
    productsHref,
    revenueState,
    type RevenueCatMetricsRead,
    STRIP_SCOPE,
    STRIP_SCOPE_DETAIL,
    stripProblem,
    stripTiles,
  } from '../../lib/revenuecat/metrics.ts';
  import InfoTip from '../ui/InfoTip.svelte';

  let { api, workspaceId, appIds, now }: { api: Api; workspaceId: string; appIds: string[]; now: number } = $props();

  let read = $state<RevenueCatMetricsRead | null>(null);
  let appId = $state('');
  let generation = 0;

  $effect(() => {
    const mine = ++generation;
    const ids = [...appIds];
    void Promise.all(ids.map((id) => api.revenueCatMetrics(workspaceId, id).catch(() => null))).then((reads) => {
      if (mine !== generation) return;
      const at = Math.max(0, reads.findIndex((r) => revenueState(r) !== 'hidden'));
      read = reads[at] ?? null;
      appId = ids[at] ?? '';
    });
  });

  const block = $derived(revenueState(read));
  const tiles = $derived(stripTiles(read));
  const problem = $derived(stripProblem(read));
</script>

{#if block !== 'hidden'}
  <section class="strip" aria-label={t('products:metrics.aria')} data-testid="revenue-block">
    <h3 class="title">{t('analytics:revenue.title')}</h3>
    {#if tiles.length > 0}
      <ul class="tiles">
        {#each tiles as tile (tile.id)}
          <li title={tile.title} data-testid="revenuecat-metric-{tile.id}">
            <span class="value tabular">{tile.value}</span>
            <span class="label">{tile.label}</span>
          </li>
        {/each}
      </ul>
    {:else if block === 'waiting'}
      <p class="text-sm muted" data-testid="revenue-waiting">{t('analytics:revenue.waiting')}</p>
    {/if}
    <p class="scope text-sm muted">
      <span>{t(STRIP_SCOPE)}</span>
      {#if tiles.length > 0}<span aria-hidden="true">·</span> <span data-testid="revenuecat-metrics-asof">{asOf(read, now)}</span>{/if}
      <InfoTip label={t('products:metrics.about')} text={t(STRIP_SCOPE_DETAIL)} align="end" width="24rem" />
      <span aria-hidden="true">·</span>
      <a href={productsHref(appId)} data-testid="revenue-products-link">{t('analytics:revenue.openProducts')}</a>
    </p>
    {#if problem !== ''}<p class="problem text-sm" role="status" data-testid="revenuecat-metrics-problem">{problem}</p>{/if}
  </section>
{/if}

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  .title {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .value {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--text);
  }

  .label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .scope {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
  }

  .problem {
    flex-basis: 100%;
    margin: 0;
    color: var(--warn-ink);
  }
</style>
