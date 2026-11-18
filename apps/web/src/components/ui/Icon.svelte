<!--
  Icon: inline SVG on a 24px grid, stroke style, colored by `currentColor`.
  Props: name (see icons.ts), size = 16 (px), title? (adds an accessible name; without it the
  icon is hidden from assistive technology, so put a text label next to it), class?
-->
<script lang="ts">
  import { type IconName, iconPaths } from './icons.ts';

  let {
    name,
    size = 16,
    title,
    class: className = '',
  }: { name: IconName; size?: number; title?: string; class?: string } = $props();
</script>

<svg
  class="icon {className}"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  focusable="false"
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  {@html iconPaths[name]}
</svg>

<style>
  .icon {
    display: inline-block;
    flex: none;
    vertical-align: -0.2em;
  }
</style>
