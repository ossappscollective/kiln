<!--
  AppSwitcherList: the rows of the app switcher (icon, name, bundle ids, pending chip, platforms, number). One list
  for the Cmd or Ctrl + K dialog (AppSwitcher) and the switcher field of the left panel (AppSwitcherField); the
  parent owns the search text and the highlighted row, and the keys (lib/app-switcher.ts moveActive).
  Props: items (already filtered), current (the highlighted row), selectedKey? (the open app, marked), id (the listbox
  id; the rows are `<id>-o<index>`), mod (Cmd or Ctrl, for the number hint), onhover (index), onpick (item).
-->
<script lang="ts">
  import type { SwitcherItem } from '../../lib/app-switcher.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import PendingChip from '../publish/PendingChip.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    items,
    current,
    selectedKey = null,
    id,
    mod = 'Ctrl',
    onhover,
    onpick,
  }: {
    items: SwitcherItem[];
    current: number;
    selectedKey?: string | null;
    id: string;
    mod?: string;
    onhover: (index: number) => void;
    onpick: (item: SwitcherItem) => void;
  } = $props();
</script>

<ul {id} class="list" role="listbox" aria-label="Apps">
  {#each items as item, i (item.key)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <li
      id="{id}-o{i}"
      role="option"
      aria-selected={i === current}
      class:active={i === current}
      class:open={item.key === selectedKey}
      onpointerenter={() => onhover(i)}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onpick(item)}
    >
      <AppIcon name={item.name} url={item.iconUrl} seed={item.key} size="sm" labelled />
      <span class="names">
        <strong class="name">{item.name}</strong>
        <code class="ids">{item.identifiers.join(' · ')}</code>
        {#if item.pending}<span class="chiprow"><PendingChip line={item.pending} /></span>{/if}
      </span>
      <span class="plats">{#each item.platforms as p (p)}<PlatformBadge platform={p} />{/each}</span>
      {#if item.number !== null}<kbd class="num" title="{mod} + {item.number}">{item.number}</kbd>{/if}
    </li>
  {/each}
</ul>

<style>
  .list {
    max-height: 340px;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    list-style: none;
  }

  .list li {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-height: var(--control-lg);
    padding: var(--space-1) var(--space-2);
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .list li.active {
    background: var(--accent-bg);
  }

  .names {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  /* The name and the bundle ids wrap: nothing in a row is cut off. */
  .name,
  .ids {
    overflow-wrap: anywhere;
  }

  .ids {
    padding: 0;
    font-size: var(--text-xs);
    color: var(--muted);
    background: none;
    border: 0;
  }

  .chiprow {
    display: flex;
    margin-top: var(--space-1);
  }

  .plats {
    display: inline-flex;
    flex: none;
    gap: var(--space-1);
  }

  .num {
    flex: none;
    min-width: 20px;
    text-align: center;
    color: var(--muted);
  }

  /* The open app: the accent colour reads on the highlight in both themes (the "ink" colour is for text ON an accent fill). */
  .list li.open .name {
    color: var(--accent);
  }
</style>
