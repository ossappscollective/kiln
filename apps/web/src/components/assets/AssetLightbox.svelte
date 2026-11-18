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
  import type { AssetProblem } from '@mrm/core';
  import {
    type PreviewState,
    dimensionsText,
    fileName,
    formatBytes,
    kindLabel,
    localeLabel,
    shortCommit,
  } from '../../lib/assets.ts';
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
    open?: boolean;
    assets: AssetItem[];
    index?: number;
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

<Modal bind:open size="lg" title={asset ? fileName(asset.path) : 'File'} description={asset ? `${kindLabel(asset.kind)} · ${asset.deviceLabel} · ${localeLabel(asset.locale)}` : undefined}>
  {#if asset}
    <div class="lightbox">
      <div class="stage" role="group" aria-label="Preview of {fileName(asset.path)}">
        {#if canShow && src}
          {#key src}
            <img
              {src}
              alt="{kindLabel(asset.kind)} {asset.order}, {asset.deviceLabel}, {localeLabel(asset.locale)}: {fileName(asset.path)}"
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
            <span>{shown === 'image' ? 'Could not load the preview.' : noteFor(shown)}</span>
          </p>
        {/if}
      </div>

      <dl class="facts">
        <div><dt>Path</dt><dd class="row"><code class="path">{asset.path}</code><CopyButton value={asset.path} iconOnly label="Copy the path" /></dd></div>
        <div><dt>Position</dt><dd>{asset.order} in its set</dd></div>
        <div><dt>Size</dt><dd>{dimensionsText(asset)}</dd></div>
        <div><dt>File size</dt><dd>{formatBytes(asset.bytes)}</dd></div>
        <div><dt>Format</dt><dd>{asset.format ?? 'Not read'}{asset.hasAlpha === true ? ', with alpha channel' : asset.hasAlpha === false ? ', no alpha channel' : ''}</dd></div>
        {#if asset.oid}<div><dt>Content id</dt><dd><code>{shortCommit(asset.oid)}</code></dd></div>{/if}
      </dl>

      <section aria-label="Problems with this file">
        {#if problems.length === 0}
          <p class="muted">No problems found for this file against the documented specs.</p>
        {:else}
          <AssetProblems {problems} showPath={false} />
        {/if}
      </section>
    </div>
  {/if}
  {#snippet footer()}
    <span class="position muted" aria-live="polite">{assets.length > 0 ? `${index + 1} of ${assets.length}` : ''}</span>
    <Button icon="chevron-left" disabled={!hasPrev} onclick={() => go(-1)}>Previous</Button>
    <Button disabled={!hasNext} onclick={() => go(1)}>Next <Icon name="chevron-right" size="sm" /></Button>
    <Button variant="primary" onclick={() => (open = false)}>Close</Button>
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
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    font-size: var(--text-base);
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
