<!--
  VersionPicker: the version of the app page, with its state beside it as a colored dot and a word
  ("2.4.0  ● Prepare for submission"). A button that opens a short list; every option carries its own dot
  and word, so nobody opens a version to learn its state. The dot never stands alone: the word is there.
  Keyboard: Enter, Space or the arrow keys open it; the arrows, Home and End move, Enter or Space picks,
  Escape closes and gives the focus back.
  Props: options (from buildVersionOptions), value (the selected version or null), onchange (version).
  No versions (the app was not synced yet) is one disabled button that says so.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { floating } from '../../lib/floating.ts';
  import { tick } from 'svelte';
  import { type VersionOption, type VersionTone } from '../../lib/app-header.ts';
  import Icon from '../ui/Icon.svelte';

  let { options, value, onchange }: { options: VersionOption[]; value: string | null; onchange: (version: string) => void } = $props();

  const uid = $props.id();
  let open = $state(false);
  let active = $state(0);
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let list = $state<HTMLElement>();

  const current = $derived(options.find((o) => o.version === value) ?? null);
  const word = (o: VersionOption) => (o.detail !== '' ? o.detail : o.state.label);

  async function show() {
    if (options.length === 0) return;
    active = Math.max(0, options.findIndex((o) => o.version === value));
    open = true;
    await tick();
    list?.focus();
  }

  function close(restore = true) {
    open = false;
    if (restore) trigger?.focus();
  }

  function pick(option: VersionOption) {
    close();
    if (option.version !== value) onchange(option.version);
  }

  function onTriggerKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void show();
    }
  }

  function onListKey(event: KeyboardEvent) {
    const last = options.length - 1;
    if (event.key === 'ArrowDown') active = Math.min(last, active + 1);
    else if (event.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (event.key === 'Home') active = 0;
    else if (event.key === 'End') active = last;
    else if (event.key === 'Enter' || event.key === ' ') {
      const option = options[active];
      if (option) pick(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close(false);
      return;
    } else return;
    event.preventDefault();
    void tick().then(() => document.getElementById(`${uid}-o${active}`)?.scrollIntoView({ block: 'nearest' }));
  }

  function onwindowdown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }

  const toneOf = (tone: VersionTone) => tone;
</script>

<svelte:window onpointerdown={onwindowdown} />

<div class="version" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="bare trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls="{uid}-list"
    aria-label={current ? t('app:versionPicker.current', { version: current.version, state: word(current) }) : t('app:versionPicker.none')}
    disabled={options.length === 0}
    onclick={() => (open ? close(false) : show())}
    onkeydown={onTriggerKey}
  >
    <span class="lbl">{t('app:versionPicker.label')}</span>
    {#if current}
      <strong class="num">{current.version}</strong>
      <span class="state"><span class="dot" data-tone={toneOf(current.state.tone)} aria-hidden="true"></span>{word(current)}</span>
    {:else}
      <span class="muted">{t('app:versionPicker.noVersions')}</span>
    {/if}
    <Icon name="chevron-down" size={14} />
  </button>

  {#if open}
    <ul
      bind:this={list}
      id="{uid}-list"
      class="menu"
      use:floating={{ anchor: trigger ?? null, align: 'start', matchAnchorWidth: true }}
      role="listbox"
      tabindex="-1"
      aria-label={t('app:versionPicker.label')}
      aria-activedescendant="{uid}-o{active}"
      onkeydown={onListKey}
    >
      {#each options as option, i (option.version)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{uid}-o{i}"
          role="option"
          aria-selected={option.version === value}
          class:active={i === active}
          onpointerenter={() => (active = i)}
          onclick={() => pick(option)}
        >
          <strong class="num">{option.version}</strong>
          <span class="state"><span class="dot" data-tone={toneOf(option.state.tone)} aria-hidden="true"></span>{word(option)}</span>
          {#if option.version === value}<Icon name="check" size={14} />{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .version {
    position: relative;
  }

  .trigger {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    color: var(--ink);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
  }

  .trigger:hover:not(:disabled) {
    border-color: var(--line-hover);
  }

  .trigger:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .trigger:focus-visible,
  .menu:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .lbl {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .state {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
    color: var(--muted);
    white-space: nowrap;
  }

  .dot {
    width: 8px;
    height: 8px;
    background: var(--muted);
    border-radius: var(--radius-full);
  }

  .dot[data-tone='ok'] {
    background: var(--ok);
  }

  .dot[data-tone='info'] {
    background: var(--info);
  }

  .dot[data-tone='accent'] {
    background: var(--accent);
  }

  .dot[data-tone='warn'] {
    background: var(--warn);
  }

  .dot[data-tone='bad'] {
    background: var(--bad);
  }

  /* In the top layer, placed by `floating` (lib/floating.ts): no container can clip it. */
  .menu {
    z-index: var(--z-dropdown);
    box-sizing: border-box;
    max-height: 320px;
    padding: var(--space-1);
    margin: 0;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  .menu li {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    justify-content: space-between;
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .menu li.active {
    background: var(--surface-hover);
  }

  .menu li[aria-selected='true'] {
    background: var(--accent-bg);
  }
</style>
