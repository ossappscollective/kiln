<!--
  ViewToggle: switches the portfolio between the list and the board. Two buttons in one group;
  the pressed one is said in words (aria-pressed) and shown with a border, not by color alone.
  Props: mode ('list' | 'board'), onchange (called with the new mode).
-->
<script lang="ts">
  import { k, t } from '../../lib/i18n/t.ts';
  import type { ViewMode } from '../../lib/dashboard.ts';

  let { mode, onchange }: { mode: ViewMode; onchange: (mode: ViewMode) => void } = $props();

  const options: { value: ViewMode; label: string }[] = [
    { value: 'list', label: k('app:viewToggle.list') },
    { value: 'board', label: k('app:viewToggle.board') },
  ];
</script>

<div class="toggle" role="group" aria-label={t('app:viewToggle.label')}>
  {#each options as option (option.value)}
    <button
      type="button"
      class="bare option"
      class:active={mode === option.value}
      aria-pressed={mode === option.value}
      onclick={() => onchange(option.value)}>{t(option.label)}</button
    >
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    padding: 2px;
    background: var(--seg-track);
    border-radius: var(--radius-md);
  }

  .option {
    min-height: var(--control-sm);
    padding: 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--muted);
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
  }

  .option:hover {
    color: var(--ink);
  }

  /* As specific as the global `button.bare:hover:not(:disabled)`, which clears backgrounds and would otherwise win. */
  .toggle button.option.bare:not(.active):hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }

  .toggle button.option.bare.active:hover:not(:disabled) {
    background: var(--seg-selected);
  }

  /* The selected option: the raised pill with a soft violet ring (--seg-selected-ring), like every segmented control. */
  .option.active {
    color: var(--ink);
    background: var(--seg-selected);
    box-shadow: var(--seg-selected-ring);
  }

  .option:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }
</style>
