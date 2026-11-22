<!--
  AsoMarkets: the same keyword across countries in one matrix: a row per term, a column per storefront, the best rank
  in each cell (bold where it is the best of the row), "not ranked" when the app is not in the results there, empty
  when the term is not tracked in that country. Hover a cell for the locale and the state.
  Props: api, workspaceId, members, version.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { type AsoMarketsResponse, asoErrorMessage, marketCell, marketColumns } from '../../lib/aso/aso.ts';
  import { marketsLead } from '../../lib/aso/lead.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { countOf, summaryLine } from '../../lib/section-state.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, members, version }: { api: Api; workspaceId: string; members: AppSummary[]; version: number } = $props();

  let data = $state<Record<string, AsoMarketsResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;

  const lead = $derived.by(() => {
    const all = members.flatMap((m) => data[m.id]?.terms ?? []);
    const countries = marketColumns(all);
    return marketsLead({ terms: all.length, countries: countries.length, unranked: all.filter((row) => row.bestRank === null).length });
  });

  $effect(() => {
    void version;
    const list = members;
    const mine = ++generation;
    void (async () => {
      const next: Record<string, AsoMarketsResponse | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          try {
            next[m.id] = await api.asoMarkets(workspaceId, m.id);
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, t('aso:markets.loadFailed'));
          }
        }),
      );
      if (mine !== generation) return;
      data = next;
      errors = bad;
      loading = false;
    })();
  });
</script>

<div class="markets stack roomy">
  {#if !loading && members.some((m) => data[m.id])}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="markets-lead" />
  {/if}
  {#if loading}
    <Skeleton width="100%" height="120px" />
  {:else}
    {#each members as app (app.id)}
      {@const d = data[app.id]}
      {@const cols = d ? marketColumns(d.terms) : []}
      <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={d ? summaryLine([t('aso:count.terms', { count: d.terms.length }), d.terms.length > 0 && t('aso:lead.markets.countries', { count: cols.length })]) : ''}>
        <div class="stack">
          <div class="row head">
            {#if d && d.terms.length > 0}
              <span class="muted">{t('aso:lead.markets.head', { terms: t('aso:count.terms', { count: d.terms.length }), countries: t('aso:lead.markets.countries', { count: cols.length }) })}</span>
              <InfoTip
                label={t('aso:markets.howLabel')}
                text={t('aso:markets.howText')}
              />
            {/if}
          </div>
          {#if errors[app.id]}
            <Alert tone="error">{errors[app.id]}</Alert>
          {:else if d && d.terms.length === 0}
            <p class="none">{t('aso:markets.none')}</p>
          {:else if d}
            <div class="table-wrap">
              <table class="compact matrix">
                <thead>
                  <tr>
                    <th scope="col" class="first">{t('aso:markets.keyword')}</th>
                    {#each cols as c (c)}<th scope="col" class="num">{c.toUpperCase()}</th>{/each}
                    <th scope="col" class="num">{t('aso:markets.best')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each d.terms as row (row.key)}
                    <tr>
                      <th scope="row" class="first">{row.term}</th>
                      {#each cols as c (c)}
                        {@const cell = marketCell(row, c)}
                        <td class="num cell" class:best={cell.best} class:muted={cell.muted} title={cell.title}>{cell.text}</td>
                      {/each}
                      <td class="num">{row.bestRank ?? '–'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      </Section>
    {/each}
  {/if}
</div>

<style>
  .roomy {
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact th),
  .roomy :global(table.compact td) {
    padding-block: var(--space-3);
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact thead th) {
    font-size: var(--text-sm);
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .first {
    position: sticky;
    left: 0;
    min-width: 10rem;
    font-weight: var(--weight-medium);
    text-align: left;
    background: var(--surface);
  }

  .cell.best {
    font-weight: var(--weight-semibold);
    color: var(--ok-ink);
  }

  .cell.muted {
    font-size: var(--text-sm);
  }
</style>
