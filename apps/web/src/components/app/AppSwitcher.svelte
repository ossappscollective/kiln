<!--
  AppSwitcher: the searchable list of apps behind Cmd or Ctrl + K. Type to narrow by name or by bundle id /
  package name (ids sit under the names, so apps with one name can be told apart), the arrow keys move,
  Enter opens the app, Escape closes. The first nine apps carry a number; Cmd or Ctrl + that digit opens the
  app from anywhere, also from this list. A native <dialog> through Modal, so the focus trap, Escape and the
  focus return come from the browser.
  The rows are AppSwitcherList, shared with the switcher field of the left panel (AppSwitcherField).
  Props: open (bindable), items (from switcherItems; null while the apps are being read), onpick (an item).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { type SwitcherItem, filterSwitcher, jumpTarget, moveActive } from '../../lib/app-switcher.ts';
  import Icon from '../ui/Icon.svelte';
  import Modal from '../ui/Modal.svelte';
  import AppSwitcherList from './AppSwitcherList.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    open = $bindable(false),
    items,
    mod = 'Ctrl',
    onpick,
  }: { open?: boolean | undefined; items: SwitcherItem[] | null; mod?: string | undefined; onpick: (item: SwitcherItem) => void } = $props();

  const uid = $props.id();
  let query = $state('');
  let active = $state(0);

  const shown = $derived(filterSwitcher(items ?? [], query));
  const current = $derived(Math.min(active, Math.max(0, shown.length - 1)));

  // Every open starts with an empty search.
  $effect(() => {
    if (open) {
      query = '';
      active = 0;
    }
  });

  function choose(item: SwitcherItem | undefined) {
    if (!item) return;
    open = false;
    onpick(item);
  }

  function onkeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey) {
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        open = false;
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        choose(jumpTarget(items ?? [], Number(event.key) - 1) ?? undefined);
        return;
      }
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = moveActive(event.key, current, shown.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(shown[current]);
    }
  }
</script>

<Modal bind:open title={t('app:switcher.title')} size="sm">
  <div class="switch">
    <label class="search">
      <Icon name="search" size={16} />
      <span class="visually-hidden">{t('app:switcher.searchLabel')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-activedescendant={shown.length > 0 ? `${uid}-o${current}` : undefined}
        placeholder={t('app:switcher.searchLabel')}
        autocomplete="off"
        spellcheck="false"
        bind:value={query}
        {onkeydown}
        autofocus
      />
    </label>

    {#if items === null}
      <div class="stack" role="status" aria-label={t('app:switcher.loading')}>
        <Skeleton width="70%" height="16px" />
        <Skeleton width="50%" height="16px" />
      </div>
    {:else if shown.length === 0}
      <p class="muted none" role="status">{items.length === 0 ? t('app:switcher.none') : t('app:switcher.noMatch')}</p>
    {:else}
      <AppSwitcherList id="{uid}-list" items={shown} {current} {mod} onhover={(i) => (active = i)} onpick={choose} />
    {/if}
    <p class="foot muted">{t('app:switcher.hint', { mod })}</p>
  </div>
</Modal>

<style>
  .switch {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .search {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding: 0 var(--space-3);
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .search:has(input:focus-visible) {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .search input {
    flex: 1;
    min-width: 0;
    padding-left: 0;
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .search input:focus-visible {
    outline: none;
  }

  .none,
  .foot {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
