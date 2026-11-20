<!--
  InfoTip: a small popover that opens on click or Enter, for what is useful to know but should not
  take room on the screen: a legend, where the data was read from, a sentence of explanation. It is
  not a tooltip: the content can be long and can hold links. Escape and a click outside close it and
  focus returns to the button.
  Props: label (the accessible name of the button, also its title), buttonText? (visible text beside
  the icon; without it the button is icon only), icon = 'info', align = 'start' | 'end' (which edge
  of the button the panel lines up with; it is placed with position: fixed in the top layer, clamped to the window), text? (a plain sentence) or children (rich content),
  open (bindable), width (CSS length, default 22rem).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { floating } from '../../lib/floating.ts';
  import type { IconName } from '../../lib/icons.ts';
  import Icon from './Icon.svelte';

  let {
    label,
    buttonText,
    icon = 'info',
    align = 'start',
    text,
    children,
    open = $bindable(false),
    width = '22rem',
  }: {
    label: string;
    buttonText?: string | undefined;
    icon?: IconName | undefined;
    align?: 'start' | 'end' | undefined;
    text?: string | undefined;
    children?: Snippet | undefined;
    open?: boolean | undefined;
    width?: string | undefined;
  } = $props();

  const uid = $props.id();
  let root = $state<HTMLElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  function close(restoreFocus: boolean) {
    open = false;
    if (restoreFocus) button?.focus();
  }

  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (root && event.target instanceof Node && !root.contains(event.target)) open = false;
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  });
</script>

<span
  class="infotip"
  bind:this={root}
  role="presentation"
  onkeydown={(e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(true);
    }
  }}
  onfocusout={(e) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && root && !root.contains(next)) open = false;
  }}
>
  <button
    type="button"
    class="bare trigger"
    class:text={buttonText !== undefined}
    bind:this={button}
    aria-expanded={open}
    aria-controls="{uid}-panel"
    aria-label={buttonText === undefined ? label : undefined}
    title={buttonText === undefined ? label : undefined}
    onclick={() => (open = !open)}
  >
    <Icon name={icon} size={14} />{#if buttonText !== undefined}<span>{buttonText}</span>{/if}
  </button>
  {#if open}
    <div class="panel" bind:this={panel} id="{uid}-panel" role="group" aria-label={label} style:width use:floating={{ anchor: button, align }}>
      {#if text}<p>{text}</p>{/if}
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</span>

<style>
  .infotip {
    position: relative;
    display: inline-flex;
  }

  .trigger {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    min-width: var(--control-sm);
    min-height: var(--control-sm);
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-md);
    justify-content: center;
  }

  .trigger:hover,
  .trigger[aria-expanded='true'] {
    color: var(--ink);
    background: var(--surface-hover);
  }

  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Drawn in the top layer and placed next to the button by the `floating` action (lib/floating.ts), so a container with
     overflow or a transform around the button cannot clip it. */
  .panel {
    z-index: var(--z-dropdown);
    max-width: min(90vw, 36rem);
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
    color: var(--ink);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  .panel :global(p) {
    margin: 0;
  }

  .panel :global(p + p) {
    margin-top: var(--space-2);
  }
</style>
