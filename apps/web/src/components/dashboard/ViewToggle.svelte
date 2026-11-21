<!--
  ViewToggle: switches the portfolio between the list and the board. Two buttons in one group;
  the pressed one is said in words (aria-pressed) and shown with a border, not by color alone.
  Props: mode ('list' | 'board'), onchange (called with the new mode).
-->
<script lang="ts">
  import type { ViewMode } from '../../lib/dashboard.ts';

  let { mode, onchange }: { mode: ViewMode; onchange: (mode: ViewMode) => void } = $props();

  const options: { value: ViewMode; label: string }[] = [
    { value: 'list', label: 'List' },
    { value: 'board', label: 'Board' },
  ];
</script>

<div class="toggle" role="group" aria-label="View">
  {#each options as option (option.value)}
    <button
      type="button"
      class="bare option"
      class:active={mode === option.value}
      aria-pressed={mode === option.value}
      onclick={() => onchange(option.value)}>{option.label}</button
    >
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    padding: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
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
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
  }

  .option:hover {
    color: var(--ink);
  }

  .option.active {
    color: var(--accent);
    background: var(--surface);
    border-color: var(--accent);
  }

  .option:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }
</style>
