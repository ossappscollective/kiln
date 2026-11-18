<!--
  Tabs: a tab list with one visible panel.
  Props: tabs ({ id, label, count? }[]), value (bindable id of the active tab), label (accessible
  name of the tab list), panel (snippet receiving the active id). Arrow keys, Home and End move
  between tabs; Tab moves into the panel. Use for views of the same object, not for navigation.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tab = { id: string; label: string; count?: number };

  let {
    tabs,
    value = $bindable(),
    label,
    panel,
  }: { tabs: Tab[]; value?: string; label: string; panel: Snippet<[string]> } = $props();

  const uid = $props.id();
  const active = $derived(tabs.find((t) => t.id === value)?.id ?? tabs[0]?.id ?? '');
  let buttons = $state<Record<string, HTMLButtonElement | undefined>>({});

  function onkeydown(event: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    value = target.id;
    buttons[target.id]?.focus();
  }
</script>

<div class="tabs">
  <div class="list" role="tablist" aria-label={label}>
    {#each tabs as tab (tab.id)}
      <button
        bind:this={buttons[tab.id]}
        type="button"
        class="bare tab"
        role="tab"
        id="{uid}-tab-{tab.id}"
        aria-selected={active === tab.id}
        aria-controls="{uid}-panel-{tab.id}"
        tabindex={active === tab.id ? 0 : -1}
        onclick={() => (value = tab.id)}
        {onkeydown}
      >
        {tab.label}
        {#if tab.count !== undefined}<span class="count">{tab.count}</span>{/if}
      </button>
    {/each}
  </div>
  {#each tabs as tab (tab.id)}
    {#if active === tab.id}
      <div role="tabpanel" id="{uid}-panel-{tab.id}" aria-labelledby="{uid}-tab-{tab.id}" tabindex="0" class="panel">
        {@render panel(tab.id)}
      </div>
    {/if}
  {/each}
</div>

<style>
  .list {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-5);
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
  }

  .tab {
    position: relative;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    margin-bottom: -1px;
    font-weight: var(--weight-medium);
    color: var(--muted);
    white-space: nowrap;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    transition: color var(--duration-fast) var(--ease);
  }

  .tab:hover {
    color: var(--ink);
  }

  .tab[aria-selected='true'] {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }

  .count {
    padding: 0 6px;
    font-size: var(--text-xs);
    line-height: 1.25rem;
    color: var(--muted);
    background: var(--surface-sunken);
    border-radius: var(--radius-full);
  }

  .panel:focus-visible {
    outline-offset: 4px;
    border-radius: var(--radius-sm);
  }
</style>
