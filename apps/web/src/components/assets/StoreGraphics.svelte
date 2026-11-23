<!--
  StoreGraphics: what the STORE holds, per language and screen size, read only: thumbnails in the store's order, how many each set has and
  the store-side checks (pixel size, file size, count per set) with no repository involved. The images come through the server's thumbnail
  route (an allow list of the stores' CDN hosts); the read is the cached one of the last minute (docs/api/assets.md, `GET /assets/store`).
  Nothing here changes a store. Props: api, workspaceId, app, now (ms), view (the answer, or null while reading), problem (why it could not
  be read, or ''), reloading, onreload.
-->
<script lang="ts">
  import { ASSET_KIND_LABELS, type StoreImagesView, checkStoreImages } from '@kiln/core';
  import { storeThumbUrl } from '../../lib/assets/sync.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import AssetProblems from './AssetProblems.svelte';

  let {
    workspaceId,
    app,
    now,
    view,
    problem = '',
    reloading = false,
    onreload,
  }: {
    workspaceId: string;
    app: AppSummary;
    now: number;
    view: StoreImagesView | null;
    problem?: string | undefined;
    reloading?: boolean | undefined;
    onreload: () => void;
  } = $props();

  const found = $derived(view ? checkStoreImages(view) : []);
  const errors = $derived(found.filter((p) => p.severity === 'error'));
  const sets = $derived((view?.sets ?? []).filter((s) => s.files.length > 0));
  const locales = $derived(
    sets.reduce((all: { locale: string; sets: typeof sets }[], set) => {
      const own = all.filter((l) => l.locale === set.locale)[0];
      if (own) own.sets.push(set);
      else all.push({ locale: set.locale, sets: [set] });
      return all;
    }, []),
  );
  const setName = (set: (typeof sets)[number]) => `${ASSET_KIND_LABELS[set.kind]} · ${set.deviceLabel}`;
</script>

<section class="store" aria-label={t('assets:store.title')}>
  <header class="head">
    <h3>{t('assets:store.title')}</h3>
    {#if view}<span class="muted">{t('assets:store.readAt', { when: timeAgo(view.readAt, now) })}</span>{/if}
    <Button size="sm" icon="refresh" loading={reloading} onclick={onreload}>{t('assets:store.reread')}</Button>
  </header>

  {#if problem && !view}
    <Alert tone="warn" title={t('assets:store.readFailed')}>{problem}</Alert>
  {:else if view && locales.length === 0}
    <div class="card"><EmptyState icon="images" title={t('assets:store.emptyTitle')} description={t('assets:store.emptyText')} /></div>
  {:else if view}
    {#if errors.length > 0}
      <Alert tone="error" title={t('assets:store.problems', { count: errors.length })}>
        <AssetProblems problems={found} />
      </Alert>
    {:else if found.length > 0}
      <Alert tone="info" title={t('assets:store.notes', { count: found.length })}>
        <AssetProblems problems={found} />
      </Alert>
    {/if}
    {#if view.unplaced > 0}<p class="muted">{t('assets:store.unplaced', { count: view.unplaced })}</p>{/if}
    {#each locales as loc (loc.locale)}
      <details class="card locale" open={locales.length === 1}>
        <summary>
          <strong>{loc.locale}</strong>
          <span class="muted">{t('assets:store.images', { count: loc.sets.reduce((n, s) => n + s.files.length, 0) })}</span>
        </summary>
        {#each loc.sets as set (`${set.kind}/${set.device ?? ''}/${set.target}`)}
          <h4>{setName(set)} <span class="muted">({set.files.length})</span></h4>
          <ul class="thumbs">
            {#each set.files as file (file.ref)}
              <li>
                {#if file.downloadable}
                  <img
                    src={storeThumbUrl(workspaceId, app.id, file.ref, 160)}
                    alt={t('assets:store.imageAlt', { set: setName(set), position: file.position })}
                    loading="lazy"
                    width="80"
                    height="140"
                  />
                {:else}
                  <span class="none muted">{t('assets:store.noPreview')}</span>
                {/if}
                {#if file.width !== null && file.height !== null}<span class="dim muted">{file.width}×{file.height}</span>{/if}
              </li>
            {/each}
          </ul>
        {/each}
      </details>
    {/each}
  {:else}
    <p class="muted" role="status">{t('assets:store.reading')}</p>
  {/if}
</section>

<style>
  .store {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .head h3 {
    margin: 0;
    margin-right: auto;
  }

  .muted {
    color: var(--muted);
  }

  .locale summary {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    cursor: pointer;
  }

  h4 {
    margin: var(--space-3) 0 var(--space-2);
  }

  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .thumbs li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .thumbs img,
  .none {
    display: grid;
    place-items: center;
    width: 80px;
    height: 140px;
    padding: var(--space-1);
    text-align: center;
    object-fit: contain;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  .dim {
    font-size: var(--text-xs);
  }
</style>
