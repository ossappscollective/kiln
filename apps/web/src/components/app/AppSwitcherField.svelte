<!--
  AppSwitcherField: the open app at the top of the left panel, as an input-like switcher. It shows the app's icon and
  name; a click or focus opens the same searchable list as the Cmd or Ctrl + K dialog (AppSwitcherList, filterSwitcher,
  moveActive from lib/app-switcher.ts): type to filter by name or bundle id, arrows move, Enter opens the app, Escape closes.
  Props: items (from switcherItems; null while the apps are being read), appId (the open app, any of its records),
  fallbackName (shown until the list is known), mod, onopen? (called when the list opens, to read the apps), onpick (an item).
-->
<script lang="ts">
  import { floating } from '../../lib/floating.ts';
  import { filterSwitcher, itemOfId, moveActive, type SwitcherItem } from '../../lib/app-switcher.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import Icon from '../ui/Icon.svelte';
  import AppSwitcherList from './AppSwitcherList.svelte';

  let {
    items,
    appId,
    fallbackName = '',
    mod = 'Ctrl',
    onopen,
    onpick,
  }: {
    items: SwitcherItem[] | null;
    appId: string;
    fallbackName?: string | undefined;
    mod?: string | undefined;
    onopen?: (() => void) | undefined;
    onpick: (item: SwitcherItem) => void;
  } = $props();

  const uid = $props.id();
  let input = $state<HTMLInputElement | null>(null);
  let box = $state<HTMLElement | null>(null);
  let open = $state(false);
  let query = $state('');
  let active = $state(0);

  const item = $derived(itemOfId(items, appId));
  const name = $derived(item?.name ?? fallbackName);
  const shown = $derived(filterSwitcher(items ?? [], query));
  const current = $derived(Math.min(active, Math.max(0, shown.length - 1)));

  function show() {
    if (open) return;
    open = true;
    query = '';
    const at = items?.findIndex((i) => i.key === item?.key) ?? -1;
    active = Math.max(0, at);
    onopen?.();
    input?.select();
  }

  function hide() {
    open = false;
    query = '';
  }

  function choose(picked: SwitcherItem | undefined) {
    if (!picked) return;
    hide();
    input?.blur();
    if (picked.key !== item?.key) onpick(picked);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else active = moveActive(event.key, current, shown.length);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      choose(shown[current]);
    }
  }
</script>

<div class="field">
  <label class="box" class:open bind:this={box}>
    <AppIcon {name} url={item?.iconUrl ?? null} seed={item?.key ?? appId} size="sm" labelled />
    <span class="visually-hidden">Switch app</span>
    <input
      bind:this={input}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls="{uid}-list"
      aria-activedescendant={open && shown.length > 0 ? `${uid}-list-o${current}` : undefined}
      aria-autocomplete="list"
      autocomplete="off"
      spellcheck="false"
      title={name}
      placeholder={name || 'Search apps'}
      value={open ? query : name}
      oninput={(e) => {
        query = e.currentTarget.value;
        active = 0;
      }}
      onfocus={show}
      onclick={show}
      onblur={hide}
      {onkeydown}
    />
    <Icon name="chevron-down" size={14} />
  </label>
  {#if open}
    <div class="pop" use:floating={{ anchor: box, align: 'start', matchAnchorWidth: true }}>
      {#if items === null}
        <p class="muted none" role="status">Loading the apps…</p>
      {:else if shown.length === 0}
        <p class="muted none" role="status">{items.length === 0 ? 'This workspace has no apps yet.' : 'No app matches.'}</p>
      {:else}
        <AppSwitcherList id="{uid}-list" items={shown} {current} selectedKey={item?.key ?? null} {mod} onhover={(i) => (active = i)} onpick={choose} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .box {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-2);
    color: var(--muted);
    cursor: text;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .box:hover {
    border-color: var(--line-hover);
  }

  .box:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .box input {
    flex: 1;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    font-weight: var(--weight-semibold);
    color: var(--ink);
    text-overflow: ellipsis;
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .box input:focus-visible {
    outline: none;
  }

  /* In the top layer, placed by `floating`: wide enough for a whole row, never cut by the left panel. */
  .pop {
    z-index: var(--z-dropdown);
    box-sizing: border-box;
    width: min(26rem, calc(100vw - 1rem));
    max-height: 22rem;
    padding: var(--space-1);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  .pop :global(ul) {
    max-height: none;
    overflow: visible;
  }

  .none {
    padding: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
