<!--
  Tooltip: a short hint on hover and keyboard focus. Escape hides it (WCAG 1.4.13); it stays while the pointer is over it. Use for
  labels of icon-only controls and brief clarifications; never for essential information or anything interactive. The bubble is drawn
  by the `floating` action (lib/floating.ts): in the top layer, placed with position: fixed, centred over the trigger, above it when
  it fits, inside the window. No container with `overflow` or a transform can clip it. The words are always in the page for assistive
  technology (the trigger's aria-describedby points at them); the visible bubble is only a picture of them.
  Props: text, placement = 'top' | 'bottom', children (snippet receiving `describedby`: spread it on the trigger so assistive
  technology reads the text).
  Usage:
    <Tooltip text="Copy key">
      {#snippet children(tip)}<button {...tip}>...</button>{/snippet}
    </Tooltip>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { floating } from '../../lib/floating.ts';

  let {
    text,
    placement = 'top',
    children,
  }: {
    text: string;
    placement?: 'top' | 'bottom' | undefined;
    children: Snippet<[{ 'aria-describedby': string }]>;
  } = $props();

  const uid = $props.id();
  let root = $state<HTMLElement | null>(null);
  let hovering = $state(false);
  let focused = $state(false);
  let dismissed = $state(false);
  const shown = $derived((hovering || focused) && !dismissed);
</script>

<span
  class="tip"
  bind:this={root}
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => {
    hovering = false;
    dismissed = false;
  }}
  onfocusin={() => (focused = true)}
  onfocusout={() => {
    focused = false;
    dismissed = false;
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') dismissed = true;
  }}
  role="presentation"
>
  {@render children({ 'aria-describedby': `${uid}-tip` })}
  <span class="visually-hidden" id="{uid}-tip" role="tooltip">{text}</span>
  {#if shown}
    <span class="bubble" aria-hidden="true" use:floating={{ anchor: root, align: 'center', gap: 6, prefer: placement === 'top' ? 'above' : 'below' }}><span class="bubble-text">{text}</span></span>
  {/if}
</span>

<style>
  .tip {
    display: inline-flex;
  }

  .bubble {
    width: max-content;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: 1.33;
    color: var(--surface);
    pointer-events: none;
    background: var(--ink);
    border: 0;
    border-radius: var(--radius-sm);
  }

  .bubble-text {
    display: block;
    max-width: 240px;
  }
</style>
