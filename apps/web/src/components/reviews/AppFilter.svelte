<!--
  AppFilter: choose which apps the reviews inbox shows. A multi-select combobox (ARIA 1.2 editable combobox with a multi-selectable
  listbox): type to search by name or bundle id, arrows move, Enter chooses or removes the highlighted app, Escape closes (the first
  Escape clears the search), Backspace in an empty box removes the last chip. The chosen apps are chips with their icon and a remove
  button; "All apps" resets. Each option shows the stored review counts from the summary. The list is a popover (lib/floating.ts), so
  the toolbar never clips it. The state is the list of app ids; the page keeps it in the address (`?apps=`) and asks the server for it.
  Props: options (lib/reviews/app-filter.ts appOptions), selected (app ids), onchange(ids).
-->
<script lang="ts">
  import { floating } from '../../lib/floating.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { allApps, type AppOption, matchApps, matchCountText, removeApp, selectedOptions, toggleApp } from '../../lib/reviews/app-filter.ts';
  import AppIcon from '../ui/AppIcon.svelte';
  import Icon from '../ui/Icon.svelte';

  let { options, selected, onchange }: { options: AppOption[]; selected: string[]; onchange: (ids: string[]) => void } = $props();

  const uid = $props.id();
  let root = $state<HTMLElement | null>(null);
  let box = $state<HTMLElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let open = $state(false);
  /** Index in `entries` of the highlighted option, -1 for none. */
  let active = $state(-1);

  const chips = $derived(selectedOptions(options, selected));
  const matches = $derived(matchApps(options, query));
  /** The first entry is the reset; the rest are the matching apps. */
  const entries = $derived<(AppOption | null)[]>([null, ...matches]);
  const optionId = (i: number) => `${uid}-opt-${i}`;

  function show() {
    open = true;
  }
  function close() {
    open = false;
    active = -1;
  }
  function choose(i: number) {
    const entry = entries[i];
    if (entry === undefined) return;
    onchange(entry === null ? allApps() : toggleApp(selected, entry.id));
    if (entry === null) close();
  }
  function move(delta: number) {
    show();
    const last = entries.length - 1;
    active = active < 0 ? (delta > 0 ? 0 : last) : Math.max(0, Math.min(last, active + delta));
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      active = 0;
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      active = entries.length - 1;
    } else if (e.key === 'Enter') {
      if (open && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (query === '') {
        // Enter in the toolbar form must not submit the search while this field is open.
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      if (open || query !== '') e.stopPropagation();
      if (query !== '') query = '';
      else close();
    } else if (e.key === 'Backspace' && query === '' && selected.length > 0) {
      onchange(removeApp(selected, selected[selected.length - 1] as string));
    }
  }
  function onfocusout(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (open && !(next && root?.contains(next))) close();
  }
</script>

<div class="app-filter" bind:this={root} {onfocusout}>
  <div class="field" bind:this={box}>
    <ul class="chips" aria-label={t('reviews:appFilter.chosen')}>
      {#each chips as chip (chip.id)}
        <li>
          <button type="button" class="bare chip" aria-label={t('reviews:appFilter.remove', { name: chip.name })} title={chip.identifier} onclick={() => { onchange(removeApp(selected, chip.id)); input?.focus(); }}>
            <AppIcon name={chip.name} url={chip.iconUrl} platform={chip.platform} size="xs" labelled={true} />
            <span class="chip-name">{chip.name}</span>
            <Icon name="x" size={12} />
          </button>
        </li>
      {/each}
    </ul>
    <label class="visually-hidden" for="{uid}-input">{t('reviews:appFilter.label')}</label>
    <input
      id="{uid}-input"
      bind:this={input}
      bind:value={query}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls="{uid}-list"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-activedescendant={open && active >= 0 && active < entries.length ? optionId(active) : undefined}
      aria-describedby="{uid}-hint"
      autocomplete="off"
      spellcheck="false"
      maxlength="100"
      placeholder={chips.length === 0 ? t('reviews:appFilter.placeholder') : ''}
      onfocus={show}
      onclick={show}
      oninput={(e) => {
        show();
        active = e.currentTarget.value === '' ? -1 : 1;
      }}
      {onkeydown}
    />
    {#if selected.length > 0}
      <button type="button" class="bare reset" onclick={() => { onchange(allApps()); input?.focus(); }}>{t('reviews:appFilter.all')}</button>
    {/if}
  </div>
  <p class="visually-hidden" id="{uid}-hint">{t('reviews:appFilter.hint')}</p>
  <p class="visually-hidden" role="status">{open ? matchCountText(matches.length) : ''}</p>

  {#if open}
    <ul
      id="{uid}-list"
      class="list"
      role="listbox"
      aria-multiselectable="true"
      aria-label={t('reviews:appFilter.label')}
      use:floating={{ anchor: box, align: 'start', gap: 4, matchAnchorWidth: true }}
    >
      {#each entries as entry, i (entry === null ? 'all' : entry.id)}
        <!-- Options are chosen with the keyboard from the input (aria-activedescendant); the mouse keeps the focus in the input. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          role="option"
          class:active={i === active}
          aria-selected={entry === null ? selected.length === 0 : selected.includes(entry.id)}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => choose(i)}
          onmousemove={() => (active = i)}
        >
          {#if entry === null}
            <span class="all">{t('reviews:appFilter.all')}</span>
            {#if selected.length === 0}<Icon name="check" size={14} />{/if}
          {:else}
            <AppIcon name={entry.name} url={entry.iconUrl} platform={entry.platform} size="xs" labelled={true} />
            <span class="text">
              <span class="name">{entry.name}</span>
              <span class="ident">{entry.identifier}</span>
            </span>
            {#if entry.total !== null}<span class="counts">{t('reviews:appFilter.counts', { total: entry.total, newCount: entry.newCount ?? 0 })}</span>{/if}
            {#if selected.includes(entry.id)}<Icon name="check" size={14} />{/if}
          {/if}
        </li>
      {/each}
      {#if matches.length === 0}<li class="none" role="presentation">{t('reviews:appFilter.noMatch')}</li>{/if}
    </ul>
  {/if}
</div>

<style>
  .app-filter {
    flex: 1 1 16rem;
    min-width: 12rem;
    max-width: 32rem;
  }

  .field {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    min-height: 2.25rem;
    padding: var(--space-1) var(--space-2);
    background: var(--field-bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .field:focus-within {
    border-color: var(--focus);
    box-shadow: var(--halo);
  }

  .chips {
    display: contents;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    max-width: 14rem;
    padding: 0 var(--space-2) 0 var(--space-1);
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-radius: var(--radius-full);
  }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  input {
    flex: 1 1 8rem;
    min-width: 6rem;
    padding: var(--space-1) 0;
    background: transparent;
    border: 0;
    box-shadow: none;
    outline: 0;
  }

  .reset {
    padding: 0 var(--space-1);
    color: var(--accent);
    text-decoration: underline;
  }

  .list {
    box-sizing: border-box;
    max-height: 22rem;
    margin: 0;
    padding: var(--space-1);
    overflow-y: auto;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  [role="option"] {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-2);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  [role="option"].active {
    background: var(--surface-active);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .name,
  .ident {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ident,
  .counts {
    color: var(--muted);
    font-size: var(--text-sm, 0.875rem);
  }

  .all {
    flex: 1;
    font-weight: var(--weight-medium, 500);
  }

  .none {
    padding: var(--space-2);
    color: var(--muted);
  }
</style>
