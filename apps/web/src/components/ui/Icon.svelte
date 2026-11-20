<!--
  Icon: inline SVG on a 24px grid, drawn in `currentColor` so it follows the text color and both
  themes. The registry is lib/icons.ts (stroke icons use a 2px round stroke, fill icons are solid).
  Props: name (an IconName; an unknown name draws the neutral "help" glyph), size = 'md'
  ('sm' 14, 'md' 16, 'lg' 20, 'xl' 24, or a pixel number), title? (adds role="img" and an
  accessible name; without it the icon is hidden from assistive technology, so put visible text
  or an aria-label on the control beside it), class?
  The size is set with width and height attributes, so the icon never shifts the layout.
-->
<script lang="ts">
  import { type IconName, type IconSize, iconDef, iconPixels } from '../../lib/icons.ts';

  let {
    name,
    size = 'md',
    title,
    class: className = '',
  }: { name: IconName; size?: IconSize | undefined; title?: string | undefined; class?: string | undefined } = $props();

  const def = $derived(iconDef(name));
  const px = $derived(iconPixels(size));
  const solid = $derived(def.style === 'fill');
</script>

<svg
  class="icon {className}"
  width={px}
  height={px}
  viewBox="0 0 24 24"
  fill={solid ? 'currentColor' : 'none'}
  stroke={solid ? 'none' : 'currentColor'}
  stroke-width={solid ? undefined : 2}
  stroke-linecap="round"
  stroke-linejoin="round"
  focusable="false"
  aria-hidden={title ? undefined : 'true'}
  aria-label={title || undefined}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  {@html def.body}
</svg>

<style>
  .icon {
    display: inline-block;
    flex: none;
    vertical-align: -0.2em;
  }
</style>
