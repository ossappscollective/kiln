<!--
  PlatformBadge: the platform of an app as a small icon tile and its name (iOS, macOS or Android).
  Props: platform ('ios' | 'macos' | 'android'; anything else draws a neutral phone), showLabel = true (false
  keeps the name for assistive technology only), tinted = false (true uses the store's accent tint,
  info for iOS and macOS, ok for Android; the glyph and the name still say which).
  The tile is a fixed square, so it never shifts the layout.
-->
<script lang="ts">
  import { platformBadgeText, platformById, storeForPlatform } from '../../lib/stores.ts';
  import Icon from './Icon.svelte';

  let { platform, showLabel = true, tinted = false }: { platform: string; showLabel?: boolean; tinted?: boolean } = $props();

  const info = $derived(platformById(platform));
  const text = $derived(platformBadgeText(info, showLabel));
  const tint = $derived(tinted ? storeForPlatform(platform).tint : 'neutral');
</script>

<span class="platform">
  <span class="tile {tint}" aria-hidden="true"><Icon name={info.icon} size="md" /></span>
  <span class:visually-hidden={!showLabel}>{text.name}</span>
</span>

<style>
  .platform {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }

  .tile {
    display: inline-grid;
    flex: none;
    width: var(--control-sm);
    height: var(--control-sm);
    color: var(--muted);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    place-items: center;
  }

  .tile.info {
    color: var(--info-ink);
    background: var(--info-bg);
    border-color: var(--info-line);
  }

  .tile.ok {
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
</style>
