<!--
  PlatformBadge: the platform of an app, as a small icon tile and its name.
  Props: platform, showLabel = true (false keeps the name for assistive technology only).
-->
<script lang="ts">
  import type { Platform } from '@mrm/core';
  import { platformLabel } from '../../lib/portfolio.ts';
  import Icon from '../ui/Icon.svelte';

  let { platform, showLabel = true }: { platform: Platform; showLabel?: boolean } = $props();
</script>

<span class="platform">
  <span class="tile" aria-hidden="true"><Icon name={platform === 'ios' ? 'smartphone' : 'play'} size={16} /></span>
  <span class:visually-hidden={!showLabel}>{platformLabel(platform)}</span>
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
</style>
