<!--
  Tooltip: a short hint on hover and keyboard focus. CSS only, no timers. Escape hides it
  (WCAG 1.4.13). Use for labels of icon-only controls and brief clarifications; never for
  essential information or anything interactive.
  Props: text, placement = 'top' | 'bottom', children (snippet receiving `describedby`: spread
  it on the trigger so assistive technology reads the text).
  Usage:
    <Tooltip text="Copy key">
      {#snippet children(tip)}<button {...tip}>...</button>{/snippet}
    </Tooltip>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    text,
    placement = 'top',
    children,
  }: {
    text: string;
    placement?: 'top' | 'bottom';
    children: Snippet<[{ 'aria-describedby': string }]>;
  } = $props();

  const uid = $props.id();
  let dismissed = $state(false);
</script>

<span
  class="tip {placement}"
  class:dismissed
  onmouseleave={() => (dismissed = false)}
  onfocusout={() => (dismissed = false)}
  onkeydown={(e) => {
    if (e.key === 'Escape') dismissed = true;
  }}
  role="presentation"
>
  {@render children({ 'aria-describedby': `${uid}-tip` })}
  <span class="bubble" id="{uid}-tip" role="tooltip">{text}</span>
</span>

<style>
  .tip {
    position: relative;
    display: inline-flex;
  }

  .bubble {
    position: absolute;
    left: 50%;
    z-index: var(--z-tooltip);
    width: max-content;
    max-width: 240px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: 1.33;
    color: var(--surface);
    pointer-events: none;
    visibility: hidden;
    background: var(--ink);
    border-radius: var(--radius-sm);
    opacity: 0;
    transition:
      opacity var(--duration-fast) var(--ease),
      visibility var(--duration-fast);
    transform: translateX(-50%);
  }

  .top .bubble {
    bottom: calc(100% + 6px);
  }

  .bottom .bubble {
    top: calc(100% + 6px);
  }

  .tip:hover:not(.dismissed) .bubble,
  .tip:focus-within:not(.dismissed) .bubble {
    visibility: visible;
    opacity: 1;
  }
</style>
