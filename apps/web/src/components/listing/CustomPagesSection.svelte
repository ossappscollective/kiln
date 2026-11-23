<!--
  CustomPagesSection: the app's Apple custom product pages as the last sync stored them, read only, on the Store listing page. A page has its
  own screenshots, previews and promotional text for a campaign; Kiln shows its name, status, languages and address and changes nothing
  (the store's console does). Same data as Insights > Experiments (docs/api/experiments.md, `GET /experiments`: the stored copy, no store call).
  Google Play has no API for custom store listings, so an Android record shows nothing here.
  Props: api, workspaceId, app, refreshKey (changes when an app sync finished).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { type Api } from '../../lib/api.ts';
  import { assetsText, type ExperimentsView, localesText, stateBadge, sumAssets } from '../../lib/experiments.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Button from '../ui/Button.svelte';

  let { api, workspaceId, app, refreshKey }: { api: Api; workspaceId: string; app: AppSummary; refreshKey: number } = $props();

  let view = $state<ExperimentsView | null>(null);
  let generation = 0;

  $effect(() => {
    void refreshKey;
    const key = `${workspaceId}/${app.id}`;
    untrack(async () => {
      if (app.platform !== 'ios') return;
      const mine = ++generation;
      try {
        const read = await api.appExperiments(workspaceId, app.id);
        if (mine === generation && key === `${workspaceId}/${app.id}`) view = read;
      } catch {
        if (mine === generation) view = null;
      }
    });
  });

  const pages = $derived(view?.customPages ?? []);
  const synced = $derived(view?.sync?.lastSyncedAt != null);
</script>

{#if app.platform === 'ios' && view !== null && view.api}
  <section class="pages" aria-label={t('experiments:pages.heading')}>
    <h3>{t('experiments:pages.heading')}</h3>
    {#if pages.length === 0}
      {#if !synced}
        <p class="muted">{t('experiments:pages.neverDescription')}</p>
      {/if}
    {:else}
      <ul class="list card flush">
        {#each pages as p (p.id)}
          {@const badge = stateBadge(p.state)}
          <li>
            <div class="main">
              <strong>{p.name}</strong>
              <Badge tone={badge.tone} dot>{badge.label}</Badge>
              {#if p.visible === false}<span class="muted">{t('experiments:pages.hidden')}</span>{/if}
            </div>
            <div class="muted meta">
              {localesText(p.locales)}{#if p.locales.length > 0} · {assetsText(sumAssets(p.locales))}{/if}
            </div>
            {#if p.url}
              <div class="row">
                <Button size="sm" icon="external-link" href={p.url} target="_blank">{t('experiments:pages.open')}<span class="visually-hidden"> {p.name}</span></Button>
                <CopyButton value={p.url} size="sm" label={t('experiments:pages.copyLink')} />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .pages {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .pages h3 {
    margin: 0;
  }

  .muted {
    margin: 0;
    color: var(--muted);
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .list li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
  }

  .list li:first-child {
    border-top: 0;
  }

  .main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
