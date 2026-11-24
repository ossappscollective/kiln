<!--
  AppSwitcherList: the rows of the app switcher (icon, name, bundle ids, pending chip, platforms, number). One list
  for the Cmd or Ctrl + K dialog (AppSwitcher) and the switcher field of the left panel (AppSwitcherField); the
  parent owns the search text and the highlighted row, and the keys (lib/app-switcher.ts moveActive).
  Props: items (already filtered), current (the highlighted row), selectedKey? (the open app, marked), id (the listbox
  id; the rows are `<id>-o<index>`), mod (Cmd or Ctrl, for the number hint), onhover (index), onpick (item).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
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
    selectedKey?: string | null | undefined;
    id: string;
    mod?: string | undefined;
    onhover: (index: number) => void;
    onpick: (item: SwitcherItem) => void;
  } = $props();
</script>

<ul {id} class="list" role="listbox" aria-label={t('app:switcher.apps')}>
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
        <span class="head">
          <strong class="name" title={item.name}>{item.name}</strong>
          {#if item.pending}<span class="chip"><PendingChip line={item.pending} /></span>{/if}
        </span>
        <code class="ids" title={item.identifiers.join(' · ')}>{item.identifiers.join(' · ')}</code>
      </span>
      <span class="plats">{#each item.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}</span>
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

  /*
    A stable row at any width: icon | text (the one column that gives way) | platform tiles | number. The text column is
    `minmax(0, 1fr)`, so the name and the bundle ids are cut with an ellipsis instead of being squeezed to one letter per line,
    and the tiles and the number never shrink or wrap.
  */
  .list li {
    display: grid;
    grid-auto-columns: auto;
    grid-auto-flow: column;
    grid-template-columns: auto minmax(0, 1fr);
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
    flex-direction: column;
    min-width: 0;
  }

  /* The name takes what the pending chip leaves; the bundle ids sit below in muted mono. Both stay on one line. */
  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    flex: none;
  }

  .ids {
    display: block;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: 0;
  }

  .plats {
    display: inline-flex;
    gap: var(--space-1);
    white-space: nowrap;
  }

  .num {
    min-width: 20px;
    padding-inline: var(--space-1);
    font-size: var(--text-xs);
    text-align: center;
    color: var(--muted);
  }

  /* The open app: the accent colour reads on the highlight in both themes (the "ink" colour is for text ON an accent fill). */
  .list li.open .name {
    color: var(--accent);
  }
</style>
