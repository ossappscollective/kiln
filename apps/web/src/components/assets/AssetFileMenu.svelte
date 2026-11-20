<!--
  AssetFileMenu: the "more" menu of one file: a button that opens a short list of actions. An action that cannot
  be done is shown disabled with its reason next to it, so nobody has to guess why. Escape and a click outside
  close it, and focus returns to the button.
  Props: label (the accessible name of the button), items ({ id, label, icon?, disabled?, reason?, danger? }),
  onselect(id).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { floating } from '../../lib/floating.ts';
  import type { MenuItem } from '../../lib/assets-sync.ts';
  import Icon from '../ui/Icon.svelte';

  let { label, items, onselect }: { label: string; items: MenuItem[]; onselect: (id: string) => void } = $props();

  const uid = $props.id();
  let open = $state(false);
  let button = $state<HTMLButtonElement>();
  let list = $state<HTMLUListElement>();

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
      list?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    }
  }

  function close(refocus: boolean) {
    open = false;
    if (refocus) button?.focus();
  }

  function pick(item: MenuItem) {
    if (item.disabled) return;
    close(true);
    onselect(item.id);
  }

  function key(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    }
  }

  $effect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (button?.contains(t) || list?.contains(t))) return;
      open = false;
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  });
</script>

<span class="menu" onkeydown={key} role="presentation">
  <button bind:this={button} type="button" class="trigger" aria-haspopup="true" aria-expanded={open} aria-controls="menu-{uid}" aria-label={label} title={label} onclick={toggle}>
    <Icon name="more" size={16} />
  </button>
  {#if open}
    <ul id="menu-{uid}" class="list" bind:this={list} aria-label={label} use:floating={{ anchor: button ?? null, align: 'end' }}>
      {#each items as item (item.id)}
        <li>
          <button type="button" class:danger={item.danger} disabled={item.disabled} onclick={() => pick(item)}>
            {#if item.icon}<Icon name={item.icon} size={14} />{/if}<span>{item.label}</span>
          </button>
          {#if item.disabled && item.reason}<span class="reason">{item.reason}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</span>

<style>
  .menu {
    position: relative;
    display: inline-block;
  }
  .trigger {
    display: inline-grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--ink);
    cursor: pointer;
  }
  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--surface-sunken);
    border-color: var(--line);
  }
  .list {
    z-index: 20;
    min-width: 14rem;
    max-width: 20rem;
    margin: var(--space-1) 0 0;
    padding: var(--space-1);
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md, 0 8px 24px rgb(0 0 0 / 0.18));
  }
  .list button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: var(--radius-md);
    color: var(--ink);
    cursor: pointer;
  }
  .list button:hover:not([disabled]) {
    background: var(--surface-sunken);
  }
  .list button[disabled] {
    color: var(--muted);
    cursor: not-allowed;
  }
  .list button.danger {
    color: var(--bad-ink);
  }
  .reason {
    display: block;
    padding: 0 var(--space-3) var(--space-2);
    font-size: var(--text-sm);
    color: var(--muted);
  }
</style>
