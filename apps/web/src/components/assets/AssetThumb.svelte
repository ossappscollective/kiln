<!--
  AssetThumb: one file of the gallery: a lazy thumbnail in a box of a fixed size (so nothing moves
  when the image arrives), its order, size in pixels and bytes, and a badge for the worst problem.
  Choosing it opens the lightbox.
  Props: asset, src (the file route URL, or null), preview (what can be shown: 'image' | 'video' |
  'too_large' | 'unavailable'), note (why there is no preview), problems (of this file), store? (the
  status of the file next to the store: lib/assets-groups.ts storeStatusOf), onopen.
  The image is served by the app's own file route from the repository (docs/api/assets.md): nothing
  is fetched from a store, and nothing is uploaded.
-->
<script lang="ts">
  import type { AssetProblem } from '@mrm/core';
  import {
    type PreviewState,
    bySeverity,
    dimensionsText,
    fileName,
    formatBytes,
    severityLabel,
    severityTone,
    worstSeverity,
  } from '../../lib/assets/assets.ts';
  import type { StoreStatus } from '../../lib/assets/groups.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { AssetItem } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';

  let {
    asset,
    src,
    preview,
    note,
    problems,
    store = undefined,
    onopen,
  }: {
    asset: AssetItem;
    src: string | null;
    preview: PreviewState;
    note: string;
    problems: AssetProblem[];
    store?: StoreStatus | undefined;
    onopen: () => void;
  } = $props();

  let failed = $state(false);
  let loaded = $state(false);
  // A different file in the same slot starts clean.
  let shown = '';
  $effect(() => {
    if (src !== shown) {
      shown = src ?? '';
      failed = false;
      loaded = false;
    }
  });

  const worst = $derived(worstSeverity(problems));
  const sorted = $derived([...problems].sort(bySeverity));
  const canShow = $derived(preview === 'image' && src !== null && !failed);
  const label = $derived(
    `${fileName(asset.path)}, number ${asset.order}, ${dimensionsText(asset)}, ${formatBytes(asset.bytes)}${worst ? `, ${sorted.length} ${sorted.length === 1 ? 'problem' : 'problems'}` : ''}`,
  );
</script>

<li class="thumb">
  <button type="button" class="open" onclick={onopen} aria-label="{label}. Open the large view.">
    <span class="box" class:loaded>
      {#if canShow && src}
        <img
          {src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable="false"
          referrerpolicy="no-referrer"
          onload={() => {
            loaded = true;
          }}
          onerror={() => {
            failed = true;
          }}
        />
      {/if}
      {#if !canShow || !loaded}
        <span class="placeholder">
          <Icon name={preview === 'video' ? 'play' : 'image'} size="lg" />
          <span class="note">
            {#if preview === 'image' && failed}Could not load the preview{:else if preview === 'image'}&nbsp;{:else}{note}{/if}
          </span>
        </span>
      {/if}
      <span class="order">{asset.order}</span>
    </span>
    <span class="caption">
      <span class="name" title={asset.path}>{fileName(asset.path)}</span>
      <span class="facts muted">{dimensionsText(asset)} · {formatBytes(asset.bytes)}</span>
      {#if store}
        <span class="status" title={store.title}><Badge tone={store.tone}>{store.label}</Badge></span>
      {/if}
    </span>
  </button>
  {#if worst}
    <span class="flag">
      <Badge tone={severityTone(worst)} icon={toneIcon(severityTone(worst))}>{severityLabel(worst)}{sorted.length > 1 ? ` (${sorted.length})` : ''}</Badge>
    </span>
  {/if}
</li>

<style>
  .thumb {
    position: relative;
    list-style: none;
    min-width: 0;
  }
  .open {
    display: grid;
    gap: var(--space-2);
    width: 100%;
    min-height: 0;
    padding: var(--space-2);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: none;
    color: var(--ink);
    cursor: pointer;
  }
  .open:hover {
    border-color: var(--line-hover);
    background: var(--surface-hover);
  }
  .box {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 180px;
    overflow: hidden;
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
  }
  .loaded img {
    opacity: 1;
  }
  .loaded .placeholder {
    display: none;
  }
  .placeholder {
    display: grid;
    justify-items: center;
    gap: var(--space-1);
    padding: var(--space-2);
    color: var(--muted);
    text-align: center;
  }
  .note {
    font-size: var(--text-sm);
  }
  .order {
    position: absolute;
    left: var(--space-1);
    top: var(--space-1);
    min-width: 20px;
    padding: 0 var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--surface);
    border: 1px solid var(--line);
    font-size: var(--text-sm);
    text-align: center;
    line-height: 20px;
  }
  .caption {
    display: grid;
    gap: var(--space-1);
    padding: 0 var(--space-1) var(--space-1);
    min-width: 0;
  }
  .name {
    font-size: 0.9375rem;
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facts {
    font-size: var(--text-sm);
  }
  .status {
    margin-top: var(--space-1);
  }
  .flag {
    position: absolute;
    right: var(--space-3);
    top: var(--space-3);
  }
  @media (prefers-reduced-motion: no-preference) {
    img {
      transition: opacity var(--duration-fast, 120ms) ease;
    }
  }
</style>
