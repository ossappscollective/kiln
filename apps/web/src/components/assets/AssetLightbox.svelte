<!--
  AssetLightbox: the large view of one file, with what is known about it and every problem found
  for it, with the documented rule in words. Built on Modal (native <dialog>: focus trap, Escape,
  focus back to the opener).
  Props: open (bindable), assets (the files in the order they are shown), index (bindable, which
  one), urlFor(asset) (file route URL or null), problemsFor(asset), stateFor(asset)
  ('image' | 'video' | 'too_large' | 'unavailable'), noteFor(state).
  Previous and next: the buttons, or the left and right arrow keys while the view is open.
  Read-only: nothing here changes a file or a store.
-->
<script lang="ts">
  import type { AssetProblem } from '@kiln/core';
  import {
    type PreviewState,
    dimensionsText,
    fileName,
    formatBytes,
    kindLabel,
    localeLabel,
    shortCommit,
  } from '../../lib/assets/assets.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AssetItem } from '../../lib/types.ts';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import AssetProblems from './AssetProblems.svelte';

  let {
    open = $bindable(false),
    assets,
    index = $bindable(0),
    urlFor,
    problemsFor,
    stateFor,
    noteFor,
  }: {
    open?: boolean | undefined;
    assets: AssetItem[];
    index?: number | undefined;
    urlFor: (asset: AssetItem) => string | null;
    problemsFor: (asset: AssetItem) => AssetProblem[];
    stateFor: (asset: AssetItem) => PreviewState;
    noteFor: (state: PreviewState) => string;
  } = $props();

  const asset = $derived(assets[index] ?? null);
  const src = $derived(asset ? urlFor(asset) : null);
  const shown = $derived(asset ? stateFor(asset) : 'unavailable');
  const problems = $derived(asset ? problemsFor(asset) : []);
  let failedSrc = $state<string | null>(null);
  const canShow = $derived(shown === 'image' && src !== null && failedSrc !== src);

  const kindText = $derived(asset ? t('assets:lightbox.kindLine', { kind: kindLabel(asset.kind), device: asset.deviceLabel, locale: localeLabel(asset.locale) }) : '');
  const formatText = $derived(
    asset ? (asset.hasAlpha === true ? t('assets:lightbox.formatAlpha', { format: asset.format ?? t('assets:lightbox.notRead') }) : asset.hasAlpha === false ? t('assets:lightbox.formatNoAlpha', { format: asset.format ?? t('assets:lightbox.notRead') }) : (asset.format ?? t('assets:lightbox.notRead'))) : '',
  );

  const hasPrev = $derived(index > 0);
  const hasNext = $derived(index < assets.length - 1);
  const go = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < assets.length) index = next;
  };

  function onkeydown(event: KeyboardEvent) {
    if (!open || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  }
</script>

<svelte:window {onkeydown} />

<Modal bind:open size="lg" title={asset ? fileName(asset.path) : t('assets:lightbox.file')} description={asset ? kindText : undefined}>
  {#if asset}
    <div class="lightbox">
      <div class="stage" role="group" aria-label={t('assets:lightbox.previewOf', { name: fileName(asset.path) })}>
        {#if canShow && src}
          {#key src}
            <img
              {src}
              alt={t('assets:lightbox.alt', { kind: kindLabel(asset.kind), order: asset.order, device: asset.deviceLabel, locale: localeLabel(asset.locale), name: fileName(asset.path) })}
              decoding="async"
              referrerpolicy="no-referrer"
              onerror={() => {
                failedSrc = src;
              }}
            />
          {/key}
        {:else}
          <p class="placeholder muted">
            <Icon name={shown === 'video' ? 'play' : 'image'} size="xl" />
            <span>{shown === 'image' ? t('assets:lightbox.loadFailed') : noteFor(shown)}</span>
          </p>
        {/if}
      </div>

      <dl class="facts">
        <div><dt>{t('assets:lightbox.path')}</dt><dd class="row"><code class="path">{asset.path}</code><CopyButton value={asset.path} iconOnly label={t('assets:lightbox.copyPath')} /></dd></div>
        <div><dt>{t('assets:lightbox.position')}</dt><dd>{t('assets:lightbox.inSet', { order: asset.order })}</dd></div>
        <div><dt>{t('assets:lightbox.dimensions')}</dt><dd>{dimensionsText(asset)}</dd></div>
        <div><dt>{t('assets:lightbox.fileSize')}</dt><dd>{formatBytes(asset.bytes)}</dd></div>
        <div><dt>{t('assets:lightbox.format')}</dt><dd>{formatText}</dd></div>
        {#if asset.oid}<div><dt>{t('assets:lightbox.contentId')}</dt><dd><code>{shortCommit(asset.oid)}</code></dd></div>{/if}
      </dl>

      <section aria-label={t('assets:lightbox.problems')}>
        {#if problems.length === 0}
          <p class="muted">{t('assets:lightbox.noProblems')}</p>
        {:else}
          <AssetProblems {problems} showPath={false} />
        {/if}
      </section>
    </div>
  {/if}
  {#snippet footer()}
    <span class="position muted" aria-live="polite">{assets.length > 0 ? t('assets:lightbox.positionOf', { number: index + 1, total: assets.length }) : ''}</span>
    <Button icon="chevron-left" disabled={!hasPrev} onclick={() => go(-1)}>{t('assets:lightbox.previous')}</Button>
    <Button disabled={!hasNext} onclick={() => go(1)}>{t('assets:lightbox.next')} <Icon name="chevron-right" size="sm" /></Button>
    <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
  {/snippet}
</Modal>

<style>
  .lightbox {
    display: grid;
    gap: var(--space-4);
  }
  .stage {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    max-height: 60vh;
    overflow: auto;
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
    padding: var(--space-2);
  }
  img {
    display: block;
    max-width: 100%;
    max-height: calc(60vh - var(--space-4));
    width: auto;
    height: auto;
    object-fit: contain;
  }
  .placeholder {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-6);
    text-align: center;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin: 0;
  }
  .facts dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }
  .path {
    font-size: var(--text-sm);
  }
  .position {
    margin-right: auto;
    font-size: var(--text-sm);
  }
</style>
